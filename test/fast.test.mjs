import test from 'node:test';
import assert from 'node:assert/strict';
import { route, HELP, HELP_EN } from '../src/core.mjs';
import { fastMode, fastSelection } from '../src/models.mjs';
import { readFastConfig, changeFastMode } from '../src/t3-control.mjs';
import { executeCommand } from '../src/commands.mjs';

const catalog = { providers: [{ providerInstanceId: 'codex', models: [
  { id: 'model', options: [{ id: 'reasoningEffort', values: ['high', 'xhigh'] },
    { id: 'serviceTier', values: ['default', 'priority'], default: 'default' }] },
  { id: 'unsupported', options: [] },
] }] };
const configuration = (tier = 'default') => ({ threadId: 'selected',
  modelSelection: { instanceId: 'codex', model: 'model', options: [
    { id: 'reasoningEffort', value: 'xhigh' }, { id: 'unrelated', value: true },
    ...(tier === undefined || tier === null ? [] : [{ id: 'serviceTier', value: tier }]),
  ] }, runtimeMode: 'full-access', interactionMode: 'default' });

function controlFixture(initial = configuration()) {
  let current = structuredClone(initial);
  const calls = [], sessions = [], writes = [];
  const control = async (target, action, options = {}) => {
    sessions.push({ target, write: !!options.write });
    return action(async (tool, args) => {
      calls.push({ tool, args });
      if (tool === 'orchestrator_capabilities') return structuredClone(catalog);
      if (args.modelSelection) {
        assert.equal(options.write, true);
        writes.push(structuredClone(args.modelSelection));
        current.modelSelection = structuredClone(args.modelSelection);
      }
      return structuredClone(current);
    });
  };
  return { control, calls, sessions, writes, get current() { return current; } };
}

test('/fast query, on and off are controls, including wrapped controls and English help', () => {
  assert.deepEqual(route('/fast'), { kind: 'fast' });
  assert.deepEqual(route('/FAST ON'), { kind: 'fast', enabled: true });
  assert.deepEqual(route('/fast off'), { kind: 'fast', enabled: false });
  for (const wrapper of ['task', 'new']) assert.deepEqual(route(`/${wrapper} /fast on`), { kind: 'fast', enabled: true });
  for (const input of ['/fast yes', '/fast on extra', '/fast on\n/task bad', '/faster']) {
    assert.equal(route(input).kind, 'help');
  }
  assert.ok(HELP.includes('/fast on|off'));
  assert.ok(HELP_EN.includes('/fast on|off'));
  assert.deepEqual(route('/to 2 /fast on'), { kind: 'fast', selector: '2', enabled: true });
  assert.deepEqual(route('/to mcp:abc /fast off'), { kind: 'fast', selector: 'mcp:abc', enabled: false });
  assert.deepEqual(route('/to home /fast'), { kind: 'fast', selector: 'home' });
  assert.deepEqual(route('/to 2 /status'), { kind: 'status', selector: '2' });
});

test('Fast distinguishes priority, default, catalog defaults and unsupported models', () => {
  assert.deepEqual(fastMode(configuration('priority'), catalog), { supported: true, enabled: true });
  assert.deepEqual(fastMode(configuration('default'), catalog), { supported: true, enabled: false });
  assert.deepEqual(fastMode(configuration(null), catalog), { supported: true, enabled: false });
  const defaults = structuredClone(catalog);
  defaults.providers[0].models[0].options[1].default = 'priority';
  assert.equal(fastMode(configuration(null), defaults).enabled, true);
  const unsupported = configuration(); unsupported.modelSelection.model = 'unsupported';
  assert.deepEqual(fastMode(unsupported, catalog), { supported: false, enabled: false });
  const absent = configuration(); absent.modelSelection.model = 'missing';
  assert.throws(() => fastMode(absent, catalog), /无法确认/);
  const disabled = structuredClone(catalog); disabled.providers[0].constraints = ['Provider instance is disabled.'];
  assert.throws(() => fastMode(configuration(), disabled), /无法确认/);
});

test('Fast selection changes only serviceTier and retains model, reasoning and other options', () => {
  const original = configuration('priority');
  const snapshot = structuredClone(original);
  const selection = fastSelection(original, catalog, false);
  assert.deepEqual(selection, { instanceId: 'codex', model: 'model', options: [
    { id: 'reasoningEffort', value: 'xhigh' }, { id: 'unrelated', value: true },
    { id: 'serviceTier', value: 'default' },
  ] });
  assert.deepEqual(original, snapshot);
  original.modelSelection.model = 'unsupported';
  assert.throws(() => fastSelection(original, catalog, true), /不支持 Fast/);
});

