import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { supervise, ensureDesktop, desktopEnvironment, matchesEntry, acquireSupervisorLock } from '../src/supervisor.mjs';

test('a slow T3 startup is retried and no bridge starts until it is ready', async () => {
  let probes = 0, attempts = 0, launches = 0, waits = 0, pid = null;
  const states = [], delays = [];
  await supervise({
    ready: async () => { if (++probes < 3) throw Error('not ready'); },
    ensureDesktop: async () => { attempts++; },
    bridgePid: async () => pid,
    startBridge: async () => { assert.equal(probes, 3); launches++; return pid = 42; },
    status: state => states.push(state),
    pause: async ms => { delays.push(ms); waits++; }, stopped: () => waits >= 4,
  });
  assert.equal(attempts, 2); assert.equal(launches, 1);
  assert.deepEqual(delays, [5000, 10000, 5000, 5000]);
  assert.deepEqual(states.map(state => state.phase), ['waiting_for_t3', 'waiting_for_t3', 'starting_bridge', 'running']);
});

test('an existing bridge is adopted and upgrades pause supervision', async () => {
  let loops = 0, launches = 0, probes = 0;
  const states = [];
  await supervise({
    bridgePid: async () => 101, ready: async () => { probes++; }, ensureDesktop: async () => assert.fail('already ready'),
    startBridge: async () => { launches++; }, paused: async () => loops === 0,
    status: state => states.push(state), pause: async () => { loops++; }, stopped: () => loops >= 2,
  });
  assert.equal(launches, 0); assert.equal(probes, 1);
  assert.deepEqual(states.map(state => state.phase), ['maintenance', 'running']);
});

test('a bridge launched by an updater during the readiness check is not duplicated', async () => {
  let ready = false, stop = false;
  await supervise({ bridgePid: async () => ready ? 8 : null, ready: async () => { ready = true; },
    ensureDesktop: async () => {}, startBridge: async () => assert.fail('duplicate'),
    pause: async () => { stop = true; }, stopped: () => stop });
});

test('transient probe and launch failures keep retrying, with a bounded delay', async () => {
  let loops = 0, launches = 0;
  const states = [], delays = [];
  await supervise({ bridgePid: async () => null, ready: async () => { if (loops < 7) throw Error('offline'); },
    ensureDesktop: async () => {}, startBridge: async () => { if (++launches === 1) throw Error('locked'); return 100; },
    status: state => states.push(state), pause: async ms => { delays.push(ms); loops++; }, stopped: () => loops >= 9 });
  assert.equal(launches, 2); assert.ok(delays.every(ms => ms >= 5000 && ms <= 30000));
  assert.equal(states.at(-1).phase, 'starting_bridge');
});

test('the desktop launcher strips Electron CLI variables and preserves server configuration', async () => {
  const env = desktopEnvironment({ ELECTRON_RUN_AS_NODE: '1', t3code_desktop_cli_launcher: '1', KEEP: 'safe' });
  assert.deepEqual(env, { KEEP: 'safe' });
  const config = { command: 'C:\\T3\\T3.exe', env: { ELECTRON_RUN_AS_NODE: '1', T3CODE_DESKTOP_CLI_LAUNCHER: '1', T3CODE_HOME: 'C:\\custom' } };
  let launched = 0;
  const launch = (command, args, options) => {
    launched++; assert.equal(command, config.command); assert.deepEqual(args, []);
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined); assert.equal(options.env.T3CODE_DESKTOP_CLI_LAUNCHER, undefined);
    assert.equal(options.env.T3CODE_HOME, 'C:\\custom'); assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
    const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child;
  };
  await ensureDesktop(config, { processes: async () => [], launch });
  await ensureDesktop(config, { processes: async () => [{ ExecutablePath: config.command, CommandLine: `"${config.command}"` }], launch });
  assert.equal(launched, 1);
  // An Electron renderer/server is not the desktop's main process.
  await ensureDesktop(config, { processes: async () => [{ ExecutablePath: config.command, CommandLine: `"${config.command}" --type=renderer` }], launch });
  assert.equal(launched, 2);
});

test('supervisor lock prevents duplicate startup and reclaims a PID reused by another application', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-supervisor-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const lock = path.join(temp, 'supervisor.lock'), entry = 'C:\\bridge\\supervisor.mjs';
  const ours = { ProcessId: process.pid, ExecutablePath: process.execPath, CommandLine: `"${process.execPath}" "${entry}"` };
  const identify = async () => [ours];
  const release = await acquireSupervisorLock(lock, { entry, identify });
  assert.equal(typeof release, 'function');
  assert.equal(await acquireSupervisorLock(lock, { entry, identify }), null);
  release(); assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(lock, JSON.stringify({ pid: 999 }));
  const stale = await acquireSupervisorLock(lock, { entry, identify: async () => [{ ...ours, CommandLine: 'unrelated app' }] });
  assert.equal(typeof stale, 'function'); stale();
  assert.equal(matchesEntry({ ...ours, CommandLine: `"${process.execPath}" "${entry}.other"` }, entry), false);
});

test('a real bridge subprocess that exits is restarted while an existing subprocess is kept', { timeout: 10000 }, async () => {
  let child, launches = 0, kept = 0;
  try {
    await supervise({
      bridgePid: async () => child && child.exitCode === null && child.signalCode === null ? child.pid : null,
      ready: async () => {}, ensureDesktop: async () => assert.fail('already ready'),
      startBridge: async () => {
        launches++;
        child = spawn(process.execPath, ['-e', launches === 1 ? 'process.exit(1)' : 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
        await once(child, 'spawn'); return child.pid;
      },
      status: state => { if (state.phase === 'running' && launches === 2) kept++; },
      pause: () => new Promise(resolve => setTimeout(resolve, 30)), stopped: () => kept >= 1,
    });
    assert.equal(launches, 2); assert.equal(kept, 1);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
  }
});
