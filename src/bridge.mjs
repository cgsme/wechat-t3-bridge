import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import QRCode from 'qrcode';
import { WechatApi, LOGIN_BASE, wechatBase } from './api.mjs';
import { commitUpdates, recover, threadLabel } from './core.mjs';
import { checkBackend, backend } from './backend.mjs';
import { createScheduler } from './scheduler.mjs';
import { catalogThreads } from './thread-labels.mjs';
import { createTypingIndicator } from './typing.mjs';
import { sendTrackedReply, rememberMessage, quotePeer } from './quotes.mjs';
import { prepareHtmlReply, readPreparedHtml } from './html-attachments.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const dataDir = path.resolve(process.env.WECHAT_T3_DATA || path.join(
  process.env.LOCALAPPDATA || os.homedir(), 'WeChatT3Bridge', 'data'));
const file = name => path.join(dataDir, name);

function read(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`无法读取 ${name}`); }
}

function write(name, value) {
  const destination = file(name);
  const temp = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  // Windows readers can briefly hold the destination without delete sharing.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temp, destination); break; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 19) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function account() {
  const value = read('account.json', null);
  if (!value?.token || !value?.owner || !value?.botId) throw new Error('尚未完成微信扫码绑定');
  wechatBase(value.base);
  return value;
}

function config() {
  const value = read('config.json', null);
  if (!value?.threadId || !value?.command || !value?.cwd) throw new Error('请先运行安装脚本生成 T3 配置');
  return value;
}

function lock(name) {
  const target = file(`${name}.lock`);
  try {
    const old = JSON.parse(fs.readFileSync(target, 'utf8'));
    let active = false;
    try { process.kill(old.pid, 0); active = true; } catch (error) { if (error.code !== 'ESRCH') active = true; }
    if (active) throw new Error(`${name} 已在运行`);
    fs.unlinkSync(target);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.writeFileSync(target, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  const release = () => {
    try { if (JSON.parse(fs.readFileSync(target, 'utf8')).pid === process.pid) fs.unlinkSync(target); } catch {}
  };
  process.on('exit', release);
  return release;
}

function loginStatus(status, extra = {}) {
  write('login-status.json', { status, updatedAt: new Date().toISOString(), ...extra });
}

export async function login() {
  const unlock = lock('login');
  try {
  const initial = new WechatApi();
  const existing = read('account.json', null);
  const qr = await initial.qr(existing?.token ? [existing.token] : []);
  if (!qr.qrcode || !qr.qrcode_img_content) throw new Error('微信没有返回可用二维码');
  const image = await QRCode.toDataURL(qr.qrcode_img_content, { width: 320, margin: 3, errorCorrectionLevel: 'M' });
  fs.writeFileSync(file('login-qr.png'), Buffer.from(image.split(',')[1], 'base64'));
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    .login{display:flex;align-items:center;gap:24px;flex-wrap:wrap;font-family:var(--font-sans,sans-serif);color:var(--foreground)}
    img{width:280px;height:280px;border-radius:var(--radius,12px)}p{line-height:1.7;max-width:310px}
    </style><div class="login"><img src="${image}" alt="用手机微信扫描以绑定"><div><p><strong>用手机微信扫码，确认连接 ClawBot</strong></p><p>绑定后直接发送具体要求执行任务；<br>发「/new 具体要求」新建任务线程。</p><p>请现在扫码；过期后需要重新生成。</p></div></div></html>`;
  fs.writeFileSync(file('login.html'), html, 'utf8');
  loginStatus('waiting', { qrFile: file('login.html') });
  console.log('二维码已生成：' + file('login.html'));
  let api = initial;
  let verifyCode;
  const deadline = Date.now() + 5 * 60000;
  while (Date.now() < deadline) {
    let result;
    try { result = await api.qrStatus(qr.qrcode, verifyCode); }
    catch { await delay(2000); continue; }
    switch (result.status) {
      case 'confirmed': {
        if (!result.bot_token || !result.ilink_bot_id || !result.ilink_user_id) {
          throw new Error('微信登录未返回完整的账号信息，未启用消息处理');
        }
        write('account.json', { token: result.bot_token, botId: result.ilink_bot_id,
          owner: result.ilink_user_id, base: wechatBase(result.baseurl || LOGIN_BASE) });
        // A newly bound identity gets an independent inbox and cursor.
        if (existing && (existing.owner !== result.ilink_user_id || existing.botId !== result.ilink_bot_id)) {
          write('state.json', { cursor: '', jobs: [], seen: [] });
        }
        loginStatus('connected');
        for (const name of ['login.html', 'login-qr.png', 'verify-code.txt']) {
          try { fs.unlinkSync(file(name)); } catch {}
        }
        console.log('微信绑定成功，已限制为扫码账号本人使用。');
        return;
      }
      case 'scaned_but_redirect':
        if (!result.redirect_host) throw new Error('微信重定向缺少地址');
        api = new WechatApi({ base: wechatBase(`https://${result.redirect_host}`) });
        break;
      case 'scaned':
        verifyCode = undefined;
        loginStatus('scanned');
        break;
      case 'need_verifycode': {
        loginStatus('need_verifycode');
        console.log('微信要求输入手机显示的验证码，请通过私密输入卡提供。');
        const verifyDeadline = Math.min(deadline, Date.now() + 120000);
        while (!fs.existsSync(file('verify-code.txt')) && Date.now() < verifyDeadline) await delay(1000);
        if (!fs.existsSync(file('verify-code.txt'))) throw new Error('等待验证码超时，请重新扫码');
        verifyCode = fs.readFileSync(file('verify-code.txt'), 'utf8').trim();
        fs.unlinkSync(file('verify-code.txt'));
        break;
      }
      case 'binded_redirect':
        if (existing?.token && existing?.owner) { loginStatus('connected'); return; }
        throw new Error('微信报告已经绑定，但本机没有凭据，请重新绑定');
      case 'expired': throw new Error('二维码已过期，请重新生成');
      case 'verify_code_blocked': throw new Error('验证码验证失败次数过多，请重新扫码');
      case 'wait': break;
      default: throw new Error('微信返回了未知登录状态');
    }
    await delay(1000);
  }
  throw new Error('二维码已过期，请重新生成');
  } finally {
    unlock();
  }
}

