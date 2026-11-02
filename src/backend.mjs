import { spawn } from 'node:child_process';
import { HISTORY_PAGE_SIZE, validateHistoryPage } from './history.mjs';
import { activeTaskStatuses, endedTaskStatuses, abortedWait, trackingError, runtimeProbe, taskPause } from './task-tracking.mjs';

export function callT3(config, args, { input = '', timeout = 30000, spawnImpl = spawn, acceptCodes = [0, 2], signal = config.signal } = {}) {
  if (signal?.aborted) return Promise.reject(abortedWait());
  return new Promise((resolve, reject) => {
    const child = spawnImpl(config.command, [...(config.prefixArgs || []), ...args], {
      cwd: config.cwd, env: { ...process.env, ...config.env },
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = [];
    let size = 0;
    let settled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const stop = error => {
      if (settled) return;
      settled = true;
      cleanup();
      // Reject independently of close: a stuck CLI or inherited pipe may never emit it.
      reject(error);
      try { child.kill('SIGKILL'); } catch {}
      child.stdin.destroy?.(); child.stdout.destroy?.(); child.stderr.destroy?.(); child.unref?.();
    };
    const abort = () => stop(abortedWait());
    const timer = setTimeout(() => stop(trackingError('T3_COMMAND_TIMEOUT',
      'T3 命令响应超时；提交状态未确认，任务不会自动重跑。')), timeout > 0 ? timeout : 30000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size <= 2 * 1024 * 1024) output.push(chunk);
      else stop(trackingError('T3_OUTPUT_TOO_LARGE', 'T3 回复过长，请在桌面端查看结果。'));
    });
    // Drain diagnostics without retaining credentials or internal paths in logs.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', () => stop(trackingError('T3_CLI_UNAVAILABLE', '无法启动 T3 命令，请检查桌面端安装。')));
    child.on('close', code => {
      if (settled) return;
      settled = true;
      cleanup();
      const text = Buffer.concat(output).toString('utf8').trim();
      if (!acceptCodes.includes(code)) return reject(trackingError('T3_CLI_FAILED',
        'T3 命令退出，未能确认结果；请检查桌面端连接，任务不会自动重跑。'));
      if (code === 2 && !text) return resolve('T3 正等待补充信息或确认，请在桌面端查看。');
      resolve(text);
    });
    try { child.stdin.end(input); } catch { stop(trackingError('T3_CLI_FAILED', 'T3 命令输入失败；任务不会自动重跑。')); }
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

export async function createThread(config, { projectId, title, provider, model, prompt, wait = true }, { call = callT3, waitFor = waitForThread } = {}) {
  if (!provider || !model) throw new Error('当前线程缺少模型配置，无法新建任务线程');
  const data = parseCliJson(await call(config, ['thread', 'start', '--json',
    '--provider', provider, '--model', model, '--title', title, projectId, '-'],
  { input: prompt, timeout: 30000, acceptCodes: [0, 1, 2] }));
  // Without --wait, the installed CLI returns only threadId/projectId/runId.
  // Requiring status here loses an already-created thread and its background run.
  if (!data.threadId || !data.runId) {
    throw new Error('无法确认新线程是否创建成功，请在 T3 检查；不会自动重试');
  }
  if (wait && (!data.status || activeTaskStatuses.has(data.status))) {
    return { ...data, ...await waitFor({ ...config, threadId: data.threadId }, data.runId, { structured: true }) };
  }
  return data;
}

// Lazy imports keep CLI helpers usable by the local MCP adapter without a cycle at startup.
export const backend = {
  read: checkBackend, list: listThreads, history: readThreadHistory, create: createThread,
  send: (config, prompt) => sendToBackend(config, prompt, { includeRunId: true, wait: false }), wait: waitForThread,
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

export async function waitForThread(config, runId, {
  read = async (target, id) => (await import('./t3-control.mjs')).readTaskState(target, id),
  probe = runtimeProbe(config), pause = taskPause, now = () => performance.now(),
  onRun = () => {}, onProgress = () => {}, structured = false, signal = config.signal,
} = {}) {
  if (!runId) throw trackingError('T3_INVALID_TASK', '任务编号缺失，无法安全跟踪；不会重新提交任务。');
  let retryDelay = 5000, disconnectedAt, waitingAt, progress;
  const approvalCache = {};
  const report = (status, detail = {}) => {
    const key = `${status}:${detail.approval?.id || ''}:${!!detail.notify}`;
    if (key !== progress) { progress = key; onProgress(status, detail); }
  };
  for (;;) {
    if (signal?.aborted) throw abortedWait();
    if (probe() === 'exited') throw trackingError('T3_SERVER_EXITED', 'T3 进程已退出，已停止等待；原任务状态未确认，不会自动重跑。请重新打开 T3 后查看 /status 或 /history。');
    let data;
    try {
      if (disconnectedAt !== undefined && now() - disconnectedAt >= 120000) {
        throw trackingError('T3_TRACKING_LOST', '与 T3 持续失联超过 2 分钟，已停止等待；原任务状态未确认，不会自动重跑。请恢复连接后查看 /status 或 /history。');
      }
      const trackingTimeoutMs = disconnectedAt === undefined ? 45000 : Math.max(1, Math.min(45000, 120000 - (now() - disconnectedAt)));
      data = await read({ ...config, signal, trackingTimeoutMs, approvalCache }, runId);
    } catch (error) {
      if (signal?.aborted) throw abortedWait();
      if (probe() === 'exited') throw trackingError('T3_SERVER_EXITED', 'T3 进程已退出，已停止等待；原任务状态未确认，不会自动重跑。请重新打开 T3 后查看 /status 或 /history。');
      if (!['T3_COMMAND_TIMEOUT', 'T3_CONNECTION_LOST', 'T3_CLI_FAILED'].includes(error.code)) throw error;
      if (disconnectedAt === undefined) { disconnectedAt = now(); waitingAt = undefined; }
      report('reconnecting', { notify: now() - disconnectedAt >= 10000 });
      const remaining = 120000 - (now() - disconnectedAt);
      if (remaining <= 0) throw trackingError('T3_TRACKING_LOST', '与 T3 持续失联超过 2 分钟，已停止等待；原任务状态未确认，不会自动重跑。请恢复连接后查看 /status 或 /history。');
      await pause(Math.min(retryDelay, remaining), signal);
      retryDelay = Math.min(retryDelay * 2, 30000);
      continue;
    }
    disconnectedAt = undefined;
    retryDelay = 5000;
    if (data?.threadId !== config.threadId || !data.runId ||
      !activeTaskStatuses.has(data.status) && !endedTaskStatuses.has(data.status) && data.status !== 'waiting') {
      throw trackingError('T3_INVALID_TASK', 'T3 任务状态校验失败，已停止跟踪；请在 T3 核对原任务，不会自动重跑。');
    }
    if (data.runId !== runId) { runId = data.runId; waitingAt = undefined; onRun(runId); }
    if (data.status === 'waiting') {
      if (data.request) return data;
      waitingAt ??= now();
      report(data.approval ? 'waiting_permission' : 'waiting', {
        approval: data.approval, notify: !!data.approval || now() - waitingAt >= 30000,
      });
      await pause(3000, signal);
      continue;
    }
    if (endedTaskStatuses.has(data.status)) {
      const reply = data.status === 'completed' ? data.reply || '任务已完成，未返回文本结果；请在 T3 查看详情。'
        : `任务状态：${data.status}。${data.error ? '\n' + data.error : '\n请在 T3 查看详情。'}`;
      return structured ? { ...data, reply } : reply;
    }
    waitingAt = undefined;
    report('running');
    await pause(3000, signal);
  }
}

export async function sendToBackend(config, prompt, { call = callT3, pending = readPendingRequest, includeRunId = false, wait = true, waitFor = waitForThread } = {}) {
  const result = parseCliJson(await call(config, ['thread', 'send', '--json', config.threadId, '-'],
    { input: prompt, timeout: 30000, acceptCodes: [0, 1, 2] }));
  if (result.threadId !== config.threadId || !result.runId || !result.status ||
    !activeTaskStatuses.has(result.status) && !endedTaskStatuses.has(result.status) && result.status !== 'waiting') {
    throw new Error('T3 任务响应校验失败，请在 T3 查看；不会自动重跑');
  }
  if (activeTaskStatuses.has(result.status)) {
    if (!wait) return result;
    const outcome = await waitFor(config, result.runId, { structured: includeRunId });
    return outcome;
  }
  if (result.status === 'waiting') return { ...result, request: await pending(config) };
  const reply = result.reply || result.error || `任务状态：${result.status}，请在 T3 查看详情。`;
  return includeRunId ? { threadId: result.threadId, runId: result.runId, status: result.status, reply } : reply;
}
