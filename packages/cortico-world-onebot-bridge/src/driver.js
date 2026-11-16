/**
 * 最小 OneBot v11 正向 WebSocket 驱动。
 *
 * 一条双工连接同时收事件、按 echo 关联 action 回执。
 * ws 走延迟 dynamic import：import 本模块不触发 ws 解析，`node --test` 与
 * dryMount 无需安装 ws；只有真正 #connect() 才要 ws（需实现端，本骨架不连）。
 * 退避 base×2 封顶 max（蓝图 §2.1：1000ms×2→30000ms），start() 永不 reject。
 */

const OPEN = 1;

/** 纯函数：入站 JSON 对象分类。有 echo → action 回执；有 post_type → 事件；否则忽略。 */
export function classifyInbound(obj) {
  if (!obj || typeof obj !== 'object') return 'ignore';
  if (obj.echo !== undefined && obj.echo !== null) return 'response';
  if (obj.post_type !== undefined) return 'event';
  return 'ignore';
}

/** 纯函数：重连退避。current 翻倍封顶 max。 */
export function nextBackoff(current, max) {
  const base = Number(current) || 1000;
  const cap = Number(max) || 30000;
  return Math.min(base * 2, cap);
}

/** 纯函数：把 action 回执判定为成功 / 失败。retcode==0 或 status ok/async 视为成功。 */
export function decodeResponse(obj) {
  const retcode = Number(obj?.retcode ?? -1);
  const status = String(obj?.status ?? '');
  const ok = retcode === 0 || status === 'ok' || status === 'async';
  return { ok, retcode, data: obj?.data, message: obj?.message ? String(obj.message) : '' };
}

export class OneBotDriver {
  #opts;
  #log;
  #ws;
  #stopped = true;
  #echoSeq = 0;
  #pending = new Map();
  #backoffMs;
  #reconnectTimer;
  #eventCbs = [];
  #readyCbs = [];
  #statusCbs = [];

  connected = false;
  identity = null;

  constructor(opts = {}) {
    this.#opts = opts;
    this.#log = opts.log ?? null;
    this.#backoffMs = Number(opts.reconnectBaseMs) || 1000;
  }

  onEvent(cb) { this.#eventCbs.push(cb); }
  onReady(cb) { this.#readyCbs.push(cb); }
  onStatus(cb) { this.#statusCbs.push(cb); }

  /** 首次连接尝试结束即 resolve；失败时后台继续退避重连。永不 reject。 */
  async start() {
    if (this.connected) return;
    this.#stopped = false;
    this.#backoffMs = Number(this.#opts.reconnectBaseMs) || 1000;
    await new Promise((resolve) => this.#connect(resolve));
  }

  async stop() {
    this.#stopped = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#rejectAllPending(new Error('driver stopped'));
    const ws = this.#ws;
    this.#ws = undefined;
    this.connected = false;
    if (ws) { try { ws.terminate(); } catch { /* ignore */ } }
  }

  /** 出站 action；未连接直接 reject（调用方用 callSafe 兜信封）。 */
  call(action, params = {}, timeoutMs) {
    const timeout = Number(timeoutMs) || Number(this.#opts.apiTimeoutMs) || 10000;
    return new Promise((resolve, reject) => {
      const ws = this.#ws;
      if (!ws || ws.readyState !== OPEN) {
        reject(new Error(`${action}: WS not connected`));
        return;
      }
      const echo = `cb-${++this.#echoSeq}`;
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        reject(new Error(`${action}: timeout (${timeout}ms)`));
      }, timeout);
      this.#pending.set(echo, { action, resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(echo);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async callSafe(action, params = {}, timeoutMs) {
    try {
      return { ok: true, data: await this.call(action, params, timeoutMs) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async #connect(onSettled) {
    if (this.#stopped) { onSettled?.(); return; }
    let settled = false;
    const settle = () => { if (!settled) { settled = true; onSettled?.(); } };

    let WebSocket;
    try {
      WebSocket = (await import('ws')).default;
    } catch (err) {
      this.#log?.warn?.('ws module unavailable; bridge cannot connect', { error: String(err) });
      settle();
      return;
    }

    let ws;
    try {
      ws = new WebSocket(this.#opts.wsUrl, {
        headers: this.#opts.token ? { Authorization: `Bearer ${this.#opts.token}` } : undefined,
      });
    } catch (err) {
      this.#log?.warn?.('WS create failed', { error: String(err) });
      settle();
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;

    ws.on('open', () => { this.connected = true; this.#backoffMs = Number(this.#opts.reconnectBaseMs) || 1000; this.#emitStatus({ connected: true }); void this.#initIdentity().then((idn) => { this.identity = idn; for (const cb of [...this.#readyCbs]) { try { cb(idn); } catch (e) { this.#log?.error?.('ready cb failed', { error: String(e) }); } } settle(); }); });
    ws.on('message', (data) => { if (!this.#stopped && this.#ws === ws) this.#onRaw(String(data)); });
    ws.on('error', (err) => this.#log?.warn?.('WS error', { error: String(err) }));
    ws.on('close', () => {
      const current = this.#ws === ws;
      if (current) {
        this.#ws = undefined; this.connected = false;
        this.#rejectAllPending(new Error('WS disconnected'));
        if (!this.#stopped) this.#emitStatus({ connected: false, error: 'WS disconnected' });
      }
      settle();
      if (current && !this.#stopped) this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (this.#reconnectTimer || this.#stopped) return;
    const delay = this.#backoffMs;
    this.#backoffMs = nextBackoff(this.#backoffMs, this.#opts.reconnectMaxMs);
    this.#reconnectTimer = setTimeout(() => { this.#reconnectTimer = undefined; if (!this.#stopped) void this.#connect(); }, delay);
  }

  async #initIdentity() {
    let login = null; let version = null;
    try { login = await this.call('get_login_info'); } catch { /* 未就绪 */ }
    try { version = await this.call('get_version_info'); } catch { /* 老实现可能无此 action */ }
    return { selfId: login?.user_id != null ? Number(login.user_id) : null, nickname: String(login?.nickname ?? ''), version };
  }

  #onRaw(raw) {
    let obj;
    try { obj = JSON.parse(raw); } catch { this.#log?.warn?.('non-JSON WS message ignored'); return; }
    const kind = classifyInbound(obj);
    if (kind === 'response') {
      const call = this.#pending.get(String(obj.echo));
      if (!call) return;
      this.#pending.delete(String(obj.echo));
      clearTimeout(call.timer);
      const res = decodeResponse(obj);
      if (res.ok) call.resolve(res.data);
      else call.reject(new Error(`${call.action}: retcode=${res.retcode}${res.message ? ` ${res.message}` : ''}`));
      return;
    }
    if (kind === 'event') {
      for (const cb of [...this.#eventCbs]) { try { cb(obj); } catch (e) { this.#log?.error?.('event cb failed', { error: String(e) }); } }
    }
  }

  #emitStatus(status) { for (const cb of [...this.#statusCbs]) { try { cb(status); } catch (e) { this.#log?.error?.('status cb failed', { error: String(e) }); } } }

  #rejectAllPending(err) { for (const call of this.#pending.values()) { clearTimeout(call.timer); call.reject(new Error(`${call.action}: ${err.message}`)); } this.#pending.clear(); }
}
