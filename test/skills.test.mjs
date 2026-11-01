import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { route } from '../src/core.mjs';
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

test('local skill discovery, querying and task submission use the real skill file', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-skills-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const folder = path.join(cwd, '.agents', 'skills', 'bridge-regression-unique');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: bridge-regression-unique\ndescription: "测试技能查询"\n---\nFollow this workflow.');
  const config = { cwd, threadId: 'a' };
  assert.ok(listSkills(config).some(skill => skill.name === 'bridge-regression-unique'));
  const state = { jobs: [], seen: [] };
  let submitted;
  const backend = { read: async () => ({ threadId: 'a', projectId: 'p', link: 'test', title: 'A' }),
    send: async (_, prompt) => { submitted = prompt; return 'done'; } };
  const execute = command => executeCommand({ command, state, config, reference: { projectId: 'p' }, backend, save: () => {}, job: {} });
  assert.match(await execute(route('/skills 测试技能查询')), /bridge-regression-unique/);
  assert.equal(await execute(route('/task --skill bridge-regression-unique 检查')), 'done');
  assert.ok(submitted.includes(path.join(folder, 'SKILL.md')));
  assert.ok(submitted.endsWith('任务：\n检查'));
  submitted = null;
  await assert.rejects(execute(route('/task --skill missing-bridge-skill 检查')), /技能不存在/);
  assert.equal(submitted, null);
  assert.equal(skillPrompt({ text: 'unchanged' }, config), 'unchanged');
});