test('Fast read uses a single read-only connection and the exact current model catalog', async () => {
  const h = controlFixture(configuration('priority'));
  const result = await readFastConfig({ threadId: 'selected' }, h);
  assert.equal(result.fast.enabled, true);
  assert.equal(h.sessions.length, 1);
  assert.equal(h.sessions[0].write, false);
  assert.equal(h.calls[1].args.search, 'model');
  assert.deepEqual(h.writes, []);
  await assert.rejects(readFastConfig({ threadId: 'wrong' }, h), /目标线程不一致/);
});

test('Fast writes verify the saved setting and preserve modes and unrelated options', async () => {
  const h = controlFixture();
  const enabled = await changeFastMode({ threadId: 'selected' }, true, h);
  assert.equal(enabled.fast.enabled, true);
  assert.equal(enabled.runtimeMode, 'full-access');
  assert.equal(enabled.modelSelection.options.find(option => option.id === 'reasoningEffort').value, 'xhigh');
  assert.ok(h.sessions.every(session => session.write));
  const disabled = await changeFastMode({ threadId: 'selected' }, false, h);
  assert.equal(disabled.fast.enabled, false);
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].options.find(option => option.id === 'serviceTier').value, 'default');
});

test('already selected or unsupported Fast modes do not issue model writes', async () => {
  const h = controlFixture(configuration('priority'));
  await changeFastMode({ threadId: 'selected' }, true, h);
  assert.deepEqual(h.writes, []);
  const unsupported = configuration(); unsupported.modelSelection.model = 'unsupported';
  const other = controlFixture(unsupported);
  await assert.rejects(changeFastMode({ threadId: 'selected' }, true, other), /不支持 Fast/);
  assert.deepEqual(other.writes, []);
  assert.throws(() => changeFastMode({ threadId: 'selected' }, 'on', other), /on 或 off/);
});

test('unconfirmed writes, model drift and lost reasoning options never report Fast success', async () => {
  for (const fault of ['ignored', 'model', 'thread', 'reasoning']) {
    let mutated = false;
    const control = async (_, action) => action(async (tool, args) => {
      if (tool === 'orchestrator_capabilities') return catalog;
      if (args.modelSelection) mutated = true;
      const result = configuration(mutated && fault !== 'ignored' ? 'priority' : 'default');
      if (mutated && fault === 'model') result.modelSelection.model = 'other';
      if (mutated && fault === 'thread') result.threadId = 'other';
      if (mutated && fault === 'reasoning') result.modelSelection.options = [{ id: 'serviceTier', value: 'priority' }];
      return result;
    });
    await assert.rejects(changeFastMode({ threadId: 'selected' }, true, { control }), /未能核实/);
  }
});

function commandHarness() {
  const state = { jobs: [{ status: 'pending' }], routing: { threadId: 'selected', listedIds: ['home', 'selected'],
    projectId: 'project', projectThreads: {}, listedProjectIds: [] } };
  const configs = new Map(['home', 'selected'].map(id => [id, { ...configuration(), threadId: id }]));
  const calls = [];
  const backend = {
    list: async () => [...configs.keys()].map(threadId => ({ threadId, projectId: 'project' })),
    read: async target => ({ threadId: target.threadId, title: `Name ${target.threadId}`, projectId: 'project',
      status: 'completed', link: `https://test/${target.threadId}` }),
    fastConfig: async target => { calls.push(['read', target.threadId]); const config = configs.get(target.threadId);
      return { ...structuredClone(config), fast: fastMode(config, catalog) }; },
    setFast: async (target, enabled) => { calls.push(['write', target.threadId, enabled]);
      const config = configs.get(target.threadId); config.modelSelection = fastSelection(config, catalog, enabled);
      return { ...structuredClone(config), fast: fastMode(config, catalog) }; },
  };
  const execute = (text, job = {}) => executeCommand({ command: route(text), state, config: { threadId: 'home' },
    reference: { projectId: 'project' }, backend, save() {}, job });
  return { state, configs, calls, backend, execute };
}

test('/fast changes only the selected thread and /status reads fresh state after external changes', async () => {
  const h = commandHarness();
  assert.match(await h.execute('/fast'), /Fast：⚪ 已关闭/);
  assert.match(await h.execute('/fast on'), /Fast：⚡ 已开启/);
  assert.match(await h.execute('/status'), /Fast：⚡ 已开启/);
  assert.equal(fastMode(h.configs.get('home'), catalog).enabled, false);
  const config = h.configs.get('selected');
  config.modelSelection = fastSelection(config, catalog, false);
  assert.match(await h.execute('/status'), /Fast：⚪ 已关闭/);
  h.state.routing.threadId = 'home';
  assert.match(await h.execute('/status'), /^1️⃣ Name home（home）\n\n/);
  assert.match(await h.execute('/fast on'), /Fast：⚡ 已开启/);
  assert.equal(fastMode(h.configs.get('selected'), catalog).enabled, false);
  assert.deepEqual(h.calls.filter(call => call[0] === 'write'), [['write', 'selected', true], ['write', 'home', true]]);
});

