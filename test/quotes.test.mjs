import test from 'node:test';
import assert from 'node:assert/strict';
import { ingest, incoming, recover, threadInfo } from '../src/core.mjs';
import { createScheduler } from '../src/scheduler.mjs';
import { quotePeer, rememberMessage, resolveQuote, quotedReferences, sendTrackedReply } from '../src/quotes.mjs';
import { WechatApi, parseWechatJson } from '../src/api.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const thread = (threadId, projectId = 'p') => ({ threadId, projectId, title: `Name ${threadId}`, link: `https://test/${threadId}` });
const message = (text, ref, extra = {}) => ({ message_id: 'incoming-1', from_user_id: 'owner', message_type: 1,
  context_token: 'context', item_list: [{ type: 1, text_item: { text }, ...(ref ? { ref_msg: ref } : {}) }], ...extra });
const remembered = (state, extras = {}, now = Date.now()) => rememberMessage(state, {
  peer: quotePeer('owner'), threadId: 'b', projectId: 'p', ids: ['18446744073709551615'], text: 'Original bot reply', ...extras,
}, now);

function harness(saved) {
  const state = saved || { jobs: [], seen: [], routing: { projectId: 'p', threadId: 'a',
    threadInfo: threadInfo(thread('a')), listedIds: ['a', 'b'] } };
  const rows = new Map([thread('a'), thread('b'), thread('other', 'other-project')].map(t => [t.threadId, t]));
  const sends = [], replies = [], changes = [];
  const backend = { read: async c => rows.get(c.threadId), list: async (_, projectId) => [...rows.values()].filter(t => t.projectId === projectId),
    send: async (c, text) => { sends.push([c.threadId, text]); return 'done'; },
    fastConfig: async c => { changes.push(c.threadId); return { threadId: c.threadId, fast: { supported: true, enabled: true }, modelSelection: { instanceId: 'codex', model: 'model' } }; } };
  const scheduler = createScheduler({ state, config: { threadId: 'a' }, reference: thread('a'), backend,
    save() {}, send: async (job, text) => replies.push([job.id, text]) });
  const tick = async () => { scheduler.tick(); await flush(); };
  const receive = (text, ref, extras) => ingest(state, [message(text, ref, extras)], 'owner', 'cursor');
  return { state, rows, backend, sends, replies, changes, receive, tick };
}

test('uint64 wire IDs remain exact through API send and update parsing', async () => {
  const json = '{"message_id":18446744073709551615,"msgs":[{"message_id":18446744073709551614,"item_list":[{"ref_msg":{"svr_id":18446744073709551615}}]}]}';
  const api = new WechatApi({ token: 'test-token', fetchImpl: async () => new Response(json) });
  assert.equal((await api.send('owner', 'context', 'reply')).message_id, '18446744073709551615');
  const updates = await api.updates('');
  assert.equal(updates.msgs[0].message_id, '18446744073709551614');
  assert.equal(updates.msgs[0].item_list[0].ref_msg.svr_id, '18446744073709551615');
  assert.equal(parseWechatJson('{"seq":0}').seq, 0);
});

test('incoming keeps only new text as its command and retains quote metadata separately', () => {
  const input = incoming(message('new request', { svr_id: 'server', message_item: { text_item: { text: '/new old request' } } }), 'owner');
  assert.deepEqual(input.command, { kind: 'task', text: 'new request' });
  assert.equal(input.text, 'new request');
  assert.deepEqual(input.references[0].ids, ['server']);
  assert.equal(JSON.stringify(input.references).includes('/new old request'), false);
  assert.equal(incoming(message('request', { svr_id: 'server' }, { from_user_id: 'stranger' }), 'owner'), null);
  assert.equal(incoming(message('request', { svr_id: 'server' }, { group_id: 'group' }), 'owner'), null);
});

test('a quoted server ID routes to the original full thread ID despite list reordering', async () => {
  const h = harness(); remembered(h.state);
  h.state.routing.listedIds = ['b', 'a'];
  h.receive('continue & $literal', { svr_id: '18446744073709551615' });
  await h.tick(); await h.tick(); await h.tick();
  assert.deepEqual(h.sends, [['b', 'continue & $literal']]);
  assert.equal(h.state.routing.threadId, 'a');
  assert.deepEqual(h.state.routing.listedIds, ['b', 'a']);
  assert.ok(h.replies.some(([, text]) => text.includes('Name b')));
});

