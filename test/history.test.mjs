import test from 'node:test';
import assert from 'node:assert/strict';
import { route, threadInfo, splitThreadReply, HELP, HELP_EN } from '../src/core.mjs';
import { executeCommand } from '../src/commands.mjs';
import { readThreadHistory } from '../src/backend.mjs';
import { formatHistory } from '../src/history.mjs';
import { createScheduler } from '../src/scheduler.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const thread = id => ({ threadId: id, projectId: 'p', title: `Thread ${id}`, link: `https://test/${id}` });
const records = Array.from({ length: 13 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `message ${index}` }));

test('history parses selected and targeted pages, including wrapped controls', () => {
  assert.deepEqual(route('/history'), { kind: 'history', page: 1 });
  assert.deepEqual(route('/HISTORY 2'), { kind: 'history', page: 2 });
  assert.deepEqual(route('/to mcp:abc /history 3'), { kind: 'history', page: 3, selector: 'mcp:abc' });
  for (const wrapper of ['new', 'task']) assert.deepEqual(route(`/${wrapper} /history`), route('/history'));
  for (const value of ['/history -1', '/history 1 extra', '/history abc']) assert.equal(route(value).kind, 'help');
  assert.ok(HELP.includes('/history')); assert.ok(HELP_EN.includes('/history'));
});

test('history reads chronological, disjoint pages of the latest CLI messages', async () => {
  const calls = [];
  const call = async (config, args, options) => {
    calls.push({ config, args, options });
    return JSON.stringify({ thread: thread('a'), messages: records.slice(-Number(args[3])) });
  };
  const pages = [];
  for (let page = 1; page <= 4; page++) pages.push(await readThreadHistory({ threadId: 'a' }, page, { call }));
  assert.deepEqual(pages.map(p => p.messages.map(m => m.text)), [records.slice(8), records.slice(3, 8), records.slice(0, 3), []].map(p => p.map(m => m.text)));
  assert.deepEqual(pages.map(p => p.hasMore), [true, true, false, false]);
  assert.deepEqual(calls[0].args, ['thread', 'show', '--messages', '6', '--json', 'a']);
  assert.ok(calls.every(c => c.options.timeout === 30000 && !c.options.input));
});

test('empty history, unsupported content, invalid pages and mismatched responses are handled', async () => {
  const config = { threadId: 'a' };
  const read = data => readThreadHistory(config, 1, { call: async () => JSON.stringify(data) });
  assert.deepEqual(await read({ thread: thread('a'), messages: [] }), { messages: [], hasMore: false });
  const filtered = await read({ thread: thread('a'), messages: [
    { role: 'system', text: 'internal' }, { role: 'tool', text: 'internal' }, { role: 'user', text: '' },
    { role: 'assistant', text: 'visible' }, { role: 'user', text: 'question' },
  ] });
  assert.deepEqual(filtered.messages.map(m => m.text), ['visible', 'question']);
  await assert.rejects(read({ thread: thread('b'), messages: records }), /校验失败/);
  await assert.rejects(read({ thread: thread('a'), messages: {} }), /校验失败/);
  for (const page of [0, -1, 101, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(readThreadHistory(config, page, { call: () => { throw Error('must not call CLI'); } }), /页码/);
  }
});

function harness() {
  const state = { jobs: [], seen: [], routing: { threadId: 'a', threadInfo: threadInfo(thread('a')), listedIds: ['a', 'b'] } };
  const rows = new Map(['a', 'b'].map(id => [id, thread(id)]));
  const reads = [], sends = [];
  const backend = { read: async c => rows.get(c.threadId), list: async () => [...rows.values()],
    history: async (c, page) => { reads.push([c.threadId, page]); return { messages: records.slice(-5), hasMore: true }; },
    send: () => { throw Error('history must not start a task'); }, create: () => { throw Error('history must not create a thread'); } };
  const config = { threadId: 'a' }, reference = { projectId: 'p' };
  const execute = text => executeCommand({ command: route(text), state, config, reference, backend, save() {}, job: {} });
  const scheduler = createScheduler({ state, config, reference, backend, save() {}, send: async (job, text) => sends.push([job.id, text]) });
  return { state, rows, reads, backend, sends, execute, scheduler };
}

test('current and targeted history preserve routing and pending answers', async () => {
  const h = harness(); h.state.pendingInputs = { a: { requestId: 'pending' } };
  const before = structuredClone(h.state);
  const current = await h.execute('/history');
  assert.ok(current.includes('👤 用户')); assert.ok(current.includes('🤖 代理'));
  const targeted = await h.execute('/to 2 /history 2');
  assert.ok(targeted.includes('Thread b'));
  assert.ok(targeted.includes('/to 2 /history 3'));
  assert.deepEqual(h.reads, [['a', 1], ['b', 2]]);
  assert.deepEqual(h.state.routing, before.routing);
  assert.deepEqual(h.state.pendingInputs, before.pendingInputs);
  assert.deepEqual(h.state.jobs, before.jobs);
});

test('targeted history rejects unavailable threads without falling back', async () => {
  for (const extra of [{ projectId: 'foreign' }, { archived: true }, { relationshipToParent: 'subagent' }]) {
    const h = harness(); h.rows.set('b', { ...thread('b'), ...extra });
    await assert.rejects(h.execute('/to 2 /history'));
    assert.deepEqual(h.reads, []);
  }
  const h = harness(); await assert.rejects(h.execute('/to missing /history'));
  assert.deepEqual(h.reads, []);
});

test('history replies while a task in that thread is still running', async () => {
  const h = harness(); let complete;
  h.backend.send = () => new Promise(resolve => { complete = resolve; });
  h.state.jobs.push({ id: 'task', command: route('long task'), status: 'pending', sent: 0 });
  h.scheduler.tick(); await flush();
  h.state.jobs.push({ id: 'history', command: route('/to 1 /history'), status: 'pending', sent: 0 });
  h.scheduler.tick(); await flush(); h.scheduler.tick(); await flush();
  assert.ok(h.sends.some(([id, text]) => id === 'history' && text.includes('对话历史')));
  assert.equal(h.state.jobs.find(j => j.id === 'task').status, 'running');
  complete('done'); await flush(); h.scheduler.tick(); await flush();
});

test('history keeps full Unicode messages through WeChat segmentation and gives navigation', () => {
  const text = '中文😀\n'.repeat(1500);
  const formatted = formatHistory({ messages: [{ role: 'assistant', text }], hasMore: true }, 2, 'b');
  assert.ok(formatted.includes(text));
  assert.ok(formatted.includes('更早：/to b /history 3'));
  assert.ok(formatted.includes('更近：/to b /history 1'));
  const chunks = splitThreadReply(formatted, thread('b'));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(c => Array.from(c).length <= 1600 && c.includes('Thread b')));
  const empty = formatHistory({ messages: [], hasMore: false }, 1);
  assert.ok(empty.includes('暂无对话记录'));
  assert.equal(empty.includes('更早：'), false);
});
