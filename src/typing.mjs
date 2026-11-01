import { catalogThreads } from './thread-labels.mjs';

const RUNNING = new Set(['preparing', 'queued', 'starting', 'running']);
const TASKS = new Set(['task', 'new', 'answer']);

export function isRunningThread(thread, projectId) {
  return thread.projectId === projectId && !thread.archived
    && thread.relationshipToParent !== 'subagent' && !thread.parentThreadId
    && !thread.pendingRequestCount && RUNNING.has(thread.status);
}

// Typing belongs to the owner's WeChat conversation, shared by all task lanes.
// T3 polling and typing requests run independently of each other and of tasks.
export function createTypingIndicator({ state, config, projectId, backend, api, owner,
  status = () => {}, now = Date.now, refreshMs = 5000, pollMs = 5000,
  retryMs = 5000, ticketMs = 5 * 60000 }) {
  let externalRunning = false;
  const projectActivity = new Map();
  let nextPollAt = 0, nextRefreshAt = 0, retryAt = 0;
  let polling = null, updating = null, closing = null, fatal;
  let stopped = false, sentActive = false, cancelNeeded = false;
  let ticket, ticketContext, ticketUntil = 0, replyRevision = 0;

  const wanted = () => !stopped && (externalRunning || state.jobs.some(job =>
    ['pending', 'running'].includes(job.status) && TASKS.has(job.command?.kind)));
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
    if (!polling && now() >= nextPollAt) {
      polling = (async () => {
        let results;
        let projectIds;
        try {
          projectIds = [...new Set([projectId, state.routing?.projectId,
            ...Object.keys(state.routing?.projectThreads || {}), ...state.jobs.map(job => job.projectId)].filter(Boolean))];
          results = await Promise.allSettled(projectIds.map(async id => {
            const threads = await backend.list(config, id);
            if (!Array.isArray(threads)) throw new Error('Invalid thread list');
            catalogThreads(state, threads);
            return threads.some(thread => isRunningThread(thread, id));
          }));
        } catch {
          status({ activityError: 'T3 activity check failed; will retry.' });
          return;
        }
        if (!stopped) {
          results.forEach((result, index) => {
            if (result.status === 'fulfilled') projectActivity.set(projectIds[index], result.value);
          });
          externalRunning = projectIds.some(id => projectActivity.get(id));
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
