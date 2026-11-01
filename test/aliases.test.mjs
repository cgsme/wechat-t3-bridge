import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_ALIASES, HELP, HELP_EN, route, threadLabel } from '../src/core.mjs';
import { executeCommand } from '../src/commands.mjs';
import { createScheduler } from '../src/scheduler.mjs';

test('all short commands match their full commands with the same arguments', () => {
  const args = { help: ['', ' en'], task: [' check memory\nsecond line'], new: [' create a file'],
    projects: [''], project: ['', ' 2', ' Empty Project'], threads: [''], switch: [' 2', ' mcp:abc', ' home'],
    history: ['', ' 2'], status: [''], models: ['', ' gpt'], model: ['', ' codex::model'],
    fast: ['', ' on', ' off'], questions: [''], answer: [' 1,2', ' original\nsecond line'], cost: ['', ' 7d'], token: ['', ' 30d'], limit: [''] };
  for (const [alias, command] of Object.entries(COMMAND_ALIASES)) {
    for (const tail of args[command]) assert.deepEqual(route('/' + alias + tail), route('/' + command + tail));
    assert.deepEqual(route('/' + alias.toUpperCase() + args[command][0]), route('/' + command + args[command][0]));
    for (const manual of [HELP, HELP_EN]) assert.ok(manual.includes('/' + alias), `Missing alias /${alias}`);
  }
  assert.match(HELP, /\/threads  \(\/t, \/ts[,)]/);
  assert.ok(HELP_EN.includes('/threads  (/t, /ts)'));
});

test('only exact slash command names expand; ordinary text and task bodies remain intact', () => {
  for (const text of ['t', 'ts', 'h', 'f on', 'please use /ts', 'ask /a about /m']) {
    assert.deepEqual(route(text), { kind: 'task', text });
  }
  for (const text of ['/tfoo', '/ts2', '/t/extra', '/f:on', '/ping', '/start']) assert.equal(route(text).kind, 'help');
  assert.deepEqual(route('/n Write /ts in a file\n/a is literal'), { kind: 'new', text: 'Write /ts in a file\n/a is literal' });
  assert.deepEqual(route('/tk Explain /f on'), { kind: 'task', text: 'Explain /f on' });
  assert.deepEqual(route('/a /ts'), { kind: 'answer', text: '/ts' });
});

test('aliases work inside task wrappers and target controls without relaxing target restrictions', () => {
  for (const wrapper of ['task', 'tk', 'new', 'n']) {
    for (const command of ['ts', 't', 's', 'h en', 'p 2', 'ps', 'sw home', 'his 2', 'ms gpt', 'm codex::model', 'f on', 'q']) {
      assert.deepEqual(route(`/${wrapper} /${command}`), route('/' + command));
    }
  }
  for (const [short, long] of [['f on', 'fast on'], ['f', 'fast'], ['a 2', 'answer 2'], ['q', 'questions'],
    ['qs', 'questions'], ['st', 'status'], ['his 2', 'history 2'], ['tk work', 'task work']]) {
    assert.deepEqual(route('/to 2 /' + short), route('/to 2 /' + long));
  }
  for (const command of ['n task', 'sw home', 'p 2', 'm other', 'ts', 'h']) {
    assert.equal(route('/to 2 /' + command).kind, 'help');
  }
});

test('/t and /ts refresh the same saved thread numbers and preserve the selected thread', async () => {
  const threads = ['a', 'b'].map(threadId => ({ threadId, title: threadId, projectId: 'p', link: `https://test/${threadId}` }));
  const state = { jobs: [], routing: { threadId: 'a', listedIds: [] } };
  const backend = { list: async () => threads, read: async target => threads.find(thread => thread.threadId === target.threadId) };
  const execute = text => executeCommand({ command: route(text), state, config: { threadId: 'a' },
    reference: { projectId: 'p' }, backend, save() {}, job: {} });
  for (const command of ['/t', '/ts', '/n /ts', '/tk /t']) {
    const result = await execute(command);
    assert.match(result, /线程列表/);
    assert.deepEqual(state.routing.listedIds, ['a', 'b']);
    assert.equal(state.routing.threadId, 'a');
  }
  await execute('/sw 2');
  assert.equal(state.routing.threadId, 'b');
});

test('a targeted Fast alias runs as a control and never becomes a model task or a new thread', async () => {
  const threads = ['a', 'b'].map(threadId => ({ threadId, title: threadId, projectId: 'p', link: `https://test/${threadId}` }));
  const state = { jobs: [{ id: 'job', status: 'pending', command: route('/to 2 /f on'), sent: 0 }], seen: [],
    routing: { threadId: 'a', listedIds: ['a', 'b'] } };
  const writes = [], replies = [];
  const scheduler = createScheduler({ state, config: { threadId: 'a' }, reference: { projectId: 'p' },
    backend: { list: async () => threads, read: async target => threads.find(thread => thread.threadId === target.threadId),
      setFast: async (target, enabled) => { writes.push([target.threadId, enabled]); return { threadId: target.threadId,
        modelSelection: { instanceId: 'codex', model: 'model' }, fast: { supported: true, enabled } }; } },
    save() {}, send: async (job, reply) => replies.push(reply) });
  scheduler.tick(); await new Promise(resolve => setImmediate(resolve)); scheduler.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [['b', true]]);
  assert.equal(state.routing.threadId, 'a');
  assert.ok(replies[0].startsWith(threadLabel({ ...threads[1], number: 2 }) + '\n\n'));
  assert.match(replies[0], /Fast：⚡ 已开启/);
});
