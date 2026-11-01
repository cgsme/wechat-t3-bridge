import test from 'node:test';
import assert from 'node:assert/strict';
import { route, recover, threadInfo, threadLabel, HELP, HELP_EN } from '../src/core.mjs';
import { executeCommand, resolveSelector } from '../src/commands.mjs';
import { createScheduler } from '../src/scheduler.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const thread = id => ({ threadId: id, projectId: 'project', title: `Name ${id}`, link: `https://test/${id}`,
  status: 'completed', providerInstanceId: 'codex', model: 'model', latestRunId: 'run' });

function harness() {
  const state = { jobs: [], seen: [], routing: { threadId: 'a', threadInfo: threadInfo(thread('a')), listedIds: ['a', 'b', 'mcp:abc'] } };
  const rows = new Map(['a', 'b', 'mcp:abc'].map(id => [id, thread(id)]));
  const sends = [], results = [], pending = [];
  const backend = {
    list: async () => [...rows.values()], read: async config => rows.get(config.threadId),
    send: async (config, text) => { sends.push([config.threadId, text]); return 'done'; },
  };
  const execute = (text, job = {}) => executeCommand({ command: route(text), state, config: { threadId: 'a' },
    reference: { projectId: 'project' }, backend, save() {}, job });
  const scheduler = createScheduler({ state, config: { threadId: 'a' }, reference: { projectId: 'project' },
    backend, save() {}, send: async (job, text) => results.push([job.id, text]) });
  const add = text => { const job = { id: String(state.jobs.length + state.seen.length + 1), command: route(text),
    context: 'owner-context', status: 'pending', sent: 0 }; state.jobs.push(job); return job; };
  const slow = () => { backend.send = async (config, text) => {
    sends.push([config.threadId, text]); const task = deferred(); pending.push(task); return task.promise;
  }; };
  return { state, rows, backend, sends, results, pending, add, execute, slow,
    tick: async () => { scheduler.tick(); await flush(); } };
}

test('/to parses numbers, namespaced IDs, prefixes and home with only the task body', () => {
  for (const selector of ['2', 'mcp:abc-123', 'abc', 'home']) {
    assert.deepEqual(route(`/TO ${selector} 检查任务\n第二行 & $literal`), {
      kind: 'task', selector, text: '检查任务\n第二行 & $literal',
    });
  }
  assert.deepEqual(route('/to 2 /task check this'), { kind: 'task', selector: '2', text: 'check this' });
  assert.deepEqual(route('/to 2 /questions'), { kind: 'questions', selector: '2' });
  assert.deepEqual(route('/to 2 /answer 1,2'), { kind: 'answer', selector: '2', text: '1,2' });
  assert.deepEqual(route('/switch mcp:abc'), { kind: 'switch', selector: 'mcp:abc' });
  for (const input of ['/to', '/to 2', '/to 2 /switch home', '/to 2 /new test', '/to 2 /model x',
    '/to 2 /help', '/to 2 /to 3 nested', '/to @invalid work', '/toast work']) {
    assert.equal(route(input).kind, 'help');
  }
  assert.ok(HELP.includes('/to <编号|ID前缀|home>'));
  assert.ok(HELP_EN.includes('/to <number|id|prefix|home>'));
});

test('direct tasks use saved numbering, exact IDs and home without changing selection or numbering', async () => {
  const h = harness();
  // Deliberately reorder the backend; saved numbering must win.
  h.backend.list = async () => [h.rows.get('mcp:abc'), h.rows.get('a'), h.rows.get('b')];
  const routing = structuredClone(h.state.routing);
  for (const selector of ['2', 'b', 'mcp:ab', 'mcp:abc', 'home']) {
    const job = {};
    assert.equal(await h.execute(`/to ${selector} 原文\nsecond line`, job), 'done');
    const expected = selector === 'home' ? 'a' : selector.startsWith('mcp:') ? 'mcp:abc' : 'b';
    assert.equal(job.threadId, expected);
    assert.equal(job.replyThread.title, `Name ${expected}`);
    assert.deepEqual(h.sends.at(-1), [expected, '原文\nsecond line']);
    assert.deepEqual(h.state.routing, routing);
  }
  assert.equal(resolveSelector('abc', [], [{ threadId: 'abc' }, { threadId: 'abc-more' }], 'a'), 'abc');
});

