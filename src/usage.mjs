const counts = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const decimals = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const text = value => String(value ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 160);
const count = value => valid(value) ? counts.format(value) : '未提供';
const money = value => valid(value) ? 'US$ ' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '未提供';

export function usageWindow(period = 'today', { now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const ranges = { today: 1, 今天: 1, 今日: 1, '1d': 1, '7d': 7, '7天': 7, '7': 7, '30d': 30, '30天': 30, '30': 30 };
  const key = String(period).toLowerCase();
  const days = Object.hasOwn(ranges, key) ? ranges[key] : null;
  if (!days) throw new Error('统计范围无效。用法：/cost [today|7d|30d] 或 /token [今天|7天|30天]。');
  const untilDay = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const start = new Date(untilDay + 'T00:00:00Z'); start.setUTCDate(start.getUTCDate() - days + 1);
  return { sinceDay: start.toISOString().slice(0, 10), untilDay, timeZone, label: days === 1 ? '今天' : `近 ${days} 天` };
}

function timestamp(value, timeZone) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date) : '未提供';
}

function sum(buckets, getter) {
  const values = buckets.map(getter);
  return values.every(valid) ? values.reduce((total, value) => total + value, 0) : null;
}

export function usageTotals(buckets) {
  const result = Object.fromEntries(['uncachedInputTokens', 'cachedInputTokens', 'cacheCreationTokens', 'outputTokens', 'reasoningTokens']
    .map(key => [key, sum(buckets, bucket => bucket.totals?.[key])]));
  const input = [result.uncachedInputTokens, result.cachedInputTokens, result.cacheCreationTokens];
  result.inputTokens = input.every(valid) ? input.reduce((a, b) => a + b, 0) : null;
  result.totalTokens = valid(result.inputTokens) && valid(result.outputTokens) ? result.inputTokens + result.outputTokens : null;
  result.costUsd = sum(buckets, bucket => bucket.costUsd);
  result.records = sum(buckets, bucket => bucket.records);
  result.unpriced = sum(buckets, bucket => bucket.unpricedRecords);
  return result;
}

function summaryNotes(summary, window) {
  const failed = summary.sources.filter(source => ['partial', 'failed', 'missing'].includes(source.status)).length;
  const refreshing = summary.sources.some(source => source.refreshing);
  return [
    ...(failed ? [`数据完整性：${failed} 个来源未就绪或仅有部分数据。`] : []),
    ...(refreshing ? ['部分来源正在后台刷新，可稍后重新查询。'] : []),
    `T3 读取时间：${timestamp(summary.readAt, window.timeZone)}`,
  ];
}

function heading(title, window) {
  return [`【${title} · ${window.label}】`, `${window.sinceDay} ～ ${window.untilDay} · ${window.timeZone}`,
    '范围：本机 T3 用量面板的全部来源。', ''];
}

export function formatCost({ summary }, window) {
  const total = usageTotals(summary.buckets);
  const groups = new Map();
  for (const bucket of summary.buckets) {
    if (!groups.has(bucket.provider)) groups.set(bucket.provider, []);
    groups.get(bucket.provider).push(bucket);
  }
  const unpriced = valid(total.unpriced) && total.unpriced > 0;
  const noPriced = valid(total.records) && total.records > 0 && total.unpriced === total.records;
  return [...heading('费用', window),
    noPriced ? '费用：尚无可计价记录。' : `${unpriced ? '已计价部分' : '费用合计'}：${money(total.costUsd)}`,
    `用量记录：${count(total.records)} 条`,
    ...(!summary.buckets.length ? ['当前时间范围暂无可统计记录。'] : []), '',
    ...[...groups].map(([provider, buckets]) => {
      const value = usageTotals(buckets);
      return `• ${text(provider)}：${value.records > 0 && value.unpriced === value.records ? '未计价' : money(value.costUsd)}${value.unpriced ? `（另有 ${count(value.unpriced)} 条未计价）` : ''}`;
    }), '',
    ...(unpriced ? [`有 ${count(total.unpriced)} 条记录未定价，费用合计不完整。`] : []),
    `定价：${({ fresh: '最新', cached: '缓存', unavailable: '不可用' })[summary.pricing?.status] || '未提供'}`,
    '包含提供商报告值或 T3 按模型定价计算的估算，非实际账单。',
    ...summaryNotes(summary, window), '', '/cost 7d  查看近 7 天', '/cost 30d  查看近 30 天',
  ].join('\n');
}

