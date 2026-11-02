import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../src/scheduler.mjs';
import { waitForThread } from '../src/backend.mjs';
import { trackingOptions } from '../src/task-tracking.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const state = { routing: { threadId: 'a', listedIds: [] }, jobs: [], seen: [] };
  const calls = [], sends = [], deliveries = [], pending = [];
  const thread = id => ({ threadId: id, title: `Name ${id}`, projectId: 'p', link: `https://test/${id}`, providerInstanceId: 'codex', model: 'm' });
  const backend = {
    read: async c => thread(c.threadId), list: async () => ['a', 'b', 'c'].map(thread),
    send: async c => { calls.push(c.threadId); const d = deferred(); pending.push(d); return d.promise; },
    create: async () => ({ threadId: 'c', runId: 'new-run', status: 'running' }),
    wait: async () => { const d = deferred(); pending.push(d); return d.promise; },
  };
  let fail = false, clock = 0;
  const scheduler = createScheduler({ state, config: { threadId: 'a' }, reference: { projectId: 'p' }, backend,
    save: () => {}, now: () => clock,
    send: async (job, chunk, index) => { if (fail && job.id === '1') throw new Error('offline'); sends.push([job.id, chunk]); deliveries.push([job.id, index]); } });
  const add = command => { const job = { id: String(state.jobs.length + state.seen.length + 1), command, status: 'pending', sent: 0 }; state.jobs.push(job); return job; };
  const tick = async () => { scheduler.tick(); await flush(); };
  return { state, calls, sends, deliveries, pending, backend, add, tick, advance: ms => { clock += ms; },
    fail: () => { fail = true; }, retry: () => { fail = false; clock = 10000; } };
}

test('fast tasks return only results, slow tasks acknowledge once and queued tasks explain the queue', async () => {
  const fast = harness(); fast.add({ kind: 'task', text: 'fast' });
  await fast.tick(); await fast.tick();
  fast.advance(4000); fast.pending[0].resolve('fast result'); await flush(); await fast.tick();
  assert.equal(fast.sends.length, 1);
  assert.match(fast.sends[0][1], /fast result/);

  const slow = harness(); slow.add({ kind: 'task', text: 'slow' });
  slow.add({ kind: 'task', text: 'queued' });
  await slow.tick(); await slow.tick();
  slow.advance(4999); await slow.tick(); assert.equal(slow.sends.length, 0);
  slow.advance(1); await slow.tick();
  assert.equal(slow.sends.length, 2);
  assert.match(slow.sends[0][1], /正在处理/);
  assert.match(slow.sends[1][1], /正在排队/);
  slow.advance(30000); await slow.tick(); assert.equal(slow.sends.length, 2);
  slow.pending[0].resolve('slow result'); await flush(); await slow.tick(); await slow.tick();
  slow.pending[1].resolve('queued result'); await flush(); await slow.tick();
  assert.equal(slow.sends.length, 4);
});

test('progress that recovers before delivery is skipped and cannot delay the final result', async () => {
  const h = harness(), item = h.add({ kind: 'task', text: 'work' });
  await h.tick(); await h.tick();
  item.noticeChunks = ['obsolete permission reminder'];
  item.noticeKinds = { 0: 'waiting_permission' };
  item.trackingStatus = 'running';
  await h.tick(); assert.equal(h.sends.length, 0);
  h.pending[0].resolve('done'); await flush(); await h.tick();
  assert.equal(h.sends.length, 1); assert.match(h.sends[0][1], /done/);
});

test('an unsent permission reminder may return if still needed, but a delivered reminder is never repeated', async () => {
  const h = harness(), item = h.add({ kind: 'task', text: 'work' });
  await h.tick(); await h.tick();
  const options = trackingOptions(item, () => {});
  const permission = { notify: true, approval: { id: 'permission' } };
  options.onProgress('waiting_permission', permission);
  options.onProgress('running');
  await h.tick(); assert.equal(h.sends.length, 0);
  options.onProgress('waiting_permission', permission);
  await h.tick(); assert.equal(h.sends.length, 1);
  options.onProgress('running'); options.onProgress('waiting_permission', permission);
  await h.tick(); assert.equal(h.sends.length, 1);
  h.pending[0].resolve('done'); await flush(); await h.tick();
  assert.equal(h.sends.length, 2);
});

