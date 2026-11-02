import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { callT3, createThread, sendToBackend, waitForThread } from '../src/backend.mjs';

const minutes = value => value * 60000;

test('persistent connection loss stops tracking within a bounded grace period', async () => {
  let clock = 0, reads = 0;
  await assert.rejects(waitForThread({ threadId: 'a' }, 'run', {
    read: async () => { reads++; throw Object.assign(new Error('offline'), { code: 'T3_CONNECTION_LOST' }); },
    probe: () => 'unknown', now: () => clock,
    pause: async ms => { clock += ms; if (reads > 12) assert.fail('unbounded reconnect loop'); },
  }), error => error.code === 'T3_TRACKING_LOST' && /状态未确认/.test(error.message));
  assert.ok(clock <= minutes(2));
});

test('confirmed T3 process exit stops waiting without reading or submitting again', async () => {
  await assert.rejects(waitForThread({ threadId: 'a' }, 'run', {
    probe: () => 'exited',
    read: async () => assert.fail('server has exited'),
    pause: async () => assert.fail('must not wait forever for an exited server'),
  }), error => error.code === 'T3_SERVER_EXITED');
});

test('even a CLI that never emits close cannot hold a timed-out request open', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cli = cliProcess();
  cli.child.kill = () => true;
  let settled = false;
  const request = callT3({ command: 't3' }, ['thread', 'show'], { timeout: 20, spawnImpl: () => cli.child })
    .catch(error => { settled = true; assert.equal(error.code, 'T3_COMMAND_TIMEOUT'); });
  t.mock.timers.tick(20);
  await Promise.resolve();
  assert.equal(settled, true);
  await request;
});

function cliProcess() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let kills = 0;
  child.kill = () => { kills++; child.emit('close', null); };
  child.stdin.end = input => { child.input = input; };
  return { child, get kills() { return kills; },
    complete: result => { child.stdout.emit('data', Buffer.from(JSON.stringify(result))); child.emit('close', 0); } };
}

test('ordinary tasks keep waiting past 30 minutes and return the eventual result', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const cli = cliProcess();
  let submissions = 0;
  const outcome = sendToBackend({ command: 't3', threadId: 'a' }, 'long task', {
    call: (config, args, options) => {
      submissions++;
      assert.equal(args.includes('--wait'), false);
      return callT3(config, args, { ...options, spawnImpl: () => cli.child });
    },
    waitFor: (config, runId) => waitForThread(config, runId, {
      probe: () => 'alive',
      read: async () => { t.mock.timers.tick(minutes(90)); return { threadId: 'a', runId, status: 'completed', reply: 'long task finished' }; },
    }),
  }).then(value => ({ value }), error => ({ error }));
  cli.complete({ threadId: 'a', runId: 'run', status: 'running' });
  assert.deepEqual(await outcome, { value: 'long task finished' });
  assert.equal(cli.kills, 0);
  assert.equal(submissions, 1);
  assert.equal(cli.child.input, 'long task');
});

test('synchronous thread creation also permits tasks longer than 30 minutes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let submissions = 0;
  const result = await createThread({ threadId: 'a' },
    { projectId: 'p', title: 'long task', provider: 'codex', model: 'model', prompt: 'long task' }, {
      call: async (_, args, options) => {
        submissions++;
        assert.equal(args.includes('--wait'), false);
        assert.equal(options.timeout, 30000);
        return JSON.stringify({ threadId: 'created-thread', runId: 'run' });
      },
      waitFor: (config, runId, options) => waitForThread(config, runId, { ...options, probe: () => 'alive',
        read: async () => { t.mock.timers.tick(minutes(90)); return { threadId: 'created-thread', runId, status: 'completed', reply: 'done' }; } }),
    });
  assert.equal(result.threadId, 'created-thread');
  assert.equal(result.reply, 'done');
  assert.equal(submissions, 1);
});

test('background waits and resumed answers still return results after hours of running', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let reads = 0;
  const reply = await waitForThread({ threadId: 'a' }, 'run', {
    probe: () => 'alive',
    read: async () => {
      reads++;
      return { threadId: 'a', runId: 'run', status: reads < 3 ? 'running' : 'completed', reply: 'eventual result' };
    },
    pause: async () => t.mock.timers.tick(minutes(90)),
  });
  assert.equal(reply, 'eventual result');
  assert.equal(reads, 3);
});

test('long background waits still release the thread lane for a question or cancellation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  for (const status of ['waiting', 'interrupted']) {
    let reads = 0;
    const request = { requestId: 'question', questions: [{ id: 'q', question: 'Continue?' }] };
    const result = await waitForThread({ threadId: 'a' }, 'run', {
      probe: () => 'alive',
      read: async () => ({ threadId: 'a', runId: 'run', status: ++reads === 1 ? 'running' : status, request }),
      pause: async () => t.mock.timers.tick(minutes(90)),
    });
    if (status === 'waiting') assert.equal(result.request.requestId, 'question');
    else assert.match(result, /interrupted/);
  }
});

