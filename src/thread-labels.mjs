import { shortThreadId, threadInfo } from './core.mjs';

// The catalog supplies collision checks; only full IDs are used for routing.
// Lists live in persisted state so replies keep their numbers after a restart.

export function catalogThreads(state, threads) {
  state.threadCatalog ||= {};
  for (const thread of threads) if (thread.threadId) state.threadCatalog[thread.threadId] = {
    projectId: thread.projectId, title: thread.title || 'Untitled',
  };
}

export function numberedThread(thread, state) {
  catalogThreads(state, [thread]);
  state.threadLists ||= {};
  const projectId = thread.projectId || state.routing?.projectId || 'default';
  const selected = state.routing && projectId === state.routing.projectId;
  const ids = selected ? (state.routing.listedIds ||= []) : (state.threadLists[projectId] ||= []);
  if (!ids.includes(thread.threadId)) ids.push(thread.threadId);
  state.threadLists[projectId] = ids;
  const known = [...Object.keys(state.threadCatalog), ...Object.values(state.threadLists).flat()];
  return { ...threadInfo(thread), projectId, number: ids.indexOf(thread.threadId) + 1,
    shortId: shortThreadId(thread.threadId, known) };
}

export function describeThread(thread, { state }) {
  // Catalog reads run at startup and with the existing activity polls. A slow
  // list endpoint must never hold a task's execution lane or its final reply.
  return numberedThread(thread, state);
}
