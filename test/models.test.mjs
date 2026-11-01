import test from 'node:test';
import assert from 'node:assert/strict';
import { route, HELP, HELP_EN } from '../src/core.mjs';
import { executeCommand } from '../src/commands.mjs';
import { catalogModels, listedModels, resolveModel, modelSelection, formatModels } from '../src/models.mjs';
import { localMcpEndpoint, decodeRpc, withT3Control, issueWriteCredential } from '../src/t3-control.mjs';

const catalog = { providers: [
  { providerInstanceId: 'codex', models: [
    { id: 'current', options: [{ id: 'effort', values: ['high', 'low'] }] },
    { id: 'next', options: [{ id: 'effort', values: ['high', 'low'] }] },
    { id: 'auto/namespaced@1m', options: [] },
  ], omittedModels: 2 },
  { providerInstanceId: 'other', models: [{ id: 'next' }, { id: 'foreign' }] },
  { providerInstanceId: 'disabled', models: [{ id: 'unavailable' }], constraints: ['Provider instance is disabled.'] },
] };
const home = { threadId: 'home', projectId: 'project', title: 'Home', link: 'https://example.test/home', model: 'current', providerInstanceId: 'codex' };
const selected = { ...home, threadId: 'selected', title: 'Selected', link: 'https://example.test/selected' };

function harness() {
  const state = { jobs: [], routing: { threadId: selected.threadId, listedIds: [] } };
  const calls = [];
  const modelConfig = { threadId: selected.threadId, modelSelection: { instanceId: 'codex', model: 'current', options: [{ id: 'effort', value: 'high' }, { id: 'unsupported', value: true }] }, runtimeMode: 'full-access' };
  const backend = {
    read: async config => { calls.push(['read', config.threadId]); return selected; },
    modelConfig: async config => { calls.push(['modelConfig', config.threadId]); return structuredClone(modelConfig); },
    catalog: async (config, search) => { calls.push(['catalog', config.threadId, search]); return catalog; },
    setModel: async (config, selection) => { calls.push(['setModel', config.threadId, selection]); modelConfig.modelSelection = selection; return structuredClone(modelConfig); },
  };
  return { state, calls, backend, modelConfig, execute: text => executeCommand({ command: route(text), state,
    config: { threadId: home.threadId }, reference: home, backend, save() {}, job: {} }) };
}

test('model commands parse exact names and namespaced IDs without becoming tasks', () => {
  assert.deepEqual(route('/models'), { kind: 'models' });
  assert.deepEqual(route('/models some filter'), { kind: 'models', search: 'some filter' });
  assert.deepEqual(route('/model'), { kind: 'model' });
  assert.deepEqual(route('/MODEL codex::auto/model@1m'), { kind: 'model', name: 'codex::auto/model@1m' });
  assert.equal(route('/model a b').kind, 'help');
  assert.equal(route('/model name\n/task test').kind, 'help');
  assert.equal(route('/modelx name').kind, 'help');
  assert.ok(HELP.includes('/models [关键词]'));
  assert.ok(HELP.includes('/model <模型|提供商::模型>'));
  assert.ok(HELP_EN.includes('/models [search]'));
  assert.ok(HELP_EN.includes('/model <model|provider::model>'));
});

test('catalog excludes disabled providers and reports omitted entries with a search command', () => {
  const models = catalogModels(catalog);
  assert.equal(models.length, 5);
  assert.equal(models.some(entry => entry.provider === 'disabled'), false);
  const text = formatModels(catalog, { instanceId: 'codex', model: 'current' });
  assert.ok(text.includes('⭐ codex::current'));
  assert.ok(text.includes('other::foreign'));
  assert.ok(text.includes('另有 2 个目录条目'));
  assert.ok(text.includes('/models <关键词>'));
});

test('bare IDs prefer the current provider; qualified names handle collisions and namespaces', () => {
  const models = catalogModels(catalog);
  assert.equal(resolveModel('next', models, { instanceId: 'codex' }).provider, 'codex');
  assert.equal(resolveModel('OTHER::NEXT', models, { instanceId: 'codex' }).provider, 'other');
  assert.equal(resolveModel('auto/namespaced@1m', models, { instanceId: 'codex' }).provider, 'codex');
  assert.throws(() => resolveModel('next', models, { instanceId: 'third' }), /Ambiguous/);
  assert.throws(() => resolveModel('unavailable', models, { instanceId: 'codex' }), /not found/);
  assert.throws(() => resolveModel('nex', models, { instanceId: 'codex' }), /not found/);
});

