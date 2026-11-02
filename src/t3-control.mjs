import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { callT3, parseCliJson } from './backend.mjs';
import { fastMode, fastSelection } from './models.mjs';
import { abortedWait, activeTaskStatuses, endedTaskStatuses, trackingError } from './task-tracking.mjs';

const ALLOWED_TOOLS = new Set(['orchestrator_capabilities', 't3_thread_configure', 't3_pending_request', 't3_project_list', 't3_project_read', 't3_thread_send', 't3_thread_organize', 't3_thread_interrupt', 't3_thread_read', 't3_thread_wait']);

export function localMcpEndpoint(origin) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('T3 control requires a local loopback server.');
  }
  return new URL('/mcp', url).href;
}

export function decodeRpc(text, requestId) {
  const candidates = [];
  try { candidates.push(JSON.parse(text)); } catch {}
  for (const event of text.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data) { try { candidates.push(JSON.parse(data)); } catch {} }
  }
  const message = candidates.flat().find(value => value?.id === requestId && value.jsonrpc === '2.0');
  if (!message || message.error) throw new Error('T3 control request failed. Please check T3.');
  return message.result;
}

// Full-access thread writes use T3's own MCP authorization flow, as the T3 CLI does.
// A CLI-issued one-time pairing credential authorizes this local integration.
export async function issueWriteCredential(config, origin, cli, fetchImpl) {
  const cleanupConfig = { ...config, signal: undefined };
  const label = `WeChat model control ${randomUUID()}`;
  const paired = parseCliJson(await cli(config, ['auth', 'pairing', 'create',
    '--scope', 'orchestration:read', '--scope', 'orchestration:operate',
    '--scope', 'settings:write', '--scope', 'source-control:write',
    '--ttl', '2m', '--label', label, '--json'], { timeout: 20000, acceptCodes: [0] }));
  const post = async (endpoint, body) => {
    const form = body instanceof URLSearchParams;
    const response = await fetchImpl(new URL(endpoint, origin), {
      method: 'POST', headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? body.toString() : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`T3 authorization HTTP ${response.status}.`); }
    return response.json();
  };
  const revoke = async () => {
    // T3 OAuth returns an access token but no session ID; locate the unique label.
    const sessions = parseCliJson(await cli(cleanupConfig, ['auth', 'session', 'list', '--json'], { timeout: 20000, acceptCodes: [0] }));
    if (!Array.isArray(sessions)) throw new Error('T3 session cleanup failed.');
    for (const session of sessions.filter(item => item.client?.label === label)) {
      await cli(cleanupConfig, ['auth', 'session', 'revoke', session.sessionId], { timeout: 20000, acceptCodes: [0] });
    }
  };
  try {
    const callback = 'http://127.0.0.1:1/wechat-t3-callback';
    const registered = await post('/oauth/mcp/register', { client_name: label, redirect_uris: [callback], token_endpoint_auth_method: 'none' });
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('hex');
    const resource = new URL('/mcp', origin).href;
    const decision = await post('/oauth/mcp/decision', { authorization: {
      response_type: 'code', client_id: registered.client_id, redirect_uri: callback,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state, resource,
    }, decision: { _tag: 'pairing-code', access: 'full-access', code: paired.credential } });
    // Read the redirect locally; no callback server or browser is started.
    const redirect = new URL(decision.redirectTo);
    if (redirect.origin !== new URL(callback).origin || redirect.pathname !== new URL(callback).pathname ||
        redirect.searchParams.get('state') !== state || !redirect.searchParams.get('code')) throw new Error('Invalid T3 authorization response.');
    const token = await post('/oauth/mcp/token', new URLSearchParams({ grant_type: 'authorization_code',
      code: redirect.searchParams.get('code'), redirect_uri: callback, client_id: registered.client_id, code_verifier: verifier, resource }));
    if (!token.access_token) throw new Error('T3 did not return a control credential.');
    return { token: token.access_token, revoke };
  } catch (error) {
    await revoke();
    throw error;
  } finally {
    await cli(cleanupConfig, ['auth', 'pairing', 'revoke', paired.id], { timeout: 20000, acceptCodes: [0] });
  }
}

