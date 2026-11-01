import test from 'node:test';
import assert from 'node:assert/strict';
import { route, threadInfo, HELP, HELP_EN, recover } from '../src/core.mjs';
import { executeCommand } from '../src/commands.mjs';
import { createScheduler } from '../src/scheduler.mjs';
import { readProjects, readProject } from '../src/t3-control.mjs';
import { createTypingIndicator } from '../src/typing.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const project = (id, title = id) => ({ id, title, workspaceRoot: `C:/workspace/${id}`, deletedAt: null });
const thread = (id, projectId) => ({ threadId: id, projectId, title: `Thread ${id}`, link: `https://test/${id}`,
  providerInstanceId: 'codex', model: 'model', status: 'completed' });

function harness() {
  const projects = new Map([project('p1', '初始项目'), project('p2', '第二项目'), project('p3', 'Empty Project')].map(p => [p.id, p]));
  const threads = new Map([thread('a', 'p1'), thread('b', 'p2'), thread('c', 'p2')].map(t => [t.threadId, t]));
  const state = { jobs: [], seen: [], routing: { threadId: 'a', listedIds: [], projectId: 'p1', projectThreads: {}, listedProjectIds: [] } };
  const calls = [], sent = [];
  const backend = {
    projects: async () => [...projects.values()],
    project: async (_, id) => { const p = projects.get(id); if (!p || p.deletedAt) throw new Error('project unavailable'); return p; },
    list: async (_, id) => [...threads.values()].filter(t => t.projectId === id),
    read: async target => threads.get(target.threadId),
    send: async (target, text) => { calls.push(['send', target.threadId, text]); return 'done'; },
    create: async (_, options) => {
      calls.push(['create', options]);
      const created = thread('new', options.projectId); threads.set('new', created);
      return { threadId: 'new', runId: 'new-run', status: 'completed', reply: 'created' };
    },
    wait: async () => 'completed',
  };
  const config = { threadId: 'a' }, reference = threads.get('a');
  const execute = (text, job = {}) => executeCommand({ command: route(text), state, config, reference, backend, save() {}, job });
  const scheduler = createScheduler({ state, config, reference, backend, save() {}, send: async (job, text) => sent.push([job.id, text]) });
  const add = text => { const job = { id: String(state.jobs.length + state.seen.length + 1), command: route(text), status: 'pending', sent: 0 }; state.jobs.push(job); return job; };
  const tick = async () => { scheduler.tick(); await flush(); };
  return { projects, threads, state, calls, sent, backend, config, reference, execute, scheduler, add, tick };
}

test('project commands parse names with spaces and wrapped controls without becoming AI prompts', () => {
  assert.deepEqual(route('/projects'), { kind: 'projects' });
  assert.deepEqual(route('/project'), { kind: 'project' });
  assert.deepEqual(route('/PROJECT Empty Project'), { kind: 'project', selector: 'Empty Project' });
  assert.deepEqual(route('/new /project 第二项目'), { kind: 'project', selector: '第二项目' });
  assert.equal(route('/project p1\n/task test').kind, 'help');
  assert.equal(route('/to 2 /project p1').kind, 'help');
});

test('project reads list all pages, deduplicate active projects, and stay on the read-only control connection', async () => {
  const calls = [];
  const control = async (_, action, options) => {
    assert.equal(options?.write, undefined);
    return action(async (tool, args) => {
      calls.push([tool, args]);
      if (tool === 't3_project_read') return project(args.projectId);
      return args.cursor === undefined ? { projects: [project('p1')], nextCursor: 100 }
        : { projects: [project('p1'), project('p2'), { ...project('deleted'), deletedAt: 'date' }], nextCursor: null };
    });
  };
  assert.deepEqual((await readProjects({}, { control })).map(p => p.id), ['p1', 'p2']);
  assert.deepEqual(calls[1], ['t3_project_list', { cursor: 100, limit: 100 }]);
  assert.equal((await readProject({}, 'p2', { control })).id, 'p2');
  await assert.rejects(readProject({}, 'p1', { control: async (_, action) => action(async () => project('wrong')) }), /不可用/);
});

