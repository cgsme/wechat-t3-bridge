import test from 'node:test';
import assert from 'node:assert/strict';
import { CHINESE_COMMAND_ALIASES, HELP, HELP_EN, route } from '../src/core.mjs';
import { executeCommand } from '../src/commands.mjs';

test('Chinese command names match English operations and appear in Chinese help', () => {
  const args = { help: ['', ' en'], task: [' 检查内存\n第二行'], new: [' 新任务'], to: [' 2 检查内存'],
    projects: [''], project: ['', ' 第二项目'], threads: [''], switch: [' 2', ' #2', ' mcp:abc'],
    history: ['', ' 2'], status: [''], models: ['', ' gpt'], model: ['', ' codex::model'],
    fast: ['', ' on', ' off'], questions: [''], answer: [' 1,2', ' 中文答案\n第二行'], steer: [' 补充指令\n第二行'],
    skills: ['', ' review'], cost: ['', ' 7d'], token: ['', ' 30d'], limit: [''] };
  for (const [name, command] of Object.entries(CHINESE_COMMAND_ALIASES)) {
    for (const tail of args[command]) assert.deepEqual(route('/' + name + tail), route('/' + command + tail));
    assert.ok(HELP.includes('/' + name));
  }
  assert.doesNotMatch(HELP_EN, /[\u4e00-\u9fff]/);
});

test('Chinese Fast, help and home arguments support ASCII and full-width separators', () => {
  for (const value of ['开启', '启用', '打开', '开']) assert.deepEqual(route('/快速 ' + value), { kind: 'fast', enabled: true });
  for (const value of ['关闭', '禁用', '关']) assert.deepEqual(route('/加速 ' + value), { kind: 'fast', enabled: false });
  assert.deepEqual(route('/帮助 英文'), { kind: 'help', language: 'en' });
  assert.deepEqual(route('/帮助 中文'), { kind: 'help' });
  assert.deepEqual(route('/帮助 zh'), { kind: 'help' });
  assert.deepEqual(route('/切换 初始'), { kind: 'switch', selector: 'home' });
  assert.deepEqual(route('/项目 初始'), { kind: 'project', selector: 'home' });
  assert.deepEqual(route('/发送 初始 检查磁盘'), { kind: 'task', selector: 'home', text: '检查磁盘' });
  for (const input of ['／线程', '／ts', '/线程']) assert.deepEqual(route(input), { kind: 'threads' });
  assert.deepEqual(route('／发送　#2　／快速　开启'), { kind: 'fast', enabled: true, selector: '#2' });
  assert.deepEqual(route('／历史　2'), { kind: 'history', page: 2 });
  assert.deepEqual(route('／模型　codex::model'), { kind: 'model', name: 'codex::model' });
  for (const input of ['／', '／不存在', '/快速 自动', '/快速 开启\n/新建 bad']) assert.equal(route(input).kind, 'help');
});

test('Chinese nested and targeted controls share restrictions with English commands', () => {
  assert.deepEqual(route('/新建 /线程'), { kind: 'threads' });
  assert.deepEqual(route('/任务 ／状态'), { kind: 'status' });
  assert.deepEqual(route('/新线程 /帮助 英文'), { kind: 'help', language: 'en' });
  assert.deepEqual(route('/发送 2 /回答 1'), { kind: 'answer', selector: '2', text: '1' });
  assert.deepEqual(route('/发给 mcp:abc /问题'), { kind: 'questions', selector: 'mcp:abc' });
  assert.deepEqual(route('/发送 2 /历史 3'), { kind: 'history', selector: '2', page: 3 });
  for (const input of ['/发送 2 /切换 初始', '/发送 2 /项目 1', '/发送 2 /新建 task',
    '/发送 2 /模型 other', '/发送 2 /发送 3 nested', '/to 2 ／发送 3 nested']) assert.equal(route(input).kind, 'help');
});

test('plain Chinese and command words inside task or answer text are preserved', () => {
  for (const text of ['线程', '状态', '帮助', '快速 开启', '请把 /线程 写入文件']) {
    assert.deepEqual(route(text), { kind: 'task', text });
  }
  const text = '保留 /线程、／快速 开启、$literal & 中文😀\n第二行';
  assert.deepEqual(route('/任务 ' + text), { kind: 'task', text });
  assert.deepEqual(route('/新建 ' + text), { kind: 'new', text });
  assert.deepEqual(route('/发送 2 ' + text), { kind: 'task', selector: '2', text });
  assert.deepEqual(route('/回答 /线程'), { kind: 'answer', text: '/线程' });
});

test('Chinese list aliases save the same number mapping and targeted Fast changes only its target', async () => {
  const rows = ['a', 'b'].map(threadId => ({ threadId, title: threadId, projectId: 'p', link: `https://test/${threadId}` }));
  const state = { jobs: [], routing: { projectId: 'p', threadId: 'a', listedIds: [] } };
  const writes = [];
  const backend = { list: async () => rows, read: async target => rows.find(thread => thread.threadId === target.threadId),
    setFast: async (target, enabled) => { writes.push([target.threadId, enabled]); return { threadId: target.threadId,
      modelSelection: { instanceId: 'codex', model: 'model' }, fast: { supported: true, enabled } }; } };
  const execute = text => executeCommand({ command: route(text), state, config: { threadId: 'a' },
    reference: { projectId: 'p' }, backend, save() {}, job: {} });
  await execute('／线程');
  assert.deepEqual(state.routing.listedIds, ['a', 'b']);
  assert.match(await execute('/发送 2 /快速 开启'), /Fast：⚡ 已开启/);
  assert.deepEqual(writes, [['b', true]]);
  assert.equal(state.routing.threadId, 'a');
  await execute('/新建 /线程列表');
  assert.deepEqual(writes, [['b', true]]);
});