test('a failed delayed receipt is discarded as soon as the result arrives, while final delivery still retries', async () => {
  const h = harness(); h.add({ kind: 'task', text: 'work' });
  await h.tick(); await h.tick();
  h.fail(); h.advance(5000); await h.tick();
  assert.equal(h.state.jobs[0].progressRetry, true);
  h.pending[0].resolve('done'); await flush(); await h.tick();
  assert.equal(h.state.jobs[0].receiptSent, 1);
  assert.equal(h.state.jobs[0].sent, 0);
  assert.equal(h.sends.length, 0);
  h.retry(); h.advance(5000); await h.tick();
  assert.equal(h.sends.length, 1); assert.match(h.sends[0][1], /done/);
});

test('different threads execute concurrently; same-thread messages keep order and bound targets', async () => {
  const h = harness();
  const a = h.add({ kind: 'task', text: 'a1' });
  h.add({ kind: 'task', text: 'a2' });
  h.add({ kind: 'switch', selector: 'b' });
  const b = h.add({ kind: 'task', text: 'b1' });
  await h.tick(); await h.tick();
  assert.deepEqual(h.calls, ['a', 'b']);
  assert.equal(a.threadId, 'a'); assert.equal(b.threadId, 'b');
  h.pending[0].resolve('first'); await flush(); await h.tick();
  assert.deepEqual(h.calls, ['a', 'b', 'a']);
  h.pending[1].resolve('other'); h.pending[2].resolve('second'); await flush();
  await h.tick(); await h.tick();
  assert.deepEqual(h.sends.filter(([id]) => id === '1' || id === '2').map(([id]) => id), ['1', '2']);
  for (const [id, text] of h.sends.filter(([id]) => ['1', '2', '4'].includes(id))) {
    const thread = id === '4' ? 'b' : 'a';
    assert.ok(text.startsWith(`${thread === 'a' ? '1️⃣' : '2️⃣'} Name ${thread}（${thread}）\n\n`));
    assert.doesNotMatch(text, /https?:\/\/|Thread:|ID:/);
  }
});

test('control replies and failures also carry the selected thread name and ID', async () => {
  const h = harness();
  h.add({ kind: 'help' });
  h.add({ kind: 'switch', selector: 'b' });
  h.add({ kind: 'task', text: 'fail' });
  h.backend.send = async () => { throw new Error('backend unavailable'); };
  await h.tick(); await h.tick(); await h.tick();
  assert.ok(h.sends.some(([id, text]) => id === '1' && text.startsWith('1️⃣ Name a（a）\n\n')));
  assert.ok(h.sends.some(([id, text]) => id === '2' && text.startsWith('2️⃣ Name b（b）\n\n')));
  assert.ok(h.sends.some(([id, text]) => id === '3' && text.startsWith('2️⃣ Name b（b）\n\n') && text.includes('backend unavailable')));
});

test('status and switching respond while tasks run concurrently', async () => {
  const h = harness();
  h.add({ kind: 'task', text: 'long' }); await h.tick();
  h.add({ kind: 'status' }); h.add({ kind: 'switch', selector: 'b' }); h.add({ kind: 'task', text: 'later' });
  await h.tick(); await h.tick();
  assert.deepEqual(h.calls, ['a', 'b']); assert.equal(h.state.routing.threadId, 'b');
  assert.ok(h.sends.some(([, text]) => text.includes('执行中：1 个任务')));
  h.pending[0].resolve('done'); await flush(); await h.tick();
  assert.deepEqual(h.calls, ['a', 'b']);
});

test('failed reply is retained for retry without blocking another thread', async () => {
  const h = harness(); h.fail();
  h.add({ kind: 'task', text: 'one' }); h.add({ kind: 'switch', selector: 'b' }); h.add({ kind: 'task', text: 'two' });
  await h.tick(); await h.tick();
  h.pending[0].resolve('one'); h.pending[1].resolve('two'); await flush(); await h.tick();
  assert.ok(h.sends.some(([id]) => id === '3')); assert.ok(h.state.jobs.some(job => job.id === '1'));
  h.retry(); await h.tick(); assert.ok(h.state.seen.includes('1'));
});

