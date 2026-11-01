import { createHash } from 'node:crypto';
import { quotedCommands } from './command-policy.mjs';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 2000;
const digest = text => createHash('sha256').update(text).digest('hex');
export const quotePeer = owner => digest(String(owner));
export const QUOTE_COMMANDS = quotedCommands;

export function messageId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return undefined;
  return (typeof value === 'string' || typeof value === 'number') && String(value).length > 0
    && String(value).length <= 160 ? String(value) : undefined;
}

export function quotedReferences(message) {
  return (message.item_list || []).filter(item => item.ref_msg && typeof item.ref_msg === 'object').map(item => {
    const ref = item.ref_msg;
    const text = ref.message_item?.text_item?.text || ref.message_item?.voice_item?.text || ref.title;
    return { ids: [ref.svr_id, ref.message_item?.msg_id].map(messageId).filter(Boolean),
      ...(typeof text === 'string' && text.trim() ? { textHash: digest(text.trim()) } : {}) };
  });
}

export function rememberMessage(state, { peer, threadId, projectId, ids = [], text }, now = Date.now()) {
  if (!peer || !threadId || !projectId) return;
  ids = [...new Set(ids.map(messageId).filter(Boolean))];
  const textHash = typeof text === 'string' && text.trim() ? digest(text.trim()) : undefined;
  if (!ids.length && !textHash) return;
  const records = (state.quoteMessages || []).filter(record => now - record.createdAt < RETENTION_MS
    && !(record.peer === peer && record.threadId === threadId && record.projectId === projectId
      && record.textHash === textHash && JSON.stringify(record.ids) === JSON.stringify(ids)));
  records.push({ peer, threadId, projectId, ids, textHash, createdAt: now });
  state.quoteMessages = records.slice(-MAX_RECORDS);
}

export function rememberInbound(state, job, now = Date.now()) {
  if (!QUOTE_COMMANDS.has(job.command.kind) && job.command.kind !== 'new') return;
  const thread = job.replyThread;
  rememberMessage(state, { peer: job.peer, threadId: job.threadId || thread?.threadId,
    projectId: job.projectId || thread?.projectId, ids: [job.sourceMessageId], text: job.text }, now);
}

export async function sendTrackedReply({ api, state, owner, job, chunk, index, save }) {
  const clientId = `t3_${job.id.slice(0, 32)}_${index}`;
  const result = await api.send(owner, job.context, chunk, clientId);
  if ((QUOTE_COMMANDS.has(job.command.kind) || job.command.kind === 'new')
    && !String(index).startsWith('received_') && job.replyThread?.threadId) {
    rememberMessage(state, { peer: quotePeer(owner), ...job.replyThread,
      ids: [result?.message_id, clientId], text: chunk });
    save();
  }
  return result;
}

export function resolveQuote(state, peer, references, now = Date.now()) {
  const records = (state.quoteMessages || []).filter(record => record.peer === peer && now - record.createdAt < RETENTION_MS);
  let target;
  for (const reference of references) {
    const byId = records.filter(record => reference.ids.some(id => record.ids.includes(id)));
    const matches = byId.length ? byId : records.filter(record => reference.textHash && record.textHash === reference.textHash);
    if (!matches.length) throw new Error('无法识别引用消息所属线程，指令未发送。请用 /to <编号或ID> <指令> 指定目标；更新前的旧消息或过期引用可能没有记录。');
    for (const record of matches) {
      if (target && (target.threadId !== record.threadId || target.projectId !== record.projectId)) {
        throw new Error('引用消息对应多个线程，指令未发送。请用 /to <编号或ID> <指令> 明确指定目标。');
      }
      target = { threadId: record.threadId, projectId: record.projectId };
    }
  }
  return target;
}
