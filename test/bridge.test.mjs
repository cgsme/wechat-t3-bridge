import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WechatApi, wechatBase } from '../src/api.mjs';
import { incoming, route, ingest, recover, splitReply, splitThreadReply, threadLabel } from '../src/core.mjs';
import { callT3, checkBackend } from '../src/backend.mjs';

function message(extra = {}) {
  return { message_id: 'one', message_type: 1, from_user_id: 'owner',
    context_token: 'context', item_list: [{ type: 1, text_item: { text: '你好' } }], ...extra };
}

test('only the QR owner can enter the inbox; groups and bot messages cannot', () => {
  for (const extra of [{ from_user_id: 'other' }, { message_type: 2 }, { group_id: 'group' }, { context_token: '' }]) {
    assert.equal(incoming(message(extra), 'owner'), null);
  }
  assert.equal(incoming(message(), ''), null);
  assert.equal(incoming(message(), 'owner').text, '你好');
});

test('owner text, transcribed voice and unsupported attachments remain distinct', () => {
  assert.equal(incoming(message({ item_list: [{ type: 3, voice_item: { text: '你好呀' } }] }), 'owner').command.kind, 'task');
  assert.equal(incoming(message({ item_list: [{ type: 2, image_item: {} }] }), 'owner').command.kind, 'unsupported');
});

test('plain text and /task use the same task route without adding instructions', () => {
  assert.deepEqual(route('/task 创建一个文件'), { kind: 'task', text: '创建一个文件' });
  assert.deepEqual(route('/task say hello\nwith details'), { kind: 'task', text: 'say hello\nwith details' });
  assert.deepEqual(route('今天有什么任务？'), route('/task 今天有什么任务？'));
  assert.equal(route('/task').kind, 'help');
  assert.equal(route('/taskforce something').kind, 'help');
  assert.equal(route('/status').kind, 'status');
  assert.deepEqual(route('/任务 创建一个文件'), { kind: 'task', text: '创建一个文件' });
  assert.equal(route('/状态').kind, 'status');
  assert.equal(route('/帮助').kind, 'help');
  assert.equal(route('/ping').kind, 'help');
  assert.equal(route('你好').text, '你好');
});

test('saved plain-text jobs migrate to tasks without changing recovery or replaying running work', () => {
  const state = { jobs: [
    { command: { kind: 'chat', text: '待处理' }, status: 'pending', threadId: 'a', bound: true },
    { command: { kind: 'chat', text: '执行中' }, status: 'running', threadId: 'a' },
  ] };
  recover(state);
  assert.deepEqual(state.jobs[0], { command: { kind: 'task', text: '待处理' }, status: 'pending', threadId: 'a', bound: true });
  assert.equal(state.jobs[1].command.kind, 'task');
  assert.equal(state.jobs[1].status, 'reply');
  assert.match(state.jobs[1].chunks.join(''), /不会自动重跑/);
});

test('repeated polls and duplicates in a batch cannot execute the same message twice', () => {
  const state = { cursor: '', jobs: [], seen: [] };
  ingest(state, [message(), message(), message({ from_user_id: 'other' })], 'owner', 'cursor-1');
  assert.equal(state.jobs.length, 1);
  assert.equal(state.cursor, 'cursor-1');
  ingest(state, [message()], 'owner', 'cursor-2');
  assert.equal(state.jobs.length, 1);
  state.seen.push(state.jobs.shift().id);
  ingest(state, [message()], 'owner', 'cursor-3');
  assert.equal(state.jobs.length, 0);
});

test('a zero sequence is a valid stable message id when message_id is unavailable', () => {
  assert.ok(incoming(message({ message_id: undefined, seq: 0 }), 'owner'));
  assert.equal(incoming(message({ message_id: undefined }), 'owner'), null);
});

test('restart never re-executes work whose outcome is uncertain', () => {
  const state = { jobs: [{ status: 'running' }, { status: 'pending' }, { status: 'reply', chunks: ['result'], sent: 1 }] };
  recover(state);
  assert.equal(state.jobs[0].status, 'reply');
  assert.match(state.jobs[0].chunks[0], /不会自动重跑/);
  assert.equal(state.jobs[1].status, 'pending');
  assert.equal(state.jobs[2].sent, 1);
});

test('restart reports a confirmed created thread without implying creation is still uncertain', () => {
  const state = { jobs: [{ command: { kind: 'new' }, status: 'running', threadId: 'created',
    createdThread: { threadId: 'created', title: 'New task', link: 'https://test/created' } }] };
  recover(state);
  assert.equal(state.jobs[0].status, 'reply');
  const reply = state.jobs[0].chunks.join('');
  assert.match(reply, /新线程已创建/);
  assert.ok(reply.startsWith('1️⃣ New task（crea）\n\n'));
  assert.doesNotMatch(reply, /https?:\/\/|Thread:|ID:/);
  assert.match(reply, /不会自动重跑/);
});

