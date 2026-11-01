import test from 'node:test';
import assert from 'node:assert/strict';
import { usageWindow, usageTotals, formatCost, formatToken, formatLimits } from '../src/usage.mjs';
import { withT3Usage, readUsage, readUsageLimits, threadUsage } from '../src/t3-usage.mjs';
import { route, HELP, HELP_EN } from '../src/core.mjs';
import { executeCommand } from '../src/commands.mjs';

const window = usageWindow('today', { now: new Date('2026-11-01T00:30:00Z'), timeZone: 'Asia/Singapore' });
const bucket = (extra = {}) => ({ day: window.untilDay, provider: 'codex', model: 'model',
  totals: { uncachedInputTokens: 100, cachedInputTokens: 50, cacheCreationTokens: 10, outputTokens: 20, reasoningTokens: 7 },
  costUsd: 2.5, costSource: 'modelPriced', records: 2, unpricedRecords: 0, ...extra });
const summary = (buckets = [bucket()]) => ({ contractVersion: 1, readAt: '2026-11-01T00:30:00Z',
  sinceDay: window.sinceDay, untilDay: window.untilDay, timeZone: window.timeZone, buckets,
  sources: [{ status: 'ok', fingerprint: { resolvedHomePath: 'private-path' } }], pricing: { status: 'cached' } });
const limits = (extra = {}) => ({ checkedAt: '2026-11-01T00:00:00Z', windows: [{ id: 'session', kind: 'session',
  label: '5 hours', usedPercent: 25, resetsAt: '2026-11-01T05:00:00Z' }], ...extra });

test('usage ranges use local calendar days, including timezone and DST boundaries', () => {
  const options = { now: new Date('2026-11-01T00:30:00Z'), timeZone: 'Asia/Singapore' };
  assert.equal(window.untilDay, '2026-11-01');
  assert.equal(usageWindow('7天', options).sinceDay, '2026-10-26');
  assert.equal(usageWindow('30d', options).sinceDay, '2026-10-03');
  assert.equal(usageWindow('7d', { ...options, timeZone: 'America/New_York' }).untilDay, '2026-10-31');
  for (const period of ['0', 'all', '-7', 'constructor', '2026-11-01']) assert.throws(() => usageWindow(period, options), /统计范围无效/);
});

test('token sums include cache reads and writes but do not count reasoning output twice', () => {
  const total = usageTotals([bucket()]);
  assert.equal(total.inputTokens, 160);
  assert.equal(total.totalTokens, 180);
  assert.equal(total.reasoningTokens, 7);
  assert.equal(usageTotals([bucket({ totals: {} })]).totalTokens, null);
  assert.equal(usageTotals([bucket({ costUsd: NaN })]).costUsd, null);
});

test('cost distinguishes unpriced records, estimates, partial sources and empty periods', () => {
  const data = summary([bucket(), bucket({ provider: 'other', records: 1, unpricedRecords: 1, costUsd: 0 })]);
  data.sources.push({ status: 'failed', message: 'private failure' }, { status: 'ok', refreshing: true });
  const output = formatCost({ summary: data }, window);
  assert.match(output, /已计价部分：US\$ 2\.50/);
  assert.match(output, /未计价/);
  assert.match(output, /费用合计不完整/);
  assert.match(output, /全部来源/);
  assert.match(output, /后台刷新/);
  assert.match(output, /非实际账单/);
  assert.doesNotMatch(output, /private/);
  assert.match(formatCost({ summary: summary([bucket({ records: 1, unpricedRecords: 1, costUsd: 0 })]) }, window), /尚无可计价记录/);
  assert.match(formatCost({ summary: summary([]) }, window), /暂无可统计记录/);
});

test('token output separates panel totals from current context and keeps zero distinct from missing', () => {
  const output = formatToken({ summary: summary(), context: { usedTokens: 0, maxTokens: 200000 } }, window);
  assert.match(output, /Token 合计：180/);
  assert.match(output, /上下文已用：0/);
  assert.match(output, /上下文上限：200,000/);
  assert.match(output, /占用：0%/);
  assert.match(output, /已计入输出/);
  assert.match(formatToken({ summary: summary(), context: null }, window), /尚未报告/);
  assert.match(formatToken({ summary: summary(), contextError: true }, window), /当前线程用量读取失败/);
});

test('limits expose remaining percentages, reset dates and stale or unsupported snapshots explicitly', () => {
  const output = formatLimits({ partial: true, accounts: [
    { id: 'codex', provider: 'codex', label: 'Codex', limits: limits({ windows: [{ label: 'Session', usedPercent: 0 }] }) },
    { id: 'stale', label: 'Stale', limits: limits({ unavailable: { reason: 'probeFailed' } }) },
    { id: 'unsupported', limits: limits({ windows: [], unavailable: { reason: 'unsupported' } }) },
    { id: 'none', limits: null },
  ] }, 'codex', { timeZone: 'Asia/Singapore' });
  assert.match(output, /Codex〉 ⭐/);
  assert.match(output, /已用 0% · 剩余 100%/);
  assert.match(output, /重置时间：未提供/);
  assert.match(output, /上次快照/);
  assert.match(output, /不支持读取额度/);
  assert.match(output, /未提供额度数据/);
  assert.match(output, /外部额度源读取不完整/);
  assert.match(output, /2026\/11\/01 13:00/);
});

