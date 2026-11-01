import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkBackend } from './backend.mjs';

const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const windowsShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// This loop only manages processes. It never resubmits messages or tasks.
export async function supervise({ bridgePid, ready, ensureDesktop, startBridge, paused = async () => false,
  status = () => {}, pause = delay, stopped = () => false }) {
  let failures = 0;
  while (!stopped()) {
    try {
      if (await paused()) {
        status({ phase: 'maintenance', bridgePid: await bridgePid() });
        await pause(1000);
        continue;
      }
      const existing = await bridgePid();
      try {
        await ready();
      } catch {
        failures++;
        const retryInMs = Math.min(30000, 5000 * 2 ** Math.min(failures - 1, 3));
        status({ phase: 'waiting_for_t3', bridgePid: existing, failures, retryInMs });
        await ensureDesktop();
        await pause(retryInMs);
        continue;
      }
      if (stopped()) break;
      // Recheck after probing T3: an updater may have launched the bridge.
      if (await paused()) continue;
      let pid = await bridgePid();
      if (!pid) {
        pid = await startBridge();
        status({ phase: 'starting_bridge', bridgePid: pid, failures: 0 });
        await pause(5000);
      } else {
        status({ phase: 'running', bridgePid: pid, failures: 0 });
        await pause(5000);
      }
      failures = 0;
    } catch {
      failures++;
      const retryInMs = Math.min(30000, 5000 * failures);
      status({ phase: 'retrying', failures, retryInMs });
      await pause(retryInMs);
    }
  }
}

export async function windowsProcesses(pid) {
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid < 1)) return [];
  const filter = pid === undefined ? '' : ` -Filter 'ProcessId = ${pid}'`;
  const { stdout } = await exec(windowsShell, ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process${filter} | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`],
  { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
  const data = stdout.trim() ? JSON.parse(stdout) : [];
  return Array.isArray(data) ? data : data ? [data] : [];
}

export function matchesEntry(row, entry, executable = process.execPath) {
  if (!row || typeof row.CommandLine !== 'string' || typeof row.ExecutablePath !== 'string') return false;
  const normalized = value => path.win32.normalize(value).toLowerCase();
  if (normalized(row.ExecutablePath) !== normalized(executable)) return false;
  const command = row.CommandLine.toLowerCase();
  const target = entry.toLowerCase();
  return command.includes(`"${target}"`) || command.split(/\s+/).includes(target);
}

export function desktopEnvironment(environment = process.env) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (['ELECTRON_RUN_AS_NODE', 'T3CODE_DESKTOP_CLI_LAUNCHER'].includes(key.toUpperCase())) delete env[key];
  }
  return env;
}

export async function ensureDesktop(config, { processes = windowsProcesses, launch = spawn } = {}) {
  const executable = config.desktopCommand || (config.env?.ELECTRON_RUN_AS_NODE === '1' && /\.exe$/i.test(config.command || '') ? config.command : null);
  if (!executable) return; // A separately managed server may simply need more time.
  const samePath = row => row.ExecutablePath?.toLowerCase() === executable.toLowerCase();
  const desktop = (await processes()).find(row => samePath(row) && row.CommandLine
    && !/(?:--type[=\s]|--require\s|\bbin\.mjs\b)/i.test(row.CommandLine));
  if (desktop) return;
  await new Promise((resolve, reject) => {
    const child = launch(executable, [], { detached: true, windowsHide: true, shell: false, stdio: 'ignore', env: desktopEnvironment({ ...process.env, ...config.env }) });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function acquireSupervisorLock(file, { entry, identify = windowsProcesses } = {}) {
  let previous;
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') return null; }
  if (previous) {
    const [row] = await identify(previous.pid);
    if (matchesEntry(row, entry)) return null;
    // Only remove the stale record we inspected, never a replacement lock.
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).pid !== previous.pid) return null;
      fs.unlinkSync(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  return () => {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file); } catch {}
  };
}

function writeStatus(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temp, file); break; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 19) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export async function main() {
  const entry = fileURLToPath(import.meta.url);
  const root = path.dirname(path.dirname(entry));
  const data = path.resolve(process.env.WECHAT_T3_DATA || path.join(process.env.LOCALAPPDATA || os.homedir(), 'WeChatT3Bridge', 'data'));
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const release = await acquireSupervisorLock(path.join(data, 'supervisor.lock'), { entry });
  if (!release) return;
  process.on('exit', release);
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  const read = name => {
    try { return JSON.parse(fs.readFileSync(path.join(data, name), 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const bridgeEntry = path.join(root, 'src', 'bridge.mjs');
  let launchedPid;
  const bridgePid = async () => {
    for (const pid of new Set([launchedPid, read('bridge.lock')?.pid])) {
      if (!pid) continue;
      const [row] = await windowsProcesses(pid);
      if (matchesEntry(row, bridgeEntry)) return pid;
    }
    return null;
  };
  const startedAt = new Date().toISOString();
  const health = { pid: process.pid, startedAt };
  const status = value => {
    Object.assign(health, { retryInMs: null }, value, { updatedAt: new Date().toISOString() });
    writeStatus(path.join(data, 'supervisor-status.json'), health);
  };
  try {
    status({ phase: 'starting' });
    await supervise({
      bridgePid, stopped: () => stopping, status,
      ready: () => {
        const config = read('config.json');
        if (!config?.command || !config?.threadId) throw new Error('Bridge configuration is missing.');
        return checkBackend(config);
      },
      ensureDesktop: () => ensureDesktop(read('config.json') || {}),
      paused: async () => {
        const pause = read('supervisor-pause.json');
        if (!Number.isSafeInteger(pause?.pid) || pause.pid < 1) return false;
        try { process.kill(pause.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
      },
      startBridge: async () => {
        // PIDs can be reused after a reboot. The bridge's legacy PID lock alone
        // cannot distinguish an unrelated live process from the old bridge.
        const previous = read('bridge.lock');
        if (previous?.pid) {
          const [row] = await windowsProcesses(previous.pid);
          if (matchesEntry(row, bridgeEntry)) return previous.pid;
          if (read('bridge.lock')?.pid === previous.pid) fs.unlinkSync(path.join(data, 'bridge.lock'));
        }
        const output = fs.openSync(path.join(data, 'supervisor-bridge.log'), 'a', 0o600);
        try {
          launchedPid = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [bridgeEntry, 'run'], { cwd: root, detached: true, windowsHide: true,
              shell: false, stdio: ['ignore', output, output], env: { ...process.env, WECHAT_T3_DATA: data } });
            child.once('error', reject);
            child.once('spawn', () => { child.unref(); resolve(child.pid); });
          });
          return launchedPid;
        } finally { fs.closeSync(output); }
      },
    });
    status({ phase: 'stopped' });
  } finally { release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Bridge supervisor failed; check the local startup configuration.'); process.exitCode = 1; });
}
