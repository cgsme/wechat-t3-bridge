import test from 'node:test';
import assert from 'node:assert/strict';
import { WechatApi } from '../src/api.mjs';
import { ingest, recover } from '../src/core.mjs';
import { createScheduler } from '../src/scheduler.mjs';
import { createTypingIndicator, isRunningThread, recoverTypingTasks } from '../src/typing.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const thread = (threadId, status = 'running', extra = {}) => ({ threadId, status, projectId: 'project',
  title: `Name ${threadId}`, link: `https://test/${threadId}`, ...extra });

test('desktop activity never starts typing or causes project scans', async () => {
  const h = harness();
  h.rows([thread('desktop')]);
  h.state.routing = { projectId: 'project', projectThreads: { previous: 'old' } };
  await h.tick(); h.advance(5000); await h.tick();
  assert.equal(h.sends.length, 0);
  assert.equal(h.polls(), 0);
});

function harness() {
  const state = { jobs: [], seen: [], typingContext: 'owner-context' };
  const configs = [], sends = [], reports = [], saved = [];
  let clock = 0, rows = [], polls = 0;
  const api = {
    getConfig: async (owner, context) => { configs.push({ owner, context }); return { typing_ticket: `ticket-${configs.length}` }; },
    sendTyping: async (owner, ticket, active) => { sends.push({ owner, ticket, active }); },
  };
  const reads = [];
  const backend = { list: async () => { polls++; return rows; },
    read: async config => { reads.push(config.threadId); return rows.find(row => row.threadId === config.threadId); } };
  const indicator = createTypingIndicator({ state, config: { threadId: 'home' },
    backend, api, owner: 'owner', save: () => saved.push(structuredClone(state)),
    now: () => clock, status: value => reports.push(value) });
  return { state, api, backend, indicator, configs, sends, reports, reads, saved,
    rows: value => { rows = value; }, advance: ms => { clock += ms; },
    polls: () => polls, tick: async () => { indicator.tick(); await flush(); } };
}

test('typing uses authenticated owner config and wire statuses, allowing an empty sendtyping response', async () => {
  const calls = [];
  const api = new WechatApi({ token: 'private', fetchImpl: async (url, options) => {
    calls.push({ endpoint: url.pathname, ...options });
    return { ok: true, json: async () => ({ ret: 0, typing_ticket: 'ticket' }), text: async () => '' };
  } });
  const result = await api.getConfig('owner', 'context');
  await api.sendTyping('owner', result.typing_ticket, true);
  await api.sendTyping('owner', result.typing_ticket, false);
  await api.getConfig('owner');
  assert.deepEqual(calls.map(call => call.endpoint), [
    '/ilink/bot/getconfig', '/ilink/bot/sendtyping', '/ilink/bot/sendtyping', '/ilink/bot/getconfig',
  ]);
  const bodies = calls.map(call => JSON.parse(call.body));
  assert.equal(bodies[0].context_token, 'context');
  assert.equal(Object.hasOwn(bodies[3], 'context_token'), false);
  assert.deepEqual(bodies.slice(1, 3).map(body => body.status), [1, 2]);
  assert.ok(bodies.every(body => body.ilink_user_id === 'owner' && body.base_info.channel_version));
  assert.ok(calls.every(call => call.method === 'POST' && call.redirect === 'error'
    && call.headers.Authorization === 'Bearer private'));
});

test('typing business errors are rejected without exposing server response details', async () => {
  const api = new WechatApi({ token: 'private', fetchImpl: async () => ({ ok: true,
    text: async () => JSON.stringify({ ret: -8, errmsg: 'private response' }) }) });
  await assert.rejects(api.sendTyping('owner', 'ticket', true), error => error.code === -8 && !error.message.includes('private'));
});

