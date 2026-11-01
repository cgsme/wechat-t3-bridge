import { randomBytes, randomUUID, createHash, createCipheriv } from 'node:crypto';

export const LOGIN_BASE = 'https://ilinkai.weixin.qq.com';
const VERSION = '2.4.8';

// iLink IDs are uint64. Preserve their original decimal digits before JS rounds
// them, otherwise a quote can no longer match the send response's message ID.
export function parseWechatJson(text) {
  return JSON.parse(text, (key, value, context) =>
    ['message_id', 'svr_id', 'msg_id', 'seq'].includes(key) && typeof value === 'number'
      && !Number.isSafeInteger(value) ? context.source : value);
}

// Implemented against Tencent's published iLink protocol; not an OpenClaw plugin.
export function wechatBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !/(^|\.)weixin\.qq\.com$/.test(url.hostname) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('微信返回的 API 地址不符合预期');
  }
  return url.origin;
}

export class WechatApi {
  constructor({ base = LOGIN_BASE, token, fetchImpl = fetch } = {}) {
    this.base = wechatBase(base);
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(endpoint, { body, timeout = 40000, authenticated = true, optionalJson = false } = {}) {
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '132104' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
    }
    if (authenticated) {
      if (!this.token) throw new Error('尚未扫码登录');
      headers.Authorization = `Bearer ${this.token}`;
      body = { ...body, base_info: { channel_version: VERSION, bot_agent: 'WeChatT3Bridge/0.7.12' } };
    }
    const response = await this.fetch(new URL(endpoint, this.base), {
      method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout), redirect: 'error',
    });
    if (!response.ok) throw new Error(`微信接口 HTTP ${response.status}`);
    const idAware = endpoint === '/ilink/bot/getupdates' || endpoint === '/ilink/bot/sendmessage';
    const data = optionalJson ? parseWechatJson((await response.text()).trim() || '{}')
      : idAware && typeof response.text === 'function' ? parseWechatJson(await response.text()) : await response.json();
    const code = Number(data.ret || data.errcode || 0);
    if (code) {
      const error = new Error(`微信接口错误 ${code}`);
      error.code = code;
      throw error;
    }
    return data;
  }

  qr(tokens = []) {
    return this.request('/ilink/bot/get_bot_qrcode?bot_type=3', {
      authenticated: false, body: { local_token_list: tokens }, timeout: 20000,
    });
  }

  qrStatus(qrcode, verifyCode) {
    const query = new URLSearchParams({ qrcode });
    if (verifyCode) query.set('verify_code', verifyCode);
    return this.request(`/ilink/bot/get_qrcode_status?${query}`, { authenticated: false });
  }

  updates(cursor) {
    return this.request('/ilink/bot/getupdates', { body: { get_updates_buf: cursor || '' } });
  }

  getConfig(owner, context) {
    return this.request('/ilink/bot/getconfig', { timeout: 10000, body: {
      ilink_user_id: owner, ...(context ? { context_token: context } : {}),
    } });
  }

  sendTyping(owner, ticket, active) {
    return this.request('/ilink/bot/sendtyping', { timeout: 10000, optionalJson: true, body: {
      ilink_user_id: owner, typing_ticket: ticket, status: active ? 1 : 2,
    } });
  }

  send(owner, context, text, clientId = randomUUID()) {
    if (!context) throw new Error('回复缺少微信会话令牌');
    return this.request('/ilink/bot/sendmessage', { timeout: 20000, body: {
      msg: { from_user_id: '', to_user_id: owner, client_id: clientId,
        message_type: 2, message_state: 2, context_token: context,
        item_list: [{ type: 1, text_item: { text } }] },
    } });
  }

  async sendHtml(owner, context, bytes, fileName, clientId = randomUUID()) {
    if (!context) throw new Error('发送附件缺少微信会话令牌');
    if (!Buffer.isBuffer(bytes) || bytes.length > 5 * 1024 * 1024 || !/\.html?$/i.test(fileName)) throw new Error('HTML 附件无效或超过 5 MB');
    const key = randomBytes(16), filekey = randomBytes(16).toString('hex');
    const cipher = createCipheriv('aes-128-ecb', key, null);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const upload = await this.request('/ilink/bot/getuploadurl', { timeout: 20000, body: {
      filekey, media_type: 3, to_user_id: owner, rawsize: bytes.length,
      rawfilemd5: createHash('md5').update(bytes).digest('hex'), filesize: encrypted.length,
      no_need_thumb: true, aeskey: key.toString('hex'),
    } });
    const cdn = new URL(upload.upload_full_url || `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param || '')}&filekey=${filekey}`);
    if (cdn.protocol !== 'https:' || cdn.hostname !== 'novac2c.cdn.weixin.qq.com' || cdn.username || cdn.password || cdn.port
      || (!upload.upload_full_url && !upload.upload_param)) throw new Error('微信未返回可用的附件上传地址');
    const response = await this.fetch(cdn, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body: encrypted, signal: AbortSignal.timeout(30000), redirect: 'error' });
    const downloadParam = response.headers.get('x-encrypted-param');
    if (response.status !== 200 || !downloadParam) { await response.body?.cancel(); throw new Error('HTML 附件上传失败，请稍后重试'); }
    return this.request('/ilink/bot/sendmessage', { timeout: 20000, body: { msg: {
      from_user_id: '', to_user_id: owner, client_id: clientId, message_type: 2, message_state: 2, context_token: context,
      item_list: [{ type: 4, file_item: { file_name: fileName, len: String(bytes.length),
        media: { encrypt_query_param: downloadParam, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 } } }],
    } } });
  }
}