test('/new releases routing after creation while its initial task is still running', async () => {
  const h = harness();
  const created = h.add({ kind: 'new', text: 'new task' });
  h.add({ kind: 'task', text: 'same new thread' }); h.add({ kind: 'switch', selector: 'b' }); h.add({ kind: 'task', text: 'parallel' });
  await h.tick(); await h.tick();
  assert.equal(created.status, 'running'); assert.equal(h.state.routing.threadId, 'b');
  assert.deepEqual(h.calls, ['b']);
  h.pending[0].resolve('new done'); await flush(); await h.tick(); assert.deepEqual(h.calls, ['b', 'c']);
});

test('/new confirms creation with the numbered compact label before its task finishes', async () => {
  const h = harness();
  const job = h.add({ kind: 'new', text: 'long task' });
  await h.tick(); await h.tick();
  assert.equal(job.status, 'running');
  assert.ok(h.sends.some(([id, text]) => id === job.id && text.includes('新线程已创建并选中') && text.startsWith('2️⃣ Name c（c）\n\n') && !text.includes('https://test/c')));
  h.pending[0].resolve('finished');
  await flush(); await h.tick();
  assert.ok(h.sends.some(([id, text]) => id === job.id && text.includes('finished')));
  assert.deepEqual(h.deliveries, [[job.id, 'received_0'], [job.id, 'start_0'], [job.id, 0]]);
});

test('/new acknowledges a slow creation without prematurely claiming success', async () => {
  const h = harness();
  const creation = deferred();
  h.backend.create = () => creation.promise;
  const job = h.add({ kind: 'new', text: 'slow creation' });
  await h.tick(); await h.tick();
  assert.ok(h.sends.some(([id, text]) => id === job.id && text.includes('正在创建新线程')));
  assert.equal(h.sends.some(([, text]) => text.includes('新线程已创建并选中')), false);
  assert.equal(h.state.routing.threadId, 'a');
  creation.resolve({ threadId: 'c', runId: 'r' });
  await flush(); await h.tick();
  assert.ok(h.sends.some(([, text]) => text.includes('新线程已创建并选中')));
  h.pending[0].resolve('done'); await flush(); await h.tick();
});

test('a result lookup failure retains the confirmed new thread in its reply', async () => {
  const h = harness();
  h.backend.wait = async () => { throw new Error('result unavailable'); };
  h.add({ kind: 'new', text: 'task' });
  await h.tick(); await h.tick();
  assert.ok(h.sends.some(([, text]) => text.includes('result unavailable') && text.includes('新线程已创建')
    && text.startsWith('2️⃣ Name c（c）\n\n') && !text.includes('https://test/c')));
  assert.equal(h.state.routing.threadId, 'c');
});

test('a failed start notice does not block another /new task or its final reply', async () => {
  const h = harness();
  let count = 0;
  h.backend.create = async () => ({ threadId: `new-${++count}`, runId: `run-${count}`, status: 'running' });
  h.fail();
  h.add({ kind: 'new', text: 'first' });
  h.add({ kind: 'new', text: 'second' });
  await h.tick(); await h.tick();
  assert.equal(h.pending.length, 2);
  h.pending[1].resolve('second finished first');
  await flush(); await h.tick();
  assert.ok(h.sends.some(([id, text]) => id === '2' && text.includes('second finished first')));
  assert.equal(h.state.jobs.find(job => job.id === '1').status, 'running');
  h.pending[0].resolve('first finished');
  await flush(); h.retry(); await h.tick();
  assert.ok(h.state.seen.includes('1'));
});

test('new-thread creation failure releases the dispatcher', async () => {
  const h = harness(); h.backend.create = async () => { throw new Error('create failed'); };
  h.add({ kind: 'new', text: 'fail' }); h.add({ kind: 'switch', selector: 'b' });
  await h.tick(); await h.tick(); assert.equal(h.state.routing.threadId, 'b');
  assert.ok(h.sends.some(([, text]) => text.includes('create failed') && text.includes('尚未确认')));
});