test('project queries never create a thread or start a model run and selection uses the last displayed project numbering', async () => {
  const h = harness();
  const listing = await h.execute('/projects');
  assert.match(listing, /初始项目.*⭐ 当前/);
  assert.deepEqual(h.state.routing.listedProjectIds, ['p1', 'p2', 'p3']);
  h.backend.projects = async () => [h.projects.get('p3'), h.projects.get('p2'), h.projects.get('p1')];
  assert.match(await h.execute('/project 2'), /第二项目/);
  assert.equal(h.state.routing.projectId, 'p2');
  assert.equal(h.state.routing.threadId, 'b');
  assert.match(await h.execute('/project'), /新建线程将属于此项目/);
  assert.deepEqual(h.calls, []);
});

test('new threads use the selected project, then switching projects restores each selected thread after restart', async () => {
  const h = harness();
  await h.execute('/project 第二项目');
  await h.execute('/threads');
  await h.execute('/switch c');
  await h.execute('/new 具体任务');
  assert.equal(h.calls[0][1].projectId, 'p2');
  assert.equal(h.calls[0][1].prompt, '具体任务');
  assert.equal(h.state.routing.threadId, 'new');
  await h.execute('/project home');
  assert.equal(h.state.routing.threadId, 'a');
  const restored = JSON.parse(JSON.stringify(h.state));
  Object.assign(h.state, restored);
  await h.execute('/project p2');
  assert.equal(h.state.routing.threadId, 'new');
  await h.execute('继续任务');
  assert.deepEqual(h.calls.at(-1), ['send', 'new', '继续任务']);
});

test('an empty project can create its first thread using the previous thread model without sending work to the previous project', async () => {
  const h = harness();
  assert.match(await h.execute('/project Empty Project'), /暂无可用线程/);
  assert.equal(h.state.routing.threadId, null);
  assert.match(await h.execute('/status'), /项目暂无选中线程/);
  await assert.rejects(h.execute('任务'), /尚未选择线程/);
  assert.equal(h.calls.length, 0);
  await h.execute('/new 第一个任务');
  const options = h.calls[0][1];
  assert.equal(options.projectId, 'p3');
  assert.equal(options.provider, 'codex');
  assert.equal(options.model, 'model');
  assert.equal(h.state.routing.threadId, 'new');
});

test('unknown, deleted, ambiguous, unreadable, or unlisted projects leave the routing unchanged', async () => {
  const h = harness();
  const original = structuredClone(h.state.routing);
  for (const selector of ['1', 'missing', 'p']) await assert.rejects(h.execute(`/project ${selector}`));
  h.projects.set('p2-copy', project('p2-copy', '第二项目'));
  await assert.rejects(h.execute('/project 第二项目'), /不唯一/);
  h.projects.delete('p2-copy');
  h.projects.get('p2').deletedAt = 'deleted';
  await assert.rejects(h.execute('/project p2'));
  assert.deepEqual(h.state.routing, original);
  h.projects.get('p2').deletedAt = null;
  h.backend.list = async () => { throw new Error('offline'); };
  await assert.rejects(h.execute('/project p2'), /offline/);
  assert.deepEqual(h.state.routing, original);
});

test('project switches use their own thread numbers and reject accidental work in another project', async () => {
  const h = harness();
  await h.execute('/threads');
  await h.execute('/project p2');
  assert.deepEqual(h.state.routing.listedIds, ['b']);
  await h.execute('/switch 1');
  assert.equal(h.state.routing.threadId, 'b');
  await assert.rejects(h.execute('/to a work'), /not found/);
  await h.execute('/threads');
  await h.execute('/to 2 work');
  assert.deepEqual(h.calls.at(-1), ['send', 'c', 'work']);
  await h.execute('/to home work');
  assert.deepEqual(h.calls.at(-1), ['send', 'a', 'work']);
  assert.equal(h.state.routing.projectId, 'p2');
  await h.execute('/switch home');
  assert.equal(h.state.routing.projectId, 'p1');
});