test('same-provider changes preserve only supported options, cross-provider changes clear them', () => {
  const entry = catalogModels(catalog).find(value => value.key === 'codex::next');
  const current = { instanceId: 'codex', options: [{ id: 'effort', value: 'high' }, { id: 'old', value: true }] };
  assert.deepEqual(modelSelection(entry, current).options, [{ id: 'effort', value: 'high' }]);
  assert.deepEqual(modelSelection(entry, { instanceId: 'other', options: current.options }).options, []);
  assert.deepEqual(modelSelection(entry, { instanceId: 'codex', options: [{ id: 'effort', value: 'unsupported' }] }).options, []);
});

test('/model and /models read the selected thread rather than the home thread', async () => {
  const h = harness();
  const current = await h.execute('/model');
  assert.ok(current.includes('codex::current'));
  assert.ok(current.startsWith('1️⃣ Selected（sele）\n\n'));
  assert.equal(current.includes(selected.link), false);
  const list = await h.execute('/models next');
  assert.ok(list.includes('codex::next'));
  assert.deepEqual(h.calls.filter(call => call[0] === 'modelConfig').map(call => call[1]), ['selected', 'selected']);
  assert.deepEqual(h.calls.find(call => call[0] === 'catalog'), ['catalog', 'selected', 'next']);
  assert.equal(h.calls.some(call => call[0] === 'setModel'), false);
});

test('/model changes only the selected thread and verifies the model returned by T3', async () => {
  const h = harness();
  const reply = await h.execute('/model next');
  const call = h.calls.find(value => value[0] === 'setModel');
  assert.deepEqual(call, ['setModel', selected.threadId, { instanceId: 'codex', model: 'next', options: [{ id: 'effort', value: 'high' }] }]);
  assert.ok(reply.includes('codex::next'));
  assert.ok(reply.startsWith('1️⃣ Selected（sele）\n\n'));
  assert.equal(reply.includes(selected.link), false);
  assert.equal(h.state.routing.threadId, selected.threadId);
  assert.equal(h.modelConfig.runtimeMode, 'full-access');
});

test('cross-provider qualification is explicit and preserves thread selection', async () => {
  const h = harness();
  await h.execute('/model other::next');
  assert.equal(h.modelConfig.modelSelection.instanceId, 'other');
  assert.deepEqual(h.modelConfig.modelSelection.options, []);
  assert.equal(h.state.routing.threadId, selected.threadId);
});

test('invalid, ambiguous, unchanged or unverified models never claim a successful change', async () => {
  const h = harness();
  await assert.rejects(h.execute('/model missing'), /not found/);
  assert.ok((await h.execute('/model current')).includes('已选中该模型'));
  assert.equal(h.calls.some(value => value[0] === 'setModel'), false);
  h.backend.setModel = async () => h.modelConfig;
  await assert.rejects(h.execute('/model next'), /could not be verified/);
});

test('model operations retain the existing project and thread validation', async () => {
  const h = harness();
  h.backend.read = async () => ({ ...selected, projectId: 'foreign' });
  for (const command of ['/models', '/model', '/model next']) await assert.rejects(h.execute(command), /不可用或不属于当前项目/);
  assert.equal(h.calls.length, 0);
});

test('model numbers match displayed provider groups, including duplicate provider sections', async () => {
  const mixed = { providers: [
    { providerInstanceId: 'codex', models: [{ id: 'first' }] },
    { providerInstanceId: 'other', models: [{ id: 'second' }] },
    { providerInstanceId: 'codex', models: [{ id: 'third' }, { id: 'first' }] },
  ] };
  const h = harness(); h.backend.catalog = async () => mixed;
  const reply = await h.execute('/models');
  assert.deepEqual(listedModels(mixed).map(model => model.key), ['codex::first', 'codex::third', 'other::second']);
  assert.deepEqual(h.state.modelLists.selected, [
    { provider: 'codex', model: 'first' }, { provider: 'codex', model: 'third' }, { provider: 'other', model: 'second' },
  ]);
  assert.match(reply, /1️⃣ codex::first/);
  assert.match(reply, /2️⃣ codex::third/);
  assert.match(reply, /3️⃣ other::second/);
  assert.ok(reply.indexOf('2️⃣ codex::third') < reply.indexOf('3️⃣ other::second'));
  assert.equal(reply.includes('disabled::unavailable'), false);
});

test('numbered model switching survives catalog reordering and restart and preserves model options', async () => {
  const h = harness();
  await h.execute('/models');
  const saved = structuredClone(h.state.modelLists.selected);
  Object.assign(h.state, JSON.parse(JSON.stringify(h.state)));
  h.backend.catalog = async () => ({ providers: [...catalog.providers].reverse().map(provider => ({
    ...provider, models: [...provider.models].reverse(),
  })) });
  assert.match(await h.execute('/model 2'), /codex::next/);
  assert.deepEqual(h.calls.find(call => call[0] === 'setModel'), ['setModel', 'selected', {
    instanceId: 'codex', model: 'next', options: [{ id: 'effort', value: 'high' }],
  }]);
  assert.deepEqual(h.state.modelLists.selected, saved);
  assert.equal(h.state.routing.threadId, 'selected');
});

