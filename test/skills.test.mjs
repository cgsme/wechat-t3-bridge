import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { incoming, route } from '../src/core.mjs';
import { listSkills, skillPrompt } from '../src/skills.mjs';
import { executeCommand } from '../src/commands.mjs';

test('skill commands support Chinese, targeted tasks and named new threads', () => {
  for (const prefix of ['/task', '/new', '/to 2 /task', '/新建']) {
    assert.deepEqual(route(`${prefix} --skills code-review,tdd 修复`), route(`${prefix} --skill code-review,tdd 修复`));
  }
  assert.equal(route('/技能 审查').kind, 'skills');
  assert.equal(route('/skills review').search, 'review');
  const task = route('/to 2 /task --skill code-review,tdd 修复');
  assert.equal(task.selector, '2');
  assert.deepEqual(task.skills, ['code-review', 'tdd']);
  const fresh = route('/new --skill tdd --name 测试 修复');
  assert.equal(fresh.title, '测试');
  assert.deepEqual(fresh.skills, ['tdd']);
});

test('incomplete or malformed skill options return usage before contacting T3', async () => {
  const inputs = ['--skills to-tickets', '--skill', '/task --skills to-tickets', '/task --skills',
    '/task --skills=', '/task --skills "" task', '/task --skills , task', '/task --skills tdd, task',
    '/task --skills tdd,,review task', '/task --skills "unclosed task', '/task --skills "tdd"task',
    '/task --skills "tdd\nreview" task', '/task --skills --skill tdd task',
    '/task --skill tdd --skills review task', '/task --skills tdd /status',
    '/new --skills to-tickets', '/new --name Report --skills to-tickets',
    '/new --skills tdd --name Report', '/new --project p --skills',
    '/to 2 --skills to-tickets', '/to 2 /task --skills to-tickets', '／任务　--skills　to-tickets'];
  const backend = Object.fromEntries(['read', 'list', 'send', 'create'].map(name =>
    [name, () => assert.fail(`invalid skill command called backend.${name}`)]));
  for (const [index, text] of inputs.entries()) {
    const message = incoming({ from_user_id: 'owner', message_type: 1, context_token: 'context',
      message_id: String(index), item_list: [{ type: 1, text_item: { text } }] }, 'owner');
    assert.equal(message.command.kind, 'error', text);
    const reply = await executeCommand({ command: message.command, state: { jobs: [], seen: [] },
      config: { threadId: 'a' }, reference: { projectId: 'p' }, backend, save() {}, job: {} });
    assert.match(reply, /用法：/, text);
    assert.match(reply, /--skill/, text);
  }
});

test('skill options work for implicit tasks and with new-thread options in any order', () => {
  for (const prefix of ['', '/task ', '/任务 ', '/to 2 ', '/to 2 /task ']) {
    assert.deepEqual(route(`${prefix}--skills tdd,code-review,tdd 修复\n第二行`), {
      kind: 'task', skills: ['tdd', 'code-review'], text: '修复\n第二行',
      ...(prefix.startsWith('/to') ? { selector: '2' } : {}),
    });
  }
  for (const options of ['--skills tdd --name Report --project p', '--name Report --skills tdd --project p',
    '--project p --name Report --skills tdd', '--project=p --skills="tdd" --name=Report']) {
    assert.deepEqual(route(`/new ${options} 修复`), {
      kind: 'new', skills: ['tdd'], title: 'Report', projectSelector: 'p', text: '修复',
    });
  }
});

test('skill parsing stops at the task body or explicit option terminator', () => {
  for (const prefix of ['', '/task ', '/new ']) {
    assert.deepEqual(route(`${prefix}解释 --skills to-tickets`), {
      kind: prefix === '/new ' ? 'new' : 'task', text: '解释 --skills to-tickets',
    });
    assert.deepEqual(route(`${prefix}-- --skills to-tickets`), {
      kind: prefix === '/new ' ? 'new' : 'task', text: '--skills to-tickets',
    });
  }
  assert.deepEqual(route('/new --skills tdd --name Report -- --skills literal'), {
    kind: 'new', skills: ['tdd'], title: 'Report', text: '--skills literal',
  });
  assert.deepEqual(route('/task --skills tdd 解释 --skills literal'), {
    kind: 'task', skills: ['tdd'], text: '解释 --skills literal',
  });
});

test('local skill discovery, querying and task submission use the real skill file', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-skills-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const folder = path.join(cwd, '.agents', 'skills', 'bridge-regression-unique');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: bridge-regression-unique\ndescription: "测试技能查询"\n---\nFollow this workflow.');
  const config = { cwd, threadId: 'a' };
  assert.ok(listSkills(config).some(skill => skill.name === 'bridge-regression-unique'));
  const state = { jobs: [], seen: [] };
  let submitted, created;
  const backend = { read: async target => ({ threadId: target.threadId, projectId: 'p', link: 'test', title: 'A' }),
    send: async (_, prompt) => { submitted = prompt; return 'done'; },
    create: async (_, options) => { created = options; return { threadId: 'created', status: 'completed', reply: 'done' }; } };
  const execute = command => executeCommand({ command, state, config, reference: { projectId: 'p' }, backend, save: () => {}, job: {} });
  assert.match(await execute(route('/skills 测试技能查询')), /bridge-regression-unique/);
  for (const input of ['/task --skill bridge-regression-unique 检查', '--skills bridge-regression-unique 检查',
    '/task --skills=bridge-regression-unique 检查']) {
    assert.equal(await execute(route(input)), 'done');
    assert.ok(submitted.includes(path.join(folder, 'SKILL.md')));
    assert.ok(submitted.endsWith('任务：\n检查'));
    assert.doesNotMatch(submitted, /--skills?/);
  }
  submitted = null;
  await assert.rejects(execute(route('/task --skill missing-bridge-skill 检查')), /技能不存在/);
  assert.equal(submitted, null);
  await execute(route('/new --name Report --skills bridge-regression-unique 检查'));
  assert.equal(created.title, 'Report');
  assert.ok(created.prompt.includes(path.join(folder, 'SKILL.md')));
  assert.ok(created.prompt.endsWith('任务：\n检查'));
  assert.doesNotMatch(created.prompt, /--skills?|--name/);
  created = null;
  await assert.rejects(execute(route('/new --name Report --skills missing-bridge-skill 检查')), /技能不存在/);
  assert.equal(created, null);
  assert.equal(skillPrompt({ text: 'unchanged' }, config), 'unchanged');
});
