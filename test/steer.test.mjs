import test from 'node:test';
import assert from 'node:assert/strict';
import { route, recover, HELP, HELP_EN } from '../src/core.mjs';
import { executeCommand } from '../src/commands.mjs';
import { createScheduler } from '../src/scheduler.mjs';
import { steerThread, withT3Control } from '../src/t3-control.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const thread = id => ({ threadId: id, projectId: 'p', title: id, link: `https://test/${id}`, status: 'running' });
function harness() {
  const state = { jobs: [], seen: [], routing: { threadId: 'a', listedIds: ['a', 'b'] } };
  const rows = new Map(['a', 'b'].map(id => [id, thread(id)]));
  const tasks = [], steers = [], replies = [], pending = [];
  const backend = {
    read: async config => rows.get(config.threadId), list: async () => [...rows.values()],
    send: (config, text) => { tasks.push([config.threadId, text]); return new Promise(resolve => pending.push(resolve)); },
    steer: async (config, text, id) => { steers.push([config.threadId, text, id]);
      return { threadId: config.threadId, runId: `run-${config.threadId}`, delivery: 'steered' }; },
  };
  const config = { threadId: 'a' }, reference = { projectId: 'p' };
  const scheduler = createScheduler({ state, config, reference, backend, save() {}, send: async (job, text) => replies.push([job.id, text]) });
  const execute = (text, job = {}) => executeCommand({ command: route(text), state, config, reference, backend, save() {}, job });
  const add = text => { const job = { id: `job-${state.jobs.length + state.seen.length}`, command: route(text), status: 'pending', sent: 0 };
    state.jobs.push(job); return job; };
  return { state, rows, backend, tasks, steers, replies, pending, add, execute,
    tick: async () => { scheduler.tick(); await flush(); } };
}

test('steer commands preserve the message and support Chinese, targeted tasks and explicit send flags', () => {
  const text = '先处理错误 & $literal\n保留 /线程 😀';
  for (const prefix of ['/steer', '/STEER', '/引导', '／引导', '/task --steer', '/任务 --steer']) {
    assert.deepEqual(route(`${prefix} ${text}`), { kind: 'steer', text });
    assert.deepEqual(route(`/to 2 ${prefix} ${text}`), { kind: 'steer', text, selector: '2' });
  }
  assert.deepEqual(route('/发送 #2 /引导 更改顺序'), { kind: 'steer', text: '更改顺序', selector: '#2' });
  for (const input of ['/steer', '/引导 ', '/task --steer', '/to 2 /steer']) assert.equal(route(input).kind, 'help');
  assert.deepEqual(route('/task explain --steer'), { kind: 'task', text: 'explain --steer' });
  assert.deepEqual(route('/new --steer literal'), { kind: 'new', text: '--steer literal' });
  assert.ok(HELP.includes('/引导')); assert.ok(HELP_EN.includes('/steer'));
});

test('steering bypasses a running task and its queued follow-up, and acknowledges before completion', async () => {
  const h = harness();
  const running = h.add('long task'); await h.tick(); await h.tick();
  const queued = h.add('next task');
  const steer = h.add('/引导 先完成诊断'); await h.tick(); await h.tick();
  assert.deepEqual(h.tasks, [['a', 'long task']]);
  assert.deepEqual(h.steers, [['a', '先完成诊断', `wechat-steer-${steer.id}`]]);
  assert.equal(running.status, 'running'); assert.equal(queued.status, 'pending');
  assert.ok(h.replies.some(([id, text]) => id === steer.id && text.includes('送入正在运行的任务')));
  h.pending[0]('long done'); await flush(); await h.tick();
  assert.deepEqual(h.tasks.at(-1), ['a', 'next task']);
  h.pending[1]('next done'); await flush(); await h.tick();
});

test('targeted steering uses saved numbering without switching or answering another thread', async () => {
  const h = harness();
  h.state.pendingInputs = { a: { requestId: 'other-draft' } };
  const before = structuredClone(h.state.routing), drafts = structuredClone(h.state.pendingInputs);
  const job = { id: 'targeted' };
  const reply = await h.execute('/to 2 /task --steer use b', job);
  assert.deepEqual(h.steers, [['b', 'use b', 'wechat-steer-targeted']]);
  assert.equal(job.threadId, 'b'); assert.equal(job.runId, 'run-b');
  assert.match(reply, /\/to 2 \/history/);
  assert.deepEqual(h.state.routing, before); assert.deepEqual(h.state.pendingInputs, drafts);
  assert.deepEqual(h.tasks, []);
});