// Only credentials authorized through the local CLI are used; tokens never enter config or logs.
export async function withT3Control(config, action, {
  cli = callT3, fetchImpl = fetch, write = false, readRuntime = () => {
    const root = config.env?.T3CODE_HOME || process.env.T3CODE_HOME || path.join(os.homedir(), '.t3');
    return JSON.parse(fs.readFileSync(path.join(root, 'userdata', 'server-runtime.json'), 'utf8'));
  },
} = {}) {
  let runtime;
  try { runtime = readRuntime(); }
  catch (error) {
    if (error.code === 'ENOENT') throw trackingError('T3_CONNECTION_LOST', 'T3 连接暂不可用。');
    throw trackingError('T3_INVALID_RUNTIME', 'T3 本机连接配置无法读取，请检查桌面端。');
  }
  const endpoint = localMcpEndpoint(runtime.origin);
  const issued = write ? await issueWriteCredential(config, new URL(endpoint).origin, cli, fetchImpl) : parseCliJson(await cli(config, ['auth', 'session', 'issue', '--subject', 'mcp-client',
    '--scope', 'orchestration:read',
    '--ttl', '2m', '--label', 'WeChat T3 model control', '--json'], { timeout: 20000, acceptCodes: [0] }));
  if (!issued.token || (!write && !issued.sessionId)) throw new Error('T3 did not issue a local control credential.');
  let sessionId;
  let sequence = 0;
  let protocol = '2025-06-18';
  const headers = () => ({ Authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocol,
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) });
  const rpc = async (method, params, notification = false) => {
    const id = notification ? undefined : ++sequence;
    let response, text;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', headers: headers(),
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params ? { params } : {}) }),
        signal: config.signal ? AbortSignal.any([config.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel();
        throw trackingError([408, 429, 502, 503, 504].includes(response.status) ? 'T3_CONNECTION_LOST' : 'T3_CONTROL_REJECTED',
          `T3 control HTTP ${response.status}.`);
      }
      text = await response.text();
    } catch (error) {
      if (config.signal?.aborted) throw abortedWait();
      if (error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name)) {
        throw trackingError('T3_CONNECTION_LOST', 'T3 连接中断或请求超时。');
      }
      throw error;
    }
    const nextSession = response.headers.get('mcp-session-id');
    if (nextSession) sessionId = nextSession;
    return notification ? undefined : decodeRpc(text, id);
  };
  try {
    const initialized = await rpc('initialize', { protocolVersion: protocol, capabilities: {},
      clientInfo: { name: 'wechat-t3-bridge', version: '0.3.0' } });
    protocol = initialized.protocolVersion || protocol;
    await rpc('notifications/initialized', undefined, true);
    return await action(async (tool, args) => {
      if (!ALLOWED_TOOLS.has(tool)) throw new Error('Unsupported T3 model control tool.');
      if (tool === 't3_thread_wait' && (!args.threadId || !args.runId || args.timeoutMs !== 1)) {
        throw new Error('Waiting requires an explicit thread, run and a bounded read.');
      }
      if (tool === 't3_thread_interrupt' && (!write || !args.threadId)) throw new Error('Interrupting requires a write credential and an explicit target.');
      if (tool === 't3_thread_organize' && (!write || !['settle', 'unsettle'].includes(args.action) || !args.threadId)) {
        throw new Error('Settling requires a write credential and an explicit target; only settle/unsettle are supported.');
      }
      if (tool === 't3_thread_send' && !write) throw new Error('Steering requires a write credential.');
      if (tool === 't3_pending_request' && args.action === 'respond' && !write) throw new Error('Answering requires a write credential.');
      const result = await rpc('tools/call', { name: tool, arguments: args });
      if (result?.isError || !result?.structuredContent) throw new Error(`T3 rejected ${tool}. Please check the selected thread in T3.`);
      return result.structuredContent;
    });
  } finally {
    if (sessionId) {
      try { await fetchImpl(endpoint, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(5000), redirect: 'error' }); } catch {}
    }
    if (write) await issued.revoke();
    else await cli({ ...config, signal: undefined }, ['auth', 'session', 'revoke', issued.sessionId], { timeout: 20000, acceptCodes: [0] });
  }
}

export function readModelConfig(config) {
  return withT3Control(config, call => call('t3_thread_configure', { threadId: config.threadId }));
}

