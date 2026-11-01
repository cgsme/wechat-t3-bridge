import { catalogThreads, describeThread } from './thread-labels.mjs';

export function projectRouting(state, config, reference) {
  state.routing ||= { threadId: config.threadId, listedIds: [] };
  state.routing.projectId ||= reference.projectId;
  state.routing.projectThreads ||= {};
  state.routing.listedProjectIds ||= [];
  return state.routing;
}

export function resolveProject(selector, listedIds, projects, homeId) {
  if (selector.toLowerCase() === 'home') return homeId;
  if (/^[1-9]\d*$/.test(selector)) {
    const id = listedIds[Number(selector) - 1];
    if (!id) throw new Error('项目编号无效，请先发送 /projects 查看项目列表。');
    return id;
  }
  const key = selector.toLowerCase();
  const exact = projects.find(project => project.id.toLowerCase() === key);
  if (exact) return exact.id;
  const named = projects.filter(project => project.title.toLowerCase() === key);
  const matches = named.length ? named : projects.filter(project => project.id.toLowerCase().startsWith(key));
  if (matches.length !== 1) throw new Error(matches.length ? '项目名称或前缀不唯一，请使用完整项目 ID。' : '项目不存在，请发送 /projects 查看。');
  return matches[0].id;
}

export function projectLabel(routing, projectId = routing.projectId) {
  return String((routing.project?.id === projectId ? routing.project.title : null) || projectId).replace(/[\r\n]/g, ' ');
}

export async function readProjectSelection({ config, backend, selector, listedIds, homeId }) {
  const projects = (await backend.projects(config)).filter(project => !project.deletedAt);
  const id = resolveProject(selector, listedIds, projects, homeId);
  const project = await backend.project(config, id);
  if (project.id !== id || project.deletedAt) throw new Error('项目不可用，请用 /projects 重新选择');
  return project;
}

export async function selectProject({ state, config, reference, backend, selector, save }) {
  const routing = projectRouting(state, config, reference);
  const project = await readProjectSelection({ config, backend, selector, listedIds: routing.listedProjectIds, homeId: reference.projectId });
  const id = project.id;
  const threads = (await backend.list(config, id)).filter(thread =>
    thread.projectId === id && !thread.archived && thread.relationshipToParent !== 'subagent');
  catalogThreads(state, threads);
  const remembered = id === routing.projectId ? routing.threadId : routing.projectThreads[id];
  const candidate = threads.find(thread => thread.threadId === remembered) || threads[0];
  let selected;
  if (candidate) {
    selected = await backend.read({ ...config, threadId: candidate.threadId });
    if (selected.threadId !== candidate.threadId || selected.projectId !== id || selected.archived ||
        selected.relationshipToParent === 'subagent') throw new Error('项目线程不可用，请重新选择项目。');
  }
  // Validate before changing routing. In-flight jobs keep their own project IDs.
  if (routing.threadId) {
    routing.projectThreads[routing.projectId] = routing.threadId;
    routing.modelSource = { threadId: routing.threadId, projectId: routing.projectId };
  }
  state.threadLists ||= {};
  state.threadLists[routing.projectId] = [...routing.listedIds];
  const changed = routing.projectId !== id;
  routing.projectId = id;
  routing.project = { id, title: project.title, workspaceRoot: project.workspaceRoot };
  routing.threadId = selected?.threadId || null;
  if (selected) routing.projectThreads[id] = selected.threadId;
  if (changed) routing.listedIds = [...(state.threadLists[id] || [])];
  routing.threadInfo = selected ? describeThread(selected, { state, backend, config }) : null;
  save();
  return { project, selected: selected ? { ...selected, ...routing.threadInfo } : undefined };
}