test('model number selects the exact saved provider even when the model name exists in several providers', async () => {
  const h = harness(); await h.execute('/模型列表');
  assert.match(await h.execute('/模型 4'), /other::next/);
  assert.equal(h.modelConfig.modelSelection.instanceId, 'other');
  assert.deepEqual(h.modelConfig.modelSelection.options, []);
  assert.match(await h.execute('/m #2'), /codex::next/);
  assert.equal(h.modelConfig.modelSelection.instanceId, 'codex');
});

test('model search replaces the displayed number mapping and an empty result clears it', async () => {
  const h = harness(); await h.execute('/models');
  h.backend.catalog = async () => ({ providers: [{ providerInstanceId: 'other', models: [{ id: 'foreign' }] }] });
  await h.execute('/models foreign');
  assert.deepEqual(h.state.modelLists.selected, [{ provider: 'other', model: 'foreign' }]);
  await h.execute('/model 1');
  assert.equal(h.modelConfig.modelSelection.model, 'foreign');
  assert.equal(h.modelConfig.modelSelection.instanceId, 'other');
  h.backend.catalog = async () => ({ providers: [] });
  await h.execute('/models missing');
  assert.deepEqual(h.state.modelLists.selected, []);
  await assert.rejects(h.execute('/model 1'), /模型序号无效/);
});

test('invalid, unlisted and stale model numbers never mutate a thread', async () => {
  const h = harness();
  await assert.rejects(h.execute('/model 2'), /先在当前线程发送/);
  await h.execute('/models');
  for (const number of ['0', '#0', '999', '9007199254740992']) {
    await assert.rejects(h.execute('/model ' + number), /模型序号无效/);
  }
  h.backend.catalog = async () => ({ providers: [{ providerInstanceId: 'codex', models: [{ id: 'current' }] },
    { providerInstanceId: 'other', models: [{ id: 'next' }] }] });
  await assert.rejects(h.execute('/model 2'), /已不可用或提供商已禁用/);
  h.backend.catalog = async () => ({ providers: [{ providerInstanceId: 'codex', models: [{ id: 'next' }],
    constraints: ['Provider instance is disabled.'] }] });
  await assert.rejects(h.execute('/model 2'), /已不可用或提供商已禁用/);
  assert.equal(h.calls.some(call => call[0] === 'setModel'), false);
});

test('failed model list queries retain the previous mapping and numbering is isolated by thread', async () => {
  const h = harness(); await h.execute('/models');
  const saved = structuredClone(h.state.modelLists.selected);
  const catalogRead = h.backend.catalog;
  h.backend.catalog = async () => { throw new Error('offline'); };
  await assert.rejects(h.execute('/models'), /offline/);
  assert.deepEqual(h.state.modelLists.selected, saved);
  h.state.routing.threadId = home.threadId;
  h.backend.read = async () => home;
  h.backend.modelConfig = async () => ({ ...h.modelConfig, threadId: home.threadId });
  h.backend.catalog = catalogRead;
  await assert.rejects(h.execute('/model 2'), /先在当前线程发送/);
  await h.execute('/models');
  assert.deepEqual(h.state.modelLists.home, saved);
  assert.deepEqual(h.state.modelLists.selected, saved);
  assert.equal(h.calls.some(call => call[0] === 'setModel'), false);
});

test('local control refuses remote origins and handles JSON or SSE RPC responses', () => {
  for (const origin of ['https://example.test', 'http://127.0.0.1.attacker.test', 'http://user@localhost', 'file:///tmp/server', 'http://localhost/path']) {
    assert.throws(() => localMcpEndpoint(origin), /loopback/);
  }
  assert.equal(localMcpEndpoint('http://127.0.0.1:3773'), 'http://127.0.0.1:3773/mcp');
  assert.deepEqual(decodeRpc('{"jsonrpc":"2.0","id":2,"result":{"ok":true}}', 2), { ok: true });
  assert.deepEqual(decodeRpc('event: message\r\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\r\n\r\n', 2), { ok: true });
  assert.throws(() => decodeRpc('{"jsonrpc":"2.0","id":3,"result":{}}', 2), /failed/);
  assert.throws(() => decodeRpc('{"jsonrpc":"2.0","id":2,"error":{"message":"private"}}', 2), /failed/);
});