test('restart retains an unverified new thread ID and asks the user to check before retrying', () => {
  const state = { jobs: [{ command: { kind: 'new' }, status: 'running', threadId: 'returned-id' }] };
  recover(state);
  const reply = state.jobs[0].chunks.join('');
  assert.match(reply, /新线程 retu/);
  assert.equal(reply.includes('returned-id'), false);
  assert.match(reply, /创建确认尚未完成/);
  assert.match(reply, /不要重复/);
});

test('long Unicode replies are split without breaking emoji or dropping content', () => {
  const text = '中文😀'.repeat(1700);
  const chunks = splitReply(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => Array.from(chunk).length <= 1600));
});

test('every long reply chunk carries a compact thread label within the message limit', () => {
  const thread = { threadId: 'mcp:full-thread-id', title: '独立任务线程', link: 'https://test/thread' };
  const text = '中文😀'.repeat(1800);
  const header = threadLabel(thread) + '\n\n';
  assert.equal(header, '1️⃣ 独立任务线程（full）\n\n');
  const chunks = splitThreadReply(text, thread);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.startsWith(header) && Array.from(chunk).length <= 1600));
  assert.ok(chunks.every(chunk => !/https?:\/\/|Thread:|ID:/.test(chunk)));
  assert.ok(chunks.every(chunk => !chunk.includes(thread.threadId)));
  assert.equal(chunks.map(chunk => chunk.slice(header.length)).join(''), text);
});

test('credential requests cannot follow a redirect or use non-WeChat API origins', () => {
  for (const value of ['http://ilinkai.weixin.qq.com', 'https://weixin.qq.com.attacker.test',
    'https://user@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:8443', 'https://ilinkai.weixin.qq.com/path']) {
    assert.throws(() => wechatBase(value));
  }
  assert.equal(wechatBase('https://ilinkai.weixin.qq.com'), 'https://ilinkai.weixin.qq.com');
});

test('login uses unauthenticated POST; status polls never disclose saved bot tokens', async () => {
  const calls = [];
  const api = new WechatApi({ token: 'private', fetchImpl: async (url, options) => {
    calls.push({ url, ...options }); return { ok: true, json: async () => ({ status: 'wait' }) };
  } });
  await api.qr();
  await api.qrStatus('qr-value');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].body), { local_token_list: [] });
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[1].redirect, 'error');
});

test('replies include the originating context, stable id and authenticated body', async () => {
  let options;
  const api = new WechatApi({ token: 'private', fetchImpl: async (_, value) => {
    options = value; return { ok: true, json: async () => ({ ret: 0 }) };
  } });
  await api.send('owner', 'context', '回复', 'stable-id');
  const body = JSON.parse(options.body);
  assert.equal(body.msg.to_user_id, 'owner');
  assert.equal(body.msg.context_token, 'context');
  assert.equal(body.msg.client_id, 'stable-id');
  assert.equal(options.headers.Authorization, 'Bearer private');
  assert.throws(() => api.send('owner', '', 'oops'), /缺少微信会话令牌/);
});

test('HTTP and business errors are failures and do not print server bodies', async () => {
  const http = new WechatApi({ token: 'private', fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(http.updates(''), /HTTP 503/);
  const expired = new WechatApi({ token: 'private', fetchImpl: async () => ({ ok: true,
    json: async () => ({ ret: 0, errcode: -14, errmsg: 'sensitive server details' }) }) });
  await assert.rejects(expired.updates(''), error => error.code === -14 && !error.message.includes('sensitive'));
});

test('Windows shell metacharacters and Chinese reach the backend only through stdin', async () => {
  const fixture = fileURLToPath(new URL('./echo.mjs', import.meta.url));
  const text = '中文 "quoted" & whoami | more $(anything) `command` %PATH%\nsecond line';
  const output = await callT3({ command: process.execPath, prefixArgs: [fixture], cwd: path.dirname(fixture) },
    ['thread', 'send', '--wait', 'thread-id', '-'], { input: text });
  const result = JSON.parse(output);
  assert.equal(result.input, text);
  assert.deepEqual(result.args, ['thread', 'send', '--wait', 'thread-id', '-']);
});

test('the backend must confirm the configured thread before polling starts', async () => {
  const fixture = fileURLToPath(new URL('./echo.mjs', import.meta.url));
  await assert.rejects(checkBackend({ command: process.execPath, prefixArgs: [fixture],
    cwd: path.dirname(fixture), threadId: 'missing' }), /目标会话校验失败/);
});
