import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { callT3, parseCliJson } from './backend.mjs';
import { localMcpEndpoint } from './t3-control.mjs';

const READ_METHODS = new Set(['server.getUsageSummary', 'server.getConfig',
  'orchestration.getThreadProjection', 'subscribeServerConfig']);

// These are the read RPCs used by T3's usage panel. Credentials and the
// WebSocket ticket stay in memory and are revoked when the connection closes.
export async function withT3Usage(config, action, { cli = callT3, fetchImpl = fetch,
  WebSocketImpl = WebSocket, timeout = 30000, readRuntime = () => {
    const root = config.env?.T3CODE_HOME || process.env.T3CODE_HOME || path.join(os.homedir(), '.t3');
    return JSON.parse(fs.readFileSync(path.join(root, 'userdata', 'server-runtime.json'), 'utf8'));
  } } = {}) {
  const origin = new URL(localMcpEndpoint(readRuntime().origin)).origin;
  const issued = parseCliJson(await cli(config, ['auth', 'session', 'issue', '--subject', 'wechat-usage',
    '--scope', 'orchestration:read', '--scope', 'diagnostics:read', '--ttl', '2m',
    '--label', 'WeChat T3 usage read', '--json'], { timeout: 20000, acceptCodes: [0] }));
  let socket;
  const pending = new Map();
  const failAll = message => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)); }
    pending.clear();
  };
  try {
    if (!issued.token || !issued.sessionId) throw new Error('T3 未返回用量查询凭据。');
    const response = await fetchImpl(new URL('/api/auth/websocket-ticket/rpc', origin), {
      method: 'POST', headers: { Authorization: `Bearer ${issued.token}` },
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`T3 用量连接 HTTP ${response.status}。`); }
    const ticket = await response.json();
    if (typeof ticket.ticket !== 'string' || !ticket.ticket) throw new Error('T3 未返回用量连接票据。');
    const url = new URL('/ws', origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('orchestrationProtocol', '2');
    url.searchParams.set('wsTicket', ticket.ticket);
    socket = new WebSocketImpl(url.href);
    socket.addEventListener('error', () => failAll('T3 用量连接失败，请稍后重试。'));
    socket.addEventListener('close', () => failAll('T3 用量连接已关闭，请稍后重试。'));
    const send = value => socket.send(JSON.stringify(value));
    socket.addEventListener('message', event => {
      try {
        for (const message of [JSON.parse(event.data)].flat()) {
          if (message._tag === 'Ping') { send({ _tag: 'Pong' }); continue; }
          if (message._tag === 'Defect') { failAll('T3 用量服务返回异常。'); continue; }
          const id = String(message.requestId);
          const request = pending.get(id);
          if (!request) continue;
          if (message._tag === 'Chunk' && request.until && Array.isArray(message.values)) {
            request.events.push(...message.values);
            if (request.events.length > 100) throw new Error('Too many events');
            send({ _tag: 'Ack', requestId: id });
            if (!request.until(request.events)) continue;
            send({ _tag: 'Interrupt', requestId: id });
            pending.delete(id); clearTimeout(request.timer); request.resolve(request.events);
          } else if (message._tag === 'Exit') {
            pending.delete(id); clearTimeout(request.timer);
            if (message.exit?._tag !== 'Success') request.reject(new Error('T3 用量请求失败或未获读取权限。'));
            else request.resolve(request.until ? request.events : message.exit.value);
          }
        }
      } catch { failAll('T3 用量响应格式不正确。'); }
    });
    await new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); socket.removeEventListener('open', opened);
        socket.removeEventListener('error', failed); socket.removeEventListener('close', closed);
        error ? reject(error) : resolve(); };
      const opened = () => finish();
      const failed = () => finish(new Error('T3 用量连接失败。'));
      const closed = () => finish(new Error('T3 用量连接已关闭。'));
      const timer = setTimeout(() => finish(new Error('T3 用量连接超时。')), timeout);
      socket.addEventListener('open', opened); socket.addEventListener('error', failed); socket.addEventListener('close', closed);
    });
    let sequence = 0;
    return await action((tag, payload, { until, timeoutMs = timeout } = {}) => {
      if (!READ_METHODS.has(tag)) throw new Error('不支持的 T3 用量读取接口。');
      return new Promise((resolve, reject) => {
        const id = String(++sequence);
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('T3 用量查询超时，请稍后重试。')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer, until, events: [] });
        try { send({ _tag: 'Request', id, tag, payload, headers: [] }); }
        catch { pending.delete(id); clearTimeout(timer); reject(new Error('T3 用量请求发送失败。')); }
      });
    });
  } catch (error) {
    // Never relay socket URLs, tickets, provider error bodies or credentials.
    if (error.message?.startsWith('T3 ') || error.message?.startsWith('不支持的 T3 ')) throw error;
    throw new Error('T3 用量查询失败，请稍后重试。');
  } finally {
    failAll('T3 用量连接已结束。');
    try { socket?.close(); } catch {}
    if (issued.sessionId) await cli(config, ['auth', 'session', 'revoke', issued.sessionId], { timeout: 20000, acceptCodes: [0] });
  }
}

