import { spawn } from 'node:child_process';
import { HISTORY_PAGE_SIZE, validateHistoryPage } from './history.mjs';

export function callT3(config, args, { input = '', timeout = 1800000, spawnImpl = spawn, acceptCodes = [0, 2] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(config.command, [...(config.prefixArgs || []), ...args], {
      cwd: config.cwd, env: { ...process.env, ...config.env },
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size <= 2 * 1024 * 1024) output.push(chunk);
      else child.kill();
    });
    // Drain diagnostics without retaining credentials or internal paths in logs.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('无法启动 T3 命令，请检查桌面端安装')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('等待 T3 回复超时，请在 T3 查看进度；任务不会自动重跑'));
      if (size > 2 * 1024 * 1024) return reject(new Error('T3 回复过长，请在桌面端查看结果'));
      const text = Buffer.concat(output).toString('utf8').trim();
      if (!acceptCodes.includes(code)) return reject(new Error('T3 未正常完成，请在桌面端查看详情；任务不会自动重跑'));
      if (code === 2 && !text) return resolve('T3 正等待补充信息或确认，请在桌面端查看。');
      resolve(text);
    });
    child.stdin.end(input);
  });
}

export async function checkBackend(config) {
  const data = parseCliJson(await callT3(config, ['thread', 'show', '--messages', '0', '--json', config.threadId], { timeout: 20000 }));
  if (data.thread?.threadId !== config.threadId) throw new Error('T3 目标会话校验失败');
  return data.thread;
}

