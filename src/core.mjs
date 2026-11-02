import { createHash } from 'node:crypto';
import { supportsTarget } from './command-policy.mjs';
import { messageId, quotePeer, quotedReferences } from './quotes.mjs';

export const COMMAND_ALIASES = Object.freeze({
  h: 'help', tk: 'task', n: 'new', ps: 'projects', p: 'project',
  t: 'threads', ts: 'threads', sw: 'switch', his: 'history',
  s: 'status', st: 'status', ms: 'models', m: 'model', f: 'fast',
  q: 'questions', qs: 'questions', a: 'answer',
  c: 'cost', tok: 'token', lim: 'limit',
});

export const CHINESE_COMMAND_ALIASES = Object.freeze({
  技能: 'skills', 帮助: 'help', 任务: 'task', 新建: 'new', 新线程: 'new',
  发送: 'to', 发给: 'to', 项目列表: 'projects', 项目: 'project',
  线程: 'threads', 线程列表: 'threads', 切换: 'switch', 历史: 'history',
  状态: 'status', 模型列表: 'models', 模型: 'model',
  快速: 'fast', 加速: 'fast', 问题: 'questions', 回答: 'answer', 引导: 'steer',
  费用: 'cost', 花费: 'cost', 用量: 'token', 令牌: 'token', 额度: 'limit', 限额: 'limit',
});

function normalizeCommand(input) {
  const normalized = input.startsWith('／') ? '/' + input.slice(1) : input;
  return normalized.replace(/^\/([a-z\p{Script=Han}]+)(?=\s|$)/iu, (command, name) => {
    const key = name.toLowerCase();
    const aliases = Object.hasOwn(COMMAND_ALIASES, key) ? COMMAND_ALIASES : CHINESE_COMMAND_ALIASES;
    return Object.hasOwn(aliases, key) ? '/' + aliases[key] : command;
  });
}

function commandManual(lines, chinese = false) {
  const shown = new Set();
  return lines.map(line => {
    const command = line.match(/^\/([a-z]+)(?=\s|$)/)?.[1];
    if (!command || shown.has(command)) return line;
    shown.add(command);
    const aliases = [...Object.entries(COMMAND_ALIASES), ...(chinese ? Object.entries(CHINESE_COMMAND_ALIASES) : [])]
      .filter(([, target]) => target === command).map(([alias]) => '/' + alias);
    return aliases.length ? `${line}  (${aliases.join(', ')})` : line;
  }).join('\n');
}