const contextFields = ['usedTokens', 'maxTokens', 'totalProcessedTokens', 'inputTokens', 'cachedInputTokens',
  'outputTokens', 'reasoningOutputTokens', 'lastUsedTokens', 'lastInputTokens', 'lastCachedInputTokens', 'lastOutputTokens'];

export function threadUsage(projection, threadId) {
  if (projection?.thread?.id !== threadId || !Array.isArray(projection.providerThreads)) throw new Error('T3 线程用量校验失败。');
  const active = projection.thread.activeProviderThreadId;
  const candidates = projection.providerThreads.filter(thread => thread.appThreadId === threadId);
  const thread = candidates.find(thread => thread.id === active) || (!active
    ? candidates.toSorted((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] : null);
  if (!thread?.contextUsage) return null;
  return Object.fromEntries(contextFields.filter(key => Number.isFinite(thread.contextUsage[key]) && thread.contextUsage[key] >= 0)
    .map(key => [key, thread.contextUsage[key]]));
}

export function readUsage(config, window, { includeContext = false, rpc = withT3Usage } = {}) {
  return rpc(config, async call => {
    const summary = await call('server.getUsageSummary', {
      sinceDay: window.sinceDay, untilDay: window.untilDay, timeZone: window.timeZone, resolution: 'day',
    });
    if (!Array.isArray(summary?.buckets) || !Array.isArray(summary.sources)) throw new Error('T3 用量汇总格式不正确。');
    if (summary.timeZone !== window.timeZone || summary.sinceDay !== window.sinceDay || summary.untilDay !== window.untilDay) {
      throw new Error('T3 用量统计范围不一致。');
    }
    let context = null, contextError = false;
    if (includeContext) {
      try { context = threadUsage(await call('orchestration.getThreadProjection', { threadId: config.threadId }), config.threadId); }
      catch { contextError = true; }
    }
    return { summary, context, contextError };
  });
}

function cleanLimits(value) {
  if (!value) return null;
  return { checkedAt: value.checkedAt, windows: Array.isArray(value.windows) ? value.windows.map(window => ({
    id: window.id, kind: window.kind, label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt,
  })) : [], unavailable: value.unavailable ? { reason: value.unavailable.reason } : null,
  resetCredits: value.resetCredits ? { availableCount: value.resetCredits.availableCount } : null };
}

export function readUsageLimits(config, { rpc = withT3Usage } = {}) {
  return rpc(config, async call => {
    let providers, sources = [], partial = false;
    try {
      const events = await call('subscribeServerConfig', { usageLimitSources: true, workspaceSnapshotsOnDemand: true }, {
        until: values => values.some(event => event.type === 'snapshot') && values.some(event => event.type === 'usageLimitSourcesUpdated'),
      });
      providers = events.find(event => event.type === 'snapshot')?.config?.providers;
      const sourceEvent = events.find(event => event.type === 'usageLimitSourcesUpdated');
      sources = sourceEvent?.payload?.sources || [];
      partial = !sourceEvent;
    } catch { providers = (await call('server.getConfig', {}))?.providers; partial = true; }
    if (!Array.isArray(providers) || !Array.isArray(sources)) throw new Error('T3 额度快照格式不正确。');
    partial ||= sources.some(source => source.error);
    return { partial, accounts: [
      ...providers.filter(provider => provider.enabled).map(provider => ({ id: provider.instanceId,
        label: provider.displayName || provider.instanceId, provider: provider.instanceId, limits: cleanLimits(provider.usageLimits) })),
      ...sources.flatMap(source => (source.accounts || []).map(account => ({ id: `${source.id}:${account.id}`,
        label: `${source.label || source.id} · ${account.driver}${account.plan ? ' · ' + account.plan : ''}`,
        limits: cleanLimits(account.usageLimits) }))),
    ] };
  });
}