test('text-only quotes match exact known message hashes, not displayed numbers or names', async () => {
  const h = harness(); remembered(h.state, { ids: [] });
  h.receive('continue', { message_item: { type: 1, text_item: { text: 'Original bot reply' } } });
  await h.tick(); await h.tick();
  assert.deepEqual(h.sends, [['b', 'continue']]);
  const unknown = harness();
  unknown.receive('continue', { message_item: { text_item: { text: '2️⃣ Name b (b)' } } });
  await unknown.tick(); await unknown.tick();
  assert.deepEqual(unknown.sends, []);
  assert.ok(unknown.replies.some(([, text]) => text.includes('无法识别引用消息')));
});

test('explicit /to wins over an unknown or conflicting quote', async () => {
  const h = harness(); remembered(h.state);
  h.receive('/to 1 explicit task', { svr_id: 'unknown' });
  await h.tick(); await h.tick();
  assert.deepEqual(h.sends, [['a', 'explicit task']]);
});

test('quoted controls use their target while global commands keep their explicit meaning', async () => {
  const h = harness(); remembered(h.state);
  h.receive('/fast', { svr_id: '18446744073709551615' });
  await h.tick(); await h.tick();
  assert.deepEqual(h.changes, ['b']);
  assert.deepEqual(h.sends, []);
  assert.equal(h.state.routing.threadId, 'a');
  h.receive('/help', { svr_id: 'missing' }, { message_id: 'help' });
  await h.tick(); await h.tick();
  assert.ok(h.replies.some(([, text]) => text.includes('/help [en]')));
});

test('quoting a different project keeps current project and selection unchanged', async () => {
  const h = harness(); remembered(h.state, { threadId: 'other', projectId: 'other-project' });
  h.receive('continue there', { svr_id: '18446744073709551615' });
  await h.tick(); await h.tick();
  assert.deepEqual(h.sends, [['other', 'continue there']]);
  assert.equal(h.state.routing.threadId, 'a'); assert.equal(h.state.routing.projectId, 'p');
});

test('expired, missing, cross-account and ambiguous references never fall back to current routing', async () => {
  for (const setup of [
    state => remembered(state, {}, Date.now() - 31 * 86400000),
    state => remembered(state, { peer: quotePeer('other-owner') }),
    state => { remembered(state); remembered(state, { threadId: 'a' }); },
  ]) {
    const h = harness(); setup(h.state);
    h.receive('do work', { svr_id: '18446744073709551615' });
    await h.tick(); await h.tick();
    assert.deepEqual(h.sends, []); assert.ok(h.replies.length > 0);
  }
  const h = harness(); remembered(h.state); remembered(h.state, { threadId: 'a', ids: ['different-id'] });
  h.receive('do work', { message_item: { text_item: { text: 'Original bot reply' } } });
  await h.tick(); await h.tick();
  assert.deepEqual(h.sends, []);
  assert.ok(h.replies.some(([, text]) => text.includes('多个线程')));
});

test('archived, subagent, moved and wrong-ID quote targets are rejected before sending', async () => {
  for (const extra of [{ archived: true }, { relationshipToParent: 'subagent' }, { projectId: 'moved' }, { threadId: 'wrong' }]) {
    const h = harness(); remembered(h.state); h.rows.set('b', { ...thread('b'), ...extra });
    h.receive('do work', { svr_id: '18446744073709551615' });
    await h.tick(); await h.tick(); assert.deepEqual(h.sends, []);
  }
});

test('persisted mappings survive restart and user messages are mapped to their dispatched thread', async () => {
  const original = harness(); remembered(original.state);
  const h = harness(JSON.parse(JSON.stringify(original.state))); recover(h.state);
  h.receive('first', { svr_id: '18446744073709551615' });
  await h.tick(); await h.tick();
  h.receive('second', { svr_id: 'incoming-1' }, { message_id: 'incoming-2' });
  await h.tick(); await h.tick();
  assert.deepEqual(h.sends, [['b', 'first'], ['b', 'second']]);
});

