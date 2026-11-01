import { splitThreadReply, threadInfo, threadLabel } from './core.mjs';
import { executeCommand, validateThread, resolveTargetThread } from './commands.mjs';
import { rememberQuestion } from './questions.mjs';
import { projectRouting } from './projects.mjs';
import { describeThread, numberedThread } from './thread-labels.mjs';
import { QUOTE_COMMANDS, rememberInbound, resolveQuote } from './quotes.mjs';
import { queuesByThread } from './command-policy.mjs';
import { waitForJob } from './task-tracking.mjs';

// One dispatcher preserves routing order; independent thread lanes run concurrently.
export function createScheduler({ state, config, reference, backend, save, send, status = () => {},
  now = Date.now, prepareReply, sendAttachment, signal }) {
  if (signal) config = { ...config, signal };
  projectRouting(state, config, reference);
  for (const job of state.jobs) if (job.bound || job.status === 'running') job.projectId ||= state.routing.projectId;
  if (!state.routing.threadInfo && reference.threadId === state.routing.threadId) state.routing.threadInfo = threadInfo(reference);
  const active = new Map();
  const sending = new Set();
  let dispatching = null;
  let fatal;
  const report = () => status({ active: [...active.values()].map(job => ({ id: job.id, threadId: job.threadId, kind: job.command.kind })), maxConcurrent: null });
  const finish = (job, reply) => {
    if (job.replyThread?.threadId) {
      const previous = threadLabel(job.replyThread) + '\n\n';
      job.replyThread = numberedThread(job.replyThread, state);
      if (reply?.startsWith(previous)) reply = threadLabel(job.replyThread) + '\n\n' + reply.slice(previous.length);
    }
    job.chunks = splitThreadReply(reply, job.replyThread, 1600, job.replyTo);
    job.status = 'reply';
    save();
  };
  function launch(job, key, onNewThread) {
    job.replyTo ||= job.text || job.command.text || `/${job.command.kind}`;
    job.replyThread ||= job.threadId === state.routing.threadInfo?.threadId
      ? { ...state.routing.threadInfo } : { threadId: job.threadId || state.routing.threadId, title: '[name unavailable]' };
    active.set(key, job);
    job.status = 'running';
    save();
    report();
    const work = async () => {
      let reply;
      try {
        reply = await executeCommand({ command: job.command, state, config, reference, backend, save, job, onNewThread });
        if (prepareReply) reply = await prepareReply(job, reply);
      }
      catch (error) {
        if (signal?.aborted || error.code === 'T3_WAIT_ABORTED') return;
        reply = job.command.kind === 'new' && job.createdThread
          ? `新线程已创建，任务结果暂未获取。\n${error.message}\n请在 T3 查看任务状态；不会自动重新创建线程或重跑任务。`
          : error.message;
      }
      finish(job, reply);
    };
    return work().catch(error => { fatal = error; }).finally(() => { active.delete(key); report(); }).catch(error => { fatal = error; });
  }
  async function dispatch() {
    for (const job of [...state.jobs]) {
      if (job.status !== 'pending' || job.bound) continue;
      job.replyTo ||= job.text || job.command.text || `/${job.command.kind}${job.command.selector ? ' ' + job.command.selector : ''}`;
      if (job.references?.length && !job.command.selector && !job.threadId && QUOTE_COMMANDS.has(job.command.kind)) {
        try {
          const target = resolveQuote(state, job.peer, job.references);
          const selected = validateThread(await backend.read({ ...config, threadId: target.threadId }), target.projectId);
          if (selected.threadId !== target.threadId) throw new Error('引用目标线程校验失败，指令未发送。');
          job.threadId = selected.threadId;
          job.projectId = selected.projectId;
          job.replyThread = describeThread(selected, { state, backend, config });
          save();
        } catch (error) {
          finish(job, error.message);
          continue;
        }
      }
      if (!job.replyThread && !['projects', 'project'].includes(job.command.kind)) {
        const selectedId = state.routing.threadId;
        if (state.routing.threadInfo?.threadId !== selectedId) {
          // Resolve a migrated routing record once, without changing its target.
          try { state.routing.threadInfo = selectedId ? threadInfo(validateThread(await backend.read({ ...config, threadId: selectedId }), state.routing.projectId)) : null; }
          catch { state.routing.threadInfo = { threadId: selectedId, title: '[name unavailable]' }; }
        }
        job.replyThread = state.routing.threadInfo ? { ...state.routing.threadInfo } : undefined;
        if (job.replyThread?.threadId) {
          job.replyThread = describeThread({ ...job.replyThread, projectId: state.routing.projectId }, { state, backend, config });
          state.routing.threadInfo = { ...job.replyThread };
        }
        save();
      }
      if (queuesByThread(job.command.kind)) {
        if (job.command.selector && !job.threadId) {
          try {
            const target = await resolveTargetThread(job.command.selector, { listedIds: state.routing.listedIds,
              config, projectId: state.routing.projectId, homeProjectId: reference.projectId, backend });
            job.threadId = target.threadId;
            job.projectId = target.projectId;
            job.replyThread = describeThread(target, { state, backend, config });
          } catch (error) {
            finish(job, error.message);
            continue;
          }
        } else job.threadId ||= state.routing.threadId;
        if (!job.threadId) {
          finish(job, '当前项目尚未选择线程，请先发送 /threads 或 /new <要求>。');
          continue;
        }
        job.projectId ||= state.routing.projectId;
        job.bound = true;
        rememberInbound(state, job);
        save();
      } else if (job.command.kind === 'new') {
        // Creating the thread is a routing barrier, waiting for its run is not.
        job.receiptChunks = splitThreadReply('已收到 /new，正在创建新线程。创建确认后会返回线程序号、名称和短ID，请勿重复发送。', job.replyThread, 1600, job.replyTo);
        job.receiptSent = 0;
        let release;
        const ready = new Promise(resolve => { release = resolve; });
        const completion = launch(job, job.id, async (created, result) => {
          job.bound = true;
          rememberInbound(state, job);
          job.noticeChunks = splitThreadReply('新线程已创建并选中。\n首次任务已提交，结果会另行返回。可以继续发送新任务。', job.replyThread, 1600, job.replyTo);
          job.noticeSent = 0;
          save();
          release();
          const outcome = await waitForJob({ state, job, thread: created, config, backend, save });
          return typeof outcome === 'string' ? `新线程任务结果：\n${outcome}` : rememberQuestion(state, created, outcome, save, job.replyTo);
        });
        // Creation failures must also release the routing barrier.
        await Promise.race([ready, completion]);
      } else {
        job.status = 'running';
        save();
        let reply;
        try {
          reply = await executeCommand({ command: job.command, state, config, reference, backend, save, job });
          rememberInbound(state, job);
        }
        catch (error) { reply = error.message; }
        finish(job, reply);
      }
    }
  }
  function tick() {
    if (signal?.aborted) return;
    if (fatal) throw fatal;
    if (!dispatching) dispatching = dispatch().catch(error => { fatal = error; }).finally(() => { dispatching = null; });
    const busy = new Set([...active.values()].map(job => job.threadId));
    for (const job of state.jobs) {
      if (job.status !== 'pending' || !job.bound) continue;
      if (job.cancelled) { finish(job, '任务已取消，未提交到 T3。'); continue; }
      if (busy.has(job.threadId)) continue;
      busy.add(job.threadId);
      launch(job, job.id);
    }
    // Reply failures only delay that job; other replies and tasks keep moving.
    for (const job of state.jobs) {
      const noticePending = (job.receiptSent || 0) < (job.receiptChunks?.length || 0)
        || (job.noticeSent || 0) < (job.noticeChunks?.length || 0);
      if ((job.status !== 'reply' && !noticePending) || sending.has(job.id) || (job.retryAt || 0) > now()) continue;
      if (!noticePending && state.jobs.some(earlier => earlier !== job && state.jobs.indexOf(earlier) < state.jobs.indexOf(job)
        && !earlier.replyFailed && earlier.bound && job.bound && earlier.threadId === job.threadId)) continue;
      sending.add(job.id);
      (async () => {
        // Receipts, creation confirmations and final replies have distinct,
        // persisted message IDs so retries do not lose or mix their progress.
        for (const [chunksKey, sentKey, prefix] of [
          ['receiptChunks', 'receiptSent', 'received'], ['noticeChunks', 'noticeSent', 'start'],
        ]) {
          while ((job[sentKey] || 0) < (job[chunksKey]?.length || 0)) {
            const index = job[sentKey] || 0;
            try { await send(job, job[chunksKey][index], `${prefix}_${index}`); }
            catch (error) { job.replyFailed = true; job.retryAt = now() + 10000; save(); status({ lastError: error.message }); return; }
            job[sentKey] = index + 1;
            save();
          }
        }
        if (job.status !== 'reply') return;
        while (job.sent < job.chunks.length) {
          try { await send(job, job.chunks[job.sent], job.sent); }
          catch (error) { job.replyFailed = true; job.retryAt = now() + 10000; save(); status({ lastError: error.message }); return; }
          job.sent++;
          save();
        }
        while ((job.htmlSent || 0) < (job.htmlAttachments?.length || 0)) {
          const index = job.htmlSent || 0;
          try {
            if (!sendAttachment) throw new Error('当前桥接未配置 HTML 附件发送');
            await sendAttachment(job, job.htmlAttachments[index], index);
          } catch (error) { job.replyFailed = true; job.retryAt = now() + 10000; save(); status({ lastError: error.message }); return; }
          job.htmlSent = index + 1;
          save();
        }
        state.seen.push(job.id);
        state.seen = state.seen.slice(-20000);
        state.jobs.splice(state.jobs.indexOf(job), 1);
        save();
        status({ lastReplyAt: new Date(now()).toISOString() });
      })().catch(error => { fatal = error; }).finally(() => sending.delete(job.id));
    }
    report();
  }
  return { tick };
}
