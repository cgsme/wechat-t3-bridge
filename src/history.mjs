import { emojiNumber } from './core.mjs';

export const HISTORY_PAGE_SIZE = 5;
export const HISTORY_MAX_PAGE = 100;

export function validateHistoryPage(page) {
  if (!Number.isSafeInteger(page) || page < 1 || page > HISTORY_MAX_PAGE) {
    throw new Error(`页码须为 1–${HISTORY_MAX_PAGE} 的整数。用 /history 查看最近对话，/history 2 查看更早一页。`);
  }
  return page;
}

export function formatHistory({ messages, hasMore }, page, selector) {
  const command = selector ? `/to ${selector} /history` : '/history';
  const entries = messages.map(message => `${message.role === 'user' ? '👤 用户' : '🤖 代理'}\n\n${message.text}`);
  const lines = [`【对话历史 · 第 ${emojiNumber(page)} 页】`, '每页最多 5 条，页内按先后顺序显示。', '',
    entries.length ? entries.join('\n\n────────\n\n') : page === 1 ? '暂无对话记录。' : '本页没有可显示的对话记录。'];
  lines.push('', '【翻页】');
  if (hasMore && page < HISTORY_MAX_PAGE) lines.push(`更早：${command} ${page + 1}`);
  if (hasMore && page === HISTORY_MAX_PAGE) lines.push('更早的记录请在 T3 桌面端查看。');
  if (!hasMore) lines.push('已到最早的记录。');
  if (page > 1) lines.push(`更近：${command} ${page - 1}`);
  lines.push(`刷新最近对话：${command}`, '新消息到达后，分页位置会随最新记录变化。');
  return lines.join('\n');
}
