import test from 'node:test';
import assert from 'node:assert/strict';
import { route, HELP, HELP_EN } from '../src/core.mjs';
import { executeCommand } from '../src/commands.mjs';
import { setThreadSettled, withT3Control } from '../src/t3-control.mjs';
import { createScheduler } from '../src/scheduler.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const thread = (id, settled = false) => ({ threadId: id, title: `Thread ${id}`, projectId: 'p',
  link: `https://test/${id}`, status: 'completed', settled });

function harness() {
  const rows = new Map([thread('home'), thread('mcp:bbbb'), thread('mcp:cccc', true)].map(t => [t.threadId, t]));
  const writes = [], replies = [];
  const state = { jobs: [], seen: [], routing: { projectId: 'p', threadId: 'home', listedIds: [...rows.keys()],
    projectThreads: {}, listedProjectIds: [] } };
  const backend = { read: async c => rows.get(c.threadId), list: async () => [...rows.values()],
    setSettled: async (c, value) => { writes.push([c.threadId, value]); rows.get(c.threadId).settled = value; return { sequence: 1 }; },
    send: async () => { throw Error('must not send a model prompt'); },
    create: async () => { throw Error('must not create a thread'); },
    interrupt: async () => { throw Error('must not stop a task'); } };
  const config = { threadId: 'home' }, reference = thread('home');
  const execute = text => executeCommand({ command: route(text), state, config, reference, backend, save() {}, job: {} });
  const scheduler = createScheduler({ state, config, reference, backend, save() {}, send: async (job, text) => replies.push([job.id, text]) });
  return { rows, writes, state, backend, execute, scheduler, replies };
}

test('settle commands parse explicit targets, current targets, wrappers and /to without ambiguity', () => {
  for (const kind of ['settle', 'unsettle']) {
    assert.deepEqual(route(`/${kind}`), { kind });
    for (const selector of ['2', '#2', 'mcp:bbbb', 'bbbb', 'home']) {
      assert.deepEqual(route(`/${kind.toUpperCase()} ${selector}`), { kind, selector });
    }
    assert.deepEqual(route(`/to 2 /${kind}`), { kind, selector: '2' });
    assert.deepEqual(route(`/task /${kind} 2`), { kind, selector: '2' });
    assert.deepEqual(route(`/new /${kind} 2`), { kind, selector: '2' });
    for (const input of [`/${kind} 2 extra`, `/to 2 /${kind} 3`]) assert.equal(route(input).kind, 'help');
    assert.ok(HELP.includes('/' + kind)); assert.ok(HELP_EN.includes('/' + kind));
  }
});

test('settle and unsettle target saved numbers, short IDs and home without changing routing', async () => {
  const h = harness();
  const before = structuredClone(h.state.routing);
  h.backend.list = async () => [...h.rows.values()].reverse();
  assert.match(await h.execute('/settle 2'), /已 settle（收起）/);
  assert.match(await h.execute('/unsettle bbbb'), /已 unsettle（恢复显示）/);
  await h.execute('/settle mcp:bbbb');
  await h.execute('/to 2 /unsettle');
  await h.execute('/settle home');
  await h.execute('/unsettle');
  assert.deepEqual(h.writes, [['mcp:bbbb', true], ['mcp:bbbb', false], ['mcp:bbbb', true],
    ['mcp:bbbb', false], ['home', true], ['home', false]]);
  assert.deepEqual(h.state.routing, before);
});

test('settled targets can be restored after listing hidden threads and normal lists reflect the change', async () => {
  const h = harness();
  const normal = await h.execute('/threads');
  assert.equal(normal.includes('Thread mcp:cccc'), false);
  const all = await h.execute('/threads --settle');
  assert.ok(all.includes('Thread mcp:cccc'));
  await h.execute('/unsettle 3');
  assert.ok((await h.execute('/threads')).includes('Thread mcp:cccc'));
});

test('already-matching states do not write and pending answers and queued tasks stay intact', async () => {
  const h = harness();
  h.state.pendingInputs = { home: { requestId: 'q' } };
  h.state.jobs.push({ id: 'queued', command: { kind: 'task', text: 'work' }, status: 'pending', bound: true, threadId: 'home' });
  const pending = structuredClone(h.state.pendingInputs), jobs = structuredClone(h.state.jobs);
  assert.match(await h.execute('/unsettle home'), /无需重复操作/);
  assert.match(await h.execute('/settle 3'), /无需重复操作/);
  assert.deepEqual(h.writes, []);
  await h.execute('/settle 2');
  assert.deepEqual(h.state.pendingInputs, pending);
  assert.deepEqual(h.state.jobs, jobs);
});

test('invalid, ambiguous, archived, subagent and foreign targets never fall back or write', async () => {
  for (const selector of ['99', 'missing', 'mcp:']) {
    const h = harness(); await assert.rejects(h.execute(`/settle ${selector}`));
    assert.deepEqual(h.writes, []); assert.equal(h.state.routing.threadId, 'home');
  }
  for (const extra of [{ projectId: 'other' }, { archived: true }, { relationshipToParent: 'subagent' }]) {
    const h = harness(); h.rows.set('mcp:bbbb', { ...thread('mcp:bbbb'), ...extra });
    await assert.rejects(h.execute('/settle 2')); assert.deepEqual(h.writes, []);
  }
  const h = harness(); h.backend.read = async () => thread('home');
  await assert.rejects(h.execute('/settle 2'), /目标线程校验失败/); assert.deepEqual(h.writes, []);
});