test('conflicting multi-item references are rejected; server identity takes precedence over text', () => {
  const state = {}; remembered(state); remembered(state, { threadId: 'a', ids: ['different-id'], text: 'Other body' });
  const refs = quotedReferences({ item_list: [{ ref_msg: { svr_id: '18446744073709551615' } }, { ref_msg: { svr_id: 'different-id' } }] });
  assert.throws(() => resolveQuote(state, quotePeer('owner'), refs), /多个线程/);
  const authoritative = quotedReferences(message('task', { svr_id: '18446744073709551615', message_item: { text_item: { text: 'Other body' } } }));
  assert.deepEqual(resolveQuote(state, quotePeer('owner'), authoritative), { threadId: 'b', projectId: 'p' });
});

test('the quote cache is bounded and stores hashes instead of quoted message bodies', () => {
  const state = {};
  for (let i = 0; i < 2010; i++) remembered(state, { ids: [String(i)], text: `private content ${i}` });
  assert.equal(state.quoteMessages.length, 2000);
  assert.equal(JSON.stringify(state.quoteMessages).includes('private content'), false);
});

test('send response -> persisted index -> quoted update -> scheduler routes an actual reply round trip', async () => {
  const h = harness(); const ids = [];
  const api = new WechatApi({ token: 'test-token', fetchImpl: async (url, options) => {
    if (url.pathname.endsWith('/sendmessage')) {
      ids.push(JSON.parse(options.body).msg.client_id);
      return new Response('{"ret":0,"message_id":18446744073709551615}');
    }
    return Response.json({ msgs: [message('follow up', { svr_id: '18446744073709551615' })] });
  } });
  let saved;
  const job = { id: 'original', command: { kind: 'task' }, context: 'context', replyThread: thread('b') };
  await sendTrackedReply({ api, state: h.state, owner: 'owner', job, chunk: 'original reply', index: 0,
    save: () => { saved = JSON.parse(JSON.stringify(h.state)); } });
  assert.deepEqual(ids, ['t3_original_0']);
  assert.ok(saved.quoteMessages.some(record => record.ids.includes('18446744073709551615')));
  const restarted = harness(saved);
  const update = await api.updates('');
  ingest(restarted.state, update.msgs, 'owner', 'cursor');
  await restarted.tick(); await restarted.tick();
  assert.deepEqual(restarted.sends, [['b', 'follow up']]);
});

test('quoting a question answers that thread even while another thread is selected', async () => {
  const h = harness(); remembered(h.state);
  const request = { requestId: 'request-b', questions: [{ id: 'choice', question: 'Choose',
    options: [{ label: 'One' }, { label: 'Two' }] }] };
  h.state.pendingInputs = { b: { ...request, answers: {}, runId: 'run-b' } };
  const answered = [];
  h.backend.pending = async () => request;
  h.backend.respond = async (target, id, answers) => answered.push([target.threadId, id, answers]);
  h.backend.wait = async () => 'resumed';
  h.receive('2', { svr_id: '18446744073709551615' });
  await h.tick(); await h.tick();
  assert.deepEqual(answered, [['b', 'request-b', { choice: ['Two'] }]]);
  assert.deepEqual(h.sends, []);
  assert.equal(h.state.routing.threadId, 'a');
});

test('failed sends do not create a quote route; chunk retries retain each confirmed server ID', async () => {
  const state = {}; const job = { id: 'task', command: { kind: 'task' }, replyThread: thread('b') };
  await assert.rejects(sendTrackedReply({ state, owner: 'owner', job, chunk: 'not sent', index: 0, save() {},
    api: { send: async () => { throw Error('offline'); } } }));
  assert.equal(state.quoteMessages, undefined);
  const clientIds = [];
  let counter = 0;
  const api = { send: async (_, __, ___, id) => { clientIds.push(id); return { message_id: String(++counter) }; } };
  for (const index of ['start_0', 0, 0]) await sendTrackedReply({ api, state, owner: 'owner', job, chunk: 'sent', index, save() {} });
  assert.deepEqual(clientIds, ['t3_task_start_0', 't3_task_0', 't3_task_0']);
  for (const id of ['1', '2', '3']) assert.deepEqual(resolveQuote(state, quotePeer('owner'), [{ ids: [id] }]), { threadId: 'b', projectId: 'p' });
});