// Some desktop builds print a startup log before the CLI's single-line JSON.
export function parseCliJson(text) {
  try { return JSON.parse(text); } catch {}
  for (const line of text.split(/\r?\n/).reverse()) {
    if (!/^\s*[\[{]/.test(line)) continue;
    try { return JSON.parse(line); } catch {}
  }
  throw new Error('T3 未返回预期的 JSON 结果，请在桌面端检查状态');
}

export async function listThreads(config, projectId) {
  const data = parseCliJson(await callT3(config, ['thread', 'list', '--project', projectId, '--json'], { timeout: 30000 }));
  if (!Array.isArray(data)) throw new Error('T3 线程列表格式不正确');
  return data;
}

export async function readThreadHistory(config, page = 1, { call = callT3 } = {}) {
  validateHistoryPage(page);
  const count = page * HISTORY_PAGE_SIZE;
  const data = parseCliJson(await call(config,
    ['thread', 'show', '--messages', String(count + 1), '--json', config.threadId], { timeout: 30000 }));
  if (data.thread?.threadId !== config.threadId || !Array.isArray(data.messages)) {
    throw new Error('T3 对话历史校验失败，请重试。');
  }
  const end = Math.max(0, data.messages.length - (page - 1) * HISTORY_PAGE_SIZE);
  const start = Math.max(0, end - HISTORY_PAGE_SIZE);
  return { messages: data.messages.slice(start, end).filter(message =>
    ['user', 'assistant'].includes(message?.role) && typeof message.text === 'string' && message.text.trim()),
    hasMore: start > 0 };
}

export async function createThread(config, { projectId, title, provider, model, prompt, wait = true }) {
  if (!provider || !model) throw new Error('当前线程缺少模型配置，无法新建任务线程');
  const data = parseCliJson(await callT3(config, ['thread', 'start', ...(wait ? ['--wait'] : []), '--json',
    '--provider', provider, '--model', model, '--title', title, projectId, '-'],
  { input: prompt, acceptCodes: [0, 1, 2] }));
  // Without --wait, the installed CLI returns only threadId/projectId/runId.
  // Requiring status here loses an already-created thread and its background run.
  if (!data.threadId || (wait ? !data.status : !data.runId)) {
    throw new Error('无法确认新线程是否创建成功，请在 T3 检查；不会自动重试');
  }
  return data;
}

// Lazy imports keep CLI helpers usable by the local MCP adapter without a cycle at startup.
export const backend = {
  read: checkBackend, list: listThreads, history: readThreadHistory, create: createThread,
  send: (config, prompt) => sendToBackend(config, prompt, { includeRunId: true }), wait: waitForThread,
  renderedHtml: async (...args) => (await import('./t3-control.mjs')).readRenderedHtml(...args),
  projects: async (...args) => (await import('./t3-control.mjs')).readProjects(...args),
  project: async (...args) => (await import('./t3-control.mjs')).readProject(...args),
  catalog: async (...args) => (await import('./t3-control.mjs')).readModelCatalog(...args),
  modelConfig: async (...args) => (await import('./t3-control.mjs')).readModelConfig(...args),
  setModel: async (...args) => (await import('./t3-control.mjs')).changeModel(...args),
  fastConfig: async (...args) => (await import('./t3-control.mjs')).readFastConfig(...args),
  setFast: async (...args) => (await import('./t3-control.mjs')).changeFastMode(...args),
  steer: async (...args) => (await import('./t3-control.mjs')).steerThread(...args),
  interrupt: async (...args) => (await import('./t3-control.mjs')).interruptThread(...args),
  usage: async (...args) => (await import('./t3-usage.mjs')).readUsage(...args),
  limits: async (...args) => (await import('./t3-usage.mjs')).readUsageLimits(...args),
  setSettled: async (...args) => (await import('./t3-control.mjs')).setThreadSettled(...args),
  pending: readPendingRequest,
  respond: async (...args) => (await import('./t3-control.mjs')).respondToRequest(...args),
};

export async function readPendingRequest(...args) {
  return (await import('./t3-control.mjs')).readPendingRequest(...args);
}

export async function waitForThread(config, runId, { call = callT3, pending = readPendingRequest, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), timeout = 1800000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const data = parseCliJson(await call(config, ['thread', 'show', '--messages', '50', '--json', config.threadId], { timeout: 20000 }));
    if (data.thread?.threadId !== config.threadId) throw new Error('T3 目标会话校验失败');
    if (runId && data.thread.latestRunId !== runId) throw new Error('线程出现了其他任务，请在 T3 查看原任务结果');
    if (data.thread.pendingRequestCount > 0 || data.thread.status === 'waiting') {
      const request = await pending(config);
      if (request) return { status: 'waiting', threadId: config.threadId, runId: runId || data.thread.latestRunId, request };
      return 'T3 正等待确认，请在桌面端处理权限确认。补充问题可用 /questions 查看。';
    }
    if (['completed', 'waiting', 'failed', 'cancelled', 'interrupted', 'rolled_back'].includes(data.thread.status)) {
      const reply = (data.messages || []).filter(message => message.role === 'assistant' && (!runId || message.runId === runId)).at(-1)?.text;
      if (data.thread.status === 'waiting') return 'T3 正等待补充信息或确认，请在桌面端查看。';
      return reply || `任务状态：${data.thread.status}，请在 T3 查看详情。`;
    }
    await pause(1000);
  }
  throw new Error('等待 T3 回复超时，请在 T3 查看进度；任务不会自动重跑');
}

export async function sendToBackend(config, prompt, { call = callT3, pending = readPendingRequest, includeRunId = false } = {}) {
  const result = parseCliJson(await call(config, ['thread', 'send', '--wait', '--json', config.threadId, '-'],
    { input: prompt, acceptCodes: [0, 1, 2] }));
  if (result.threadId !== config.threadId || !result.status) throw new Error('T3 任务响应校验失败，请在 T3 查看；不会自动重跑');
  if (result.status === 'waiting') return { ...result, request: await pending(config) };
  const reply = result.reply || result.error || `任务状态：${result.status}，请在 T3 查看详情。`;
  return includeRunId ? { threadId: result.threadId, runId: result.runId, status: result.status, reply } : reply;
}
