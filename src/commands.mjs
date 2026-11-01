import { HELP, HELP_EN, bareThreadId, shortThreadId, threadInfo, threadLabel, statusLabel, emojiNumber } from './core.mjs';
import { catalogModels, listedModels, resolveModel, modelSelection, modelLabel, formatModels, fastLabel } from './models.mjs';
import { answerQuestion, rememberQuestion, formatQuestion } from './questions.mjs';
import { projectRouting, projectLabel, selectProject, readProjectSelection } from './projects.mjs';
import { formatHistory, validateHistoryPage } from './history.mjs';
import { catalogThreads, describeThread } from './thread-labels.mjs';
import { usageWindow, formatCost, formatToken, formatLimits } from './usage.mjs';
import { listSkills, skillPrompt } from './skills.mjs';
import { supportsTarget } from './command-policy.mjs';
import { activeTaskStatuses, waitForJob } from './task-tracking.mjs';

export function validateThread(thread, projectId) {
  if (!thread?.threadId || thread.projectId !== projectId || thread.archived || thread.relationshipToParent === 'subagent') {
    throw new Error('该线程不可用或不属于当前项目，请使用 /threads 查看可用线程');
  }
  if (!thread.link) throw new Error('T3 未返回线程链接');
  return thread;
}

export { threadLabel };

