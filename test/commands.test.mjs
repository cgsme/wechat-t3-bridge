import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { route, HELP, HELP_EN, emojiNumber } from '../src/core.mjs';
import { executeCommand } from '../src/commands.mjs';
import { parseCliJson, createThread } from '../src/backend.mjs';

const home = { threadId: 'aaa-home', title: 'Home', link: 'https://example.test/home', projectId: 'project',
  status: 'completed', providerInstanceId: 'codex', model: 'existing-model' };
const other = { ...home, threadId: 'bbb-other', title: 'Other', link: 'https://example.test/other' };
const created = { ...home, threadId: 'ccc-created', title: 'New task', link: 'https://example.test/created' };

function harness(initial = {}) {
  const calls = [];
  const state = { jobs: [], seen: [], ...initial };
  const threads = new Map([home, other, created].map(thread => [thread.threadId, thread]));
  const backend = {
    read: async config => { calls.push(['read', config.threadId]); return threads.get(config.threadId); },
    list: async () => { calls.push(['list']); return [...threads.values()]; },
    send: async (config, prompt) => { calls.push(['send', config.threadId, prompt]); return 'done'; },
    create: async (_, options) => { calls.push(['create', options]); return { threadId: created.threadId, runId: 'run', status: 'completed', reply: 'new result' }; },
  };
  let saves = 0;
  const execute = (text, job = {}) => executeCommand({ command: route(text), state, config: { threadId: home.threadId },
    reference: home, backend, save: () => { saves++; }, job });
  return { state, calls, threads, backend, execute, get saves() { return saves; } };
}

test('commands keep English names with Chinese help by default and optional English help', () => {
  for (const command of ['help', 'status', 'threads']) assert.equal(route(`/${command}`).kind, command);
  assert.deepEqual(route('/new Write a file'), { kind: 'new', text: 'Write a file' });
  assert.deepEqual(route('/SWITCH 2'), { kind: 'switch', selector: '2' });
  assert.equal(route('/new').kind, 'help');
  assert.equal(route('/switch').kind, 'help');
  assert.equal(route('/switch 1 extra').kind, 'help');
  assert.equal(route('/newspaper story').kind, 'help');
  assert.deepEqual(route('/help'), { kind: 'help' });
  assert.deepEqual(route('/HELP EN'), { kind: 'help', language: 'en' });
  assert.match(HELP, /中文帮助/);
  assert.doesNotMatch(HELP_EN, /[\u4e00-\u9fff]/);
  for (const help of [HELP, HELP_EN]) {
    for (const command of ['new', 'switch', 'threads', 'task', 'status', 'help', 'models', 'model', 'questions', 'answer']) {
      assert.ok(help.includes('/' + command));
    }
    assert.ok(help.includes('/help en'));
  }
});

test('help and unknown commands cannot start a model run or create threads', async () => {
  const h = harness();
  for (const text of ['/help', '/不存在 test', '/new', '/switch', '/threads extra']) assert.equal(await h.execute(text), HELP);
  for (const text of ['/help en', '/HELP EN', '/task /help en', '/new /help en']) assert.equal(await h.execute(text), HELP_EN);
  assert.equal(await h.execute('/help'), HELP);
  assert.equal(h.calls.length, 0);
});

test('old installations default to home; switching persists and sends subsequent tasks to the selected thread', async () => {
  const h = harness();
  const reply = await h.execute('/switch bbb');
  assert.ok(reply.startsWith('1️⃣ Other（bbb-）\n\n'));
  assert.equal(reply.includes(other.link), false);
  assert.equal(h.state.routing.threadId, other.threadId);
  const job = {};
  await h.execute('/task 实际任务', job);
  assert.equal(job.threadId, other.threadId);
  assert.equal(h.calls.find(call => call[0] === 'send')[1], other.threadId);
  assert.ok(h.saves >= 2);
  const restarted = harness(JSON.parse(JSON.stringify(h.state)));
  await restarted.execute('继续聊天');
  assert.equal(restarted.calls.find(call => call[0] === 'send')[1], other.threadId);
  await restarted.execute('/switch home');
  assert.equal(restarted.state.routing.threadId, home.threadId);
});

