import test from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/core.mjs';
import { executeCommand } from '../src/commands.mjs';
import { waitForThread, sendToBackend } from '../src/backend.mjs';
import { readPendingRequest, respondToRequest } from '../src/t3-control.mjs';
import { createScheduler } from '../src/scheduler.mjs';
import { rememberQuestion } from '../src/questions.mjs';

const request = { requestId: 'req-1', questions: [
  { id: 'color', header: 'Color', question: '请选择颜色', options: [
    { label: '红色', description: '暖色' }, { label: '蓝色', description: '冷色' }], allowCustomAnswer: true },
] };
function harness() {
  const thread = { threadId: 'a', projectId: 'p', title: 'A', link: 'https://test/a', latestRunId: 'run', pendingRequestCount: 0 };
  const state = { jobs: [], seen: [], routing: { threadId: 'a', listedIds: [] } };
  let live = structuredClone(request);
  const calls = [];
  const backend = {
    read: async config => ({ ...thread, threadId: config.threadId, link: `https://test/${config.threadId}` }),
    pending: async config => { calls.push(['pending', config.threadId]); return live; },
    respond: async (config, id, answers) => { calls.push(['respond', config.threadId, id, answers]); live = null; },
    send: async config => { calls.push(['send', config.threadId]); return { status: 'waiting', runId: 'run', request: live }; },
    wait: async config => { calls.push(['wait', config.threadId]); return '任务完成'; },
  };
  const execute = (text, job = {}) => executeCommand({ command: route(text), state,
    config: { threadId: 'a' }, reference: { projectId: 'p' }, backend, save() {}, job });
  return { state, thread, calls, backend, execute, setLive: value => { live = value; } };
}

test('question commands parse without becoming new prompts', () => {
  assert.deepEqual(route('/questions'), { kind: 'questions' });
  assert.deepEqual(route('/answer 2'), { kind: 'answer', text: '2' });
  assert.deepEqual(route('/answer /path with spaces\n第二行'), { kind: 'answer', text: '/path with spaces\n第二行' });
});

test('questions include the saved thread number and a usable direct-answer command without renumbering', async () => {
  const h = harness();
  h.state.routing.listedIds = ['other', 'a'];
  const before = structuredClone(h.state.routing);
  const reply = await h.execute('/questions');
  assert.match(reply, /线程序号：2️⃣（当前项目）/);
  assert.match(reply, /定向回答：\/to 2 \/answer 1/);
  assert.match(reply, /定向查看：\/to 2 \/questions/);
  assert.match(reply, /2️⃣ 蓝色/);
  assert.deepEqual(h.state.routing.listedIds, before.listedIds);
  assert.equal(h.state.routing.threadId, before.threadId);
  assert.deepEqual(h.calls, [['pending', 'a']]);
});

test('later questions and rediscovered questions use the latest list, including after restart', async () => {
  const h = harness();
  h.state.routing.listedIds = ['other', 'a'];
  h.setLive({ ...request, questions: [...request.questions, { id: 'notes', question: '补充说明', options: [] }] });
  assert.match(await h.execute('/questions'), /线程序号：2️⃣/);
  h.state.routing.listedIds = ['a', 'other'];
  Object.assign(h.state, JSON.parse(JSON.stringify(h.state)));
  const reply = await h.execute('/answer 1');
  assert.match(reply, /线程序号：1️⃣/);
  assert.match(reply, /定向回答：\/to 1 \/answer <补充内容>/);
  assert.match(reply, /待回答 · 2️⃣\/2️⃣/);
  assert.match(await h.execute('/questions'), /线程序号：1️⃣/);
  assert.equal(h.calls.some(call => call[0] === 'respond'), false);
});

test('unlisted threads append a usable number without changing earlier numbers', async () => {
  const h = harness(); h.state.routing.listedIds = ['other'];
  const reply = await h.execute('/questions');
  assert.match(reply, /线程序号：2️⃣/);
  assert.match(reply, /定向回答：\/to 2 \/answer 1/);
  assert.deepEqual(h.state.routing.listedIds, ['other', 'a']);
  h.state.routing.listedIds = ['other', 'a'];
  assert.match(await h.execute('/questions'), /定向回答：\/to 2 \/answer 1/);
});