test('persisted bound targets survive routing changes', async () => {
  const h = harness(); const job = h.add({ kind: 'task', text: 'saved' }); job.bound = true; job.threadId = 'b';
  await h.tick(); assert.deepEqual(h.calls, ['b']);
});

test('twenty distinct threads run without a global concurrency cap', async () => {
  const h = harness();
  for (let index = 0; index < 20; index++) {
    const job = h.add({ kind: 'task', text: String(index) }); job.bound = true; job.threadId = `thread-${index}`;
  }
  await h.tick(); assert.equal(h.calls.length, 20);
  assert.equal(h.state.jobs.filter(job => job.status === 'pending').length, 0);
  h.add({ kind: 'new', text: 'another thread' });
  h.add({ kind: 'status' });
  await h.tick(); await h.tick();
  assert.equal(h.state.routing.threadId, 'c');
  assert.equal(h.pending.length, 21);
  assert.ok(h.sends.some(([, text]) => text.includes('执行中：21 个任务')));
});

test('recovered replies keep their chunks and do not execute again', async () => {
  const h = harness(); const job = h.add({ kind: 'task', text: 'saved' });
  Object.assign(job, { status: 'reply', bound: true, threadId: 'a', chunks: ['sent', 'remaining'], sent: 1 });
  await h.tick(); assert.deepEqual(h.calls, []); assert.deepEqual(h.sends, [['1', 'remaining']]);
});

test('persisted start notices resume without resending acknowledged chunks or restarting tasks', async () => {
  const h = harness();
  const job = h.add({ kind: 'new', text: 'saved' });
  Object.assign(job, { status: 'reply', bound: true, threadId: 'c', noticeChunks: ['already sent', 'remaining notice'],
    noticeSent: 1, chunks: ['final result'], sent: 0 });
  await h.tick();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.sends, [['1', 'remaining notice'], ['1', 'final result']]);
  assert.ok(h.state.seen.includes(job.id));
});

test('a persisted receipt retry sends creation confirmation and result once, without creating again', async () => {
  const h = harness();
  let creates = 0;
  h.backend.create = async () => { creates++; throw new Error('unexpected creation'); };
  const job = h.add({ kind: 'new', text: 'saved' });
  Object.assign(job, { status: 'reply', bound: true, threadId: 'c',
    receiptChunks: ['acknowledged receipt', 'remaining receipt'], receiptSent: 1,
    noticeChunks: ['creation confirmation'], noticeSent: 0, chunks: ['final result'] });
  h.fail(); await h.tick();
  assert.equal(job.receiptSent, 1);
  assert.equal(job.noticeSent, 0);
  h.retry(); await h.tick(); await h.tick();
  assert.equal(creates, 0);
  assert.deepEqual(h.sends.map(([, text]) => text), ['remaining receipt', 'creation confirmation', 'final result']);
  assert.deepEqual(h.deliveries.map(([, index]) => index), ['received_1', 'start_0', 0]);
});

test('new-thread wait requests its exact run even after a desktop client starts another turn', async () => {
  const read = async (_, runId) => {
    assert.equal(runId, 'r');
    return { threadId: 'a', runId, status: 'completed', reply: 'right' };
  };
  assert.equal(await waitForThread({ threadId: 'a' }, 'r', { read, probe: () => 'alive' }), 'right');
});

test('a failed reply does not block later results on the same thread and remains retryable', async () => {
  const h = harness(); h.fail();
  h.add({ kind: 'task', text: 'one' });
  h.add({ kind: 'task', text: 'two' });
  await h.tick(); await h.tick();
  h.pending[0].resolve('first'); await flush(); await h.tick();
  h.pending[1].resolve('second'); await flush(); await h.tick(); await h.tick();
  assert.ok(h.sends.some(([id]) => id === '2'));
  assert.ok(h.state.jobs.some(job => job.id === '1' && job.sent === 0));
  h.retry(); await h.tick();
  assert.ok(h.state.seen.includes('1'));
});
