import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { route, recover, HELP, HELP_EN } from '../src/core.mjs';
import { executeCommand } from '../src/commands.mjs';
import { createThread } from '../src/backend.mjs';

test('new thread names work with English and Chinese options, aliases, quotes and equals syntax', () => {
  for (const command of ['new', 'n', '新建', '新线程']) {
    for (const flag of ['--name', '--title', '--名称', '--名字', '-n']) {
      assert.deepEqual(route(`/${command} ${flag} 内存检查 检查内存\n第二行`), {
        kind: 'new', title: '内存检查', text: '检查内存\n第二行',
      });
    }
  }
  for (const quoted of ['"工作 计划"', "'工作 计划'", '“工作 计划”', '「工作 计划」']) {
    assert.deepEqual(route('/new --name ' + quoted + ' 原始任务'), { kind: 'new', title: '工作 计划', text: '原始任务' });
  }
  assert.deepEqual(route('/new --name=Report task'), { kind: 'new', title: 'Report', text: 'task' });
  assert.deepEqual(route('／新建　--名称=“内存 检查”　检查内存'), { kind: 'new', title: '内存 检查', text: '检查内存' });
  assert.deepEqual(route('/new --name ' + '长'.repeat(100) + ' task'), { kind: 'new', title: '长'.repeat(100), text: 'task' });
  assert.ok(HELP.includes('/new --name <名称> <要求>'));
  assert.ok(HELP_EN.includes('/new --name <title> <request>'));
});

test('invalid names return usage without starting a task, and ordinary flag-like text remains unchanged', async () => {
  const state = { jobs: [], routing: { threadId: 'home', listedIds: [] } };
  for (const input of ['/new --name', '/new --name=', '/new --name "" task', '/new --name "  " task',
    '/new --name "unclosed task', '/new --name "name"task', '/new --name name', '/new --name "first\nsecond" task',
    '/new --name "bad\u0000name" task']) {
    const command = route(input);
    assert.equal(command.kind, 'error', input);
    const reply = await executeCommand({ command, state, config: { threadId: 'home' }, reference: { projectId: 'p' },
      backend: {}, save() {}, job: {} });
    assert.match(reply, /用法：\/new --name/);
    assert.equal(state.routing.threadId, 'home');
  }
  assert.deepEqual(route('/new --provider something\n第二行'), { kind: 'new', text: '--provider something\n第二行' });
  assert.deepEqual(route('/new --names text'), { kind: 'new', text: '--names text' });
  assert.deepEqual(route('/task --name Report actual task'), { kind: 'task', text: '--name Report actual task' });
  assert.deepEqual(route('/new --name Report Explain /threads'), { kind: 'new', title: 'Report', text: 'Explain /threads' });
  assert.deepEqual(route('/new --name Report /threads'), { kind: 'threads' });
});

test('a pending named job survives restart and passes its title separately from the untouched task body', async () => {
  const home = { threadId: 'home', projectId: 'p', title: 'Home', providerInstanceId: 'codex', model: 'model', link: 'https://test/home' };
  const title = '内存 检查';
  const text = '只处理正文\n包含 --name、"quotes" & $literal 😀';
  const state = { jobs: [{ id: 'job', status: 'pending', command: route(`/new --name "${title}" ${text}`) }], seen: [] };
  Object.assign(state, JSON.parse(JSON.stringify(state))); recover(state);
  const job = state.jobs[0], calls = [];
  const reply = await executeCommand({ command: job.command, job, state, config: { threadId: 'home' }, reference: home,
    backend: { read: async target => target.threadId === 'home' ? home : { ...home, threadId: 'created', title },
      create: async (_, options) => { calls.push(options); return { threadId: 'created', runId: 'run', status: 'completed', reply: 'done' }; } }, save() {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, title);
  assert.equal(calls[0].prompt, text);
  assert.equal(calls[0].projectId, 'p');
  assert.equal(calls[0].provider, 'codex');
  assert.equal(calls[0].model, 'model');
  assert.equal(state.routing.threadId, 'created');
  assert.equal(job.replyThread.title, title);
  assert.equal(job.createdThread.title, title);
  assert.ok(reply.includes(title));
});

test('thread title metacharacters remain one CLI argument and task text travels through stdin', async () => {
  const fixture = fileURLToPath(new URL('./fake-t3.mjs', import.meta.url));
  const title = '内存 & "quoted" | $(anything) %PATH%';
  const prompt = '正文中文\n包含 --name flags';
  const result = await createThread({ command: process.execPath, prefixArgs: [fixture], cwd: path.dirname(fixture) },
    { projectId: 'p', provider: 'codex', model: 'model', title, prompt });
  assert.equal(result.args[result.args.indexOf('--title') + 1], title);
  assert.equal(result.input, prompt);
});
