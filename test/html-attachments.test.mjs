import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDecipheriv } from 'node:crypto';
import { prepareHtmlReply, readPreparedHtml } from '../src/html-attachments.mjs';
import { WechatApi } from '../src/api.mjs';
import { readRenderedHtml } from '../src/t3-control.mjs';
import { createScheduler } from '../src/scheduler.mjs';

const html = '<!doctype html><html><meta charset="utf-8"><style>h1{color:red}</style><h1>完整报告😀</h1><script>window.example=1</script></html>';
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-html-'));
  try { await action(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const job = () => ({ id: 'task', command: { kind: 'task' }, threadId: 'thread', runId: 'run' });

test('linked local HTML is attached byte-for-byte and the inaccessible link becomes an attachment label', async () => fixture(async root => {
  const file = path.join(root, '完整 report.html'); const bytes = Buffer.from('\uFEFF' + html);
  await fs.writeFile(file, bytes);
  const j = job();
  const reply = await prepareHtmlReply(j, `建议已整理。\n[打开完整报告](<${file}>)`, { dataDir: path.join(root, 'data'), config: { cwd: root } });
  assert.equal(j.htmlAttachments.length, 1);
  assert.deepEqual(await readPreparedHtml(j.htmlAttachments[0]), bytes);
  assert.ok(reply.includes('完整 HTML 见附件')); assert.equal(reply.includes(file), false);
  assert.equal(j.htmlAttachments[0].name, '完整 report.html');
  await fs.writeFile(j.htmlAttachments[0].filePath, 'changed');
  await assert.rejects(readPreparedHtml(j.htmlAttachments[0]), /已变化/);
}));

test('inline HTML and T3 rendered pages are preserved, deduplicated and never evaluated', async () => fixture(async root => {
  const options = { dataDir: root, config: { cwd: root } };
  const j = job();
  const reply = await prepareHtmlReply(j, `说明\n\`\`\`html\n${html}\n\`\`\`\n\`\`\`html\n${html}\n\`\`\``, options);
  assert.equal(j.htmlAttachments.length, 1);
  assert.ok((await readPreparedHtml(j.htmlAttachments[0])).toString().includes('<script>window.example=1</script>'));
  assert.equal(reply.includes('<script>'), false);
  const rendered = job();
  await prepareHtmlReply(rendered, '页面已展示。', { ...options, renderedHtml: async (config, runId) => {
    assert.equal(config.threadId, 'thread'); assert.equal(runId, 'run');
    return [{ html, title: '图表：报告' }];
  } });
  assert.equal(rendered.htmlAttachments[0].name, '图表：报告.html');
  assert.equal((await readPreparedHtml(rendered.htmlAttachments[0])).toString(), html);
}));

test('ordinary text stays unchanged, failures retain the reply and remote links are not fetched', async () => fixture(async root => {
  const options = { dataDir: root, config: { cwd: root } };
  assert.equal(await prepareHtmlReply(job(), 'normal text', options), 'normal text');
  const remote = '[website](https://example.test/page.html)';
  assert.equal(await prepareHtmlReply(job(), remote, options), remote);
  const missing = await prepareHtmlReply(job(), `[missing](${root}/missing.html)`, options);
  assert.ok(missing.includes('文件已不存在'));
  const invalid = path.join(root, 'not-html.html'); await fs.writeFile(invalid, 'not an html report');
  const bad = job(); await prepareHtmlReply(bad, `[invalid](${invalid})`, options); assert.equal(bad.htmlAttachments.length, 0);
  const history = { ...job(), command: { kind: 'history' } };
  await prepareHtmlReply(history, `[old user link](${invalid})`, options); assert.equal(history.htmlAttachments, undefined);
}));

test('WeChat file upload encrypts the complete HTML, sends a FILE item and preserves server IDs', async () => {
  const bytes = Buffer.from(html); const requests = []; let uploadKey;
  const api = new WechatApi({ token: 'test-token', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.pathname.endsWith('getuploadurl')) {
      const body = JSON.parse(options.body);
      assert.equal(body.media_type, 3); assert.equal(body.rawsize, bytes.length);
      uploadKey = Buffer.from(body.aeskey, 'hex');
      return Response.json({ ret: 0, upload_param: 'test-param' });
    }
    if (url.hostname === 'novac2c.cdn.weixin.qq.com') {
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.redirect, 'error');
      const decipher = createDecipheriv('aes-128-ecb', uploadKey, null);
      assert.deepEqual(Buffer.concat([decipher.update(options.body), decipher.final()]), bytes);
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'download-param' } });
    }
    const message = JSON.parse(options.body).msg;
    assert.equal(message.client_id, 'stable-html-id'); assert.equal(message.context_token, 'context');
    assert.equal(message.item_list[0].type, 4);
    assert.equal(message.item_list[0].file_item.file_name, 'report.html');
    assert.equal(message.item_list[0].file_item.len, String(bytes.length));
    assert.equal(Buffer.from(message.item_list[0].file_item.media.aes_key, 'base64').toString(), uploadKey.toString('hex'));
    return new Response('{"ret":0,"message_id":18446744073709551615}');
  } });
  const response = await api.sendHtml('owner', 'context', bytes, 'report.html', 'stable-html-id');
  assert.equal(response.message_id, '18446744073709551615'); assert.equal(requests.length, 3);
});