export function formatToken({ summary, context, contextError, noThread }, window) {
  const total = usageTotals(summary.buckets);
  const contextLines = noThread ? ['当前项目尚未选择线程。'] : !context ? [contextError ? '当前线程用量读取失败。' : '提供商尚未报告当前线程上下文用量。'] : [
    `上下文已用：${count(context.usedTokens)}`, `上下文上限：${count(context.maxTokens)}`,
    ...(valid(context.usedTokens) && valid(context.maxTokens) && context.maxTokens > 0
      ? [`占用：${decimals.format(context.usedTokens / context.maxTokens * 100)}%`] : []),
    ...(valid(context.totalProcessedTokens) ? [`累计处理：${count(context.totalProcessedTokens)}`] : []),
    ...(valid(context.lastUsedTokens) ? [`最近一次：${count(context.lastUsedTokens)}`] : []),
  ];
  return [...heading('Token 用量', window),
    `Token 合计：${count(total.totalTokens)}`, `输入合计：${count(total.inputTokens)}`,
    `• 普通输入：${count(total.uncachedInputTokens)}`, `• 缓存读取：${count(total.cachedInputTokens)}`,
    `• 缓存写入：${count(total.cacheCreationTokens)}`, `输出：${count(total.outputTokens)}`,
    `推理：${count(total.reasoningTokens)}（已计入输出，不重复相加）`, '',
    '【当前线程上下文】', ...contextLines, '', ...summaryNotes(summary, window), '',
    '/token 7d  查看近 7 天', '/token 30d  查看近 30 天',
  ].join('\n');
}

export function formatLimits({ accounts, partial }, selectedProvider, { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  if (!Array.isArray(accounts)) throw new Error('T3 额度数据格式不正确。');
  const lines = ['【账户额度】', '范围：本机 T3 提供商及外部额度源的账户快照。', '⭐ 为当前线程的提供商；额度按账户共享。', ''];
  for (const account of accounts) {
    lines.push(`〈${text(account.label || account.id)}〉${account.provider === selectedProvider ? ' ⭐' : ''}`);
    const limits = account.limits;
    if (!limits) { lines.push('未提供额度数据。', ''); continue; }
    const unavailable = limits.unavailable?.reason;
    if (unavailable === 'unsupported') lines.push('此提供商不支持读取额度。');
    else if (unavailable) lines.push('最近一次读取失败；下列数值如有显示，为上次快照。');
    if (!limits.windows?.length && unavailable !== 'unsupported') lines.push('暂无可用的额度窗口数据。');
    for (const window of limits.windows || []) {
      const percent = window.usedPercent;
      lines.push(valid(percent) && percent <= 100 ? `${text(window.label || window.kind)}：已用 ${decimals.format(percent)}% · 剩余 ${decimals.format(100 - percent)}%`
        : `${text(window.label || window.kind)}：使用比例未提供`);
      lines.push(`重置时间：${timestamp(window.resetsAt, timeZone)}`);
    }
    if (valid(limits.resetCredits?.availableCount)) lines.push(`可用重置额度：${count(limits.resetCredits.availableCount)}`);
    lines.push(`快照时间：${timestamp(limits.checkedAt, timeZone)}`, '');
  }
  if (!accounts.length) lines.push('T3 暂未返回账户额度。', '');
  if (partial) lines.push('外部额度源读取不完整，当前仅显示已取得的提供商快照。');
  lines.push(`时区：${timeZone}`, '读取失败或不支持不代表剩余额度为零。');
  return lines.join('\n');
}
