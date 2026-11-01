const RUNNING = new Set(['preparing', 'queued', 'starting', 'running']);
const TASKS = new Set(['task', 'new', 'answer']);

// Capture only accepted WeChat work before recover() converts it to a notice.
// Persist separately because delivering that notice removes the inbox job.
export function recoverTypingTasks(state) {
  const tasks = state.typingTasks ||= [];
  for (const job of state.jobs) {
    if (job.status !== 'running' || !TASKS.has(job.command?.kind === 'chat' ? 'task' : job.command?.kind)) continue;
    const threadId = job.createdThread?.threadId || job.threadId;
    if (job.waitOnly && job.runId && threadId && (job.command?.kind !== 'new' || job.createdThread)) {
      // The resumed inbox job owns its status; a second observer can outlive it.
      for (let index = tasks.length - 1; index >= 0; index--) {
        if (tasks[index].threadId === threadId && tasks[index].runId === job.runId) tasks.splice(index, 1);
      }
      continue;
    }
    if (!threadId || tasks.some(task => task.threadId === threadId && task.runId === job.runId)) continue;
    tasks.push({ threadId, projectId: job.projectId || job.createdThread?.projectId || job.replyThread?.projectId,
      runId: job.runId });
  }
}

export function isRunningThread(thread, projectId) {
  return thread.projectId === projectId && !thread.archived
    && thread.relationshipToParent !== 'subagent' && !thread.parentThreadId
    && !thread.pendingRequestCount && RUNNING.has(thread.status);
}

// Typing belongs to the owner's WeChat conversation, shared by all task lanes.
// Only recovered WeChat tasks need polling; live jobs already carry their status.
export function createTypingIndicator({ state, config, backend, api, owner,
  save = () => {}, status = () => {}, now = Date.now, refreshMs = 5000, pollMs = 5000,
  retryMs = 5000, ticketMs = 5 * 60000 }) {
  let nextPollAt = 0, nextRefreshAt = 0, retryAt = 0;
  let polling = null, updating = null, closing = null, fatal;
  let stopped = false, sentActive = false, cancelNeeded = false;
  let ticket, ticketContext, ticketUntil = 0, replyRevision = 0;

  const wanted = () => !stopped && (state.typingTasks?.length > 0 || state.jobs.some(job =>
    ['pending', 'running'].includes(job.status) && TASKS.has(job.command?.kind)
    && !['waiting_permission', 'reconnecting'].includes(job.trackingStatus)));
  const context = () => state.typingContext || state.jobs.findLast(job => job.context)?.context;

  function refresh() {
    if (updating || now() < retryAt) return;
    if (wanted() ? sentActive && now() < nextRefreshAt : !cancelNeeded) return;
    updating = (async () => {
      try {
        const currentContext = context();
        if (!ticket || ticketContext !== currentContext || now() >= ticketUntil) {
          const result = await api.getConfig(owner, currentContext);
          if (typeof result.typing_ticket !== 'string' || !result.typing_ticket) throw new Error('Missing typing ticket');
          ticket = result.typing_ticket;
          ticketContext = currentContext;
          ticketUntil = now() + ticketMs;
        }
        // A task can finish while getconfig is in flight.
        const active = wanted();
        if (!active && !cancelNeeded) return;
        const revision = replyRevision;
        // A timed-out start may have reached WeChat, so still cancel when idle.
        if (active) cancelNeeded = true;
        await api.sendTyping(owner, ticket, active);
        sentActive = active;
        cancelNeeded = active;
        retryAt = 0;
        nextRefreshAt = revision === replyRevision ? now() + refreshMs : 0;
      } catch {
        ticket = undefined;
        retryAt = now() + retryMs;
        status({ typingError: 'WeChat typing update failed; will retry.' });
        return;
      }
      status({ typing: sentActive, lastTypingAt: new Date(now()).toISOString(), typingError: null });
    })().catch(error => { fatal = error; }).finally(() => {
      updating = null;
      if (!stopped && !fatal) refresh();
    });
  }

  function tick() {
    if (fatal) throw fatal;
    if (stopped) return;
    if (state.typingTasks?.length && !polling && now() >= nextPollAt) {
      polling = (async () => {
        const tasks = [...state.typingTasks];
        const results = await Promise.allSettled(tasks.map(async task => {
          const thread = await backend.read({ ...config, threadId: task.threadId });
          if (!thread || thread.threadId !== task.threadId) throw new Error('Invalid recovered thread');
          return isRunningThread(thread, task.projectId || thread.projectId)
            && (!task.runId || !thread.latestRunId || thread.latestRunId === task.runId);
        }));
        if (!stopped) {
          let changed = false;
          results.forEach((result, index) => {
            if (result.status === 'fulfilled' && !result.value) {
              state.typingTasks.splice(state.typingTasks.indexOf(tasks[index]), 1);
              changed = true;
            }
          });
          if (changed) save();
          status({ activityError: results.some(result => result.status === 'rejected') ? 'T3 activity check failed; will retry.' : null });
        }
      })().catch(error => { fatal = error; }).finally(() => {
        nextPollAt = now() + pollMs;
        polling = null;
        if (!stopped) refresh();
      });
    }
    refresh();
  }

  function replySent() {
    // WeChat may clear typing on any outgoing reply, including another lane's.
    replyRevision++;
    nextRefreshAt = 0;
  }

  function stop() {
    if (!closing) {
      stopped = true;
      closing = (async () => {
        await updating;
        retryAt = 0;
        refresh();
        await updating;
      })();
    }
    return closing;
  }

  return { tick, replySent, stop };
}
