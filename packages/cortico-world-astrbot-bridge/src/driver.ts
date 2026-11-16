/**
 * driver —— WS 客户端，拨 AstrBot 侧桥（37c1e6ccd 形态：桥是服务器，本机没有公网，
 * 方向理由逐字先例 driver.ts:1-9 @4725feee6）。
 *
 * 参数表钉先例实测值（d-bridge-priorart §3.4；内核 cortico-bridge-core/src/driver.ts
 * 落仓后改指内核，本文件即退役）：
 * 退避 1000×2→30000、握手 10s+2s guard、心跳 ping 20s、idle 120s 判死、start() 永不 reject。
 *
 * 两阶段升级第 1 态在本文件落地：
 * - 出帧按协商结果分形：旧桥（ready 无 `caps` 数组）走私有帧 v1 形
 *   ——send 的 conv 是 dict `{kind,id}`、text 顶层（37c1e6ccd bridge.py:459-462 实读）；
 *   CBP 桥走 §3.1 形（conv 字符串 = UMO，segments 数组）。
 * - 入帧先做旧帧兼容读：msg 的 conv 是 dict → 收敛成 MsgFrame；`tool-ack`/`ack` 都进关联表。
 * - hello 永远并集发（CBP 头 + v/token/name/capabilities），旧桥多余字段无害。
 */
import WebSocket from 'ws';
import type { Logger } from 'cortico/core/types.ts';
import {
  CBP_VERSION,
  intersectCaps,
  isActor,
  negotiateVersions,
  parseFrame,
  readCaps,
  readVersionSupport,
  type Actor,
  type CatalogFrame,
  type EventFrame,
  type MsgFrame,
  type NoticeFrame,
  type ReadyFrame,
  type SelfDecl,
  type ToolAnn,
} from './frames.ts';
import { legacyMsgToCbp, umoToLegacyConv } from './normalize.ts';

export interface AgentIdentity {
  name: string;
  version: string;
  sha: string;
}

export interface DriverOptions {
  url: string;
  token: string;
  agent: AgentIdentity;
  caps: string[];
  tools: ToolAnn[];
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  log: Logger;
}

export interface Negotiated {
  /** 对端 ready 带 caps 数组才为 true；旧桥 false = 私有帧面、功能位全关。 */
  cbp: boolean;
  version: number;
  caps: string[];
  /** CBP self 声明（F2：桥监听方在 ready 带；旧私有帧无 proven，读作 undefined）。 */
  self?: SelfDecl;
  /** 对端 ready/hello 申报的工具集（F1 权威面）。旧私有帧没这字段 → 空数组。 */
  tools?: ToolAnn[];
  ownerIds: string[];
  tts: { ready: boolean; provider?: string };
}

export interface SendResult {
  ok: boolean;
  error?: string;
  /** 「结果未知」：超时不重试的语义照先例 SendResult.uncertain（d-bridge-priorart §3.4）。 */
  uncertain?: boolean;
}

export interface ToolCallResult {
  ok: boolean;
  result?: string;
  error?: string;
}

export interface DriverHandlers {
  onReady(n: Negotiated): void;
  onMsg(frame: MsgFrame): void;
  onNotice(frame: NoticeFrame): void;
  onEvent(frame: EventFrame): void;
  onCatalog(tools: ToolAnn[]): void;
  onState(connected: boolean): void;
}

/**
 * World 只依赖这个形状（先例把驱动面抽成接口的同一手法，
 * 4725feee6 driver.ts:111-114「抽成接口是为了让测试塞假驱动进来」）。
 */
