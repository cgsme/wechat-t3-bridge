import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createScheduler } from '../src/scheduler.mjs';
import { createThread } from '../src/backend.mjs';
import { route } from '../src/core.mjs';

test('two /new commands using the real CLI launch result start both background waits before either finishes', async () => {
  const fixture = fileURLToPath(new URL('./launch-shape.mjs', import.meta.url));
  const config = { threadId: 'home', command: process.execPath, prefixArgs: [fixture], cwd: path.dirname(fixture) };
  const state = { routing: { threadId: 'home', listedIds: [] }, seen: [], jobs: [
    { id: '1', command: route('/new --name First first'), status: 'pending', sent: 0 },
    { id: '2', command: route('/新建 --名称 Second second'), status: 'pending', sent: 0 },
  ] };
  const started = [];
  const completed = [];
  const replies = [];
  let creates = 0;
  const titles = new Map();
  const read = async value => ({ threadId: value.threadId, projectId: 'p', link: `https://test/${value.threadId}`,
    providerInstanceId: 'codex', model: 'test-model', title: titles.get(value.threadId) || 'Home' });
  const backend = { read, create: async (...args) => { try {
    const result = await createThread(...args); titles.set(result.threadId, args[1].title); return result;
  } finally { creates++; } },
    wait: async (value, runId) => { started.push({ threadId: value.threadId, runId }); return new Promise(resolve => completed.push(resolve)); } };
  const scheduler = createScheduler({ state, config, reference: { projectId: 'p' }, backend, save() {},
    send: async (job, text) => replies.push([job.id, text]) });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && started.length < 2 && !(creates === 2 && state.jobs.every(job => job.status !== 'running'))) {
    scheduler.tick();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(started.length, 2, `both /new runs must be tracked concurrently; replies: ${JSON.stringify(replies)}`);
  assert.equal(new Set(started.map(value => value.threadId)).size, 2);
  assert.deepEqual([...titles.values()], ['First', 'Second']);
  completed[1]('second finished first');
  await new Promise(resolve => setImmediate(resolve));
  scheduler.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(replies.some(([id, text]) => id === '2' && text.includes('second finished first') && text.includes('Second')));
  assert.equal(state.jobs.find(job => job.id === '1')?.status, 'running');
  completed[0]('first finished last');
  await new Promise(resolve => setImmediate(resolve));
  scheduler.tick();
});