function controlFixture({ rejectTool = false, failInitialize = false } = {}) {
  const cliCalls = [];
  const fetchCalls = [];
  const cli = async (_, args) => {
    cliCalls.push(args);
    return args.includes('issue') ? JSON.stringify({ token: 'private-token', sessionId: 'session' }) : '';
  };
  const fetchImpl = async (url, options) => {
    fetchCalls.push({ url: String(url), ...options });
    if (options.method === 'DELETE') return new Response('', { status: 200 });
    const request = JSON.parse(options.body);
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = request.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { isError: rejectTool, structuredContent: { value: 'ok' } };
    if (failInitialize && request.method === 'initialize') return new Response(null, { status: 500 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'mcp-session-id': 'transport' } });
  };
  return { cliCalls, fetchCalls, options: { cli, fetchImpl, readRuntime: () => ({ origin: 'http://127.0.0.1:3773' }) } };
}

test('local MCP credentials stay in headers and are revoked after success', async () => {
  const f = controlFixture();
  const value = await withT3Control({}, call => call('t3_thread_configure', { threadId: 'selected' }), f.options);
  assert.deepEqual(value, { value: 'ok' });
  assert.deepEqual(f.cliCalls.at(-1), ['auth', 'session', 'revoke', 'session']);
  assert.ok(f.cliCalls[0].includes('orchestration:read'));
  assert.equal(f.cliCalls[0].includes('orchestration:operate'), false);
  assert.ok(f.fetchCalls.every(call => !call.url.includes('private-token') && !call.body?.includes('private-token')));
  assert.ok(f.fetchCalls.every(call => call.redirect === 'error'));
  assert.equal(f.fetchCalls.at(-1).method, 'DELETE');
});

test('failed initialization, rejected tools, and unsupported tools still revoke credentials', async () => {
  for (const scenario of [{ failInitialize: true }, { rejectTool: true }, {}]) {
    const f = controlFixture(scenario);
    await assert.rejects(withT3Control({}, call => call(scenario.rejectTool || scenario.failInitialize ? 't3_thread_configure' : 't3_thread_launch', {}), f.options));
    assert.deepEqual(f.cliCalls.at(-1), ['auth', 'session', 'revoke', 'session']);
  }
});

test('write credentials use PKCE and one-time local pairing and revoke only their uniquely labeled session', async () => {
  let label;
  let state;
  const cliCalls = [];
  const cli = async (_, args) => {
    cliCalls.push(args);
    if (args[1] === 'pairing' && args[2] === 'create') {
      label = args[args.indexOf('--label') + 1];
      return JSON.stringify({ id: 'pairing-id', credential: 'private-pairing' });
    }
    if (args[1] === 'session' && args[2] === 'list') return JSON.stringify([
      { sessionId: 'our-session', client: { label } }, { sessionId: 'unrelated', client: { label: 'another app' } },
    ]);
    return '';
  };
  const fetchImpl = async (url, options) => {
    const endpoint = new URL(url).pathname;
    assert.equal(options.redirect, 'error');
    let result;
    if (endpoint.endsWith('register')) result = { client_id: 'client' };
    if (endpoint.endsWith('decision')) {
      const body = JSON.parse(options.body);
      state = body.authorization.state;
      assert.equal(body.authorization.code_challenge_method, 'S256');
      assert.equal(body.decision.code, 'private-pairing');
      result = { redirectTo: `http://127.0.0.1:1/wechat-t3-callback?state=${state}&code=code` };
    }
    if (endpoint.endsWith('token')) {
      const body = new URLSearchParams(options.body);
      assert.ok(body.get('code_verifier'));
      result = { access_token: 'private-token' };
    }
    return new Response(JSON.stringify(result));
  };
  const issued = await issueWriteCredential({}, 'http://127.0.0.1:3773', cli, fetchImpl);
  assert.equal(issued.token, 'private-token');
  await issued.revoke();
  assert.ok(cliCalls.some(args => args.join(' ') === 'auth pairing revoke pairing-id'));
  assert.ok(cliCalls.some(args => args.join(' ') === 'auth session revoke our-session'));
  assert.equal(cliCalls.some(args => args.includes('unrelated')), false);
});

test('invalid OAuth redirects are rejected and local pairing credentials are revoked', async () => {
  const calls = [];
  const cli = async (_, args) => {
    calls.push(args);
    if (args[2] === 'create') return JSON.stringify({ id: 'pairing', credential: 'private' });
    if (args[2] === 'list') return '[]';
    return '';
  };
  const fetchImpl = async url => new Response(JSON.stringify(new URL(url).pathname.endsWith('register')
    ? { client_id: 'client' } : { redirectTo: 'https://external.test/?code=private' }));
  await assert.rejects(issueWriteCredential({}, 'http://127.0.0.1:3773', cli, fetchImpl), /Invalid T3 authorization/);
  assert.deepEqual(calls.at(-1), ['auth', 'pairing', 'revoke', 'pairing']);
});