test('latest typing context is persisted only for fresh accepted owner messages', () => {
  const state = { jobs: [], seen: [] };
  const message = (id, context, extra = {}) => ({ message_id: id, from_user_id: 'owner', message_type: 1,
    context_token: context, item_list: [{ type: 1, text_item: { text: 'hello' } }], ...extra });
  ingest(state, [message('1', 'old'), message('2', 'latest')], 'owner', 'cursor');
  ingest(state, [message('1', 'old'), message('3', 'other', { from_user_id: 'other' }),
    message('4', 'group', { group_id: 'group' }), message('5', 'bot', { message_type: 2 })], 'owner');
  assert.equal(state.typingContext, 'latest');
  assert.equal(state.jobs.length, 2);
});

test('typing refreshes across concurrent tasks and cancels only after the last task ends', async () => {
  const h = harness();
  h.state.jobs.push({ command: { kind: 'new' }, status: 'running', threadId: 'one' },
    { command: { kind: 'task' }, status: 'running', threadId: 'two' });
  await h.tick();
  assert.deepEqual(h.sends.map(call => call.active), [true]);
  h.state.jobs[0].status = 'reply';
  h.state.routing = { threadId: 'unrelated' };
  h.advance(1000); await h.tick();
  assert.equal(h.sends.length, 1);
  h.advance(4000); await h.tick();
  assert.deepEqual(h.sends.map(call => call.active), [true, true]);
  assert.equal(h.configs.length, 1);
  h.state.jobs[1].status = 'reply';
  await h.tick(); await h.tick();
  assert.deepEqual(h.sends.map(call => call.active), [true, true, false]);
  h.advance(5000); await h.tick();
  assert.equal(h.sends.length, 3);
  assert.ok(h.sends.every(call => call.owner === 'owner'));
});

test('only usable running top-level threads in the bound project count as activity', () => {
  for (const status of ['preparing', 'queued', 'starting', 'running']) assert.equal(isRunningThread(thread('a', status), 'project'), true);
  for (const status of ['waiting', 'completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']) {
    assert.equal(isRunningThread(thread('a', status), 'project'), false);
  }
  for (const extra of [{ projectId: 'other' }, { archived: true }, { parentThreadId: 'parent' },
    { relationshipToParent: 'subagent' }, { pendingRequestCount: 1 }]) {
    assert.equal(isRunningThread(thread('a', 'running', extra), 'project'), false);
  }
});

test('only saved WeChat tasks retain typing across restarts until their run ends', async () => {
  const h = harness();
  h.state.jobs.push({ command: { kind: 'task' }, status: 'running', threadId: 'recovered',
    projectId: 'project', runId: 'wechat-run' });
  recoverTypingTasks(h.state); recover(h.state);
  h.state.jobs = []; // The recovery notice has been delivered.
  Object.assign(h.state, JSON.parse(JSON.stringify(h.state)));
  recoverTypingTasks(h.state); // Another restart retains the saved tracker.
  h.rows([thread('desktop'), thread('recovered', 'running', { latestRunId: 'wechat-run' })]);
  await h.tick();
  assert.deepEqual(h.sends.map(call => call.active), [true]);
  assert.deepEqual(h.reads, ['recovered']);
  assert.equal(h.polls(), 0);
  h.rows([thread('desktop'), thread('recovered', 'running', { latestRunId: 'desktop-run' })]);
  h.advance(5000); await h.tick();
  assert.equal(h.sends.at(-1).active, false);
  assert.deepEqual(h.state.typingTasks, []);
  assert.deepEqual(h.saved.at(-1).typingTasks, []);
  h.advance(5000); await h.tick();
  assert.deepEqual(h.reads, ['recovered', 'recovered']);
});

test('recovery captures running WeChat tasks and creations without including controls or completed work', () => {
  const state = { jobs: [
    { command: { kind: 'new' }, status: 'running', createdThread: { threadId: 'new', projectId: 'other' }, runId: 'run' },
    { command: { kind: 'chat' }, status: 'running', threadId: 'legacy' },
    ...['threads', 'status', 'steer'].map(kind => ({ command: { kind }, status: 'running', threadId: kind })),
    { command: { kind: 'task' }, status: 'reply', threadId: 'done' },
    { command: { kind: 'new' }, status: 'running' },
  ] };
  recoverTypingTasks(state); recoverTypingTasks(state);
  assert.deepEqual(state.typingTasks.map(task => task.threadId), ['new', 'legacy']);
  assert.equal(state.typingTasks[0].projectId, 'other');
});