export async function run() {
  lock('bridge');
  const target = config();
  const identity = account();
  const reference = await checkBackend(target);
  const api = new WechatApi({ base: identity.base, token: identity.token });
  const state = read('state.json', { cursor: '', jobs: [], seen: [] });
  try {
    const projectId = state.routing?.projectId || reference.projectId;
    const threads = (await backend.list(target, projectId)).filter(thread => thread.projectId === projectId
      && !thread.archived && thread.relationshipToParent !== 'subagent');
    catalogThreads(state, threads);
  } catch {}
  recover(state);
  const save = () => write('state.json', state);
  save();
  const health = { version: '0.7.15', connected: true, startedAt: new Date().toISOString(), queue: 0, active: null, typing: false };
  // Probe the formatter loaded by this process, not files changed afterward.
  health.replyNumberStyle = threadLabel({ threadId: 'format-check', title: 'format-check', number: 1, shortId: 'test' })
    .startsWith('1\uFE0F\u20E3 ') ? 'emoji' : 'plain';
  const status = extra => {
    Object.assign(health, extra, { updatedAt: new Date().toISOString(),
      queue: state.jobs.filter(job => job.status === 'pending').length,
      selectedThreadId: state.routing ? state.routing.threadId : target.threadId,
      selectedProjectId: state.routing?.projectId || reference.projectId });
    write('status.json', health);
  };
  status({});
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  console.log('微信桥接已启动。');

  const typing = createTypingIndicator({ state, config: target, projectId: reference.projectId,
    backend, api, owner: identity.owner, status });
  const scheduler = createScheduler({ state, config: target, reference, backend, save, status,
    prepareReply: (job, reply) => prepareHtmlReply(job, reply, { dataDir, config: target, renderedHtml: backend.renderedHtml }),
    sendAttachment: async (job, attachment, index) => {
      const clientId = `t3_${job.id.slice(0, 32)}_html_${index}`;
      const result = await api.sendHtml(identity.owner, job.context, await readPreparedHtml(attachment), attachment.name, clientId);
      rememberMessage(state, { peer: quotePeer(identity.owner), ...job.replyThread, ids: [result?.message_id, clientId] });
      save(); typing.replySent();
    },
    send: async (job, chunk, index) => {
      await sendTrackedReply({ api, state, owner: identity.owner, job, chunk, index, save });
      typing.replySent();
    } });
  async function worker() {
    while (!stopping) {
      scheduler.tick();
      typing.tick();
      await delay(100);
    }
  }

  const working = worker();
  // Attach immediately: unexpected storage failures must stop the service.
  working.catch(error => { console.error(error.message); process.exit(1); });
  let failures = 0;
  try {
  while (!stopping) {
    try {
      const update = await api.updates(state.cursor);
      // Persist the inbox before acknowledging the next server cursor.
      commitUpdates(state, update, identity.owner, draft => write('state.json', draft));
      status({ connected: true, lastPollAt: new Date().toISOString(), lastError: null });
      failures = 0;
      if (!(update.msgs || []).length) await delay(500);
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') continue;
      failures++;
      status({ connected: false, lastError: error.message });
      if (error.code === -14) {
        stopping = true;
        throw new Error('微信登录已失效，请重新扫码绑定');
      }
      await delay(Math.min(30000, 2000 * failures));
    }
  }
  } finally {
    stopping = true;
    await working;
    await typing.stop();
    status({ connected: false });
  }
}

async function main() {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const command = process.argv[2] || 'status';
  if (command === 'login' || command === 'connect') {
    await checkBackend(config());
    await login();
    if (command === 'connect') await run();
  }
  else if (command === 'run') await run();
  else if (command === 'check') {
    const target = await checkBackend(config());
    console.log(JSON.stringify({ ok: true, threadId: target.threadId, status: target.status }));
  } else if (command === 'status') {
    let loggedIn = false;
    try { account(); loggedIn = true; } catch {}
    console.log(JSON.stringify({ loggedIn, login: read('login-status.json', null), bridge: read('status.json', null) }, null, 2));
  } else throw new Error('支持的命令：connect、login、run、check、status');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    if (['login', 'connect'].includes(process.argv[2])) loginStatus('error', { message: error.message });
    console.error(error.message);
    process.exitCode = 1;
  });
}
