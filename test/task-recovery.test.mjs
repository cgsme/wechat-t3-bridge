import test from 'node:test';
import assert from 'node:assert/strict';
import { route, recover } from '../src/core.mjs';
import { executeCommand } from '../src/commands.mjs';
import { createScheduler } from '../src/scheduler.mjs';
import { sendToBackend, waitForThread } from '../src/backend.mjs';
import { recoverTypingTasks } from '../src/typing.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const thread = id => ({ threadId: id, projectId: 'p', title: `Thread ${id}`, link: `https://test/${id}`,
  providerInstanceId: 'codex', model: 'model', status: 'running', latestRunId: `run-${id}` });
const job = (id, text) => ({ id, command: route(text), status: 'pending', sent: 0 });

function harness(state = { jobs: [], seen: [] }, signal) {
  const rows = new Map(['a', 'b', 'created'].map(id => [id, thread(id)]));
  const sent = [], mutations = [], snapshots = [];
  const backend = { read: async config => rows.get(config.threadId), list: async () => [...rows.values()],
    send: async (config, text) => {
      mutations.push(['send', config.threadId, text]);
      return { threadId: config.threadId, runId: `run-${config.threadId}`, status: 'running' };
    },
    create: async () => { mutations.push(['create']); return { threadId: 'created', runId: 'run-created' }; },
    wait: async config => `result-${config.threadId}` };
  const config = { threadId: 'a' }, reference = thread('a');
  const save = () => snapshots.push(JSON.parse(JSON.stringify(state)));
  const scheduler = createScheduler({ state, config, reference, backend, save, signal,
    send: async (item, text, index) => sent.push([item.id, text, index]) });
  const tick = async () => { scheduler.tick(); await flush(); };
  const execute = (text, item = {}) => executeCommand({ command: route(text), state, config, reference, backend, save, job: item });
  return { state, rows, backend, sent, mutations, snapshots, scheduler, tick, execute };
}

test('a confirmed ordinary submission persists its run before waiting and only resumes reading after a bridge restart', async () => {
  const stopping = new AbortController();
  const h = harness(undefined, stopping.signal);
  let reads = 0, submissions = 0;
  h.backend.send = (config, text) => sendToBackend(config, text, { wait: false,
    call: async (_, args, options) => {
      submissions++;
      assert.equal(args.includes('--wait'), false);
      assert.equal(options.input, 'long task');
      return JSON.stringify({ threadId: 'a', runId: 'run-a', status: 'running' });
    } });
  h.backend.wait = (config, runId, options) => waitForThread(config, runId, { ...options, probe: () => 'alive',
    read: async () => { reads++; return { threadId: 'a', runId, status: 'running' }; } });
  h.state.jobs.push(job('one', 'long task'));
  await h.tick(); await h.tick();
  assert.equal(reads, 1);
  assert.equal(h.state.jobs[0].runId, 'run-a');
  assert.equal(h.state.jobs[0].waitOnly, true);
  const saved = h.snapshots.findLast(state => state.jobs[0]?.waitOnly);
  stopping.abort(); await flush();
  assert.equal(h.state.jobs[0].status, 'running');
  recover(saved);
  assert.equal(saved.jobs[0].status, 'pending');
  const resumed = harness(saved);
  resumed.backend.wait = async (_, id) => { assert.equal(id, 'run-a'); return 'eventual result'; };
  await resumed.tick(); await resumed.tick();
  assert.equal(submissions, 1);
  assert.equal(resumed.mutations.length, 0);
  assert.ok(resumed.sent.some(([, text]) => text.includes('eventual result')));
});

test('resuming a confirmed new task never recreates a thread or changes current routing', async () => {
  const state = { seen: [], routing: { threadId: 'b', projectId: 'p', listedIds: ['a', 'b'], projectThreads: {} },
    jobs: [{ ...job('new', '/new task'), status: 'running', bound: true, waitOnly: true,
      threadId: 'created', projectId: 'p', runId: 'run-created', createdThread: thread('created'),
      receiptChunks: ['receipt already sent'], receiptSent: 1,
      noticeChunks: ['creation already confirmed'], noticeSent: 1 }] };
  recover(state);
  const h = harness(state);
  await h.tick(); await h.tick();
  assert.equal(h.state.routing.threadId, 'b');
  assert.deepEqual(h.mutations, []);
  assert.ok(h.sent.some(([, text]) => text.includes('result-created')));
  assert.equal(h.sent.some(([, text]) => text.includes('already sent') || text.includes('already confirmed')), false);
});

test('an answered question resumes its confirmed run after restart without submitting the answer twice', async () => {
  const h = harness();
  h.state.pendingInputs = { a: { requestId: 'q', runId: 'run-a', questions: [{ id: 'q1', question: 'Continue?' }], answers: {} } };
  h.backend.pending = async () => ({ requestId: 'q', questions: [{ id: 'q1', question: 'Continue?' }] });
  let answers = 0;
  h.backend.respond = async () => { answers++; };
  h.backend.wait = async () => { throw Object.assign(new Error('shutdown'), { code: 'T3_WAIT_ABORTED' }); };
  const item = { ...job('answer', '/answer yes'), status: 'running' };
  h.state.jobs.push(item);
  await assert.rejects(h.execute('/answer yes', item), error => error.code === 'T3_WAIT_ABORTED');
  assert.equal(item.waitOnly, true);
  assert.equal(item.runId, 'run-a');
  const saved = JSON.parse(JSON.stringify(h.state));
  recover(saved);
  const resumed = harness(saved);
  await resumed.tick(); await resumed.tick();
  assert.equal(answers, 1);
  assert.deepEqual(resumed.mutations, []);
  assert.ok(resumed.sent.some(([, text]) => text.includes('result-a')));
});