export const HELP = commandManual([
  '/skills [关键词]',
  '  查询本机技能；也可用 /技能。',
  '/task --skill <名称[,名称]> <要求>',
  '  指定技能执行任务；--skills 与 --skill 等价，可省略 /task；技能名称和任务正文均必填。',
  '  /new 的 --skill、--name、--project 可任意排序，均放在正文之前；支持 --skill=名称。',
  '  正文以 --skills 开头时，用 -- 分隔，如 /task -- --skills 是正文。',
  '',
  '/help [en]',
  '  显示微信 → T3 中文帮助；/help en 显示英文帮助。',
  '  <参数> 为必填，[参数] 为可选，| 表示任选一项。',
  '  括号内为等价短命令，参数用法相同；短命令也要加 /。',
  '  支持中文命令及全角 ／；命令和参数之间用空格。',
  '',
  '/task <要求>',
  '  在当前线程执行任务；也可直接发送正文，省略 /task。',
  '  长任务持续跟踪；T3 退出或持续失联会提示。桥接重启后只恢复已确认任务的查询，不重新提交。',
  '',
  '/steer <补充指令>',
  '  立即向正在运行的任务补充指令；也可用 /task --steer <内容>。',
  '',
  '/to <编号或ID前缀> /steer <补充指令>',
  '  引导指定线程的当前任务，不切换线程；用 /history 查看结果。',
  '',
  '/new <要求>',
  '  在当前项目新建并选中线程，后台执行任务。',
  '',
  '/new --name <名称> <要求>',
  '  指定新线程名称；也可用 --title、--名称、--名字 或 -n。',
  '  名称含空格时用引号包住，如 /新建 --名称 "内存 检查" 检查本机内存。',
  '',
  '/new --project <编号|名称|ID前缀|home> [--name <名称>] <要求>',
  '  在指定项目新建并选中线程；--项目、-p 等价，可与名称参数任意排序。',
  '  项目名称含空格时用引号包住；项目编号来自最近一次 /projects。',
  '  模型继承当前线程；创建确认前不切换项目，失败时保留当前选择。',
  '',
  '/to <编号|ID前缀|home> <要求>',
  '  引用桥接新回复后也可直接发送指令，自动发回原线程；不切换当前线程。',
  '  向指定线程发送任务，不改变当前选中线程；支持完整 ID。',
  '  home 可写 初始，例如 /发送 初始 检查内存。',
  '',
  '/projects',
  '  列出项目及编号，标记当前项目。',
  '',
  '/project [编号|名称|ID前缀|home]',
  '  查看或选择项目；后续新建线程属于该项目。',
  '',
  '/stop',
  '  停止当前线程任务；/to <编号> /stop 可停止指定线程任务。',
  '',
  '/threads',
  '  列出当前项目未 settle 的线程。/switch 与 /to 的编号以本次列表为准。',
  '',
  '/threads --settle',
  '  包含已 settle 的线程，并标记其状态；短命令和中文命令同样支持。',
  '',
  '/settle [编号|ID前缀|home]',
  '  收起指定线程；省略目标时操作当前线程，不切换线程。',
  '',
  '/unsettle [编号|ID前缀|home]',
  '  恢复显示指定线程；先用 /threads --settle 查看已收起线程。',
  '  也可用 /to 2 /settle 或 /to 2 /unsettle。',
  '',
  '/switch <编号|ID前缀|home>',
  '  切换线程，支持完整 ID；home 返回最初绑定的线程及项目。',
  '',
  '/history [页码]',
  '  查看当前线程对话，每页 5 条。省略页码显示最新一页。',
  '',
  '/status',
  '  查看当前项目、线程、连接、Fast 状态及任务队列。',
  '',
  '/models [关键词]',
  '  列出或搜索可用模型，显示可用于切换的序号。',
  '',
  '/cost [today|7d|30d]',
  '  查看 T3 本机用量面板的费用汇总，默认今天；范围也可写 今天、7天、30天。',
  '',
  '/token [today|7d|30d]',
  '  查看 Token 汇总及当前线程上下文用量；/tokens 也可使用。',
  '',
  '/limit',
  '  查看 T3 账户额度、剩余比例及重置时间；额度按提供商账户共享。',
  '  /发送 2 /用量 可查看指定线程的上下文。',
  '',
  '/model',
  '  查看当前线程的模型和选项。',
  '',
  '/model <模型|提供商::模型>',
  '  切换当前线程的模型，不影响其他线程。',
  '',
  '/model <序号>',
  '  按当前线程最近一次模型列表切换；也可用 /模型 2 或 /m 2。',
  '',
  '/fast',
  '  查看当前线程的 Fast 状态。',
  '',
  '/fast on|off',
  '  开启或关闭当前线程的 Fast，后续任务生效。',
  '  中文用法：/快速 开启、/快速 关闭。',
  '',
  '/questions',
  '  查看当前线程待补充的问题、线程序号及回答命令。',
  '',
  '/answer <文字|编号>',
  '  回答当前线程已显示的问题；多选编号用逗号分隔。',
  '  也可引用问题消息直接回复答案，自动定位原线程。',
  '',
  '/to <编号或ID前缀> /fast [on|off]',
  '  查询或设置指定线程的 Fast，不切换当前线程。',
  '',
  '/to <编号或ID前缀> /status',
  '  查看指定线程状态，包括 Fast。',
  '',
  '/to <编号或ID前缀> /history [页码]',
  '  查看指定线程的对话历史。',
  '',
  '/to <编号或ID前缀> /questions',
  '  查看指定线程的问题。',
  '',
  '/to <编号或ID前缀> /answer <文字|编号>',
  '  回答指定线程的问题，不切换当前线程。',
  '',
  '/new 检查本机内存',
  '  示例：新建线程处理任务。',
  '',
  '/to 2 /answer 1',
  '  示例：回答最近一次线程列表中第 2 个线程的问题，选择选项 1。',
], true);