test('queued and running jobs retain their original projects while commands select a new project', async () => {
  const h = harness();
  const pending = [];
  h.backend.send = async (target, text) => {
    h.calls.push(['send', target.threadId, text]);
    return new Promise(resolve => pending.push(resolve));
  };
  const first = h.add('old task');
  const queued = h.add('old queued task');
  h.add('/project p2');
  const second = h.add('new project task');
  await h.tick(); await h.tick();
  assert.deepEqual(h.calls, [['send', 'a', 'old task'], ['send', 'b', 'new project task']]);
  assert.equal(first.projectId, 'p1'); assert.equal(queued.projectId, 'p1'); assert.equal(second.projectId, 'p2');
  pending[0]('old done'); await flush(); await h.tick();
  assert.deepEqual(h.calls.at(-1), ['send', 'a', 'old queued task']);
  pending[1]('new done'); pending[2]('queued done');
  await flush(); await h.tick(); await h.tick();
  assert.ok(h.sent.some(([id, text]) => id === queued.id && text.startsWith('1️⃣ Thread a（a）\n\n')));
});

test('legacy bound inbox jobs acquire their original project before any project switches', async () => {
  const h = harness();
  const job = { id: 'legacy', command: { kind: 'task', text: 'saved' }, bound: true, status: 'pending', sent: 0,
    threadId: 'a', replyThread: threadInfo(h.threads.get('a')) };
  h.state.jobs.push(job);
  const scheduler = createScheduler({ state: h.state, config: h.config, reference: h.reference, backend: h.backend, save() {}, send: async () => {} });
  await h.execute('/project p2');
  scheduler.tick(); await flush();
  assert.equal(job.projectId, 'p1');
  assert.deepEqual(h.calls.at(-1), ['send', 'a', 'saved']);
});

test('typing monitors selected and previous projects independently when one project is unavailable', async () => {
  const h = harness();
  h.state.typingContext = 'owner-context';
  await h.execute('/project p2');
  h.threads.get('b').status = 'running';
  const list = h.backend.list, polls = [], sent = [], reports = [];
  h.backend.list = async (config, id) => {
    polls.push(id);
    if (id === 'p1') throw new Error('project temporarily unavailable');
    return list(config, id);
  };
  const indicator = createTypingIndicator({ state: h.state, config: h.config, projectId: 'p1', backend: h.backend,
    api: { getConfig: async () => ({ typing_ticket: 'ticket' }), sendTyping: async (_, __, active) => sent.push(active) },
    owner: 'owner', status: report => reports.push(report) });
  indicator.tick(); await flush(); await flush();
  assert.ok(polls.includes('p1') && polls.includes('p2'));
  assert.equal(sent.at(-1), true);
  assert.ok(reports.some(report => report.activityError));
  await indicator.stop();
});

test('deleting a previously listed project never reassigns its saved number to a different project', async () => {
  const h = harness();
  await h.execute('/projects');
  h.projects.delete('p2');
  h.projects.set('p4', project('p4', 'Replacement'));
  await assert.rejects(h.execute('/project 2'), /unavailable/);
  assert.equal(h.state.routing.projectId, 'p1');
});

test('an empty selected project cannot dispatch ordinary text into the old thread lane', async () => {
  const h = harness();
  h.add('/project p3');
  h.add('do not send to the old thread');
  await h.tick(); await h.tick();
  assert.deepEqual(h.calls, []);
  assert.ok(h.sent.some(([, text]) => text.includes('尚未选择线程')));
});

test('inline new project options combine with naming in either order and preserve the task body', () => {
  for (const command of ['new', 'n', '新建', '新线程']) {
    for (const flag of ['--project', '--项目', '-p']) {
      for (const quoted of ['"Empty Project"', "'Empty Project'", '“Empty Project”', '「Empty Project」']) {
        assert.deepEqual(route(`/${command} ${flag}=${quoted} --名称 "线程 名" 执行任务\n--project 保留正文`), {
          kind: 'new', projectSelector: 'Empty Project', title: '线程 名', text: '执行任务\n--project 保留正文',
        });
        assert.deepEqual(route(`/${command} -n Report ${flag} ${quoted} task`), {
          kind: 'new', title: 'Report', projectSelector: 'Empty Project', text: 'task',
        });
      }
    }
  }
  assert.deepEqual(route('／新建　--项目=2　任务'), { kind: 'new', projectSelector: '2', text: '任务' });
  assert.deepEqual(route('/新建 --项目 初始 任务'), { kind: 'new', projectSelector: 'home', text: '任务' });
  assert.deepEqual(route('/new --project p2 -- --name this is task text'), {
    kind: 'new', projectSelector: 'p2', text: '--name this is task text',
  });
  assert.deepEqual(route('/new --projects text'), { kind: 'new', text: '--projects text' });
  assert.deepEqual(route('/task --project p2 task'), { kind: 'task', text: '--project p2 task' });
  assert.deepEqual(route('/new --project p2 /threads'), { kind: 'threads' });
  for (const help of [HELP, HELP_EN]) assert.ok(help.includes('/new --project <'));
});