test('numbered switching refers to the saved list, even if the server later reorders it', async () => {
  const h = harness();
  const list = await h.execute('/threads');
  assert.ok(list.includes('1️⃣ Home（aaa-）  ⭐ 当前\n'));
  assert.ok(list.includes('2️⃣ Other（bbb-）\n'));
  assert.doesNotMatch(list, /https?:\/\/|Thread:|ID:/);
  assert.equal(h.state.routing.listedIds[1], other.threadId);
  h.backend.list = async () => [created, home, other];
  await h.execute('/switch 2');
  assert.equal(h.state.routing.threadId, other.threadId);
});

test('thread lists hide settled threads by default and explicitly include them with selectable saved numbers', async () => {
  const h = harness();
  h.threads.set(home.threadId, { ...home, settled: true });
  h.threads.set(other.threadId, { ...other, settled: false });
  const current = await h.execute('/threads');
  assert.equal(current.includes('Home（'), false);
  assert.deepEqual(h.state.routing.listedIds, [other.threadId, created.threadId]);
  await h.execute('/switch 1');
  assert.equal(h.state.routing.threadId, other.threadId);
  const all = await h.execute('/threads --settle');
  assert.ok(all.includes('Home（'));
  assert.ok(all.includes('已 settle'));
  assert.deepEqual(h.state.routing.listedIds, [home.threadId, other.threadId, created.threadId]);
  await h.execute('/switch 1');
  assert.equal(h.state.routing.threadId, home.threadId);
  await h.execute('/threads');
  assert.deepEqual(h.state.routing.listedIds, [other.threadId, created.threadId]);
  assert.equal(h.calls.some(call => call[0] === 'send' || call[0] === 'create'), false);
});

test('settled filtering happens before the display limit and does not confuse completed with settled', async () => {
  const h = harness();
  h.backend.list = async () => [
    ...Array.from({ length: 35 }, (_, index) => ({ ...home, threadId: `settled-${index}`, settled: true })),
    { ...other, status: 'completed', settled: false },
  ];
  assert.ok((await h.execute('/threads')).includes('Other（'));
  assert.deepEqual(h.state.routing.listedIds, [other.threadId]);
  await h.execute('/threads --settle');
  assert.equal(h.state.routing.listedIds.length, 30);
});

test('an all-settled project has an empty default list and offers the explicit inclusion flag', async () => {
  const h = harness();
  h.backend.list = async () => [{ ...home, settled: true }];
  const reply = await h.execute('/threads');
  assert.match(reply, /暂无未 settle/);
  assert.ok(reply.includes('/threads --settle'));
  assert.deepEqual(h.state.routing.listedIds, []);
  await h.execute('/threads --settle');
  assert.deepEqual(h.state.routing.listedIds, [home.threadId]);
});

test('settle inclusion keeps archived, subagent and other-project threads out of the list', async () => {
  const h = harness();
  h.backend.list = async () => [{ ...home, settled: true },
    { ...other, archived: true, settled: true }, { ...other, projectId: 'foreign' },
    { ...created, relationshipToParent: 'subagent', settled: true }];
  await h.execute('/threads --settle');
  assert.deepEqual(h.state.routing.listedIds, [home.threadId]);
});

test('settle flag parses with short aliases, Chinese commands and wrapped controls only', () => {
  for (const text of ['/threads --settle', '/T --SETTLE', '/ts --settle', '/线程 --settle', '／线程列表　--settle',
    '/task /threads --settle', '/new /t --settle']) {
    assert.deepEqual(route(text), { kind: 'threads', includeSettled: true });
  }
  for (const text of ['/threads --settled', '/threads --settle extra', '/threads --settle --settle', '/threads --settle\n/task nope', '/to 2 /threads --settle']) {
    assert.deepEqual(route(text), { kind: 'help' });
  }
});

