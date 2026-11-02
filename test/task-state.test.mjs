import test from 'node:test';
import assert from 'node:assert/strict';
import { readTaskState, withT3Control } from '../src/t3-control.mjs';
import { runtimeProbe, taskPause } from '../src/task-tracking.mjs';

function transport({ status = 'completed', timedOut = false, runId = 'run', thread = {}, respond, fail } = {}) {
  const tools = [], revoked = [];
  const snapshot = { threadId: 'a', latestRunId: 'newer', activeRunId: 'newer', ...thread };
  const cli = async (_, args) => {
    if (args.includes('issue')) return JSON.stringify({ token: 'fixture-token', sessionId: 'fixture-session' });
    revoked.push(args); return '';
  };
  const fetchImpl = async (_, options) => {
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    const request = JSON.parse(options.body);
    if (!request.id) return new Response(null, { status: 202 });
    let result = { protocolVersion: '2025-06-18' };
    if (request.method === 'tools/call') {
      const { name, arguments: args } = request.params;
      tools.push([name, args]);
      if (fail) return fail(options, name);
      const fallback = name === 't3_thread_wait' ? { threadId: 'a', runId, status, timedOut }
        : { thread: snapshot, items: [], hasMore: false, nextPosition: null };
      result = { structuredContent: respond ? respond(name, args, fallback) : fallback };
    }
    return Response.json({ jsonrpc: '2.0', id: request.id, result }, { headers: { 'mcp-session-id': 'transport' } });
  };
  const control = (config, action) => withT3Control(config, action,
    { cli, fetchImpl, readRuntime: () => ({ origin: 'http://127.0.0.1:3773' }) });
  return { tools, revoked, control, read: () => readTaskState({ threadId: 'a' }, 'original', { control }) };
}

test('exact-run reads follow continuations and return paginated complete text despite a newer desktop turn', async () => {
  const h = transport({ runId: 'continuation', respond: (name, args, fallback) => {
    if (name !== 't3_thread_read' || !args.view && !args.itemId) return fallback;
    if (args.itemId) return { ...fallback, items: [{ itemId: 'answer', runId: 'continuation', text: 'second half', textTruncated: false }] };
    if (args.afterPosition === undefined) return { ...fallback, hasMore: true, nextPosition: 100,
      items: [{ type: 'assistant_message', runId: 'original', text: 'old answer' }] };
    return { ...fallback, items: [{ itemId: 'answer', type: 'assistant_message', runId: 'continuation',
      text: 'first half ', textTruncated: true, nextTextOffset: 11 },
      { type: 'assistant_message', runId: 'newer', text: 'wrong answer' }] };
  } });
  assert.deepEqual(await h.read(), { threadId: 'a', runId: 'continuation', status: 'completed', reply: 'first half second half' });
  assert.deepEqual(h.tools[0], ['t3_thread_wait', { threadId: 'a', runId: 'original', timeoutMs: 1, untilDelegatedWorkSettled: true }]);
  assert.ok(h.tools.every(([name]) => ['t3_thread_read', 't3_thread_wait'].includes(name)));
  assert.deepEqual(h.revoked, [['auth', 'session', 'revoke', 'fixture-session']]);
});

test('queued tasks do not consume another run pending questions or results', async () => {
  const h = transport({ status: 'queued', timedOut: true, thread: { pendingRequestCount: 1 } });
  assert.equal((await h.read()).status, 'running');
  assert.equal(h.tools.some(([name]) => name === 't3_pending_request'), false);
});

test('delegated background completions use the result run selected by T3', async () => {
  const h = transport({ respond: (name, args, fallback) => name === 't3_thread_wait'
    ? { ...fallback, resultRun: { runId: 'final-run', status: 'completed' } }
    : args.view ? { ...fallback, items: [{ runId: 'run', type: 'assistant_message', text: 'delegated work started' },
      { runId: 'final-run', type: 'assistant_message', text: 'full result' }] } : fallback });
  assert.deepEqual(await h.read(), { threadId: 'a', runId: 'final-run', status: 'completed', reply: 'full result' });
});

test('nonblocking questions release the matching task and permission cards without questions also return', async () => {
  for (const question of [true, false]) {
    const h = transport({ status: 'running', timedOut: true,
      thread: { latestRunId: 'run', activeRunId: 'run', pendingRequestCount: 1 },
      respond: (name, args, fallback) => name !== 't3_pending_request' ? fallback
        : args.action === 'list' ? { requestIds: question ? ['q'] : [] }
          : { requestId: 'q', questions: [{ id: 'confirm', question: 'Continue?' }] },
    });
    const result = await h.read();
    assert.equal(result.status, 'waiting');
    assert.equal(result.request?.requestId || null, question ? 'q' : null);
  }
});

test('failed or interrupted tasks return their own error rather than a partial assistant reply', async () => {
  for (const status of ['failed', 'cancelled', 'interrupted', 'rolled_back']) {
    const h = transport({ status, respond: (name, args, fallback) => name === 't3_thread_read' && args.view
      ? { ...fallback, items: [{ type: 'assistant_message', runId: 'run', text: 'partial work' },
        { type: 'error', runId: 'run', text: 'ended with an error' }] } : fallback });
    const result = await h.read();
    assert.equal(result.status, status);
    assert.equal(result.reply, undefined);
    assert.equal(result.error, 'ended with an error');
  }
});

test('waiting alone is never evidence of a desktop permission request', async () => {
  const h = transport({ status: 'waiting', thread: { latestRunId: 'run', activeRunId: 'run', pendingRequestCount: 0 },
    respond: (name, args, fallback) => name === 't3_pending_request' ? { requestIds: [] } : fallback });
  const result = await h.read();
  assert.equal(result.status, 'waiting');
  assert.equal(result.approval, undefined);
  assert.equal(h.tools.some(([name, args]) => name === 't3_thread_read' && args.view === 'activity'), false);
});