test('background questions from another project do not borrow current project numbering', () => {
  const h = harness();
  h.state.routing.projectId = 'different-project';
  h.state.routing.listedIds = ['a'];
  const reply = rememberQuestion(h.state, h.thread, { request, runId: 'run' }, () => {});
  assert.match(reply, /线程序号：1️⃣（所属项目）/);
  assert.match(reply, /先选择所属项目：\/project p/);
  assert.match(reply, /定向回答：\/to a \/answer 1/);
  assert.doesNotMatch(reply, /线程序号：1️⃣（当前项目）/);
  assert.equal(h.state.routing.projectId, 'different-project');
});

test('a task displays the actual question, then plain WeChat text answers the same request and resumes the run', async () => {
  const h = harness();
  const question = await h.execute('/task 开始');
  assert.match(question, /请选择颜色/);
  assert.match(question, /2️⃣ 蓝色/);
  assert.ok(question.startsWith('1️⃣ A（a）\n\n'));
  assert.doesNotMatch(question, /https?:\/\/|Thread:|ID:/);
  assert.equal(await h.execute('2'), '任务完成');
  assert.deepEqual(h.calls.filter(call => call[0] === 'respond'), [['respond', 'a', 'req-1', { color: ['蓝色'] }]]);
  assert.equal(h.calls.filter(call => call[0] === 'send').length, 1);
  assert.deepEqual(h.calls.at(-1), ['wait', 'a']);
});

test('multi-question drafts persist across restart and only submit once all answers are supplied', async () => {
  const h = harness();
  h.setLive({ ...request, questions: [...request.questions,
    { id: 'notes', header: 'Notes', question: '补充说明', options: [] }] });
  await h.execute('/questions');
  assert.match(await h.execute('/answer 1'), /补充说明/);
  assert.equal(h.calls.some(call => call[0] === 'respond'), false);
  const persisted = JSON.parse(JSON.stringify(h.state));
  Object.assign(h.state, persisted);
  await h.execute('/answer 中文 & $(test)\n第二行');
  assert.deepEqual(h.calls.find(call => call[0] === 'respond')[3], { color: ['红色'], notes: ['中文 & $(test)\n第二行'] });
});

test('expired requests never become a new AI task or receive an answer intended for an older request', async () => {
  for (const live of [null, { ...request, requestId: 'replacement' }]) {
    const h = harness();
    await h.execute('/questions');
    h.setLive(live);
    assert.match(await h.execute('2'), /已失效|已变化/);
    assert.equal(h.calls.some(call => ['send', 'respond', 'wait'].includes(call[0])), false);
  }
});

test('messages queued before the question are not misinterpreted as answers with either task spelling', async () => {
  const h = harness();
  await h.execute('/questions');
  for (const text of ['2', '/task 2']) {
    assert.match(await h.execute(text, { receivedAt: '2000-01-01T00:00:00.000Z' }), /未作为答案或新任务提交/);
  }
  assert.equal(h.calls.some(call => ['send', 'respond'].includes(call[0])), false);
});

test('plain text and /task both answer the displayed request and resume the original task', async () => {
  for (const text of ['2', '/task 2']) {
    const h = harness();
    await h.execute('/questions');
    assert.equal(await h.execute(text), '任务完成');
    assert.deepEqual(h.calls.find(call => call[0] === 'respond'), ['respond', 'a', 'req-1', { color: ['蓝色'] }]);
    assert.equal(h.calls.some(call => call[0] === 'send'), false);
  }
});

test('question drafts are isolated by selected thread and can be rediscovered after restart', async () => {
  const h = harness();
  await h.execute('/questions');
  h.state.routing.threadId = 'b';
  assert.match(await h.execute('/answer 2'), /先.*questions/);
  assert.equal(h.calls.some(call => call[0] === 'respond'), false);
  h.state.routing.threadId = 'a';
  await h.execute('/answer 2');
  assert.equal(h.calls.find(call => call[0] === 'respond')[1], 'a');
});

test('nonblocking pending questions end the background wait so the thread lane can accept an answer', async () => {
  const result = await waitForThread({ threadId: 'a' }, 'run', {
    call: async () => JSON.stringify({ thread: { threadId: 'a', latestRunId: 'run', status: 'running', pendingRequestCount: 1 } }),
    pending: async () => request,
    pause: async () => { throw new Error('blocked waiting for an answer'); },
  });
  assert.equal(result.request.requestId, 'req-1');
});