function transport({ respond, open = true, ticketStatus = 200, timeout = 100 } = {}) {
  const calls = [], frames = [], sockets = [], fetches = [];
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; sockets.push(this); if (open) queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    emit(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
    send(raw) { const frame = JSON.parse(raw); frames.push(frame); if (frame._tag === 'Request') queueMicrotask(() => respond?.(this, frame)); }
    close() { this.closed = true; this.dispatchEvent(new Event('close')); }
  }
  return { calls, frames, sockets, fetches, options: { timeout, WebSocketImpl: Socket, readRuntime: () => ({ origin: 'http://127.0.0.1:1234' }),
    cli: async (_, args) => { calls.push(args); return args.includes('issue') ? JSON.stringify({ token: 'private-token', sessionId: 'owned-session' }) : ''; },
    fetchImpl: async (url, options) => { fetches.push({ url, options }); return { ok: ticketStatus === 200, status: ticketStatus,
      json: async () => ({ ticket: 'private-ticket' }), body: { cancel: async () => {} } }; } } };
}
const success = (socket, request, value) => socket.emit({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Success', value } });

test('read RPC uses short-lived scoped credentials and revokes them after successful multiplexed calls', async () => {
  const h = transport({ respond: (socket, request) => { socket.emit({ _tag: 'Ping' }); success(socket, request, { method: request.tag }); } });
  const output = await withT3Usage({}, call => Promise.all([call('server.getConfig', {}), call('server.getUsageSummary', window)]), h.options);
  assert.equal(output.length, 2);
  assert.ok(h.calls[0].includes('orchestration:read') && h.calls[0].includes('diagnostics:read'));
  assert.equal(h.calls[0].includes('orchestration:operate'), false);
  assert.equal(h.calls[0].includes('settings:write'), false);
  assert.deepEqual(h.calls.at(-1), ['auth', 'session', 'revoke', 'owned-session']);
  assert.equal(h.fetches[0].options.redirect, 'error');
  assert.equal(h.fetches[0].options.headers.Authorization, 'Bearer private-token');
  assert.equal(new URL(h.sockets[0].url).searchParams.get('orchestrationProtocol'), '2');
  assert.ok(h.frames.some(frame => frame._tag === 'Pong'));
  assert.ok(h.sockets.every(socket => socket.closed));
});

test('transport refuses remote origins and write RPCs, and never exposes credentials in errors', async () => {
  const h = transport();
  await assert.rejects(withT3Usage({}, async () => {}, { ...h.options, readRuntime: () => ({ origin: 'https://remote.test' }) }), /loopback/);
  assert.deepEqual(h.calls, []);
  await assert.rejects(withT3Usage({}, call => call('provider.consumeResetCredit', {}), h.options), /不支持/);
  assert.equal(h.frames.some(frame => frame._tag === 'Request'), false);
  assert.deepEqual(h.calls.at(-1), ['auth', 'session', 'revoke', 'owned-session']);
  const failed = transport({ ticketStatus: 403 });
  await assert.rejects(withT3Usage({}, async () => {}, failed.options), error => /HTTP 403/.test(error.message) && !/private/.test(error.message));
  assert.deepEqual(failed.calls.at(-1), ['auth', 'session', 'revoke', 'owned-session']);
});

test('RPC rejection, malformed frames, disconnects and timeouts all clean up the read connection', async () => {
  for (const mode of ['reject', 'malformed', 'close', 'timeout', 'open-timeout']) {
    const h = transport({ timeout: 15, open: mode !== 'open-timeout', respond: (socket, request) => {
      if (mode === 'reject') socket.emit({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Failure', cause: 'private server error' } });
      if (mode === 'malformed') socket.dispatchEvent(new MessageEvent('message', { data: 'private invalid json' }));
      if (mode === 'close') socket.close();
    } });
    await assert.rejects(withT3Usage({}, call => call('server.getConfig', {}), h.options), error => !/private/.test(error.message));
    assert.deepEqual(h.calls.at(-1), ['auth', 'session', 'revoke', 'owned-session']);
    assert.ok(h.sockets.every(socket => socket.closed));
  }
});

test('limit subscription reads the initial sources and strips auth, paths, messages and redemption identifiers', async () => {
  const h = transport({ respond: (socket, request) => socket.emit({ _tag: 'Chunk', requestId: request.id, values: [
    { type: 'snapshot', config: { settings: { secret: 'private-settings' }, providers: [
      { instanceId: 'codex', enabled: true, auth: { token: 'private-auth' }, usageLimits: limits({ credentialFingerprint: 'private-fingerprint',
        resetCredits: { availableCount: 2, nextCreditId: 'private-credit' } }) },
      { instanceId: 'disabled', enabled: false, usageLimits: limits() },
    ] } }, { type: 'usageLimitSourcesUpdated', payload: { sources: [{ id: 'source', label: 'Proxy', accounts: [
      { id: 'account', driver: 'codex', email: 'private-email', usageLimits: limits() },
    ] }] } },
  ] }) });
  const result = await readUsageLimits({}, { rpc: (config, action) => withT3Usage(config, action, h.options) });
  assert.equal(result.accounts.length, 2);
  assert.equal(result.partial, false);
  assert.equal(result.accounts[0].limits.resetCredits.availableCount, 2);
  assert.doesNotMatch(JSON.stringify(result), /private|disabled/);
  assert.ok(h.frames.some(frame => frame._tag === 'Ack'));
  assert.ok(h.frames.some(frame => frame._tag === 'Interrupt'));
});

test('limits fall back to a provider snapshot if the source stream fails', async () => {
  const rpc = async (_, action) => action(async tag => {
    if (tag === 'subscribeServerConfig') throw new Error('unavailable');
    return { providers: [{ instanceId: 'codex', enabled: true, usageLimits: limits() }] };
  });
  const result = await readUsageLimits({}, { rpc });
  assert.equal(result.partial, true);
  assert.equal(result.accounts.length, 1);
});

test('usage reads validate the requested date window and extract only the active thread context', async () => {
  const projection = { thread: { id: 'a', activeProviderThreadId: 'active' }, messages: ['private conversation'], providerThreads: [
    { id: 'old', appThreadId: 'a', contextUsage: { usedTokens: 999 }, updatedAt: '2026-11-02' },
    { id: 'active', appThreadId: 'a', contextUsage: { usedTokens: 10, maxTokens: 100, private: 'private' } },
    { id: 'other', appThreadId: 'b', contextUsage: { usedTokens: 888 } },
  ] };
  assert.deepEqual(threadUsage(projection, 'a'), { usedTokens: 10, maxTokens: 100 });
  assert.throws(() => threadUsage(projection, 'b'), /校验失败/);
  const rpc = async (_, action) => action(async tag => tag === 'server.getUsageSummary' ? summary() : projection);
  const result = await readUsage({ threadId: 'a' }, window, { includeContext: true, rpc });
  assert.deepEqual(result.context, { usedTokens: 10, maxTokens: 100 });
  const failure = await readUsage({ threadId: 'b' }, window, { includeContext: true, rpc });
  assert.equal(failure.contextError, true);
  await assert.rejects(readUsage({}, { ...window, sinceDay: '2025-01-01' }, { rpc }), /统计范围不一致/);
});

test('usage commands and Chinese aliases run read queries, including targeted context, without changing selection', async () => {
  assert.deepEqual(route('/费用 7天'), { kind: 'cost', period: '7天' });
  assert.deepEqual(route('/tokens'), { kind: 'token' });
  assert.deepEqual(route('/发送 2 /用量'), { kind: 'token', selector: '2' });
  assert.deepEqual(route('/额度'), { kind: 'limit' });
  assert.deepEqual(route('/new /cost'), { kind: 'cost' });
  assert.ok(HELP.includes('/cost [today|7d|30d]') && HELP_EN.includes('/limit'));
  const state = { jobs: [], routing: { projectId: 'p', threadId: 'a', listedIds: ['a', 'b'] } };
  const rows = ['a', 'b'].map(threadId => ({ threadId, title: threadId, projectId: 'p', link: `https://test/${threadId}`, providerInstanceId: 'codex' }));
  const calls = [];
  const backend = { read: async target => rows.find(row => row.threadId === target.threadId), list: async () => rows,
    usage: async (target, requested, options) => { calls.push([target.threadId, options.includeContext]);
      return { summary: { ...summary(), ...requested }, context: { usedTokens: 10, maxTokens: 100 } }; },
    limits: async target => { calls.push([target.threadId, 'limits']); return { accounts: [] }; } };
  const execute = text => executeCommand({ command: route(text), state, config: { threadId: 'a' }, reference: { projectId: 'p' }, backend, save() {}, job: {} });
  assert.match(await execute('/cost'), /费用合计/);
  assert.match(await execute('/发送 2 /用量'), /上下文已用：10/);
  assert.match(await execute('/limit'), /账户额度/);
  assert.deepEqual(calls, [['a', false], ['b', true], ['a', 'limits']]);
  assert.equal(state.routing.threadId, 'a');
  await assert.rejects(execute('/cost invalid'), /统计范围无效/);
  await assert.rejects(execute('/to 99 /token'));
  assert.equal(calls.length, 3);
  state.routing.threadId = null;
  backend.read = async () => { throw new Error('Thread read must not be needed'); };
  assert.match(await execute('/cost'), /费用合计/);
  assert.match(await execute('/token'), /当前项目尚未选择线程/);
  assert.match(await execute('/limit'), /账户额度/);
  assert.deepEqual(calls.slice(3), [[null, false], [null, false], [null, 'limits']]);
});
