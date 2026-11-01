import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const looksLikeHtml = text => /<!doctype\s+html|<(?:html|body|main|article|div|style|table|svg)\b/i.test(text);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const displayName = value => `${String(value || 'T3-report').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100).replace(/\.html?$/i, '')}.html`;

export async function prepareHtmlReply(job, reply, { dataDir, config, renderedHtml } = {}) {
  if (typeof reply !== 'string' || !['task', 'new', 'answer'].includes(job.command.kind)) return reply;
  const attachments = [], warnings = [], known = new Set();
  const outputDir = path.join(dataDir, 'html-artifacts');
  const store = async (bytes, name) => {
    if (bytes.length > MAX_HTML_BYTES) throw new Error('HTML 文件超过 5 MB');
    if (!looksLikeHtml(bytes.toString('utf8'))) throw new Error('文件不包含可识别的 HTML 页面');
    const sha256 = digest(bytes);
    if (known.has(sha256)) return;
    if (attachments.length >= MAX_ATTACHMENTS) throw new Error('单条回复最多附带 5 个 HTML 文件');
    await fs.mkdir(outputDir, { recursive: true });
    const filePath = path.join(outputDir, `${sha256}.html`);
    await fs.writeFile(filePath, bytes, { mode: 0o600 });
    attachments.push({ filePath, name: displayName(name), sha256, size: bytes.length });
    known.add(sha256);
  };
  let text = reply;
  const blocks = [...reply.matchAll(/```html[^\S\r\n]*\r?\n([\s\S]*?)```/gi)];
  if (!blocks.length && /^\s*(?:<!doctype\s+html|<html\b)/i.test(reply)) {
    blocks.push({ 0: reply, 1: reply });
  }
  for (const [index, block] of blocks.entries()) {
    try { await store(Buffer.from(block[1], 'utf8'), `T3-report-${index + 1}.html`); text = text.replace(block[0], '完整 HTML 见附件。'); }
    catch (error) { warnings.push(error.message); }
  }
  for (const match of reply.matchAll(/\[([^\]\r\n]+)\]\((?:<([^>]+)>|([^\)\r\n]+))\)/g)) {
    const link = (match[2] || match[3]).trim();
    if (!/\.html?$/i.test(link) || /^https?:/i.test(link)) continue;
    try {
      const filePath = link.startsWith('file:') ? fileURLToPath(link) : path.resolve(config.cwd, link);
      const real = await fs.realpath(filePath);
      const roots = [config.cwd, os.tmpdir(), path.join(os.homedir(), '.t3', 'scratch'), path.join(os.homedir(), '.t3', 'userdata', 'attachments')];
      const allowed = (await Promise.all(roots.map(root => fs.realpath(root).catch(() => undefined))))
        .some(root => root && !path.relative(root, real).startsWith('..') && !path.isAbsolute(path.relative(root, real)));
      if (!allowed) throw new Error('HTML 文件不在任务目录或报告目录内');
      const stat = await fs.stat(real);
      if (!stat.isFile() || stat.size > MAX_HTML_BYTES) throw new Error('HTML 文件不可用或超过 5 MB');
      await store(await fs.readFile(real), path.basename(real));
      text = text.replace(match[0], `${match[1]}（完整 HTML 见附件）`);
    } catch (error) { warnings.push(`报告附件未准备完成：${error.code === 'ENOENT' ? '文件已不存在' : error.message}`); }
  }
  // T3's inline html_render output is a separate timeline item, not reply text.
  if (!attachments.length && renderedHtml && job.runId && job.threadId) {
    try {
      const reports = await renderedHtml({ ...config, threadId: job.threadId }, job.runId);
      for (const [index, report] of reports.entries()) await store(Buffer.from(report.html, 'utf8'), report.title || `T3-page-${index + 1}`);
    } catch { warnings.push('T3 内嵌页面读取失败；文字回复已保留。'); }
  }
  job.htmlAttachments = attachments;
  job.htmlSent = 0;
  if (attachments.length) text += `\n\n📎 完整 HTML：${attachments.map(file => file.name).join('、')}\n请下载后用浏览器打开。外部资源需要联网；微信预览可能无法运行交互脚本。`;
  if (warnings.length) text += `\n\n${[...new Set(warnings)].join('\n')}`;
  return text;
}

export async function readPreparedHtml(attachment) {
  const bytes = await fs.readFile(attachment.filePath);
  if (bytes.length > MAX_HTML_BYTES || digest(bytes) !== attachment.sha256) throw new Error('HTML 附件已变化，发送已暂停。');
  return bytes;
}