// Only a live approval card for this run is evidence of required desktop action.
// Cache against the server revision so a stable wait does not reread its history.
async function pendingApproval(call, config, runId, thread) {
  const cache = config.approvalCache;
  if (thread.updatedAt && cache?.runId === runId && cache.updatedAt === thread.updatedAt) return cache.approval;
  let afterPosition, approval;
  for (;;) {
    const page = await call('t3_thread_read', { threadId: config.threadId, view: 'activity', limit: 100,
      runLimit: 1, maxCharsPerItem: 1, ...(afterPosition === undefined ? {} : { afterPosition }) });
    if (page.thread?.threadId !== config.threadId || !Array.isArray(page.items) || typeof page.hasMore !== 'boolean') {
      throw trackingError('T3_INVALID_TASK', 'T3 等待状态校验失败，请在桌面端核对；不会自动重跑。');
    }
    const item = page.items.find(item => item.runId === runId && item.type === 'approval_request'
      && ['pending', 'waiting'].includes(item.status));
    if (item?.itemId) approval = { id: item.itemId, summary: item.title?.replace(/[\r\n]+/g, ' ').slice(0, 160) };
    // Ignore cards if their snapshot no longer agrees with the live task.
    if ((page.thread.activeRunId || page.thread.latestRunId) !== runId || !page.thread.pendingRequestCount
      || thread.updatedAt && page.thread.updatedAt !== thread.updatedAt) return undefined;
    if (approval || !page.hasMore) break;
    if (!Number.isSafeInteger(page.nextPosition) || page.nextPosition < 0
      || afterPosition !== undefined && page.nextPosition <= afterPosition) {
      throw trackingError('T3_INVALID_TASK', 'T3 等待状态分页无效，请在桌面端核对。');
    }
    afterPosition = page.nextPosition;
  }
  if (cache && thread.updatedAt) Object.assign(cache, { runId, updatedAt: thread.updatedAt, approval });
  return approval;
}

// T3's exact-run wait follows restart continuations and does not confuse a
// desktop client's newer turn with this task, including while this task queues.
export async function readTaskState(config, runId, { control = withT3Control } = {}) {
  const parentSignal = config.signal;
  const budget = AbortSignal.timeout(config.trackingTimeoutMs || 45000);
  config = { ...config, signal: parentSignal ? AbortSignal.any([parentSignal, budget]) : budget };
  try { return await control(config, async call => {
    const invalid = () => trackingError('T3_INVALID_TASK', 'T3 任务状态或结果校验失败，请在桌面端核对；不会自动重跑。');
    const waited = await call('t3_thread_wait', { threadId: config.threadId, runId, timeoutMs: 1, untilDelegatedWorkSettled: true });
    if (waited.threadId !== config.threadId || !waited.runId || typeof waited.timedOut !== 'boolean' ||
      !activeTaskStatuses.has(waited.status) && !endedTaskStatuses.has(waited.status) && waited.status !== 'waiting') throw invalid();
    if (waited.resultRun && (!waited.resultRun.runId || !endedTaskStatuses.has(waited.resultRun.status))) throw invalid();
    const result = { threadId: config.threadId, runId: waited.resultRun?.runId || waited.runId,
      status: waited.resultRun?.status || waited.status };
    const snapshot = await call('t3_thread_read', { threadId: config.threadId, limit: 1, runLimit: 1 });
    const thread = snapshot.thread;
    if (thread?.threadId !== config.threadId || thread.archived ||
      config.expectedProjectId && thread.projectId !== config.expectedProjectId) throw invalid();
    const current = (thread.activeRunId || thread.latestRunId) === result.runId;
    if (current && (waited.status === 'waiting' || waited.timedOut && thread.pendingRequestCount > 0)) {
      const request = await readPendingRequest(config, { control: (_, action) => action(call) });
      if (request) return { ...result, status: 'waiting', request };
      const approval = thread.pendingRequestCount > 0 ? await pendingApproval(call, config, result.runId, thread) : undefined;
      return { ...result, status: 'waiting', request: null, ...(approval ? { approval } : {}) };
    }
    if (waited.status === 'waiting') return { ...result, request: null };
    if (waited.timedOut) return { ...result, status: 'running' };
    if (!endedTaskStatuses.has(waited.status)) throw invalid();
    const type = result.status === 'completed' ? 'assistant_message' : 'error';
    let item, afterPosition;
    do {
      const page = await call('t3_thread_read', { threadId: config.threadId,
        view: type === 'error' ? 'activity' : 'messages', limit: 100, runLimit: 1, maxCharsPerItem: 50000,
        ...(afterPosition === undefined ? {} : { afterPosition }) });
      if (page.thread?.threadId !== config.threadId || !Array.isArray(page.items) || typeof page.hasMore !== 'boolean') throw invalid();
      item = page.items.filter(entry => entry.runId === result.runId && entry.type === type).at(-1) || item;
      if (!page.hasMore) break;
      if (!Number.isSafeInteger(page.nextPosition) || page.nextPosition < 0 ||
        afterPosition !== undefined && page.nextPosition <= afterPosition) throw invalid();
      afterPosition = page.nextPosition;
    } while (true);
    let text = item?.text || '', offset = item?.nextTextOffset;
    if (typeof text !== 'string') throw invalid();
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw trackingError('T3_OUTPUT_TOO_LARGE', 'T3 回复过长，请在桌面端查看结果。');
    let truncated = item?.textTruncated;
    while (truncated) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw invalid();
      const page = await call('t3_thread_read', { threadId: config.threadId, itemId: item.itemId,
        textOffset: offset, runLimit: 1, maxCharsPerItem: 50000 });
      const chunk = page.items?.find(entry => entry.itemId === item.itemId && entry.runId === result.runId);
      if (page.thread?.threadId !== config.threadId || !chunk || chunk.textTruncated && chunk.nextTextOffset <= offset) throw invalid();
      text += chunk.text || '';
      offset = chunk.nextTextOffset;
      truncated = chunk.textTruncated;
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw trackingError('T3_OUTPUT_TOO_LARGE', 'T3 回复过长，请在桌面端查看结果。');
    }
    return { ...result, [type === 'error' ? 'error' : 'reply']: text };
  }); } catch (error) {
    if (parentSignal?.aborted) throw abortedWait();
    if (budget.aborted) throw trackingError('T3_CONNECTION_LOST', 'T3 状态查询超时，正在核对连接。');
    throw error;
  }
}