test('only a pending approval card on the matching live run permits an actionable reminder', async () => {
  for (const variant of ['live', 'resolved', 'other-run', 'changed-snapshot']) {
    const h = transport({ status: 'waiting',
      thread: { latestRunId: 'run', activeRunId: 'run', pendingRequestCount: 1 },
      respond: (name, args, fallback) => {
        if (name === 't3_pending_request') return { requestIds: [] };
        if (name !== 't3_thread_read' || !args.view) return fallback;
        const item = { type: 'approval_request', itemId: 'approval', runId: variant === 'other-run' ? 'newer' : 'run',
          status: variant === 'resolved' ? 'completed' : 'waiting', title: '执行测试' };
        if (args.afterPosition === undefined) return { ...fallback, items: [], hasMore: true, nextPosition: 100 };
        return { ...fallback, thread: { ...fallback.thread, pendingRequestCount: variant === 'changed-snapshot' ? 0 : 1 }, items: [item] };
      } });
    const result = await h.read();
    assert.equal(result.approval?.id, variant === 'live' ? 'approval' : undefined, variant);
    if (variant === 'live') assert.equal(result.approval.summary, '执行测试');
  }
});

test('stable permission snapshots reuse verification and any server revision is checked again', async () => {
  let revision = 'v1';
  const h = transport({ status: 'waiting', thread: { latestRunId: 'run', activeRunId: 'run', pendingRequestCount: 1 },
    respond: (name, args, fallback) => {
      if (name === 't3_pending_request') return { requestIds: [] };
      if (name !== 't3_thread_read') return fallback;
      return { ...fallback, thread: { ...fallback.thread, updatedAt: revision }, items: args.view
        ? [{ type: 'approval_request', itemId: revision, runId: 'run', status: 'waiting' }] : [] };
    } });
  const config = { threadId: 'a', approvalCache: {} };
  for (let i = 0; i < 2; i++) assert.equal((await readTaskState(config, 'run', { control: h.control })).approval.id, 'v1');
  assert.equal(h.tools.filter(([name, args]) => name === 't3_thread_read' && args.view).length, 1);
  revision = 'v2';
  assert.equal((await readTaskState(config, 'run', { control: h.control })).approval.id, 'v2');
});

test('malformed states and nonadvancing result pages terminate safely and revoke the credential', async () => {
  for (const mode of ['wrong-thread', 'no-run', 'unknown-status', 'no-timeout-flag', 'bad-page', 'bad-chunk']) {
    const h = transport({ respond: (name, args, fallback) => {
      if (name === 't3_thread_wait') {
        if (mode === 'wrong-thread') return { ...fallback, threadId: 'other' };
        if (mode === 'no-run') return { ...fallback, runId: null };
        if (mode === 'unknown-status') return { ...fallback, status: 'mystery' };
        if (mode === 'no-timeout-flag') return { ...fallback, timedOut: undefined };
      }
      if (name === 't3_thread_read' && args.view) return mode === 'bad-page'
        ? { ...fallback, hasMore: true, nextPosition: 1 }
        : { ...fallback, items: [{ type: 'assistant_message', itemId: 'answer', runId: 'run',
          text: 'first', textTruncated: true, nextTextOffset: 5 }] };
      if (args.itemId) return { ...fallback, items: [{ itemId: 'answer', runId: 'other', text: 'wrong' }] };
      return fallback;
    } });
    await assert.rejects(h.read(), error => error.code === 'T3_INVALID_TASK', mode);
    assert.equal(h.revoked.length, 1);
  }
});

test('connection failures are retryable while authorization rejection remains explicit', async () => {
  for (const mode of ['network', 503, 403]) {
    const h = transport({ fail: () => {
      if (mode === 'network') throw new TypeError('private internal network detail');
      return new Response('private server detail', { status: mode });
    } });
    await assert.rejects(h.read(), error => error.code === (mode === 403 ? 'T3_CONTROL_REJECTED' : 'T3_CONNECTION_LOST')
      && !error.message.includes('private'));
    assert.equal(h.revoked.length, 1);
  }
});

test('runtime probe distinguishes an exited server, a restarted server and unavailable process information', () => {
  let runtime = { pid: 12 }, alive = true;
  const probe = runtimeProbe({}, { read: () => {
    if (!runtime) throw Object.assign(new Error('removed'), { code: 'ENOENT' });
    return JSON.stringify(runtime);
  }, kill: pid => {
    if (!alive && pid === 12) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  } });
  assert.equal(probe(), 'alive');
  runtime = null; alive = false;
  assert.equal(probe(), 'exited');
  runtime = { pid: 13 };
  assert.equal(probe(), 'alive');
  const unknown = runtimeProbe({}, { read: () => '{broken', kill: () => assert.fail('no known PID') });
  assert.equal(unknown(), 'unknown');
  const inaccessible = runtimeProbe({}, { read: () => '{"pid":12}', kill: () => { throw Object.assign(new Error(), { code: 'EPERM' }); } });
  assert.equal(inaccessible(), 'unknown');
});

test('stopping aborts both reconnect delays and a request in flight and still revokes its credential', async () => {
  const controller = new AbortController();
  const delay = taskPause(30000, controller.signal);
  controller.abort();
  await assert.rejects(delay, error => error.code === 'T3_WAIT_ABORTED');
  const inflight = new AbortController();
  const h = transport({ fail: options => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    inflight.abort();
  }) });
  await assert.rejects(readTaskState({ threadId: 'a', signal: inflight.signal }, 'run', { control: h.control }),
    error => error.code === 'T3_WAIT_ABORTED');
  assert.equal(h.revoked.length, 1);
});