test('media upload rejects arbitrary hosts and fails cleanly without posting a file message', async () => {
  let count = 0;
  const api = new WechatApi({ token: 'test-token', fetchImpl: async () => {
    count++; return Response.json({ upload_full_url: 'https://example.test/upload' });
  } });
  await assert.rejects(api.sendHtml('owner', 'context', Buffer.from(html), 'report.html'), /上传地址/);
  assert.equal(count, 1);
  await assert.rejects(api.sendHtml('owner', '', Buffer.from(html), 'report.html'), /会话令牌/);
});

test('T3 inline HTML is read only from the exact thread and completed run', async () => {
  const reports = await readRenderedHtml({ threadId: 'thread' }, 'run', { control: async (_, action, options) => {
    assert.equal(options?.write, undefined);
    return action(async (name, args) => {
      assert.equal(name, 't3_thread_read'); assert.equal(args.threadId, 'thread');
      if (args.limit === 1) return { thread: { threadId: 'thread', itemCount: 20 } };
      return { thread: { threadId: 'thread' }, items: [
        { type: 'dynamic_tool', runId: 'older-run', text: JSON.stringify({ toolName: 't3-code.html_render', input: { html: 'old' } }) },
        { type: 'dynamic_tool', runId: 'run', text: JSON.stringify({ toolName: 't3-code.html_preview', input: { html: 'preview' } }) },
        { type: 'dynamic_tool', runId: 'run', text: JSON.stringify({ toolName: 't3-code.html_render', input: { html, title: 'Report' } }) },
      ] };
    });
  } });
  assert.deepEqual(reports, [{ html, title: 'Report' }]);
});

test('attachment delivery retries persist progress without resending text or rerunning the task', async () => {
  const state = { jobs: [{ id: 'reply', command: { kind: 'task' }, status: 'reply', bound: true, threadId: 'a',
    chunks: ['summary'], sent: 0, htmlAttachments: [{ name: 'one.html' }, { name: 'two.html' }], htmlSent: 0 }], seen: [],
    routing: { projectId: 'p', threadId: 'a', listedIds: [] } };
  const text = [], files = []; let fail = true, now = 0;
  const scheduler = createScheduler({ state, config: { threadId: 'a' }, reference: { projectId: 'p' }, backend: {}, save() {}, now: () => now,
    send: async (_, chunk) => text.push(chunk), sendAttachment: async (_, file, index) => {
      if (index === 1 && fail) throw Error('offline'); files.push(file.name);
    } });
  scheduler.tick(); await flush();
  assert.equal(state.jobs[0].htmlSent, 1); assert.equal(state.jobs[0].sent, 1); assert.deepEqual(state.seen, []);
  fail = false; now = 10000; scheduler.tick(); await flush(); scheduler.tick(); await flush();
  assert.deepEqual(text, ['summary']); assert.deepEqual(files, ['one.html', 'two.html']);
  assert.deepEqual(state.seen, ['reply']); assert.equal(state.jobs.length, 0);
});

test('completed model replies carry the run ID through scheduling and prepare the corresponding HTML attachment', async () => fixture(async root => {
  const thread = { threadId: 'a', projectId: 'p', title: 'A', link: 'https://test/a' };
  const state = { jobs: [{ id: 'task', command: { kind: 'task', text: 'create report' }, status: 'pending', sent: 0 }], seen: [],
    routing: { projectId: 'p', threadId: 'a', listedIds: ['a'] } };
  const texts = [], files = [];
  const scheduler = createScheduler({ state, config: { threadId: 'a' }, reference: thread, save() {},
    backend: { read: async () => thread, send: async () => ({ threadId: 'a', runId: 'report-run', status: 'completed', reply: 'Report ready.' }) },
    prepareReply: (job, reply) => prepareHtmlReply(job, reply, { dataDir: root, config: { cwd: root }, renderedHtml: async (config, runId) => {
      assert.equal(config.threadId, 'a'); assert.equal(runId, 'report-run'); return [{ html, title: 'report' }];
    } }),
    send: async (_, text) => texts.push(text), sendAttachment: async (job, file) => { assert.equal(job.runId, 'report-run'); files.push(await readPreparedHtml(file)); },
  });
  for (let i = 0; i < 20 && !state.seen.length; i++) { scheduler.tick(); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(state.seen.length, 1);
  assert.ok(texts.some(text => text.includes('Report ready.')));
  assert.deepEqual(files, [Buffer.from(html)]);
}));