test('lost tracking releases independent lanes and prevents following tasks in the uncertain thread from submitting', async () => {
  const h = harness();
  h.backend.wait = async config => {
    if (config.threadId === 'a') throw Object.assign(new Error('T3 process exited; original task not resubmitted'), { code: 'T3_SERVER_EXITED' });
    return 'other thread completed';
  };
  h.state.jobs.push(job('one', 'long task'), job('two', 'follow-up'), job('other', '/to b another task'));
  for (let i = 0; i < 5; i++) await h.tick();
  assert.deepEqual(h.mutations.map(([, id]) => id), ['a', 'b']);
  assert.ok(h.sent.some(([, text]) => text.includes('本条任务未提交')));
  assert.ok(h.sent.some(([, text]) => text.includes('other thread completed')));
  h.rows.get('a').status = 'completed';
  h.backend.wait = async () => 'new result';
  await h.execute('explicit next task');
  assert.equal(h.mutations.filter(([, id]) => id === 'a').length, 2);
  assert.equal(h.state.untrackedRuns.a, undefined);
});

test('an uncertain submission or crash before acknowledgement is never replayed and blocks automatic follow-ups', async () => {
  const h = harness();
  let submissions = 0;
  h.backend.send = async () => { submissions++; throw Object.assign(new Error('acknowledgement lost'), { code: 'T3_COMMAND_TIMEOUT' }); };
  await assert.rejects(h.execute('first task'));
  assert.match(await h.execute('following task'), /本条任务未提交/);
  assert.equal(submissions, 1);
  const state = { jobs: [{ ...job('crash', 'task'), status: 'running', threadId: 'a', projectId: 'p' }], seen: [] };
  recover(state);
  assert.equal(state.jobs[0].status, 'reply');
  assert.ok(state.untrackedRuns.a);
});

test('questions remain answerable after tracking was lost', async () => {
  const h = harness();
  h.state.untrackedRuns = { a: { runId: 'run-a' } };
  h.rows.get('a').status = 'waiting';
  const request = { requestId: 'q', questions: [{ id: 'q1', question: 'Continue?' }] };
  h.backend.pending = async () => request;
  h.backend.respond = async () => {};
  assert.match(await h.execute('/questions'), /Continue/);
  assert.equal(await h.execute('/answer yes'), 'result-a');
  assert.equal(h.state.untrackedRuns.a, undefined);
});

test('desktop confirmation notices are delivered once and the same task still returns its final result', async () => {
  const h = harness();
  let finish;
  const resumed = new Promise(resolve => { finish = resolve; });
  const statuses = ['waiting', 'waiting', 'running', 'completed'];
  h.backend.wait = (config, runId, options) => waitForThread(config, runId, { ...options, probe: () => 'alive',
    pause: async () => resumed, read: async () => ({ threadId: config.threadId, runId, status: statuses.shift(),
      approval: { id: 'permission', summary: '执行测试' }, reply: 'final result' }) });
  h.state.jobs.push(job('one', 'needs permission'));
  await h.tick(); await h.tick();
  assert.equal(h.sent.filter(([, text]) => text.includes('需要在 T3 处理权限确认')).length, 1);
  finish();
  for (let i = 0; i < 4; i++) await h.tick();
  assert.equal(h.sent.filter(([, text]) => text.includes('需要在 T3 处理权限确认')).length, 1);
  assert.equal(h.sent.filter(([, text]) => text.includes('final result')).length, 1);
  assert.equal(h.mutations.length, 1);
});

test('waiting submission receipts without questions keep tracking rather than ending with an instruction to open T3', async () => {
  const h = harness();
  h.backend.send = async () => ({ threadId: 'a', runId: 'run-a', status: 'waiting', request: null });
  h.state.jobs.push(job('one', 'task'));
  await h.tick(); await h.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0][1], /result-a/);
});

test('status explains unknown waiting, verified permissions and reconnection for the selected task', async () => {
  const h = harness();
  const item = { ...job('one', 'work'), threadId: 'a', status: 'running' };
  h.state.jobs.push(item);
  for (const [status, message] of [['waiting', /原因正在核实/], ['waiting_permission', /需要在 T3 处理权限确认/],
    ['reconnecting', /正在重连/]]) {
    item.trackingStatus = status;
    assert.match(await h.execute('/status'), message);
  }
});

test('resumable task recovery has one status owner and does not leave a second typing observer behind', () => {
  const state = { typingTasks: [{ threadId: 'a', runId: 'run-a' }], jobs: [
    { ...job('one', 'task'), status: 'running', waitOnly: true, threadId: 'a', runId: 'run-a' },
  ] };
  recoverTypingTasks(state);
  assert.deepEqual(state.typingTasks, []);
  recover(state);
  assert.equal(state.jobs[0].status, 'pending');
});