test('invalid or unavailable direct targets never fall back to the selected thread', async () => {
  for (const selector of ['99', 'missing', 'mcp:']) {
    const h = harness(); h.rows.set('mcp:another', thread('mcp:another'));
    await assert.rejects(h.execute(`/to ${selector} task`));
    assert.deepEqual(h.sends, []);
    assert.equal(h.state.routing.threadId, 'a');
  }
  for (const extra of [{ projectId: 'other' }, { archived: true }, { relationshipToParent: 'subagent' }]) {
    const h = harness(); h.rows.set('b', { ...thread('b'), ...extra });
    for (const selector of ['2', 'b']) await assert.rejects(h.execute(`/to ${selector} task`));
    assert.deepEqual(h.sends, []);
    assert.equal(h.state.routing.threadId, 'a');
  }
  const h = harness(); h.backend.read = async () => thread('a');
  await assert.rejects(h.execute('/to b task'), /目标线程校验失败/);
  assert.deepEqual(h.sends, []);
});

test('direct tasks and ordinary tasks share ordered thread lanes while other targets run concurrently', async () => {
  const h = harness(); h.slow();
  const first = h.add('/to 2 b-first');
  const second = h.add('/to b b-second');
  const ordinary = h.add('a-first');
  h.add('/to mcp:abc third-thread');
  await h.tick(); await h.tick();
  assert.deepEqual(h.sends, [['b', 'b-first'], ['a', 'a-first'], ['mcp:abc', 'third-thread']]);
  assert.equal(second.status, 'pending');
  assert.equal(ordinary.threadId, 'a');
  assert.equal(h.state.routing.threadId, 'a');
  // A list refresh and a switch must not retarget the queued /to 2 task.
  h.state.routing.listedIds = ['mcp:abc', 'a', 'b'];
  h.state.routing.threadId = 'mcp:abc';
  h.pending[0].resolve('first done'); await flush(); await h.tick();
  assert.deepEqual(h.sends.at(-1), ['b', 'b-second']);
  assert.ok(h.results.find(([id]) => id === first.id)[1].startsWith(threadLabel({ ...thread('b'), number: 3 }) + '\n\n'));
  h.pending[1].resolve('ordinary done'); h.pending[2].resolve('third done'); h.pending[3].resolve('second done');
  await flush(); await h.tick();
  assert.deepEqual(h.results.filter(([id]) => [first.id, second.id].includes(id)).map(([id]) => id), [first.id, second.id]);
});

test('a direct task to the selected thread queues behind an ordinary task', async () => {
  const h = harness(); h.slow();
  h.add('first'); h.add('/to home second'); h.add('/to b parallel');
  await h.tick(); await h.tick();
  assert.deepEqual(h.sends, [['a', 'first'], ['b', 'parallel']]);
  h.pending[0].resolve('first done'); await flush(); await h.tick();
  assert.deepEqual(h.sends.at(-1), ['a', 'second']);
  h.pending[1].resolve('parallel done'); h.pending[2].resolve('second done'); await flush(); await h.tick();
});

test('failed target resolution releases the dispatcher and replies without launching work there', async () => {
  const h = harness();
  const failed = h.add('/to missing task'); h.add('/status'); h.add('/to b valid');
  await h.tick(); await h.tick();
  assert.deepEqual(h.sends, [['b', 'valid']]);
  assert.ok(h.results.some(([id, text]) => id === failed.id && text.includes('Thread not found')));
  assert.ok(h.results.some(([, text]) => text.includes('微信已连接')));
  assert.equal(h.state.routing.threadId, 'a');
});