export function readProjects(config, { control = withT3Control } = {}) {
  return control(config, async call => {
    const projects = new Map();
    const cursors = new Set();
    let cursor;
    do {
      const page = await call('t3_project_list', { limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      if (!Array.isArray(page.projects)) throw new Error('T3 项目列表格式不正确');
      for (const project of page.projects) if (project.id && !project.deletedAt) projects.set(project.id, project);
      cursor = page.nextCursor ?? undefined;
      if (cursor !== undefined && cursors.has(cursor)) throw new Error('T3 项目列表分页异常，请重新查询');
      cursors.add(cursor);
    } while (cursor !== undefined);
    return [...projects.values()];
  });
}

export function readProject(config, projectId, { control = withT3Control } = {}) {
  return control(config, async call => {
    const project = await call('t3_project_read', { projectId });
    if (project.id !== projectId || project.deletedAt) throw new Error('项目不可用，请用 /projects 重新选择');
    return project;
  });
}

export function readModelCatalog(config, search) {
  return withT3Control(config, call => call('orchestrator_capabilities', search ? { search } : {}));
}

export function changeModel(config, modelSelection) {
  return withT3Control(config, async call => {
    await call('t3_thread_configure', { threadId: config.threadId, modelSelection });
    const result = await call('t3_thread_configure', { threadId: config.threadId });
    if (result.threadId !== config.threadId || result.modelSelection?.instanceId !== modelSelection.instanceId ||
        result.modelSelection?.model !== modelSelection.model) {
      throw new Error('T3 model change could not be verified. Use /model to check before retrying.');
    }
    return result;
  }, { write: true });
}

async function fastContext(call, threadId) {
  const current = await call('t3_thread_configure', { threadId });
  if (current.threadId !== threadId) throw new Error('T3 Fast 配置与目标线程不一致。');
  const catalog = await call('orchestrator_capabilities', { search: current.modelSelection?.model });
  return { current, catalog };
}

export function readFastConfig(config, { control = withT3Control } = {}) {
  return control(config, async call => {
    const { current, catalog } = await fastContext(call, config.threadId);
    return { ...current, fast: fastMode(current, catalog) };
  });
}

export function changeFastMode(config, enabled, { control = withT3Control } = {}) {
  if (typeof enabled !== 'boolean') throw new Error('Fast 开关必须为 on 或 off。');
  return control(config, async call => {
    const { current, catalog } = await fastContext(call, config.threadId);
    const selection = fastSelection(current, catalog, enabled);
    const mode = fastMode(current, catalog);
    if (mode.enabled === enabled) return { ...current, fast: mode };
    await call('t3_thread_configure', { threadId: config.threadId, modelSelection: selection });
    const result = await call('t3_thread_configure', { threadId: config.threadId });
    if (result.threadId !== config.threadId || result.modelSelection?.instanceId !== selection.instanceId ||
        result.modelSelection?.model !== selection.model) throw new Error('Fast 切换未能核实，请用 /fast 查看实际状态。');
    const fast = fastMode(result, catalog);
    const options = result.modelSelection.options || [];
    if (fast.enabled !== enabled || (current.modelSelection.options || []).some(option => option.id !== 'serviceTier'
      && !options.some(value => value.id === option.id && value.value === option.value))) {
      throw new Error('Fast 切换未能核实，请用 /fast 和 /model 查看实际配置。');
    }
    return { ...result, fast };
  }, { write: true });
}

export function readPendingRequest(config, { control = withT3Control } = {}) {
  return control(config, async call => {
    const result = await call('t3_pending_request', { action: 'list', threadId: config.threadId });
    if (!Array.isArray(result.requestIds)) throw new Error('T3 待答问题列表格式不正确');
    if (!result.requestIds.length) return null;
    const requestId = result.requestIds[0];
    const request = await call('t3_pending_request', { action: 'read', threadId: config.threadId, requestId });
    if (request.requestId !== requestId || !Array.isArray(request.questions) || !request.questions.length) {
      throw new Error('T3 待答问题格式不正确');
    }
    return request;
  });
}

export function respondToRequest(config, requestId, answers, { control = withT3Control } = {}) {
  return control(config, async call => {
    // Re-read on the write connection: an expired request must never be answered.
    const live = await call('t3_pending_request', { action: 'read', threadId: config.threadId, requestId });
    if (live.requestId !== requestId || !Array.isArray(live.questions) ||
        live.questions.some(question => !Object.hasOwn(answers, question.id))) throw new Error('待答问题已变化，请先用 /questions 重新查看');
    return call('t3_pending_request', { action: 'respond', threadId: config.threadId, requestId, answers });
  }, { write: true });
}

export function interruptThread(config, { control = withT3Control } = {}) {
  return control(config, call => call('t3_thread_interrupt', { threadId: config.threadId }), { write: true });
}

export function readRenderedHtml(config, runId, { control = withT3Control } = {}) {
  return control(config, async call => {
    const head = await call('t3_thread_read', { threadId: config.threadId, limit: 1, maxCharsPerItem: 1, runLimit: 1 });
    if (head.thread?.threadId !== config.threadId) throw new Error('HTML 目标线程校验失败');
    let afterPosition = Math.max(0, (head.thread.itemCount || 0) - 100);
    const reports = [];
    for (let page = 0; page < 4; page++) {
      const data = await call('t3_thread_read', { threadId: config.threadId, view: 'activity', afterPosition,
        limit: 100, maxCharsPerItem: 50000, runLimit: 1 });
      if (data.thread?.threadId !== config.threadId || !Array.isArray(data.items)) throw new Error('HTML 页面读取失败');
      for (let item of data.items) {
        if (item.runId !== runId || item.type !== 'dynamic_tool') continue;
        let text = item.text || '';
        if (!text.includes('html_render')) continue;
        for (let part = 0; item.textTruncated && item.nextTextOffset != null && part < 40; part++) {
          const tail = await call('t3_thread_read', { threadId: config.threadId, itemId: item.itemId,
            textOffset: item.nextTextOffset, maxCharsPerItem: 50000, runLimit: 1 });
          const next = tail.items?.find(value => value.itemId === item.itemId && value.runId === runId);
          if (!next || next.nextTextOffset === item.nextTextOffset) break;
          text += next.text || ''; item = next;
        }
        if (item.textTruncated) continue;
        try {
          const tool = JSON.parse(text);
          if (/(?:^|\.)html_render$/.test(tool.toolName) && typeof tool.input?.html === 'string') {
            reports.push({ html: tool.input.html, title: tool.input.title });
          }
        } catch {}
        if (reports.length >= 5) return reports;
      }
      if (!data.hasMore || data.nextPosition == null || data.nextPosition <= afterPosition) break;
      afterPosition = data.nextPosition;
    }
    return reports;
  });
}

export function setThreadSettled(config, settled, { control = withT3Control } = {}) {
  if (typeof settled !== 'boolean' || !config.threadId) throw new Error('settle 操作需要明确的线程和状态。');
  return control(config, call => call('t3_thread_organize', {
    threadId: config.threadId, action: settled ? 'settle' : 'unsettle',
  }), { write: true });
}

export function steerThread(config, message, clientRequestId = randomUUID(), { control = withT3Control } = {}) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('请提供引导内容。');
  return control(config, async call => {
    const result = await call('t3_thread_send', { threadId: config.threadId, message, mode: 'steer', clientRequestId });
    if (result.threadId !== config.threadId || !result.runId || !['steered', 'started', 'queued'].includes(result.delivery)) {
      throw new Error('引导响应未能核实，请在 T3 查看目标任务；不会自动重发。');
    }
    return result;
  }, { write: true });
}