test('background query timeouts back off and recover without resubmitting the task', async () => {
  let reads = 0;
  const pauses = [];
  const result = await waitForThread({ threadId: 'a' }, 'run', {
    probe: () => 'alive',
    read: async () => {
      reads++;
      if (reads < 3 || reads === 4) throw Object.assign(new Error('query timed out'), { code: 'T3_COMMAND_TIMEOUT' });
      return { threadId: 'a', runId: 'run', status: reads === 3 ? 'running' : 'completed', reply: 'reconnected result' };
    },
    pause: async ms => { pauses.push(ms); },
  });
  assert.equal(result, 'reconnected result');
  assert.deepEqual(pauses, [5000, 10000, 3000, 5000]);
  assert.equal(reads, 5);
});

test('background waits do not hide invalid state, changed targets or unrelated CLI errors', async () => {
  for (const response of [
    { threadId: 'other', runId: 'run', status: 'running' },
    { threadId: 'a', runId: 'run', status: 'unknown' },
    'invalid JSON', new Error('CLI unavailable'),
  ]) {
    let reads = 0;
    await assert.rejects(waitForThread({ threadId: 'a' }, 'run', {
      probe: () => 'alive',
      read: async () => {
        reads++;
        if (response instanceof Error) throw response;
        return response;
      },
      pause: async () => assert.fail('must not retry an invalid response'),
    }));
    assert.equal(reads, 1);
  }
});

test('a stalled short CLI request still times out as a connection issue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  const cli = cliProcess();
  const outcome = callT3({ command: 't3' }, ['thread', 'show', '--json', 'a'],
    { spawnImpl: () => cli.child }).then(value => ({ value }), error => ({ error }));
  t.mock.timers.tick(30000);
  assert.equal(cli.kills, 1);
  const { error } = await outcome;
  assert.equal(error.code, 'T3_COMMAND_TIMEOUT');
  assert.match(error.message, /连接|命令/);
  assert.doesNotMatch(error.message, /等待 T3 回复超时/);
});

test('desktop permission confirmation notifies once then continues to the final result', async () => {
  const statuses = ['waiting', 'waiting', 'running', 'completed'], progress = [];
  const result = await waitForThread({ threadId: 'a' }, 'run', {
    probe: () => 'alive', read: async () => ({ threadId: 'a', runId: 'run', status: statuses.shift(),
      approval: { id: 'permission' }, reply: 'finished' }),
    pause: async () => {}, onProgress: status => progress.push(status),
  });
  assert.equal(result, 'finished');
  assert.deepEqual(progress, ['waiting_permission', 'running']);
});

test('continuation IDs are persisted and a long task never reverts to its original run', async () => {
  const runs = [];
  let reads = 0;
  const result = await waitForThread({ threadId: 'a' }, 'original', {
    probe: () => 'alive', read: async (_, runId) => {
      assert.equal(runId, reads++ === 0 ? 'original' : 'continuation');
      return { threadId: 'a', runId: 'continuation', status: reads === 1 ? 'running' : 'completed', reply: 'continued result' };
    }, pause: async () => {}, onRun: id => runs.push(id),
  });
  assert.equal(result, 'continued result');
  assert.deepEqual(runs, ['continuation']);
});

test('a task that fails after reporting partial work is clearly returned as failed', async () => {
  const result = await waitForThread({ threadId: 'a' }, 'run', { probe: () => 'alive',
    read: async () => ({ threadId: 'a', runId: 'run', status: 'failed', reply: 'partial work', error: 'provider stopped' }),
  });
  assert.match(result, /failed/);
  assert.match(result, /provider stopped/);
  assert.doesNotMatch(result, /partial work/);
});

test('a successful credential cleanup command may have empty output', async () => {
  const cli = cliProcess();
  const cleanup = callT3({ command: 't3' }, ['auth', 'session', 'revoke', 'fixture'], { spawnImpl: () => cli.child });
  cli.child.emit('close', 0);
  assert.equal(await cleanup, '');
  assert.equal(cli.kills, 0);
});

test('aborting a stuck CLI cancels only the spawned request without waiting for its close event', async () => {
  const cli = cliProcess();
  const controller = new AbortController();
  cli.child.kill = () => true;
  const command = callT3({ command: 't3', signal: controller.signal }, ['thread', 'send'], { spawnImpl: () => cli.child });
  controller.abort();
  await assert.rejects(command, error => error.code === 'T3_WAIT_ABORTED');
});
