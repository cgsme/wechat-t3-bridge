import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForThread } from '../src/backend.mjs';
import { trackingOptions } from '../src/task-tracking.mjs';

async function track(states, job = {}) {
  let clock = 0;
  const result = await waitForThread({ threadId: 'a' }, 'run', {
    ...trackingOptions(job, () => {}), probe: () => 'alive', now: () => clock,
    read: async () => ({ threadId: 'a', runId: 'run', ...states.shift() }),
    pause: async ms => { clock += ms; },
  });
  return { result, job };
}

test('brief unexplained waits return the final result without asking for desktop confirmation', async () => {
  const { result, job } = await track([{ status: 'waiting' }, { status: 'running' }, { status: 'completed', reply: 'done' }]);
  assert.equal(result, 'done');
  assert.deepEqual(job.noticeChunks || [], []);
});

test('persistent unexplained waits send one neutral notice and survive restart without duplicate reminders', async () => {
  const { job } = await track([...Array.from({ length: 13 }, () => ({ status: 'waiting' })), { status: 'completed', reply: 'done' }]);
  assert.equal(job.noticeChunks.length, 1);
  assert.match(job.noticeChunks[0], /等待.*核实/);
  assert.doesNotMatch(job.noticeChunks[0], /桌面|权限|请在 T3/);
  const restored = structuredClone(job);
  await track([...Array.from({ length: 13 }, () => ({ status: 'waiting' })), { status: 'completed', reply: 'done' }], restored);
  assert.equal(restored.noticeChunks.length, 1);
});

test('verified permission requests notify once per request and do not send extra resume messages', async () => {
  const approval = { id: 'permission-1', summary: '执行测试' };
  const { job } = await track([{ status: 'waiting', approval }, { status: 'waiting', approval },
    { status: 'running' }, { status: 'waiting', approval }, { status: 'completed', reply: 'done' }]);
  assert.equal(job.noticeChunks.length, 1);
  assert.match(job.noticeChunks[0], /执行测试/);
  assert.match(job.noticeChunks[0], /无需重复发送/);
});

test('short connection failures stay quiet while a sustained interruption notifies only once', async () => {
  for (const failures of [1, 4]) {
    let clock = 0, reads = 0;
    const job = {};
    const result = await waitForThread({ threadId: 'a' }, 'run', {
      ...trackingOptions(job, () => {}), probe: () => 'alive', now: () => clock,
      pause: async ms => { clock += ms; }, read: async () => {
        if (reads++ < failures) throw Object.assign(new Error('offline'), { code: 'T3_CONNECTION_LOST' });
        return { threadId: 'a', runId: 'run', status: 'completed', reply: 'done' };
      },
    });
    assert.equal(result, 'done');
    assert.equal(job.noticeChunks?.length || 0, failures === 1 ? 0 : 1);
  }
});