export interface BridgeLike {
  start(): Promise<void>;
  stop(): void;
  send(umo: string, text: string, opts?: { replyTo?: string }): Promise<SendResult>;
  callTool(name: string, args: Record<string, unknown>, turn: string, actor: Actor): Promise<ToolCallResult>;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;
const HANDSHAKE_GUARD_EXTRA_MS = 2_000;
const HEARTBEAT_MS = 20_000;
const IDLE_TIMEOUT_MS = 120_000;
export const SEND_TIMEOUT_MS = 30_000;
export const TOOL_TIMEOUT_MS = 90_000;

type Pending = { resolve: (v: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> };

export class BridgeDriver implements BridgeLike {
  readonly opts: DriverOptions;
  private readonly h: DriverHandlers;
  private ws: WebSocket | null = null;
  private stopped = true;
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastActivity = 0;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private negotiated: Negotiated = { cbp: false, version: 0, caps: [], ownerIds: [], tts: { ready: false } };

  constructor(opts: DriverOptions, handlers: DriverHandlers) {
    this.opts = opts;
    this.h = handlers;
    this.backoffMs = opts.reconnectBaseMs;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get state(): Negotiated {
    return this.negotiated;
  }

  /** 永不 reject：连不上只记日志、后台重连（硬规则 2）。 */
  start(): Promise<void> {
    if (!this.opts.url) {
      this.opts.log.info('未配置桥地址，保持未连接');
      return Promise.resolve();
    }
    this.stopped = false;
    this.backoffMs = this.opts.reconnectBaseMs;
    this.connect();
    return Promise.resolve();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.rejectAllPending('驱动已停止');
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  /**
   * 发一条消息。conv = UMO 串（senderKey 同键）；帧形按协商结果分：
   * 旧桥 → 私有帧 v1 dict-conv + 顶层 text；CBP → conv 串 + segments。
   */
  send(umo: string, text: string, opts?: { replyTo?: string }): Promise<SendResult> {
    const rid = `a-${++this.seq}`;
    if (!this.connected) {
      return Promise.resolve({ ok: false, error: '与 AstrBot 桥的连接未建立' });
    }
    const legacy = !this.negotiated.cbp;
    const frame: Record<string, unknown> = legacy
      ? { t: 'send', rid, conv: umoToLegacyConv(umo), text }
      : {
          v: CBP_VERSION,
          t: 'send',
          id: rid,
          ts: Date.now() / 1000,
          rid,
          conv: umo,
          segments: [{ type: 'text', data: { text } }],
        };
    if (opts?.replyTo) frame.replyTo = opts.replyTo;
    return this.requestFrame(rid, frame, SEND_TIMEOUT_MS).then((reply) => {
      const ok = reply.ok === true;
      return {
        ok,
        error: ok ? undefined : String(reply.error ?? '桥拒绝发送'),
        uncertain: ok ? undefined : reply.uncertain === true || reply.t === 'timeout',
      };
    });
  }

  /**
   * 调对端工具；旧桥形 t:'tool'，CBP 形 t:'call'（§3.1）。F3 门序逐字：
   * 连接 → turn → actor 结构 → 上线。CBP 分支 actor 不过 isActor 就不发
   * （结构缺位=坏帧，绝不把缺必填位的 call 推上线；60004 口径 SECURITY-CBP §1.3）。
   * 旧方言面线上无 actor 位，帧表不为它开洞（CHANGELOG F17）。
   */
  callTool(name: string, args: Record<string, unknown>, turn: string, actor: Actor): Promise<ToolCallResult> {
    const rid = `t-${++this.seq}`;
    if (!this.connected) return Promise.resolve({ ok: false, error: '连接未建立' });
    if (!turn) return Promise.resolve({ ok: false, error: '60004 unknown_session: 缺 turn，不能调工具' });
    if (this.negotiated.cbp && !isActor(actor)) {
      return Promise.resolve({ ok: false, error: '60004 unknown_session: actor 未经入站实证，不发 call' });
    }
    const frame: Record<string, unknown> = this.negotiated.cbp
      ? { v: CBP_VERSION, t: 'call', id: rid, ts: Date.now() / 1000, rid, tool: name, args, turn, actor }
      : { t: 'tool', rid, name, args, turn };
    return this.requestFrame(rid, frame, TOOL_TIMEOUT_MS).then((reply) => ({
      ok: reply.ok === true,
      result: typeof reply.result === 'string' ? reply.result : typeof reply.text === 'string' ? reply.text : undefined,
      error: reply.ok === true ? undefined : String(reply.error ?? '桥拒绝了这次工具调用'),
    }));
  }

  private requestFrame(
    rid: string,
    frame: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, error: 'not connected', t: 'timeout' });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        resolve({ ok: false, error: `回执超时（${timeoutMs}ms），结果未知`, uncertain: true, t: 'timeout' });
      }, timeoutMs);
      this.pending.set(rid, { resolve, timer });
      try {
        ws.send(JSON.stringify(frame));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(rid);
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    // 握手 guard：对端只接受 TCP、不回 Upgrade 时靠它收尾（先例 driver.ts:388-402 的理由）。
    const guard = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== WebSocket.OPEN) ws.terminate();
    }, HANDSHAKE_TIMEOUT_MS + HANDSHAKE_GUARD_EXTRA_MS);
    guard.unref?.();
    ws.on('error', () => {
      // close 事件随后到；不在 error 上抛，避免 uncaughtException 把宿主带下去（硬规则 3）。
    });
    ws.on('close', () => {
      clearTimeout(guard);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.rejectAllPending('连接断开');
      this.h.onState(false);
      if (!this.stopped) this.scheduleReconnect();
    });
    ws.on('open', () => {
      if (this.ws !== ws || this.stopped) {
        ws.terminate();
        return;
      }
      this.backoffMs = this.opts.reconnectBaseMs;
      this.lastActivity = Date.now();
      // 握手帧：CBP 头 ∪ 旧私有帧字段。旧桥只认 t==='hello' + token
      //（37c1e6ccd bridge.py:330-341：首帧非 hello → close 4002；token 不符 → 4003）。
      this.rawSend({
        v: CBP_VERSION,
        v_support: [CBP_VERSION],
        t: 'hello',
        id: `h-${++this.seq}`,
        ts: Date.now() / 1000,
        agent: this.opts.agent,
        caps: this.opts.caps,
        tools: this.opts.tools,
        token: this.opts.token,
        name: 'Cortico',
        capabilities: {},
      });
      this.h.onState(true);
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (!this.connected) return;
        if (Date.now() - this.lastActivity > IDLE_TIMEOUT_MS) {
          this.opts.log.warn('AstrBot 桥超 120s 无往来，判死重连');
          this.ws?.terminate();
          return;
        }
        this.rawSend({ t: 'tick' });
      }, HEARTBEAT_MS);
    });
    ws.on('message', (data: WebSocket.RawData) => {
      this.lastActivity = Date.now();
      this.handleFrame(String(data));
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
  }

  private rawSend(frame: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      this.opts.log.warn('帧发送失败', { error: String(err) });
    }
  }

  private handleFrame(raw: string): void {
    const frame = parseFrame(raw);
    if (!frame) {
      this.opts.log.warn('AstrBot 桥送来无法解析的帧，已忽略');
      return;
    }
    try {
      this.handleFrameUnsafe(frame);
    } catch (err) {
      this.opts.log.error('AstrBot 桥帧处理异常', { error: String(err) });
    }
  }

  private handleFrameUnsafe(frame: Record<string, unknown>): void {
    const t = typeof frame.t === 'string' ? frame.t : '';
    if (t === 'tick') return;
    if (t === 'ready') {
      const peer = frame as unknown as ReadyFrame;
      const n = negotiateVersions(
        [CBP_VERSION],
        readVersionSupport(frame),
        this.opts.agent,
        { name: 'cortico-bridge-astrbot', version: typeof peer.v === 'number' ? `v${peer.v}` : 'legacy', sha: '' },
      );
      if (!n.ok || n.version === undefined) {
        this.opts.log.error(`CBP 版本门禁断开：${n.message}`);
        this.ws?.close(1002, String(n.message ?? '60001').slice(0, 120));
        return;
      }
      const admins = Array.isArray(frame.admins) ? frame.admins : [];
      this.negotiated = {
        cbp: Array.isArray(frame.caps),
        version: n.version,
        caps: intersectCaps(this.opts.caps, readCaps(frame)),
        self: peer.self,
        tools: Array.isArray(peer.tools) ? (peer.tools as ToolAnn[]) : [],
        ownerIds: admins.map((x) => String(x).trim()).filter((x) => x !== ''),
        tts: normalizeTts(frame.tts),
      };
      this.h.onReady(this.negotiated);
      return;
    }
    if (t === 'msg') {
      const cbpShape = typeof frame.conv === 'string';
      const converted = cbpShape ? (frame as unknown as MsgFrame) : legacyMsgToCbp(frame);
      if (converted) this.h.onMsg(converted);
      else this.opts.log.warn('msg 帧形状不符，已忽略');
      return;
    }
    if (t === 'notice') {
      const notice = frame as unknown as NoticeFrame;
      this.h.onNotice(notice);
      return;
    }
    if (t === 'event') {
      this.h.onEvent(frame as unknown as EventFrame);
      return;
    }
    if (t === 'catalog') {
      this.h.onCatalog((frame as unknown as CatalogFrame).tools ?? []);
      return;
    }
    if (t === 'tools') {
      // 旧桥的清单帧（4725feee6 driver.ts:581-605：items[{name,risk,desc,sig}]）→ ToolAnn[]。
      const items = Array.isArray(frame.items) ? frame.items : [];
      const ann: ToolAnn[] = [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const name = typeof rec.name === 'string' ? rec.name.trim() : '';
        if (!name) continue;
        ann.push({
          name,
          risk: rec.risk === 'write' || rec.risk === 'exec' ? 'write' : 'read',
          confirm_required: rec.risk === 'write' || rec.risk === 'exec',
          description: typeof rec.desc === 'string' ? rec.desc : undefined,
        });
      }
      this.h.onCatalog(ann);
      return;
    }
    if (t === 'ack' || t === 'reply' || t === 'tool-ack') {
      const rid = typeof frame.rid === 'string' ? frame.rid : '';
      const p = this.pending.get(rid);
      if (!p) return;
      this.pending.delete(rid);
      clearTimeout(p.timer);
      p.resolve(frame);
      return;
    }
    this.opts.log.debug('未知帧类型，已忽略', { t });
  }

  private rejectAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: reason, uncertain: true, t: 'timeout' });
    }
    this.pending.clear();
  }
}

/** tts 两形兼容：旧桥 bool、新桥 {ready, provider}（4725feee6 driver.ts:617-628）。 */
function normalizeTts(raw: unknown): { ready: boolean; provider?: string } {
  if (typeof raw === 'boolean') return { ready: raw };
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    return {
      ready: rec.ready === true,
      provider: typeof rec.provider === 'string' && rec.provider ? rec.provider : undefined,
    };
  }
  return { ready: false };
}