export const HELP_EN = commandManual([
  '/skills [search]',
  '  List or search local skills.',
  '/task --skill <name[,name]> <request>',
  '  Use named local skills. --skills is an alias of --skill; /task is optional. Skill names and a request are required.',
  '  For /new, put --skill, --name and --project in any order before the request. --skill=name also works.',
  '  Use -- before a literal request starting with --skills, for example /task -- --skills is literal text.',
  '',
  '/help [en]',
  '  Show Chinese help; /help en shows this English manual.',
  '  <arg> is required, [arg] is optional, and | separates alternatives.',
  '  Parentheses list aliases with the same arguments; aliases also require /.',
  '',
  '/task <request>',
  '  Run a task in the selected thread. Plain text works without /task.',
  '  Long tasks remain tracked. T3 exit or prolonged disconnection is reported. A bridge restart only resumes confirmed task reads.',
  '',
  '/steer <instruction>',
  '  Immediately update a running task; /task --steer <instruction> also works.',
  '',
  '/to <number|id-prefix> /steer <instruction>',
  '  Steer another thread without switching; use /history to read the result.',
  '',
  '/new <request>',
  '  Create and select a thread in the current project; run the task in the background.',
  '',
  '/new --name <title> <request>',
  '  Name the new thread; --title and -n also work. Quote titles containing spaces.',
  '',
  '/new --project <number|name|id-prefix|home> [--name <title>] <request>',
  '  Create and select a thread in that project; -p also works. Options accept either order.',
  '  Quote project names containing spaces. Numbers use the last /projects list.',
  '  Inherit the current thread model. Change selection only after creation is confirmed.',
  '',
  '/to <number|id|prefix|home> <request>',
  '  Quote a new bridge reply to send instructions back to its thread without switching.',
  '  Send a task to a specific thread without changing the selected thread.',
  '',
  '/projects',
  '  List projects and numbers; mark the selected project.',
  '',
  '/project [number|name|id-prefix|home]',
  '  Show or select the project used for new threads.',
  '',
  '/stop',
  '  Stop the selected thread task; /to <number> /stop targets another thread.',
  '',
  '/threads',
  '  List project threads that are not settled. /switch and /to use this saved list.',
  '',
  '/threads --settle',
  '  Include settled threads and label them. Aliases accept the same flag.',
  '',
  '/settle [number|id|prefix|home]',
  '  Settle a thread without switching; omit the target for the selected thread.',
  '',
  '/unsettle [number|id|prefix|home]',
  '  Unsettle a thread. Use /threads --settle to list settled targets.',
  '  /to 2 /settle and /to 2 /unsettle also work.',
  '',
  '/switch <number|id|prefix|home>',
  '  Select a thread; home returns to the original thread and project.',
  '',
  '/history [page]',
  '  Read 5 messages per page. Omit page for the latest messages.',
  '',
  '/status',
  '  Show the selected project, thread, connection, Fast state and task queue.',
  '',
  '/models [search]',
  '  List or search available models with selection numbers.',
  '',
  '/cost [today|7d|30d]',
  '  Show cost totals from the local T3 usage panel; default: today.',
  '',
  '/token [today|7d|30d]',
  '  Show token totals and selected thread context usage; /tokens also works.',
  '',
  '/limit',
  '  Show account usage limits, remaining percentages and reset times.',
  '  /to 2 /token reads another thread context; panel totals cover all local sources.',
  '',
  '/model',
  '  Show the selected thread model and options.',
  '',
  '/model <model|provider::model>',
  '  Change only the selected thread model.',
  '',
  '/model <number>',
  '  Select from the last model list shown for this thread; /m 2 also works.',
  '',
  '/fast',
  '  Show the selected thread Fast state.',
  '',
  '/fast on|off',
  '  Enable or disable Fast for subsequent tasks in the selected thread.',
  '',
  '/questions',
  '  Show pending questions, the thread number and an answer command.',
  '',
  '/answer <text|number>',
  '  Answer the displayed question; separate multiple choices with commas.',
  '  Or quote the question and reply with your answer to target its thread.',
  '',
  '/to <number|id-prefix> /fast [on|off]',
  '  Query or set another thread Fast mode without switching.',
  '',
  '/to <number|id-prefix> /status',
  '  Show another thread status, including Fast.',
  '',
  '/to <number|id-prefix> /history [page]',
  '  Read another thread conversation.',
  '',
  '/to <number|id-prefix> /questions',
  '  Show another thread pending questions.',
  '',
  '/to <number|id-prefix> /answer <text|number>',
  '  Answer another thread question without switching.',
  '',
  '/new Check system memory',
  '  Example: create a thread to handle a task.',
  '',
  '/to 2 /answer 1',
  '  Example: answer option 1 in thread 2 from your last /threads list.',
]);