test('invalid and unavailable targets cannot receive steering or fall back to the selected thread', async () => {
  for (const extra of [{ projectId: 'foreign' }, { archived: true }, { relationshipToParent: 'subagent' }]) {
    const h = harness(); h.rows.set('b', { ...thread('b'), ...extra });
    await assert.rejects(h.execute('/to 2 /steer change')); assert.deepEqual(h.steers, []);
  }
  const h = harness(); await assert.rejects(h.execute('/to missing /steer change'));
  h.backend.read = async () => thread('b');
  await assert.rejects(h.execute('/steer change'), /校验失败/); assert.deepEqual(h.steers, []);
});

test('pending questions or approvals do not consume steering as an answer or task', async () => {
  for (const extra of [{ status: 'waiting' }, { pendingRequestCount: 1 }, {}]) {
    const h = harness(); h.rows.set('a', { ...thread('a'), ...extra });
    if (!Object.keys(extra).length) h.state.pendingInputs = { a: { requestId: 'draft' } };
    assert.match(await h.execute('/steer change'), /本条引导未提交/);
    assert.deepEqual(h.steers, []); assert.deepEqual(h.tasks, []);
  }
});

test('failed or uncertain steering is not automatically replayed', async () => {
  const h = harness(); let attempts = 0;
  h.backend.steer = async () => { attempts++; throw Error('unconfirmed'); };
  h.add('/steer change'); await h.tick(); await h.tick(); await h.tick();
  assert.equal(attempts, 1); assert.ok(h.replies.some(([, text]) => text.includes('unconfirmed')));
  const recovered = h.add('/steer uncertain'); recovered.status = 'running';
  recover(h.state); await h.tick(); await h.tick();
  assert.equal(attempts, 1); assert.ok(h.replies.some(([id, text]) => id === recovered.id && text.includes('不会自动重跑')));
});

test('MCP steering explicitly uses steer mode, a stable retry key and a write credential', async () => {
  const calls = [];
  const expected = { threadId: 'a', runId: 'run-a', delivery: 'steered' };
  const control = async (config, action, options) => {
    assert.equal(config.threadId, 'a'); assert.equal(options.write, true);
    return action(async (tool, args) => { calls.push([tool, args]); return expected; });
  };
  assert.deepEqual(await steerThread({ threadId: 'a' }, 'literal & $data\n😀', 'stable', { control }), expected);
  assert.deepEqual(calls, [['t3_thread_send', { threadId: 'a', message: 'literal & $data\n😀', mode: 'steer', clientRequestId: 'stable' }]]);
  assert.throws(() => steerThread({ threadId: 'a' }, ' ', 'stable', { control }), /引导内容/);
  const mismatch = async (_, action) => action(async () => ({ threadId: 'b', runId: 'r', delivery: 'steered' }));
  await assert.rejects(steerThread({ threadId: 'a' }, 'change', 'stable', { control: mismatch }), /不会自动重发/);
});

test('the control transport prevents read-only credentials from sending messages and still revokes them', async () => {
  const revoked = [], methods = [];
  const cli = async (_, args) => {
    if (args.includes('issue')) return JSON.stringify({ token: 'private', sessionId: 'session' });
    revoked.push(args); return '';
  };
  const fetchImpl = async (_, options) => {
    if (options.method === 'DELETE') return new Response('', { status: 200 });
    const request = JSON.parse(options.body); methods.push(request.method);
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18' } }),
      { headers: { 'mcp-session-id': 'transport' } });
  };
  await assert.rejects(withT3Control({}, call => call('t3_thread_send', { threadId: 'a', message: 'change', mode: 'steer' }),
    { cli, fetchImpl, readRuntime: () => ({ origin: 'http://127.0.0.1:3773' }) }), /write credential/);
  assert.equal(methods.includes('tools/call'), false);
  assert.deepEqual(revoked, [['auth', 'session', 'revoke', 'session']]);
});