test('/status displays unsupported and unknown Fast states while retaining queue and connection details', async () => {
  const h = commandHarness();
  h.configs.get('selected').modelSelection.model = 'unsupported';
  assert.match(await h.execute('/status'), /Fast：当前模型不支持/);
  h.backend.fastConfig = async () => { throw new Error('sensitive diagnostics'); };
  const reply = await h.execute('/status');
  assert.match(reply, /Fast：未知（读取失败/);
  assert.match(reply, /排队中：1 条消息/);
  assert.match(reply, /微信已连接/);
  assert.doesNotMatch(reply, /sensitive/);
  h.backend.fastConfig = async () => ({ threadId: 'wrong', fast: { supported: true, enabled: true } });
  assert.match(await h.execute('/status'), /Fast：未知/);
  await assert.rejects(h.execute('/fast'), /未能核实/);
});

test('Fast command validates the project and rejects unverified settings', async () => {
  const h = commandHarness();
  h.backend.setFast = async () => ({ threadId: 'selected', fast: { supported: true, enabled: false } });
  await assert.rejects(h.execute('/fast on'), /未能核实/);
  h.backend.read = async () => ({ threadId: 'selected', projectId: 'other', link: 'https://test/selected' });
  await assert.rejects(h.execute('/fast'), /不可用或不属于当前项目/);
  assert.deepEqual(h.calls, []);
});

test('targeted Fast controls and status use saved numbers, IDs, prefixes and home without switching', async () => {
  const h = commandHarness();
  const routing = structuredClone(h.state.routing);
  const job = {};
  assert.match(await h.execute('/to 1 /fast on', job), /Fast：⚡ 已开启/);
  assert.equal(job.threadId, 'home');
  assert.equal(job.replyThread.title, 'Name home');
  assert.equal(fastMode(h.configs.get('selected'), catalog).enabled, false);
  assert.match(await h.execute('/to home /status'), /Fast：⚡ 已开启/);
  assert.match(await h.execute('/to hom /fast'), /\/to hom \/fast off/);
  assert.match(await h.execute('/to home /fast off'), /Fast：⚪ 已关闭/);
  h.configs.set('mcp:abc', { ...configuration(), threadId: 'mcp:abc' });
  assert.match(await h.execute('/to mcp:abc /fast on'), /Fast：⚡ 已开启/);
  assert.match(await h.execute('/to mcp:a /fast'), /Fast：⚡ 已开启/);
  assert.deepEqual(h.state.routing, { ...routing, listedIds: [...routing.listedIds, 'mcp:abc'] });
  assert.deepEqual(h.calls.filter(call => call[0] === 'write'), [
    ['write', 'home', true], ['write', 'home', false], ['write', 'mcp:abc', true],
  ]);
});

test('targeted Fast rejects missing, ambiguous, archived and project-external targets without writing', async () => {
  const h = commandHarness();
  h.configs.set('home-other', { ...configuration(), threadId: 'home-other' });
  for (const selector of ['99', 'missing', 'hom']) await assert.rejects(h.execute(`/to ${selector} /fast on`));
  for (const extra of [{ archived: true }, { projectId: 'other' }, { relationshipToParent: 'subagent' }]) {
    h.backend.read = async () => ({ threadId: 'home', projectId: 'project', link: 'https://test/home', ...extra });
    await assert.rejects(h.execute('/to 1 /fast on'), /不可用或不属于当前项目/);
  }
  assert.deepEqual(h.calls, []);
  assert.equal(h.state.routing.threadId, 'selected');
});

test('a persisted Fast target cannot be retargeted by a new list or selected thread', async () => {
  const h = commandHarness();
  h.state.routing.listedIds = ['selected', 'home'];
  const job = { threadId: 'home' };
  assert.match(await h.execute('/to 1 /fast on', job), /Fast：⚡ 已开启/);
  assert.deepEqual(h.calls, [['write', 'home', true]]);
  assert.equal(h.state.routing.threadId, 'selected');
  h.backend.fastConfig = async () => { throw new Error('offline'); };
  assert.match(await h.execute('/to home /status'), /请用 \/to home \/fast 重试/);
});