function taskRequest(input, kind) {
  const flags = kind === 'new'
    ? /^(--skills?|--name|--title|--名称|--名字|-n|--project|--项目|-p)(?=$|[\s=])/i
    : /^--skills?(?=$|[\s=])/i;
  if (!flags.test(input) && !/^--(?:\s|$)/.test(input)) return null;
  const error = message => ({ kind: 'error', text: message + (kind === 'new'
    ? '\n用法：/new --name "线程名称" <任务内容>\n项目：/new --project <项目> [--name "线程名称"] <任务内容>\n中文：/新建 [--项目 <项目>] [--名称 "线程名称"] <任务内容>\n技能：/new [--project <项目>] [--name "线程名称"] --skill <名称[,名称]> <任务内容>'
    : '\n用法：/task --skill <名称[,名称]> <任务内容>\n--skills 与 --skill 等价，可省略 /task；多个技能用英文逗号分隔。') });
  const result = { kind };
  let rest = input;
  for (let option; (option = rest.match(flags));) {
    const field = /^--skills?$/i.test(option[0]) ? 'skills'
      : /^(--project|--项目|-p)$/i.test(option[0]) ? 'projectSelector' : 'title';
    const label = { skills: '技能名称', title: '线程名称', projectSelector: '项目' }[field];
    if (Object.hasOwn(result, field)) return error(`${label}参数不能重复。`);
    rest = rest.slice(option[0].length).trimStart();
    if (rest.startsWith('=')) rest = rest.slice(1).trimStart();
    if (!rest || flags.test(rest) || /^--(?:\s|$)/.test(rest)) return error(`请提供${label}及任务内容。`);
    const closing = { '"': '"', "'": "'", '“': '”', '「': '」' }[rest[0]];
    let value;
    if (closing) {
      const end = rest.indexOf(closing, 1);
      if (end < 0) return error(`${label}的引号未闭合。`);
      value = rest.slice(1, end).trim();
      rest = rest.slice(end + 1);
      if (rest && !/^\s/.test(rest)) return error(`${label}与后续内容之间需要空格。`);
    } else {
      value = rest.match(/^\S+/)[0];
      rest = rest.slice(value.length);
    }
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) return error(`${label}不能为空，且必须为单行文字。`);
    if (field === 'skills') {
      const names = value.split(',').map(name => name.trim());
      if (names.some(name => !name || /\s/.test(name) || name.startsWith('-'))) {
        return error('请提供有效的技能名称；多个技能用英文逗号分隔，名称不能为空或包含空白。');
      }
      result.skills = [...new Set(names)];
    } else {
      result[field] = field === 'projectSelector' && value === '初始' ? 'home' : value;
    }
    rest = rest.trimStart();
  }
  // Once the body starts, keep every subsequent byte of its contents, including flags.
  if (/^--(?:\s|$)/.test(rest)) rest = rest.slice(2).trimStart();
  if (!rest) return error('参数后还需要提供任务内容。');
  const control = routeControl(normalizeCommand(rest));
  if (control && result.skills) return error('--skill 仅用于任务正文。');
  return control || { ...result, text: rest };
}