test('persisted direct targets survive restart, and uncertain running tasks are never replayed', async () => {
  const h = harness();
  const saved = h.add('/to 2 saved');
  Object.assign(saved, { threadId: 'b', bound: true, replyThread: threadInfo(thread('b')) });
  h.state.routing.listedIds = ['mcp:abc', 'a', 'b'];
  h.state.routing.threadId = 'mcp:abc';
  recover(h.state); await h.tick(); await h.tick();
  assert.deepEqual(h.sends, [['b', 'saved']]);
  const running = h.add('/to 2 uncertain');
  Object.assign(running, { status: 'running', bound: true, threadId: 'b', replyThread: threadInfo(thread('b')) });
  recover(h.state); await h.tick();
  assert.deepEqual(h.sends, [['b', 'saved']]);
  assert.ok(h.results.some(([id, text]) => id === running.id && text.includes('不会自动重跑')
    && text.startsWith(threadLabel({ ...thread('b'), number: 3 }) + '\n\n')));
});

test('/to can view and answer another thread question without affecting current selection or drafts', async () => {
  const h = harness();
  const request = { requestId: 'req-b', questions: [{ id: 'choice', question: 'Choose',
    options: [{ label: 'one' }, { label: 'two' }] }] };
  const calls = [];
  const homeDraft = { requestId: 'req-a', questions: [], answers: {} };
  h.state.pendingInputs = { a: structuredClone(homeDraft) };
  h.backend.pending = async config => { assert.equal(config.threadId, 'b'); return request; };
  h.backend.respond = async (config, id, answers) => calls.push([config.threadId, id, answers]);
  h.backend.wait = async config => { assert.equal(config.threadId, 'b'); return 'resumed b'; };
  const job = {};
  const prompt = await h.execute('/to 2 /questions', job);
  assert.match(prompt, /Choose/);
  assert.match(prompt, /线程序号：2️⃣/);
  assert.match(prompt, /定向回答：\/to 2 \/answer 1/);
  assert.equal(job.replyThread.threadId, 'b');
  assert.equal(await h.execute('/to 2 /answer 2'), 'resumed b');
  assert.deepEqual(calls, [['b', 'req-b', { choice: ['two'] }]]);
  assert.deepEqual(h.state.pendingInputs.a, homeDraft);
  assert.equal(h.state.routing.threadId, 'a');
  assert.deepEqual(h.sends, []);
});

test('targeted Fast controls bypass a busy task lane and the next task retains the intended target', async () => {
  const h = harness(); h.slow();
  const changes = [];
  h.backend.setFast = async (config, enabled) => {
    changes.push([config.threadId, enabled]);
    return { threadId: config.threadId, fast: { supported: true, enabled },
      modelSelection: { instanceId: 'codex', model: 'model' } };
  };
  h.add('/to b long task'); await h.tick(); await h.tick();
  const fast = h.add('/to 2 /fast on');
  const later = h.add('/to b later task');
  await h.tick(); await h.tick();
  assert.deepEqual(changes, [['b', true]]);
  assert.equal(h.state.jobs.find(job => job.command.text === 'long task').status, 'running');
  assert.ok(h.results.some(([id, text]) => id === fast.id && text.includes('Fast：⚡ 已开启')
    && text.startsWith(threadLabel({ ...thread('b'), number: 2 }) + '\n\n')));
  assert.equal(later.threadId, 'b');
  assert.equal(later.status, 'pending');
  assert.equal(h.state.routing.threadId, 'a');
  h.pending[0].resolve('long task done'); await flush(); await h.tick();
  assert.deepEqual(h.sends, [['b', 'long task'], ['b', 'later task']]);
  h.pending[1].resolve('later done'); await flush(); await h.tick();
});