test('wrapped /threads refreshes the actual switch list without creating an AI-generated list', async () => {
  for (const wrapper of ['new', 'task']) {
    const h = harness();
    await h.execute('/threads');
    const refreshed = [created, home, other];
    h.backend.list = async () => refreshed;
    const reply = await h.execute(`/${wrapper} /threads`);
    assert.equal(h.calls.some(call => call[0] === 'create' || call[0] === 'send'), false);
    assert.deepEqual(h.state.routing.listedIds, refreshed.map(thread => thread.threadId));
    for (const [index, thread] of refreshed.entries()) {
      assert.ok(reply.includes(`${String(index + 1).replace(/\d/g, digit => digit + "\uFE0F\u20E3")} ${thread.title}（${thread.threadId.slice(0, 4)}）${thread.threadId === home.threadId ? '  ⭐ 当前' : ''}\n`));
      assert.equal(reply.includes(thread.link), false);
      await h.execute(`/switch ${index + 1}`);
      assert.equal(h.state.routing.threadId, thread.threadId);
    }
    // A newly created thread must not shift the last displayed numbers.
    await h.execute('/new hi');
    await h.execute('/switch 3');
    assert.equal(h.state.routing.threadId, other.threadId);
  }
});

test('wrapped bridge controls use the same parser while ordinary requests remain tasks', () => {
  for (const wrapper of ['new', 'task']) {
    for (const control of ['/threads', '/SWITCH 3', '/switch home', '/help', '/help en', '/status', '/models gpt', '/model codex::gpt']) {
      assert.deepEqual(route(`/${wrapper} ${control}`), route(control));
    }
    for (const text of ['Explain /threads', '/threads and explain the results', 'Write a file\n/threads']) {
      assert.deepEqual(route(`/${wrapper} ${text}`), { kind: wrapper, text });
    }
  }
});

test('unlisted numbers, ambiguous prefixes and unavailable threads do not change selection', async () => {
  const h = harness();
  await assert.rejects(h.execute('/switch 1'), /Run \/threads/);
  h.threads.set('bbb-another', { ...other, threadId: 'bbb-another' });
  await assert.rejects(h.execute('/switch bbb'), /Ambiguous/);
  await assert.rejects(h.execute('/switch missing'), /not found/);
  assert.equal(h.state.routing.threadId, home.threadId);
});

test('cross-project, archived and subagent threads cannot be selected or used as task targets', async () => {
  for (const extra of [{ projectId: 'foreign' }, { archived: true }, { relationshipToParent: 'subagent' }]) {
    const h = harness({ routing: { threadId: home.threadId, listedIds: [other.threadId] } });
    h.threads.set(other.threadId, { ...other, ...extra });
    await assert.rejects(h.execute('/switch 1'), /不可用或不属于当前项目/);
    assert.equal(h.state.routing.threadId, home.threadId);
    h.state.routing.threadId = other.threadId;
    await assert.rejects(h.execute('/task test'), /不可用或不属于当前项目/);
    assert.equal(h.calls.some(call => call[0] === 'send'), false);
    assert.equal((await h.execute('/threads')).includes(other.threadId), false);
  }
});

test('/new creates exactly one task thread using the selected model and then selects it', async () => {
  const h = harness();
  const job = {};
  const reply = await h.execute('/new --provider something\n第二行任务', job);
  const mutations = h.calls.filter(call => call[0] === 'create');
  assert.equal(mutations.length, 1);
  assert.equal(h.calls.some(call => call[0] === 'send'), false);
  const options = mutations[0][1];
  assert.equal(options.projectId, home.projectId);
  assert.equal(options.provider, home.providerInstanceId);
  assert.equal(options.model, home.model);
  assert.ok(options.title.startsWith('WeChat: '));
  assert.equal(options.prompt, '--provider something\n第二行任务');
  assert.equal(h.state.routing.threadId, created.threadId);
  assert.equal(job.threadId, created.threadId);
  assert.equal(job.runId, 'run');
  assert.ok(reply.includes('2️⃣ New task（ccc-）\n\n'));
  assert.equal(reply.includes(created.link), false);
  assert.ok(reply.includes('new result'));
});