test('write failures, unverified state and deferred settlement never claim completed success or retry', async () => {
  const h = harness(); let writes = 0;
  h.backend.setSettled = async () => { writes++; throw Error('write rejected'); };
  await assert.rejects(h.execute('/settle 2'), /write rejected/);
  assert.equal(writes, 1);
  h.backend.setSettled = async () => { writes++; return { sequence: 1 }; };
  await assert.rejects(h.execute('/settle 2'), /实际状态未能确认/);
  assert.equal(writes, 2);
  h.backend.setSettled = async () => ({ settlesWhenTurnEnds: true });
  const deferred = await h.execute('/settle 2');
  assert.ok(deferred.includes('尚未确认收起')); assert.equal(deferred.includes('线程状态已更新'), false);
});

test('settle uses the write control connection with an explicit action and exact target', async () => {
  for (const value of [true, false]) {
    const calls = [];
    await setThreadSettled({ threadId: 'mcp:target' }, value, { control: async (config, action, options) => {
      assert.equal(options.write, true); assert.equal(config.threadId, 'mcp:target');
      return action(async (name, args) => { calls.push([name, args]); return { sequence: 1 }; });
    } });
    assert.deepEqual(calls, [['t3_thread_organize', { threadId: 'mcp:target', action: value ? 'settle' : 'unsettle' }]]);
  }
  assert.throws(() => setThreadSettled({}, true), /明确/);
  assert.throws(() => setThreadSettled({ threadId: 'a' }, 'settle'), /明确/);
});

test('settle bypasses a running task lane and its completion does not switch threads', async () => {
  const h = harness(); let complete;
  h.backend.send = () => new Promise(resolve => { complete = resolve; });
  h.state.jobs.push({ id: 'task', command: route('/to 2 long task'), status: 'pending', sent: 0 });
  h.scheduler.tick(); await flush();
  h.state.jobs.push({ id: 'settle', command: route('/settle 2'), status: 'pending', sent: 0 });
  h.scheduler.tick(); await flush(); h.scheduler.tick(); await flush();
  assert.equal(h.state.jobs.find(j => j.id === 'task').status, 'running');
  assert.ok(h.replies.some(([id, text]) => id === 'settle' && text.includes('线程状态已更新')));
  assert.equal(h.state.routing.threadId, 'home');
  complete('done'); await flush(); h.scheduler.tick(); await flush();
});

test('organize RPC allows settle writes, blocks other organize actions and read credentials, and revokes sessions', async () => {
  function fixture(write) {
    const tools = [], revoked = []; let label;
    const cli = async (_, args) => {
      if (args[2] === 'create') { label = args[args.indexOf('--label') + 1]; return JSON.stringify({ id: 'pair', credential: 'test-pair' }); }
      if (args[2] === 'list') return JSON.stringify([{ sessionId: 'write-session', client: { label } }]);
      if (args[2] === 'issue') return JSON.stringify({ sessionId: 'read-session', token: 'test-token' });
      if (args[2] === 'revoke') revoked.push(args.at(-1));
      return '';
    };
    const fetchImpl = async (url, options) => {
      const endpoint = new URL(url).pathname;
      if (endpoint.endsWith('register')) return Response.json({ client_id: 'test-client' });
      if (endpoint.endsWith('decision')) return Response.json({ redirectTo: `http://127.0.0.1:1/wechat-t3-callback?state=${JSON.parse(options.body).authorization.state}&code=test-code` });
      if (endpoint.endsWith('token')) return Response.json({ access_token: 'test-token' });
      if (options.method === 'DELETE') return new Response(null, { status: 200 });
      const request = JSON.parse(options.body);
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (request.method === 'tools/call') tools.push(request.params);
      return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'initialize'
        ? { protocolVersion: '2025-06-18' } : { structuredContent: { sequence: 1 } } }, { headers: { 'mcp-session-id': 'test-transport' } });
    };
    return { tools, revoked, options: { cli, fetchImpl, write, readRuntime: () => ({ origin: 'http://127.0.0.1:3773' }) } };
  }
  for (const action of ['settle', 'unsettle']) {
    const f = fixture(true);
    await withT3Control({}, call => call('t3_thread_organize', { threadId: 'target', action }), f.options);
    assert.deepEqual(f.tools, [{ name: 't3_thread_organize', arguments: { threadId: 'target', action } }]);
    assert.ok(f.revoked.includes('write-session'));
  }
  for (const [write, action, threadId] of [[false, 'settle', 'target'], [true, 'archive', 'target'], [true, 'settle', undefined]]) {
    const f = fixture(write);
    await assert.rejects(withT3Control({}, call => call('t3_thread_organize', { threadId, action }), f.options), /Settling requires/);
    assert.deepEqual(f.tools, []);
    assert.ok(f.revoked.includes(write ? 'write-session' : 'read-session'));
  }
});