test('invalid inline project or repeated options return usage without calling T3', async () => {
  const h = harness();
  for (const input of ['/new --project', '/new --project=', '/new --project "" task', '/new -p "  " task',
    '/new --project "unclosed task', '/new --project "p2"task', '/new --project p2',
    '/new --project "first\nsecond" task', '/new --project "bad\u0000project" task',
    '/new --project --name Report task', '/new --name Report -p', '/new -n --project p2 task',
    '/new -p p2 --project p3 task', '/new -p p2 -n A --title B task', '/new -p p2 --']) {
    assert.equal(route(input).kind, 'error', input);
    assert.match(await h.execute(input), /项目：\/new --project/);
  }
  assert.equal(h.state.routing.projectId, 'p1');
  assert.equal(h.state.routing.threadId, 'a');
  assert.deepEqual(h.calls, []);
});

test('inline creation uses saved project numbers and current model, then restores each project selection and numbering', async () => {
  const h = harness();
  h.threads.get('b').model = 'other-project-model';
  await h.execute('/projects');
  await h.execute('/project p2');
  await h.execute('/threads');
  await h.execute('/switch c');
  await h.execute('/project home');
  await h.execute('/threads');
  h.backend.projects = async () => [h.projects.get('p3'), h.projects.get('p1'), h.projects.get('p2')];
  const job = {};
  await h.execute('/new --project 2 --name Report 原始任务\n第二行', job);
  const options = h.calls.find(([kind]) => kind === 'create')[1];
  assert.equal(options.projectId, 'p2');
  assert.equal(options.title, 'Report');
  assert.equal(options.prompt, '原始任务\n第二行');
  assert.equal(options.model, 'model');
  assert.equal(job.projectId, 'p2');
  assert.equal(job.createdThread.projectId, 'p2');
  assert.equal(job.replyThread.number, 3);
  assert.equal(h.state.routing.projectId, 'p2');
  assert.equal(h.state.routing.project.title, '第二项目');
  assert.equal(h.state.routing.threadId, 'new');
  assert.deepEqual(h.state.routing.listedIds, ['b', 'c', 'new']);
  await h.execute('/project home');
  assert.equal(h.state.routing.threadId, 'a');
  assert.deepEqual(h.state.routing.listedIds, ['a']);
  await h.execute('/project p2');
  assert.equal(h.state.routing.threadId, 'new');
  assert.deepEqual(h.state.routing.listedIds, ['b', 'c', 'new']);
});

test('inline project names, unique prefixes and home can create first threads without selecting a project first', async () => {
  for (const selector of ['"Empty Project"', 'p3', 'home', '初始']) {
    const h = harness();
    await h.execute(`/new -p ${selector} task`);
    const expected = ['home', '初始'].includes(selector) ? 'p1' : 'p3';
    assert.equal(h.calls[0][1].projectId, expected);
    assert.equal(h.state.routing.projectId, expected);
    assert.equal(h.state.routing.threadId, 'new');
  }
  const h = harness();
  h.projects.set('unique-project', project('unique-project', 'Prefix Project'));
  await h.execute('/new --project unique task');
  assert.equal(h.calls[0][1].projectId, 'unique-project');
});

test('pending inline project options survive restart, including when the current project is empty', async () => {
  const h = harness();
  await h.execute('/project p3');
  const job = h.add('/new --name Report --project p2 task');
  Object.assign(h.state, JSON.parse(JSON.stringify(h.state)));
  recover(h.state);
  await executeCommand({ command: h.state.jobs[0].command, job: h.state.jobs[0], state: h.state,
    config: h.config, reference: h.reference, backend: h.backend, save() {} });
  assert.equal(h.calls[0][1].projectId, 'p2');
  assert.equal(h.calls[0][1].model, 'model');
  assert.equal(h.calls[0][1].title, job.command.title);
  assert.equal(h.state.routing.projectId, 'p2');
});

