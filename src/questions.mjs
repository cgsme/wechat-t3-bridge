// Drafts are keyed by thread and request, persisted with the inbox, and never
// submitted as a new agent prompt. One WeChat reply answers one question.
import { threadLabel, emojiNumber } from './core.mjs';
import { numberedThread } from './thread-labels.mjs';

function nextQuestion(draft) {
  return draft.questions.find(question => !Object.hasOwn(draft.answers, question.id));
}

export function rememberQuestion(state, thread, result, save, originalQuestion) {
  const request = result.request;
  state.pendingInputs ||= {};
  if (!request) {
    delete state.pendingInputs[thread.threadId];
    save();
    return 'T3 正等待确认，请在桌面端处理权限确认。补充问题可用 /questions 查看。';
  }
  const previous = state.pendingInputs[thread.threadId];
  const answers = previous?.requestId === request.requestId ? { ...previous.answers } : {};
  // A fresh read confirms the request is still pending. Let the user explicitly
  // re-enter the last answer after an uncertain submission; never replay it.
  if (previous?.submissionAttempted && previous.requestId === request.requestId) {
    delete answers[request.questions.at(-1).id];
  }
  state.pendingInputs[thread.threadId] = { ...request, runId: result.runId || thread.latestRunId,
    originalQuestion: (previous?.requestId === request.requestId ? previous.originalQuestion : undefined) || originalQuestion,
    openedAt: previous?.requestId === request.requestId ? previous.openedAt : new Date().toISOString(), answers };
  save();
  return formatQuestion(thread, state.pendingInputs[thread.threadId], state);
}

export function formatQuestion(thread, draft, state = {}) {
  thread = numberedThread(thread, state);
  const question = nextQuestion(draft);
  if (!question) return '答案已收集，请用 /questions 检查请求状态。';
  const index = draft.questions.indexOf(question) + 1;
  const options = question.options || [];
  const otherProject = thread.projectId && state.routing?.projectId && thread.projectId !== state.routing.projectId;
  const number = thread.number;
  const selector = otherProject ? thread.shortId : String(number);
  const example = options.length ? question.multiSelect && options.length > 1 ? '1,2' : '1' : '<补充内容>';
  return [threadLabel(thread), '', `【待回答 · ${emojiNumber(index)}/${emojiNumber(draft.questions.length)}】`,
    `线程序号：${emojiNumber(number)}（${otherProject ? '所属项目' : '当前项目'}）`, '',
    question.question, '', ...(options.length ? [question.multiSelect ? '【选项 · 多选】' : '【选项 · 单选】',
      ...options.map((option, i) => `${emojiNumber(i + 1)} ${option.label}${option.description ? `\n   ${option.description}` : ''}`), ''] : []),
    '【如何回答】',
    ...(otherProject ? [`先选择所属项目：/project ${thread.projectId}`] : []),
    `定向回答：/to ${selector} /answer ${example}`,
    `定向查看：/to ${selector} /questions`,
    options.length ? question.multiSelect ? '将示例数字换成选项编号，多选用逗号分隔。' : '将示例数字换成选项编号或你的答案。'
      : '将 <补充内容> 换成你的答案。',
    '定向回答不会切换当前选中线程。',
    '刷新 /threads 后，以新列表的序号为准。',
  ].join('\n');
}

function parseAnswer(question, text) {
  const options = question.options || [];
  const input = text.trim();
  let values;
  if (options.length && /^\d+(?:\s*[,，]\s*\d+)*$/.test(input)) {
    const indices = input.split(/[,，]/).map(value => Number(value.trim()));
    if ((!question.multiSelect && indices.length > 1) || indices.some(index => index < 1 || index > options.length)) {
      throw new Error('选项编号无效，请按当前问题显示的编号回答。');
    }
    values = [...new Set(indices)].map(index => options[index - 1].label);
  } else if (question.multiSelect && options.some(option => option.label === input)) values = [input];
  else values = [input];
  if (!input || (options.length && question.allowCustomAnswer === false && values.some(value => !options.some(option => option.label === value)))) {
    throw new Error('请从当前问题提供的选项中选择。');
  }
  return values;
}

export async function answerQuestion({ state, thread, target, backend, text, save, job }) {
  const draft = state.pendingInputs?.[thread.threadId];
  if (!draft) return '请先发送 /questions 查看当前线程的问题，再用 /answer 回答。';
  const live = await backend.pending(target);
  if (!live || live.requestId !== draft.requestId || JSON.stringify(live.questions) !== JSON.stringify(draft.questions)) {
    delete state.pendingInputs[thread.threadId];
    save();
    return '之前的问题已失效或已变化，答案未提交。请先发送 /questions 查看当前问题。';
  }
  const question = nextQuestion(draft);
  if (!question) return '答案提交状态不确定，请在 T3 核对；不会自动重复提交。';
  if (job) job.replyTo = draft.originalQuestion || question.question;
  draft.answers[question.id] = parseAnswer(question, text);
  save();
  if (nextQuestion(draft)) return formatQuestion(thread, draft, state);
  // Persisted running-job recovery prevents replay if submission outcome is unknown.
  draft.submissionAttempted = true;
  save();
  try { await backend.respond(target, draft.requestId, draft.answers); }
  catch { return '答案提交状态未确认，请用 /questions 核对后重新回答，或在 T3 查看；不会自动重复提交。'; }
  delete state.pendingInputs[thread.threadId];
  save();
  if (job) { job.runId = draft.runId || thread.latestRunId; save(); }
  const result = await backend.wait(target, draft.runId || thread.latestRunId);
  return typeof result === 'string' ? result : rememberQuestion(state, thread, result, save, draft.originalQuestion);
}