test('plain text and /task forward identical task bodies without bridge instructions', async () => {
  for (const prefix of ['', '/task ']) {
    const h = harness();
    const text = '原始消息\n第二段 & $literal';
    const job = {};
    await h.execute(prefix + text, job);
    assert.equal(h.calls.find(call => call[0] === 'send')[2], text);
    assert.equal(job.replyThread.title, home.title);
    assert.equal(job.replyThread.threadId, home.threadId);
  }
});

test('creation failures are not retried and leave the existing selection intact', async () => {
  const h = harness();
  let creates = 0;
  h.backend.create = async () => { creates++; throw new Error('uncertain outcome'); };
  await assert.rejects(h.execute('/new task'), /uncertain/);
  assert.equal(creates, 1);
  assert.equal(h.state.routing.threadId, home.threadId);
});

test('a failed post-creation check reports the returned thread ID without losing it or retrying', async () => {
  const h = harness();
  const job = {};
  h.backend.read = async config => {
    if (config.threadId === created.threadId) throw new Error('read unavailable');
    return home;
  };
  await assert.rejects(h.execute('/new task', job), error => error.message.includes('ccc-') && !error.message.includes(created.threadId)
    && error.message.includes('不要重复') && error.message.includes('read unavailable'));
  assert.equal(h.calls.filter(call => call[0] === 'create').length, 1);
  assert.equal(job.threadId, created.threadId);
  assert.equal(job.runId, 'run');
  assert.equal(h.state.routing.threadId, home.threadId);
});

test('a created thread is retained when its first task fails or requires input', async () => {
  for (const status of ['failed', 'waiting']) {
    const h = harness();
    h.backend.create = async () => ({ threadId: created.threadId, status, reply: null });
    const reply = await h.execute('/new task');
    assert.equal(h.state.routing.threadId, created.threadId);
    assert.ok(reply.includes('2️⃣ New task（ccc-）\n\n'));
    assert.equal(reply.includes(created.link), false);
    assert.ok(status === 'waiting' ? reply.includes('waiting') : reply.includes('failed'));
  }
});

test('/status identifies the selected thread and reports queued messages', async () => {
  const h = harness({ routing: { threadId: other.threadId, listedIds: [] }, jobs: [{ status: 'pending' }] });
  const reply = await h.execute('/status');
  assert.ok(reply.startsWith('1️⃣ Other（bbb-）\n\n'));
  assert.equal(reply.includes(other.link), false);
  assert.ok(reply.includes('排队中：1 条消息'));
  assert.equal(h.calls.some(call => call[0] === 'send' || call[0] === 'create'), false);
});

test('CLI startup logs do not corrupt object or array JSON output', () => {
  assert.deepEqual(parseCliJson('[T3] starting\n{"thread":{"threadId":"id"}}\n'), { thread: { threadId: 'id' } });
  assert.deepEqual(parseCliJson('[T3] starting\n[{"threadId":"id"}]\n'), [{ threadId: 'id' }]);
  assert.throws(() => parseCliJson('broken secret-bearing log'), /未返回预期/);
});

test('failed first runs still return their thread id and stdin safely through the real process boundary', async () => {
  const fixture = fileURLToPath(new URL('./fake-t3.mjs', import.meta.url));
  const prompt = '中文 & echo injected | more\nactual task';
  const result = await createThread({ command: process.execPath, prefixArgs: [fixture], cwd: path.dirname(fixture) }, {
    projectId: 'project', title: 'WeChat: task', provider: 'codex', model: 'existing-model', prompt,
  });
  assert.equal(result.threadId, 'created-thread');
  assert.equal(result.status, 'failed');
  assert.equal(result.input, prompt);
  assert.deepEqual(result.args, ['thread', 'start', '--wait', '--json', '--provider', 'codex',
    '--model', 'existing-model', '--title', 'WeChat: task', 'project', '-']);
});