test('invalid, stale or mismatched inline project selections never create or change selection', async () => {
  const h = harness();
  await h.execute('/projects');
  const original = structuredClone(h.state.routing);
  for (const selector of ['missing', 'p', '99']) await assert.rejects(h.execute(`/new -p ${selector} task`));
  h.projects.set('copy', project('copy', '第二项目'));
  await assert.rejects(h.execute('/new -p 第二项目 task'), /不唯一/);
  h.projects.delete('copy');
  h.projects.delete('p2');
  h.projects.set('p4', project('p4', 'Replacement'));
  await assert.rejects(h.execute('/new -p 2 task'), /unavailable/);
  h.projects.get('p3').deletedAt = 'deleted';
  await assert.rejects(h.execute('/new -p p3 task'));
  h.backend.project = async () => h.projects.get('p1');
  await assert.rejects(h.execute('/new -p p4 task'), /不可用/);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.state.routing, original);
});

test('uncertain cross-project creation and failed confirmation preserve selection and never create twice', async () => {
  for (const mode of ['create-failed', 'read-failed', 'wrong-project']) {
    const h = harness();
    await h.execute('/threads');
    const original = structuredClone(h.state.routing);
    const create = h.backend.create;
    h.backend.create = async (...args) => {
      if (mode === 'create-failed') { h.calls.push(['create', args[1]]); throw new Error('uncertain'); }
      const result = await create(...args);
      if (mode === 'wrong-project') h.threads.get('new').projectId = 'p1';
      return result;
    };
    const read = h.backend.read;
    h.backend.read = async target => {
      if (mode === 'read-failed' && target.threadId === 'new') throw new Error('unreadable');
      return read(target);
    };
    const job = {};
    await assert.rejects(h.execute('/new -p p2 task', job), /不要重复/);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.state.routing, original);
    if (mode !== 'create-failed') {
      assert.equal(job.threadId, 'new');
      assert.equal(job.projectId, 'p2');
    }
  }
});

test('inline cross-project new commands release independent waits and queued tasks keep their original project', async () => {
  const h = harness();
  let count = 0;
  const pending = [], waiting = [];
  h.backend.create = async (_, options) => {
    h.calls.push(['create', options]);
    const created = { ...thread(`created-${++count}`, options.projectId), title: options.title };
    h.threads.set(created.threadId, created);
    return { threadId: created.threadId, runId: `run-${count}` };
  };
  h.backend.send = async (target, text) => {
    h.calls.push(['send', target.threadId, text]);
    if (target.threadId === 'a' && text === 'old running') return new Promise(resolve => pending.push(resolve));
    return 'done';
  };
  h.backend.wait = async target => {
    waiting.push(target.threadId);
    return new Promise(resolve => pending.push(resolve));
  };
  h.add('old running');
  const queued = h.add('old queued');
  h.add('/new -p p2 -n First first');
  h.add('/new -p p3 -n Second second');
  const followup = h.add('new project followup');
  for (let i = 0; i < 8; i++) await h.tick();
  assert.deepEqual(waiting, ['created-1', 'created-2']);
  assert.equal(queued.projectId, 'p1');
  assert.equal(followup.projectId, 'p3');
  assert.equal(followup.threadId, 'created-2');
  assert.equal(h.state.routing.projectId, 'p3');
  pending[2]('second done first');
  await flush(); await h.tick(); await h.tick();
  assert.ok(h.sent.some(([, text]) => text.includes('second done first')));
  assert.ok(h.calls.some(call => call[0] === 'send' && call[1] === 'created-2' && call[2] === 'new project followup'));
  pending[0]('old done'); pending[1]('first done last');
  for (let i = 0; i < 5; i++) await h.tick();
  assert.ok(h.calls.some(call => call[0] === 'send' && call[1] === 'a' && call[2] === 'old queued'));
  assert.equal(h.state.routing.threadId, 'created-2');
});