test('recovered tasks stop independently when completed or waiting, and late reads cannot restart after stop', async () => {
  const h = harness();
  h.state.typingTasks = ['one', 'two'].map(threadId => ({ threadId, projectId: 'project' }));
  h.rows([thread('one'), thread('two')]); await h.tick();
  h.rows([thread('one', 'completed'), thread('two')]);
  h.advance(5000); await h.tick();
  assert.deepEqual(h.state.typingTasks.map(task => task.threadId), ['two']);
  assert.equal(h.sends.at(-1).active, true);
  h.rows([thread('two', 'running', { pendingRequestCount: 1 })]);
  h.advance(5000); await h.tick();
  assert.equal(h.sends.at(-1).active, false);
  assert.deepEqual(h.saved.at(-1).typingTasks, []);

  const reading = deferred();
  h.state.typingTasks.push({ threadId: 'late' });
  h.backend.read = () => reading.promise;
  h.advance(5000); await h.tick();
  await h.indicator.stop();
  reading.resolve(thread('late')); await flush(); await h.tick();
  assert.equal(h.sends.at(-1).active, false);
});

test('idle controls and undelivered results do not start typing or flood the config endpoint', async () => {
  const h = harness();
  h.state.jobs.push({ command: { kind: 'threads' }, status: 'running' },
    { command: { kind: 'task' }, status: 'reply' });
  await h.tick(); await h.tick(); h.advance(5000); await h.tick();
  assert.equal(h.sends.length, 0);
  assert.equal(h.configs.length, 0);
  assert.equal(h.polls(), 0);
  h.state.jobs.push({ command: { kind: 'task' }, status: 'pending' });
  await h.tick();
  assert.equal(h.sends.at(-1).active, true);
});

test('reply delivery renews typing immediately when another thread remains active', async () => {
  const h = harness();
  h.state.jobs.push({ command: { kind: 'task' }, status: 'running' }); await h.tick();
  h.advance(100); h.indicator.replySent(); await h.tick();
  assert.deepEqual(h.sends.map(call => call.active), [true, true]);
  await h.tick(); assert.equal(h.sends.length, 2);
});

test('an outgoing reply during a typing request still triggers a refresh', async () => {
  const h = harness(), response = deferred();
  h.state.jobs.push({ command: { kind: 'task' }, status: 'running' });
  const send = h.api.sendTyping;
  h.api.sendTyping = async (...args) => { await send(...args); await response.promise; };
  await h.tick();
  h.indicator.replySent();
  response.resolve(); await flush(); await h.tick();
  assert.deepEqual(h.sends.map(call => call.active), [true, true]);
});

test('ticket failures back off, refresh the ticket and recover without leaking details', async () => {
  const h = harness();
  h.state.jobs.push({ command: { kind: 'task' }, status: 'running' });
  const send = h.api.sendTyping;
  h.api.sendTyping = async (...args) => { await send(...args); throw new Error('sensitive ticket'); };
  await h.tick(); await h.tick();
  assert.equal(h.configs.length, 1);
  h.api.sendTyping = send;
  h.advance(4999); await h.tick(); assert.equal(h.sends.length, 1);
  h.advance(1); await h.tick();
  assert.equal(h.configs.length, 2);
  assert.equal(h.sends.at(-1).ticket, 'ticket-2');
  assert.equal(h.reports.findLast(report => Object.hasOwn(report, 'typingError')).typingError, null);
  assert.equal(JSON.stringify(h.reports).includes('sensitive'), false);
});

test('missing tickets retry later; changing context or aging a ticket renews config', async () => {
  const h = harness();
  h.state.jobs.push({ command: { kind: 'task' }, status: 'running', context: 'old' });
  const config = h.api.getConfig;
  h.api.getConfig = async () => ({});
  await h.tick(); assert.equal(h.sends.length, 0);
  h.api.getConfig = config;
  h.advance(5000); await h.tick();
  assert.equal(h.configs.length, 1);
  h.state.typingContext = 'new-context';
  h.advance(5000); await h.tick();
  assert.equal(h.configs.at(-1).context, 'new-context');
  h.advance(5 * 60000); await h.tick();
  assert.equal(h.configs.length, 3);
});

