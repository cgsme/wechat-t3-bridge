import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitThreadReply } from './core.mjs';

export const activeTaskStatuses = new Set(['preparing', 'queued', 'starting', 'running']);
export const endedTaskStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);
export const trackingError = (code, message) => Object.assign(new Error(message), { code });
export const abortedWait = () => trackingError('T3_WAIT_ABORTED', '桥接正在停止；任务不会重新提交。');

// Keep the last observed server PID so removing the runtime file during exit
// cannot turn a confirmed process exit into an endless connection retry.
export function runtimeProbe(config, { read = file => fs.readFileSync(file, 'utf8'), kill = process.kill } = {}) {
  const root = config.env?.T3CODE_HOME || process.env.T3CODE_HOME || path.join(os.homedir(), '.t3');
  let pid;
  return () => {
    try {
      const runtime = JSON.parse(read(path.join(root, 'userdata', 'server-runtime.json')));
      if (Number.isSafeInteger(runtime.pid) && runtime.pid > 0) pid = runtime.pid;
    } catch {}
    if (!pid) return 'unknown';
    try { kill(pid, 0); return 'alive'; }
    catch (error) { return error.code === 'ESRCH' ? 'exited' : 'unknown'; }
  };
}

export function taskPause(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortedWait());
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(abortedWait()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function trackingOptions(job, save) {
  return {
    onRun: runId => { job.runId = runId; save(); },
    onProgress: status => {
      if (job.trackingStatus === status) return;
      const previous = job.trackingStatus;
      job.trackingStatus = status;
      const text = status === 'waiting_permission' ? 'T3 正等待桌面端确认，请在 T3 处理；确认后桥接会继续跟踪并返回结果。'
        : status === 'reconnecting' ? '与 T3 的连接暂时中断，正在重连；原任务未重新提交。'
          : status === 'running' && previous === 'reconnecting' ? '已恢复 T3 连接，继续跟踪原任务。'
            : status === 'running' && previous === 'waiting_permission' ? 'T3 已继续执行，完成后会返回结果。' : null;
      if (text) {
        job.noticeChunks ||= [];
        job.noticeChunks.push(...splitThreadReply(text, job.replyThread, 1600, job.replyTo || job.command?.text));
      }
      save();
    },
  };
}

export async function waitForJob({ state, job, thread, config, backend, save }) {
  try {
    const result = await backend.wait({ ...config, threadId: thread.threadId, expectedProjectId: thread.projectId }, job.runId, trackingOptions(job, save));
    delete state.untrackedRuns?.[thread.threadId];
    return result;
  } catch (error) {
    if (error.code !== 'T3_WAIT_ABORTED') {
      state.untrackedRuns ||= {};
      state.untrackedRuns[thread.threadId] = { runId: job.runId, projectId: thread.projectId };
      save();
    }
    throw error;
  }
}