function routeControl(input) {
  const skills = input.match(/^\/skills(?:\s+([^\r\n]+))?$/i);
  if (skills) return { kind: 'skills', search: skills[1]?.trim() || '' };
  const steer = input.match(/^\/steer\s+([\s\S]+)$/i);
  if (steer) return { kind: 'steer', text: steer[1].trim() };
  const help = input.match(/^\/help(?:[ \t\u3000]+(en|英文|中文|zh))?$/i);
  if (help) return { kind: 'help', ...(/^(en|英文)$/i.test(help[1] || '') ? { language: 'en' } : {}) };
  const threads = input.match(/^\/threads(?:[ \t\u3000]+(--settle))?$/i);
  if (threads) return { kind: 'threads', ...(threads[1] ? { includeSettled: true } : {}) };
  const settle = input.match(/^\/(settle|unsettle)(?:[ \t\u3000]+(初始|#\d+|[\w:-]+))?$/i);
  if (settle) return { kind: settle[1].toLowerCase(), ...(settle[2] ? { selector: settle[2] === '初始' ? 'home' : settle[2] } : {}) };
  const simple = input.match(/^\/(status|questions|projects|stop|limit)$/i);
  if (simple) return { kind: simple[1].toLowerCase() };
  const usage = input.match(/^\/(cost|token|tokens)(?:[ \t\u3000]+([^\s]+))?$/i);
  if (usage) return { kind: usage[1].toLowerCase() === 'cost' ? 'cost' : 'token', ...(usage[2] ? { period: usage[2] } : {}) };
  const history = input.match(/^\/history(?:[ \t\u3000]+(\d+))?$/i);
  if (history) return { kind: 'history', page: history[1] === undefined ? 1 : Number(history[1]) };
  const project = input.match(/^\/project(?:[ \t\u3000]+([^\r\n]+))?$/i);
  if (project) return { kind: 'project', ...(project[1]?.trim() ? { selector: project[1].trim() === '初始' ? 'home' : project[1].trim() } : {}) };
  const select = input.match(/^\/switch\s+(初始|#\d+|[\w:-]+)$/i);
  if (select) return { kind: 'switch', selector: select[1] === '初始' ? 'home' : select[1] };
  const models = input.match(/^\/models(?:[ \t\u3000]+([^\r\n]+))?$/i);
  if (models) return { kind: 'models', ...(models[1]?.trim() ? { search: models[1].trim() } : {}) };
  const model = input.match(/^\/model(?:[ \t\u3000]+(\S+))?$/i);
  if (model) return { kind: 'model', ...(model[1] ? { name: model[1] } : {}) };
  const fast = input.match(/^\/fast(?:[ \t\u3000]+(on|off|开启|关闭|启用|禁用|打开|开|关))?$/i);
  if (fast) return { kind: 'fast', ...(fast[1] ? { enabled: /^(on|开启|启用|打开|开)$/i.test(fast[1]) } : {}) };
}

export function route(text) {
  const input = normalizeCommand(text.trim());
  const direct = input.match(/^\/to[ \t\u3000]+(初始|#\d+|[\w:-]+)\s+([\s\S]+)$/i);
  if (direct) {
    const requestText = normalizeCommand(direct[2]);
    if (/^\/to\b/i.test(requestText)) return { kind: 'help' };
    const request = route(requestText);
    if (request.kind === 'error') return request;
    // Target tasks, questions and Fast controls without changing global routing.
    if (request.selector || !supportsTarget(request.kind)) return { kind: 'help' };
    return { ...request, selector: direct[1] === '初始' ? 'home' : direct[1] };
  }
  const answer = input.match(/^\/answer\s+([\s\S]+)$/i);
  if (answer) return { kind: 'answer', text: answer[1].trim() };
  const control = routeControl(input);
  if (control) return control;
  const task = input.match(/^\/(task|new)(?:\s+([\s\S]+))?$/i);
  if (task) {
    const request = task[2]?.trim();
    if (!request) return { kind: 'help' };
    if (task[1].toLowerCase() === 'task' && /^--steer(?:\s|$)/i.test(request)) {
      const text = request.replace(/^--steer\s*/i, '');
      return text ? { kind: 'steer', text } : { kind: 'help' };
    }
    const options = taskRequest(request, task[1].toLowerCase());
    if (options) return options;
    // Keep bridge controls out of AI prompts: an AI-generated thread list does
    // not update the saved numbering used by /switch.
    return routeControl(normalizeCommand(request)) || { kind: task[1].toLowerCase(), text: request };
  }
  if (input.startsWith('/')) return { kind: 'help' };
  return taskRequest(input, 'task') || { kind: 'task', text: input };
}

export function incoming(message, owner) {
  if (!owner || message.from_user_id !== owner || message.message_type !== 1 || message.group_id) return null;
  if (!message.context_token || (!message.message_id && message.seq === undefined)) return null;
  const text = (message.item_list || []).map(item => {
    if (item.type === 1) return item.text_item?.text || '';
    if (item.type === 3) return item.voice_item?.text || '';
    return '';
  }).filter(Boolean).join('\n').trim();
  const id = createHash('sha256').update(`${owner}:${message.message_id ?? message.seq}`).digest('hex');
  return { id, context: message.context_token, text,
    peer: quotePeer(owner), sourceMessageId: messageId(message.message_id), references: quotedReferences(message),
    command: text ? route(text) : { kind: 'unsupported' } };
}

export function threadInfo(thread) {
  return { threadId: thread.threadId, title: thread.title || 'Untitled', link: thread.link,
    ...(thread.projectId ? { projectId: thread.projectId } : {}),
    ...(thread.number ? { number: thread.number } : {}), ...(thread.shortId ? { shortId: thread.shortId } : {}) };
}

export const bareThreadId = id => String(id).replace(/^mcp:/i, '');

export function shortThreadId(id, knownIds = []) {
  const full = String(id);
  const peers = [...new Set(knownIds)].filter(other => other.toLowerCase() !== full.toLowerCase());
  const bare = bareThreadId(full);
  const useFull = peers.some(other => bareThreadId(other).toLowerCase() === bare.toLowerCase());
  const value = useFull ? full : bare;
  const others = peers.map(other => (useFull ? other : bareThreadId(other)).toLowerCase());
  let length = Math.min(4, value.length);
  while (length < value.length && (others.some(other => other.startsWith(value.slice(0, length).toLowerCase())) || /^\d+$/.test(value.slice(0, length)))) length++;
  return value.slice(0, length);
}

export const emojiNumber = value => String(value).replace(/\d/g, digit => `${digit}\uFE0F\u20E3`);

export function threadLabel(thread) {
  const title = String(thread.title || 'Untitled').replace(/[\r\n]/g, ' ');
  return `${emojiNumber(thread.number || 1)} ${title}（${thread.shortId || shortThreadId(thread.threadId)}）`;
}

export function statusLabel(status) {
  return ({ preparing: '🟡 准备中', queued: '🟡 排队中', starting: '🟡 启动中',
    running: '🟢 运行中', waiting: '🟠 等待回复', completed: '✅ 已完成',
    failed: '🔴 失败', cancelled: '⚪ 已取消', interrupted: '⚪ 已中断',
    rolled_back: '↩️ 已回滚', idle: '⚪ 空闲' })[status] || `⚪ ${String(status || '未知').replace(/[\r\n]/g, ' ')}`;
}

export function replyQuestion(text, limit = 160) {
  const points = Array.from(String(text || '').replace(/\s+/g, ' ').trim());
  return points.slice(0, limit).join('') + (points.length > limit ? '…' : '');
}

export function splitThreadReply(text, thread, limit = 1600, question = '') {
  const identity = thread?.threadId ? threadLabel(thread) + '\n\n' : '';
  const header = identity + (question ? `指令：${replyQuestion(question)}\n\n` : '');
  const body = identity && text?.startsWith(identity) ? text.slice(identity.length) : text;
  return splitReply(body, Math.max(1, limit - Array.from(header).length)).map(chunk => header + chunk);
}

export function splitReply(text, limit = 1600) {
  const points = Array.from(text || '任务已结束，T3 未返回文字回复。');
  const chunks = [];
  for (let start = 0; start < points.length;) {
    let end = Math.min(start + limit, points.length);
    if (end < points.length) {
      // Prefer complete cards, then complete lines; retain every character.
      const window = points.slice(start, end).join('');
      const paragraph = window.lastIndexOf('\n\n');
      const line = window.lastIndexOf('\n');
      const boundary = paragraph >= window.length / 3 ? paragraph + 2 : line >= window.length / 3 ? line + 1 : 0;
      if (boundary) end = start + Array.from(window.slice(0, boundary)).length;
    }
    chunks.push(points.slice(start, end).join(''));
    start = end;
  }
  return chunks;
}

export function ingest(state, messages, owner, cursor) {
  const known = new Set([...state.seen, ...state.jobs.map(job => job.id)]);
  for (const message of messages) {
    const entry = incoming(message, owner);
    if (!entry || known.has(entry.id)) continue;
    known.add(entry.id);
    state.typingContext = entry.context;
    state.jobs.push({ ...entry, status: 'pending', receivedAt: new Date().toISOString(), sent: 0 });
  }
  if (cursor) state.cursor = cursor;
}

// Publish the new inbox and cursor only after the complete snapshot is durable.
// This is synchronous so the scheduler cannot observe an uncommitted inbox.
export function commitUpdates(state, update, owner, persist) {
  const draft = { ...state, jobs: [...state.jobs] };
  ingest(draft, update.msgs || [], owner, update.get_updates_buf);
  persist(draft);
  Object.assign(state, draft);
}

export function recover(state) {
  for (const job of state.jobs) {
    // Existing inboxes may still contain the former plain-text command kind.
    if (job.command?.kind === 'chat') job.command.kind = 'task';
    if (job.status !== 'running') continue;
    if (job.waitOnly && job.runId && job.threadId && (job.command?.kind !== 'new' || job.createdThread)) {
      // Only resume observing a confirmed submission. Never submit the command again.
      job.status = 'pending';
      job.bound = true;
      continue;
    }
    if (job.threadId && ['task', 'new', 'answer'].includes(job.command?.kind)) {
      state.untrackedRuns ||= {};
      state.untrackedRuns[job.threadId] = { runId: job.runId, projectId: job.projectId };
    }
    job.status = 'reply';
    const thread = job.createdThread;
    const identity = thread || job.replyThread;
    const ids = identity?.projectId && identity.projectId !== state.routing?.projectId
      ? state.threadLists?.[identity.projectId] || [] : state.routing?.listedIds || [];
    const display = identity ? { ...identity, number: ids.indexOf(identity.threadId) + 1 || identity.number || 1,
      shortId: shortThreadId(identity.threadId, [...Object.keys(state.threadCatalog || {}), ...ids]) } : undefined;
    job.chunks = splitThreadReply(thread
      ? '新线程已创建。桥接重启，任务结果未继续跟踪。\n请在 T3 查看任务状态；本条任务不会自动重跑。'
      : job.command?.kind === 'new' && job.threadId
        ? `桥接重启前已记录新线程 ${shortThreadId(job.threadId, Object.keys(state.threadCatalog || {}))}，创建确认尚未完成。请用 /threads 或在 T3 中核对，不要重复发送 /new；本条任务不会自动重跑。`
        : '桥接在处理这条消息时重启。任务可能已经执行，请先在 T3 查看结果；为避免重复操作，本条任务不会自动重跑。', display, 1600, job.replyTo || job.text || job.command?.text);
    job.sent = 0;
  }
}