export function resolveSelector(selector, listedIds, available, homeId) {
  if (/^#\d+$/.test(selector)) selector = selector.slice(1);
  if (selector.toLowerCase() === 'home') return homeId;
  if (/^[1-9]\d*$/.test(selector)) {
    const id = listedIds[Number(selector) - 1];
    if (!id) throw new Error('Invalid thread number. Run /threads first.');
    return id;
  }
  const exact = available.find(thread => thread.threadId.toLowerCase() === selector.toLowerCase());
  if (exact) return exact.threadId;
  const key = selector.toLowerCase();
  const raw = available.filter(thread => thread.threadId.toLowerCase().startsWith(key));
  const matches = raw.length ? raw : available.filter(thread => bareThreadId(thread.threadId).toLowerCase().startsWith(key));
  if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous thread prefix. Use a longer ID.' : 'Thread not found. Run /threads first.');
  return matches[0].threadId;
}

export async function resolveTargetThread(selector, { listedIds = [], config, projectId, homeProjectId = projectId, backend }) {
  if (selector.toLowerCase() === 'home') projectId = homeProjectId;
  const available = (await backend.list(config, projectId)).filter(thread =>
    thread.projectId === projectId && !thread.archived && thread.relationshipToParent !== 'subagent');
  const id = resolveSelector(selector, listedIds, available, config.threadId);
  const thread = validateThread(await backend.read({ ...config, threadId: id }), projectId);
  if (thread.threadId !== id) throw new Error('T3 目标线程校验失败，任务未发送。');
  return thread;
}

export async function executeCommand({ command, state, config, reference, backend, save, job, onNewThread }) {
  const routing = projectRouting(state, config, reference);
  const targetProjectId = job.projectId || routing.projectId;
  // The scheduler normally resolves /to before queueing. Direct callers use
  // the same resolver, while persisted bound jobs always retain their target.
  if (command.selector && !job.threadId && supportsTarget(command.kind)) {
    const selected = await resolveTargetThread(command.selector, {
      listedIds: routing.listedIds, config, projectId: routing.projectId, homeProjectId: reference.projectId, backend,
    });
    job.threadId = selected.threadId;
    job.projectId = selected.projectId;
    job.replyThread = describeThread(selected, { state, backend, config });
    save();
  }
  const readSelected = async id => {
    if (!id) throw new Error('当前项目尚未选择线程，请先用 /threads 选择，或用 /new <要求> 新建任务线程。');
    const selected = validateThread(await backend.read({ ...config, threadId: id }), job.projectId || targetProjectId);
    if (selected.threadId !== id) throw new Error('T3 目标线程校验失败，任务未发送。');
    job.replyThread = describeThread(selected, { state, backend, config });
    save();
    return { ...selected, ...job.replyThread };
  };
  const available = async () => (await backend.list(config, routing.projectId))
    .filter(thread => thread.projectId === routing.projectId && !thread.archived && thread.relationshipToParent !== 'subagent');

  if (job.waitOnly && job.runId && job.threadId) {
    const selected = { ...(job.createdThread || job.replyThread), threadId: job.threadId, projectId: job.projectId || targetProjectId };
    const result = await waitForJob({ state, job, thread: selected, config, backend, save });
    return typeof result === 'string' ? result : rememberQuestion(state, selected, result, save, job.replyTo || command.text);
  }

  switch (command.kind) {
    case 'skills': {
      const query = (command.search || '').toLowerCase();
      const skills = listSkills(config).filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query));
      return skills.length ? '【本机技能】\n\n' + skills.map(skill => `${skill.name}\n${skill.description}`).join('\n\n')
        + '\n\n使用：/task --skill <名称> <要求>\n新建：/new --skill <名称> <要求>\n多个技能用逗号分隔。' : '没有找到匹配的本机技能。';
    }
    case 'help': return command.language === 'en' ? HELP_EN : HELP;
    case 'error': return command.text;
    case 'cost':
    case 'token': {
      const window = usageWindow(command.period);
      const id = job.threadId || routing.threadId;
      const selected = id ? await readSelected(id) : null;
      const report = await backend.usage({ ...config, threadId: selected?.threadId || null }, window, { includeContext: command.kind === 'token' && !!selected });
      return `${selected ? threadLabel(selected) + '\n\n' : ''}${command.kind === 'cost' ? formatCost(report, window) : formatToken({ ...report, noThread: !selected }, window)}`;
    }
    case 'limit': {
      const id = job.threadId || routing.threadId;
      const selected = id ? await readSelected(id) : null;
      return `${selected ? threadLabel(selected) + '\n\n' : ''}${formatLimits(await backend.limits({ ...config, threadId: selected?.threadId || null }), selected?.providerInstanceId)}`;
    }
    case 'settle':
    case 'unsettle': {
      const selected = await readSelected(job.threadId || routing.threadId);
      const settled = command.kind === 'settle';
      const label = settled ? '已 settle（收起）' : '已 unsettle（恢复显示）';
      if (selected.settled === settled) return `${threadLabel(selected)}\n\n【线程状态】\n当前${label}，无需重复操作。`;
      const result = await backend.setSettled({ ...config, threadId: selected.threadId }, settled);
      const updated = await readSelected(selected.threadId);
      if (updated.settled !== settled) {
        if (settled && result?.settlesWhenTurnEnds === true) {
          return `${threadLabel(updated)}\n\n【settle 已提交】\nT3 将在当前回合结束后处理；尚未确认收起。\n请稍后用 /threads --settle 核对。`;
        }
        throw new Error(`${command.kind} 已提交，但实际状态未能确认。请用 /threads --settle 核对；不会自动重试。`);
      }
      return `${threadLabel(updated)}\n\n【线程状态已更新】\n${label}\n\n/threads --settle  查看全部线程\n当前选中线程未改变。`;
    }
    case 'steer': {
      const selected = await readSelected(job.threadId || routing.threadId);
      if (state.pendingInputs?.[selected.threadId] || selected.pendingRequestCount > 0 || selected.status === 'waiting') {
        return '当前线程正在等待回答或确认，本条引导未提交。请先用 /questions 查看问题，并用 /answer 回答；权限确认请在 T3 处理。';
      }
      const result = await backend.steer({ ...config, threadId: selected.threadId }, command.text,
        job.id ? `wechat-steer-${job.id}` : undefined);
      job.runId = result.runId;
      save();
      const delivery = { steered: '已将补充指令送入正在运行的任务。', started: '线程当前空闲，已作为新任务启动。',
        queued: 'T3 已接收指令并排队，尚未即时引导当前任务。' }[result.delivery];
      return `${threadLabel(selected)}\n\n${delivery}\n用 ${command.selector ? `/to ${command.selector} /history` : '/history'} 查看任务结果。`;
    }
    case 'stop': {
      const selected = await readSelected(job.threadId || routing.threadId);
      // Persist cancellation before contacting T3 so queued work cannot restart it.
      let count = 0;
      for (const queued of state.jobs) {
        if (queued !== job && queued.status === 'pending' && queued.bound && queued.threadId === selected.threadId
            && ['task', 'answer'].includes(queued.command.kind)) {
          queued.cancelled = true;
          count++;
        }
      }
      save();
      await backend.interrupt({ ...config, threadId: selected.threadId });
      delete state.pendingInputs?.[selected.threadId];
      save();
      return `${threadLabel(selected)}\n\n已向 T3 提交停止请求，并取消 ${count} 条桥接排队任务。\n请用 /status 核对线程状态。`;
    }
    case 'history': {
      const page = validateHistoryPage(command.page ?? 1);
      const selected = await readSelected(job.threadId || routing.threadId);
      const history = await backend.history({ ...config, threadId: selected.threadId }, page);
      return `${threadLabel(selected)}\n\n${formatHistory(history, page, command.selector)}`;
    }
    case 'projects': {
      const projects = (await backend.projects(config)).filter(project => !project.deletedAt);
      routing.listedProjectIds = projects.map(project => project.id);
      save();
      return projects.length ? ['【项目列表】', '', ...projects.map((project, index) =>
        `${emojiNumber(index + 1)} ${String(project.title || 'Untitled').replace(/[\r\n]/g, ' ')}${project.id === routing.projectId ? '  ⭐ 当前' : ''}\n${project.id}`),
      '', '选择：/project <编号、名称或ID前缀>', '查看线程：/threads', '新建任务：/new <要求>'].join('\n\n') : '当前没有可用项目。';
    }
    case 'project': {
      if (!command.selector) {
        const project = await backend.project(config, routing.projectId);
        if (project.id !== routing.projectId || project.deletedAt) throw new Error('项目不可用，请用 /projects 重新选择');
        return `【当前项目】\n${project.title}\n${project.id}\n\n新建线程将属于此项目。\n/projects  查看项目\n/project <编号或名称>  选择项目\n/threads  查看项目线程`;
      }
      const { project, selected } = await selectProject({ state, config, reference, backend, selector: command.selector, save });
      job.replyThread = selected ? describeThread(selected, { state, backend, config }) : undefined;
      return `${selected ? threadLabel(job.replyThread) + '\n\n' : ''}【项目已选择】\n${project.title}\n${project.id}\n\n${selected ? '已恢复或选中项目内的可用线程。\n/threads  查看其他线程' : '此项目暂无可用线程。'}\n/new <要求>  在此项目新建任务线程`;
    }
    case 'questions': {
      const selected = await readSelected(job.threadId || routing.threadId);
      const request = await backend.pending({ ...config, threadId: selected.threadId });
      if (!request) {
        if (state.pendingInputs) delete state.pendingInputs[selected.threadId];
        save();
        return `${threadLabel(selected)}\n\n【待回答】\n当前线程没有待补充的问题。\n\n权限确认仍需在 T3 桌面端处理。`;
      }
      return rememberQuestion(state, selected, { request, runId: selected.latestRunId }, save);
    }
    case 'unsupported': return 'Text and transcribed voice are supported. Please describe your request in text.';
    case 'fast': {
      const selected = await readSelected(job.threadId || routing.threadId);
      const target = { ...config, threadId: selected.threadId };
      const changing = typeof command.enabled === 'boolean';
      const current = await (changing ? backend.setFast(target, command.enabled) : backend.fastConfig(target));
      if (current.threadId !== selected.threadId || (changing && (!current.fast?.supported || current.fast.enabled !== command.enabled))) {
        throw new Error('Fast 状态未能核实，请用 /fast 查看实际状态。');
      }
      const control = command.selector ? `/to ${command.selector} /fast` : '/fast';
      return `${threadLabel(selected)}\n\n【Fast 模式】\nFast：${fastLabel(current.fast)}\n模型：${current.modelSelection.instanceId}::${current.modelSelection.model}\n\n${control} on  开启\n${control} off  关闭${changing ? '\n后续任务使用此设置，正在运行的任务不会重启。' : ''}${command.selector ? '\n当前选中线程未改变。' : ''}`;
    }
    case 'models': {
      const selected = await readSelected(job.threadId || routing.threadId);
      const target = { ...config, threadId: selected.threadId };
      const current = await backend.modelConfig(target);
      if (current.threadId !== selected.threadId) throw new Error('T3 model configuration does not match the selected thread.');
      const catalog = await backend.catalog(target, command.search);
      const reply = formatModels(catalog, current.modelSelection, command.search);
      state.modelLists ||= {};
      state.modelLists[selected.threadId] = listedModels(catalog).map(entry => ({ provider: entry.provider, model: entry.model }));
      save();
      return reply;
    }
    case 'model': {
      const selected = await readSelected(job.threadId || routing.threadId);
      const target = { ...config, threadId: selected.threadId };
      const current = await backend.modelConfig(target);
      if (current.threadId !== selected.threadId) throw new Error('T3 model configuration does not match the selected thread.');
      if (!command.name) return `${threadLabel(selected)}\n\n【当前模型】\n${modelLabel(current)}\n\n切换：/model <序号或模型ID>\n搜索：/models <关键词>`;
      // Search the live catalog so models omitted from the summary remain usable.
      const number = command.name.match(/^#?(\d+)$/);
      const ordinal = number ? Number(number[1]) : null;
      const saved = number ? state.modelLists?.[selected.threadId]?.[ordinal - 1] : null;
      if (number && (!Number.isSafeInteger(ordinal) || ordinal < 1 || typeof saved?.provider !== 'string' || typeof saved?.model !== 'string')) {
        throw new Error('模型序号无效。请先在当前线程发送 /models 或 /模型列表，再按返回的序号切换。');
      }
      const search = number ? saved.model : command.name.includes('::') ? command.name.split('::').slice(1).join('::') : command.name;
      const models = catalogModels(await backend.catalog(target, search));
      const entry = number ? models.find(model => model.provider === saved.provider && model.model === saved.model)
        : resolveModel(command.name, models, current.modelSelection);
      if (!entry) throw new Error('上次列表中的模型已不可用或提供商已禁用。请重新发送 /models 或 /模型列表。');
      if (entry.provider === current.modelSelection.instanceId && entry.model === current.modelSelection.model) {
        return `${threadLabel(selected)}\n\n【当前模型】\n已选中该模型。\n\n${modelLabel(current)}`;
      }
      const updated = await backend.setModel(target, modelSelection(entry, current.modelSelection));
      if (updated.threadId !== selected.threadId || updated.modelSelection?.instanceId !== entry.provider || updated.modelSelection?.model !== entry.model) {
        throw new Error('T3 model change could not be verified. Use /model to check before retrying.');
      }
      return `${threadLabel(selected)}\n\n【模型已切换】\n${modelLabel(updated)}\n\n后续消息和任务使用此模型。`;
    }
    case 'threads': {
      const all = await available();
      const visible = command.includeSettled ? all : all.filter(thread => !thread.settled);
      const threads = visible.slice(0, 30);
      routing.listedIds = threads.map(thread => thread.threadId);
      state.threadLists ||= {};
      state.threadLists[routing.projectId] = routing.listedIds;
      catalogThreads(state, all);
      save();
      return threads.length ? ['【线程列表】', `项目：${projectLabel(routing)}`, `显示 ${threads.length} / ${visible.length} 个线程 · ⭐ 当前选中`,
        command.includeSettled ? '范围：包含已 settle 的线程' : '范围：未 settle 的线程 · /threads --settle 查看全部', '',
        threads.map((thread, index) => `${threadLabel({ ...thread, number: index + 1,
          shortId: shortThreadId(thread.threadId, Object.keys(state.threadCatalog)) })}${thread.threadId === routing.threadId ? '  ⭐ 当前' : ''}\n${statusLabel(thread.status)}${thread.settled ? ' · 💤 已 settle' : ''}`).join('\n\n'),
        '', '【切换线程】', '/switch <编号或ID前缀>', '/switch home  返回初始线程',
        '', '【直接发送任务】', '/to <编号或ID前缀> <要求>', '保持当前选中线程不变。',
        '编号以上次列表为准。',
      ].join('\n') : `【线程列表】\n项目：${projectLabel(routing)}\n${all.length && !command.includeSettled ? '当前项目暂无未 settle 的线程。\n\n/threads --settle  查看包含已 settle 的线程' : '当前项目暂无可用线程。'}\n\n新建：/new <要求>`;
    }
    case 'switch': {
      const selected = await resolveTargetThread(command.selector, { listedIds: routing.listedIds || [], config,
        projectId: routing.projectId, homeProjectId: reference.projectId, backend });
      if (routing.threadId) routing.projectThreads[routing.projectId] = routing.threadId;
      if (routing.projectId !== selected.projectId) {
        state.threadLists ||= {};
        state.threadLists[routing.projectId] = [...routing.listedIds];
        routing.projectId = selected.projectId;
        routing.project = null;
        routing.listedIds = [...(state.threadLists[selected.projectId] || [])];
      }
      routing.threadId = selected.threadId;
      routing.threadInfo = describeThread(selected, { state, backend, config });
      routing.projectThreads[routing.projectId] = selected.threadId;
      job.replyThread = routing.threadInfo;
      save();
      return `${threadLabel(job.replyThread)}\n\n【线程已切换】\n${statusLabel(selected.status)}\n\n后续消息将发送到此线程。`;
    }
    case 'status': {
      if (!job.threadId && !routing.threadId) return `【连接状态】\n🟢 微信已连接\n项目：${projectLabel(routing)}\n\n项目暂无选中线程。\n/new <要求>  新建任务线程\n/projects  查看项目`;
      const selected = await readSelected(job.threadId || routing.threadId);
      const control = command.selector ? `/to ${command.selector} /fast` : '/fast';
      let fast = `未知（读取失败，请用 ${control} 重试）`;
      try {
        const current = await backend.fastConfig({ ...config, threadId: selected.threadId });
        if (current.threadId !== selected.threadId) throw new Error('Fast thread mismatch');
        fast = fastLabel(current.fast);
      } catch {}
      return `${threadLabel(selected)}\n\n【连接状态】\n🟢 微信已连接\n项目：${projectLabel(routing, selected.projectId)}\n${command.selector ? '目标' : '当前'}线程：${statusLabel(selected.status)}\nFast：${fast}\n\n【桥接任务】\n执行中：${state.jobs.filter(item => item !== job && item.status === 'running').length} 个任务\n排队中：${state.jobs.filter(item => item.status === 'pending').length} 条消息\n\n【快捷操作】\n/threads  查看线程\n${control} on|off  切换 Fast\n/new <要求>  新建任务线程`;
    }
    case 'new': {
      // /new is the only path that creates a thread. A restart never reruns it.
      let project;
      let source;
      try {
        project = command.projectSelector ? await readProjectSelection({ config, backend, selector: command.projectSelector,
          listedIds: routing.listedProjectIds, homeId: reference.projectId })
          : backend.project ? await backend.project(config, routing.projectId) : { id: routing.projectId };
        if (!project?.id || project.deletedAt || (!command.projectSelector && project.id !== routing.projectId)) {
          throw new Error('项目不可用，请用 /projects 重新选择');
        }
        if (routing.threadId) source = await readSelected(routing.threadId);
        else {
          const previous = routing.modelSource || { threadId: config.threadId, projectId: reference.projectId };
          source = validateThread(await backend.read({ ...config, threadId: previous.threadId }), previous.projectId);
          if (source.threadId !== previous.threadId) throw new Error('T3 模型来源线程校验失败');
        }
      }
      catch (error) { throw new Error(`新线程尚未创建：无法确认项目或模型来源线程。\n${error.message}`); }
      let result;
      try {
        result = await backend.create(config, { projectId: project.id,
          title: command.title ?? 'WeChat: ' + Array.from(command.text.split('\n')[0]).slice(0, 72).join(''),
          provider: source.providerInstanceId, model: source.model,
          prompt: skillPrompt(command, config), wait: !onNewThread });
      } catch (error) {
        throw new Error(`尚未确认新线程是否创建成功。请用 /threads 或在 T3 中核对，不要重复发送 /new。\n${error.message}`);
      }
      job.threadId = result.threadId;
      job.projectId = project.id;
      job.runId = result.runId;
      save();
      let created;
      try { created = await readSelected(result.threadId); }
      catch (error) {
        throw new Error(`T3 已返回新线程 ${shortThreadId(result.threadId, Object.keys(state.threadCatalog || {}))}，但尚未完成创建确认，当前选中线程未改变。\n请用 /threads 核对，不要重复发送 /new。\n${error.message}`);
      }
      job.createdThread = threadInfo(created);
      job.waitOnly = !!job.runId;
      if (routing.projectId !== project.id) {
        if (routing.threadId) {
          routing.projectThreads[routing.projectId] = routing.threadId;
          routing.modelSource = { threadId: routing.threadId, projectId: routing.projectId };
        }
        state.threadLists ||= {};
        state.threadLists[routing.projectId] = [...routing.listedIds];
        routing.listedIds = [...(state.threadLists[project.id] || [])];
      }
      routing.projectId = project.id;
      if (project.title !== undefined) routing.project = { id: project.id, title: project.title, workspaceRoot: project.workspaceRoot };
      routing.threadId = created.threadId;
      routing.threadInfo = threadInfo(created);
      routing.projectThreads[routing.projectId] = created.threadId;
      save();
      if (onNewThread) return onNewThread(created, result);
      const reply = result.reply || (result.status === 'waiting'
        ? backend.pending ? rememberQuestion(state, created, { ...result,
          request: await backend.pending({ ...config, threadId: created.threadId }) }, save)
          : 'T3 is waiting for input or approval. Please open the thread in T3.'
        : `Task status: ${result.status}. Please open the thread in T3 for details.`);
      return `新线程已创建并选中：\n${threadLabel(created)}\n\n${reply}`;
    }
    default: {
      const selected = await readSelected(job.threadId || routing.threadId);
      job.threadId = selected.threadId;
      save();
      const target = { ...config, threadId: selected.threadId };
      if (state.untrackedRuns?.[selected.threadId] && command.kind !== 'answer' && !state.pendingInputs?.[selected.threadId]) {
        if (activeTaskStatuses.has(selected.status) || selected.status === 'waiting' || selected.pendingRequestCount > 0) {
          return '上条任务的跟踪已中断，当前任务仍在运行或等待确认；本条任务未提交。请先用 /status、/history 或 /questions 核对，或用 /stop 停止原任务。';
        }
        if (!['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back', 'idle'].includes(selected.status)) {
          return '上条任务状态仍未确认，本条任务未提交。请先在 T3 核对原任务。';
        }
        delete state.untrackedRuns[selected.threadId];
        save();
      }
      const draft = state.pendingInputs?.[selected.threadId];
      if (draft && job.receivedAt && draft.openedAt && job.receivedAt <= draft.openedAt) {
        return `当前线程有待答问题，本条消息未作为答案或新任务提交。请用 /answer 回答，或用 /new 创建其他任务。\n\n${formatQuestion(selected, draft, state)}`;
      }
      if (command.kind === 'answer' || state.pendingInputs?.[selected.threadId]) {
        return answerQuestion({ state, thread: selected, target, backend, text: command.text, save, job });
      }
      // An unseen question may predate this process or originate on the desktop.
      if (backend.pending && (selected.pendingRequestCount > 0 || selected.status === 'waiting')) {
        const request = await backend.pending(target);
        if (request) return rememberQuestion(state, selected, { request, runId: selected.latestRunId }, save);
        return 'T3 正等待确认，请在桌面端查看；本条消息未作为新任务发送。';
      }
      let result;
      const prompt = skillPrompt(command, config);
      try { result = await backend.send(target, prompt); }
      catch (error) {
        if (error.code !== 'T3_WAIT_ABORTED') {
          state.untrackedRuns ||= {};
          state.untrackedRuns[selected.threadId] = { projectId: selected.projectId };
          save();
        }
        throw error;
      }
      if (result?.runId) { job.runId = result.runId; save(); }
      if (activeTaskStatuses.has(result?.status)) {
        if (!result.runId) throw new Error('T3 未返回任务编号，请在桌面端核对；不会自动重跑。');
        job.waitOnly = true;
        save();
        result = await waitForJob({ state, job, thread: selected, config, backend, save });
      }
      if (typeof result?.reply === 'string' && result.status !== 'waiting') return result.reply;
      return typeof result === 'string' ? result : rememberQuestion(state, selected, result, save, job.replyTo || command.text);
    }
  }
}