test('a task finishing during config retrieval does not send a late typing start', async () => {
  const h = harness(), config = deferred();
  h.state.jobs.push({ command: { kind: 'task' }, status: 'running' });
  h.api.getConfig = () => config.promise;
  await h.tick();
  h.state.jobs[0].status = 'reply';
  config.resolve({ typing_ticket: 'ticket' }); await flush(); await h.tick();
  assert.equal(h.sends.length, 0);
});

test('stop cancels an in-flight typing start and never restarts on later ticks', async () => {
  const h = harness(), response = deferred();
  h.state.jobs.push({ command: { kind: 'task' }, status: 'running' });
  const send = h.api.sendTyping;
  h.api.sendTyping = async (...args) => { await send(...args); if (args[2]) await response.promise; };
  await h.tick();
  const closing = h.indicator.stop();
  response.resolve(); await closing;
  await h.indicator.stop(); h.advance(6000); await h.tick();
  assert.deepEqual(h.sends.map(call => call.active), [true, false]);
});

test('a timed-out typing start is still cancelled when work ends, and failed cancels retry', async () => {
  const h = harness();
  h.state.jobs.push({ command: { kind: 'task' }, status: 'running' });
  const send = h.api.sendTyping;
  h.api.sendTyping = async (...args) => { await send(...args); throw new Error('timeout'); };
  await h.tick();
  h.state.jobs[0].status = 'reply'; h.advance(5000); await h.tick();
  h.api.sendTyping = send;
  h.advance(5000); await h.tick();
  assert.deepEqual(h.sends.map(call => call.active), [true, false, false]);
});

test('failed recovery reads preserve saved WeChat activity and retry without project scans', async () => {
  const h = harness();
  h.state.typingTasks = [{ threadId: 'recovered', projectId: 'project' }];
  h.rows([thread('recovered')]); await h.tick();
  const read = h.backend.read;
  h.backend.read = async () => { throw new Error('sensitive diagnostics'); };
  h.advance(5000); await h.tick();
  assert.ok(h.sends.every(call => call.active));
  assert.ok(h.reports.some(report => report.activityError));
  h.backend.read = read; h.rows([thread('recovered', 'completed')]);
  h.advance(5000); await h.tick();
  assert.equal(h.sends.at(-1).active, false);
  assert.equal(h.polls(), 0);
  assert.equal(JSON.stringify(h.reports).includes('sensitive'), false);
});

test('slow typing requests do not block independent scheduler lanes', async () => {
  const h = harness(), config = deferred();
  const tasks = [deferred(), deferred()], starts = [], replies = [];
  h.api.getConfig = () => config.promise;
  h.backend.read = async c => thread(c.threadId);
  h.backend.send = async c => { starts.push(c.threadId); return tasks[starts.length - 1].promise; };
  h.state.routing = { threadId: 'one', listedIds: [] };
  h.state.jobs.push(...['one', 'two'].map((threadId, i) => ({ id: String(i), context: 'context',
    threadId, bound: true, command: { kind: 'task', text: 'work' }, status: 'pending', sent: 0 })));
  const scheduler = createScheduler({ state: h.state, config: { threadId: 'one' }, reference: { projectId: 'project' },
    backend: h.backend, save: () => {}, send: async (job, text) => { replies.push(job.id); h.indicator.replySent(); } });
  scheduler.tick(); await h.tick();
  assert.deepEqual(starts, ['one', 'two']);
  tasks[1].resolve('second done'); await flush(); scheduler.tick(); await h.tick();
  assert.deepEqual(replies, ['1']);
  assert.equal(h.state.jobs[0].status, 'running');
  config.resolve({ typing_ticket: 'ticket' }); await flush();
  await h.tick(); assert.equal(h.sends.at(-1).active, true);
  tasks[0].resolve('first done'); await flush(); scheduler.tick(); await h.tick();
  assert.deepEqual(replies, ['1', '0']);
  assert.equal(h.sends.at(-1).active, false);
});
