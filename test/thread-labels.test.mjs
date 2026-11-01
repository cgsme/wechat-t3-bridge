import test from 'node:test';
import assert from 'node:assert/strict';
import { route, threadLabel, shortThreadId, splitThreadReply, recover } from '../src/core.mjs';
import { catalogThreads, numberedThread } from '../src/thread-labels.mjs';
import { resolveSelector } from '../src/commands.mjs';
import { createScheduler } from '../src/scheduler.mjs';

const a = { threadId: 'mcp:abcd-11111111', title: '检查本机内存', projectId: 'p', link: 'https://test/a' };
const b = { ...a, threadId: 'mcp:abcd-22222222', title: '整理报告', link: 'https://test/b' };
const stateFor = () => ({ routing: { projectId: 'p', threadId: a.threadId, listedIds: [a.threadId, b.threadId] }, jobs: [], seen: [] });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('reply identity has a sequence number, name and uniquely resolving short ID without a full ID or address', () => {
  const state = stateFor();
  catalogThreads(state, [a, b]);
  const first = numberedThread(a, state), second = numberedThread(b, state);
  assert.equal(threadLabel(first), '1️⃣ 检查本机内存（abcd-1）');
  assert.equal(threadLabel(second), '2️⃣ 整理报告（abcd-2）');
  for (const value of [first, second]) {
    assert.equal(resolveSelector(value.shortId, [], [a, b], a.threadId), value.threadId);
    assert.equal(threadLabel(value).includes(value.threadId), false);
    assert.equal(threadLabel(value).includes('https:'), false);
  }
});

test('UUID short prefixes avoid numeric-only selectors and distinguish transport-prefixed IDs', () => {
  const rows = [a, b, { ...a, threadId: 'abcd-11111111' }];
  for (const row of rows) {
    const short = shortThreadId(row.threadId, rows.map(t => t.threadId));
    assert.equal(resolveSelector(short, [], rows, a.threadId), row.threadId);
  }
  const id = '5398f479-e17d-4ee0-88d4-fc38bd228b92';
  assert.equal(shortThreadId(id, [id]), '5398f');
  assert.equal(resolveSelector('5398f', [], [{ threadId: id }], a.threadId), id);
  assert.equal(resolveSelector('#2', [a.threadId, b.threadId], [a, b], a.threadId), b.threadId);
  assert.deepEqual(route('/switch #2'), { kind: 'switch', selector: '#2' });
  assert.deepEqual(route('/to #2 continue'), { kind: 'task', selector: '#2', text: 'continue' });
});

test('new threads append to existing numbering and project-specific numbers survive serialization', () => {
  const state = stateFor();
  assert.equal(numberedThread(b, state).number, 2);
  const fresh = { ...a, threadId: 'mcp:fedc-33333333' };
  assert.equal(numberedThread(fresh, state).number, 3);
  assert.deepEqual(state.routing.listedIds, [a.threadId, b.threadId, fresh.threadId]);
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(numberedThread(fresh, restored).number, 3);
  assert.equal(numberedThread({ ...a, projectId: 'other' }, restored).number, 1);
  assert.equal(numberedThread(b, restored).number, 2);
});

test('every segmented reply repeats the original question and compact identity and retains the full response', () => {
  const state = stateFor(); catalogThreads(state, [a, b]);
  const thread = numberedThread(a, state);
  const question = '原始问题😀\n详细要求'.repeat(25);
  const body = '回复正文😀'.repeat(800);
  const chunks = splitThreadReply(threadLabel(thread) + '\n\n' + body, thread, 500, question);
  const header = chunks[0].slice(0, chunks[0].indexOf('\n\n', chunks[0].indexOf('\n\n') + 2) + 2);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.startsWith('1️⃣ 检查本机内存（abcd-1）\n\n指令：原始问题😀 详细要求')));
  assert.ok(chunks.every(chunk => Array.from(chunk).length <= 500 && !chunk.includes(a.threadId)));
  assert.ok(header.includes('…'));
  assert.equal(chunks.map(chunk => chunk.slice(header.length)).join(''), body);
});

test('concurrent tasks keep the question they are replying to and use shortened labels in all deliveries', async () => {
  const state = stateFor(); catalogThreads(state, [a, b]);
  const rows = new Map([a, b].map(t => [t.threadId, t]));
  const pending = [], delivered = [];
  const backend = { read: async config => rows.get(config.threadId), list: async () => [a, b],
    send: async (config, text) => new Promise(resolve => pending.push({ id: config.threadId, text, resolve })) };
  const scheduler = createScheduler({ state, config: { threadId: a.threadId }, reference: a, backend, save() {},
    send: async (job, text) => delivered.push([job.id, text]) });
  state.jobs.push({ id: '1', command: route('检查内存'), text: '检查内存', status: 'pending', sent: 0 },
    { id: '2', command: route('/to 2 整理报告'), text: '/to 2 整理报告', status: 'pending', sent: 0 });
  scheduler.tick(); await flush(); scheduler.tick(); await flush();
  assert.equal(pending.length, 2);
  pending[1].resolve('报告完成'); pending[0].resolve('内存结果');
  await flush(); scheduler.tick(); await flush(); scheduler.tick(); await flush();
  assert.ok(delivered.find(([id]) => id === '1')[1].includes('指令：检查内存\n\n内存结果'));
  assert.ok(delivered.find(([id]) => id === '2')[1].includes('指令：/to 2 整理报告\n\n报告完成'));
  assert.ok(delivered.every(([, text]) => /^(?:\d\uFE0F\u20E3)+ .+（[^）]+）\n\n指令：/.test(text)));
  assert.ok(delivered.every(([, text]) => !text.includes(a.threadId) && !text.includes(b.threadId)));
});

test('answering a follow-up preserves the original user task as reply context', async () => {
  const state = stateFor(); catalogThreads(state, [a, b]);
  const request = { requestId: 'request', questions: [{ id: 'color', question: '请选择报告颜色', options: [{ label: '蓝色' }] }] };
  let live = request;
  const delivered = [];
  const backend = { read: async () => a,
    send: async () => ({ status: 'waiting', runId: 'run', request }),
    pending: async () => live, respond: async () => { live = null; }, wait: async () => '报告完成' };
  const scheduler = createScheduler({ state, config: { threadId: a.threadId }, reference: a, backend, save() {},
    send: async (_, text) => delivered.push(text) });
  const add = (id, text) => state.jobs.push({ id, text, command: route(text), status: 'pending', sent: 0 });
  add('task', '生成检测报告');
  scheduler.tick(); await flush(); scheduler.tick(); await flush();
  add('answer', '/answer 1');
  scheduler.tick(); await flush(); scheduler.tick(); await flush();
  assert.ok(delivered.some(text => text.includes('指令：生成检测报告') && text.includes('请选择报告颜色')));
  assert.ok(delivered.some(text => text.includes('指令：生成检测报告\n\n报告完成')));
});

test('recovered task notices keep both the original question and a resolvable compact label', () => {
  const state = stateFor(); catalogThreads(state, [a, b]);
  state.jobs.push({ command: { kind: 'task', text: '整理报告' }, status: 'running', replyThread: b, threadId: b.threadId });
  recover(state);
  const text = state.jobs[0].chunks.join('');
  assert.ok(text.startsWith('2️⃣ 整理报告（abcd-2）\n\n指令：整理报告\n\n'));
  assert.equal(text.includes(b.threadId), false);
});