test('send reads structured waiting output instead of discarding it', async () => {
  const result = await sendToBackend({ threadId: 'a' }, 'task', {
    call: async (_, args, options) => {
      assert.ok(args.includes('--json'));
      assert.equal(options.input, 'task');
      return JSON.stringify({ threadId: 'a', runId: 'run', status: 'waiting', reply: null });
    }, pending: async () => request,
  });
  assert.equal(result.request.requestId, 'req-1');
});

test('multiple choices and invalid option numbers preserve the draft until a valid answer arrives', async () => {
  const h = harness();
  h.setLive({ ...request, questions: [{ ...request.questions[0], multiSelect: true, allowCustomAnswer: false }] });
  await h.execute('/questions');
  await assert.rejects(h.execute('/answer 3'), /编号无效/);
  await assert.rejects(h.execute('/answer 紫色'), /选项中选择/);
  await h.execute('/answer 1，2,1');
  assert.deepEqual(h.calls.find(call => call[0] === 'respond')[3], { color: ['红色', '蓝色'] });
});

test('uncertain submissions are not replayed; a fresh read lets the user explicitly answer again', async () => {
  const h = harness();
  h.backend.respond = async () => { h.calls.push(['respond']); throw new Error('lost connection'); };
  await h.execute('/questions');
  assert.match(await h.execute('2'), /提交状态未确认/);
  assert.match(await h.execute('2'), /不会自动重复提交/);
  assert.equal(h.calls.filter(call => call[0] === 'respond').length, 1);
  assert.match(await h.execute('/questions'), /请选择颜色/);
  await h.execute('/answer 2');
  assert.equal(h.calls.filter(call => call[0] === 'respond').length, 2);
});

test('the local control adapter lists and reads exact request IDs, then submits question-ID keyed answers with write authorization', async () => {
  const calls = [];
  const control = async (config, action, options) => {
    assert.equal(config.threadId, 'a');
    calls.push(['access', options?.write || false]);
    return action(async (tool, args) => {
      calls.push([tool, args]);
      if (args.action === 'list') return { requestIds: ['req-1'] };
      if (args.action === 'read') return request;
      return { sequence: 42 };
    });
  };
  assert.deepEqual(await readPendingRequest({ threadId: 'a' }, { control }), request);
  assert.deepEqual(await respondToRequest({ threadId: 'a' }, 'req-1', { color: ['蓝色'] }, { control }), { sequence: 42 });
  assert.deepEqual(calls[0], ['access', false]);
  assert.deepEqual(calls[3], ['access', true]);
  assert.deepEqual(calls.at(-1), ['t3_pending_request', { action: 'respond', threadId: 'a', requestId: 'req-1', answers: { color: ['蓝色'] } }]);
  await assert.rejects(respondToRequest({ threadId: 'a' }, 'stale', { color: ['蓝色'] }, { control }), /已变化/);
});

test('the scheduler delivers a /new question and accepts the WeChat answer without deadlocking its thread lane', async () => {
  const h = harness();
  h.backend.create = async () => ({ threadId: 'a', runId: 'run' });
  h.thread.providerInstanceId = 'codex'; h.thread.model = 'm';
  let waiting = true;
  h.backend.wait = async () => waiting ? { status: 'waiting', runId: 'run', request } : '任务完成';
  const respond = h.backend.respond;
  h.backend.respond = async (...args) => { await respond(...args); waiting = false; };
  const sent = [];
  const scheduler = createScheduler({ state: h.state, config: { threadId: 'a' }, reference: { projectId: 'p' },
    backend: h.backend, save() {}, send: async (_, text) => sent.push(text) });
  const add = (id, text) => h.state.jobs.push({ id, command: route(text), status: 'pending', sent: 0 });
  const flush = async () => { scheduler.tick(); await new Promise(resolve => setImmediate(resolve)); };
  add('new', '/new 开始');
  await flush(); await flush();
  assert.ok(sent.some(text => text.includes('请选择颜色')));
  add('answer', '2');
  await flush(); await flush();
  assert.ok(sent.some(text => text.includes('任务完成')), JSON.stringify(sent));
  assert.equal(h.calls.filter(call => call[0] === 'respond').length, 1);
  assert.equal(h.calls.some(call => call[0] === 'send'), false);
});
