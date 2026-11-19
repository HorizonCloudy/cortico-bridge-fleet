/**
 * CBP transport, dual role (blueprint §2.1 transport row). The one runtime dependency is
 * `ws` (§1.3-1: Node ships a WS client but no server, so the reverse role needs it too);
 * the 311-line qq-lite two-role driver is the implementation baseline (driver.ts:22
 * mode:'reverse'|'forward' @f908b0357).
 *
 * Timing table, verbatim from the astrbot prior art (4725feee6): backoff 1000ms ×2 capped
 * 30000ms; handshake timeout 10s + 2s terminate guard; ping every 20s; a link silent for
 * 120s is declared dead and rebuilt. `start()` never rejects — bind failures and dial
 * failures surface through onState + counters, not the promise.
 */
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import {
  parseFrame,
  encodeFrame,
  newHead,
  type Actor,
  type Frame,
  type HelloFrame,
  type ReadyFrame,
  type SelfDecl,
  type ToolAnn,
} from './frames.js';
import { RET, err } from './errors.js';
import { checkVersion, intersectCaps, type AgentId } from './negotiate.js';
import { PINS, loadPins } from './pins.js';
import { PendingTable, TurnLedger } from './correlate.js';
import { TtlDedup } from './dedup.js';
import { RidReplyCache } from './idempotency.js';
import { redactJson, redactText } from './redact.js';

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30000;
export const HANDSHAKE_TIMEOUT_MS = 10000;
export const HANDSHAKE_GUARD_MS = 2000;
export const PING_INTERVAL_MS = 20000;
export const IDLE_TIMEOUT_MS = 120000;
export const CALL_TIMEOUT_MS = 30000;

export type DriverRole = 'dial' | 'listen';

export interface DriverState {
  role: DriverRole;
  connected: boolean;
  peersReady: number;
  lastError?: string;
}

export interface DriverCounters {
  framesIn: number;
  framesOut: number;
  framesBad: number;
  dupsDropped: number;
  reconnectScheduled: number;
  handshakeFailed: number;
  listenErrors: number;
}

export interface DriverOptions {
  role: DriverRole;
  /** dial only: ws:// URL of the peer. */
  url?: string;
  /** listen only. */
  host?: string;
  port?: number;
  path?: string;
  /** identity announced in hello/ready. */
  agent: AgentId;
  /** F1/F2: our own account declaration, announced in the first handshake frame; no default. */
  self: SelfDecl;
  caps: string[];
  tools: ToolAnn[];
  /**
   * REQUIRED shared secret. 2026-11-19 hardening (11-13 判例 elymes-nte-web): a
   * loopback WebSocket is NOT private — any web page in the user's browser can open
   * ws://127.0.0.1:<port> because WebSocket has no same-origin preflight. So the old
   * "loopback needs no key" default is gone: both roles refuse to start without a
   * non-empty token. It rides ONLY the HTTP Upgrade header `Authorization: Bearer
   * <token>` — never a URL query, never a frame field (_BUILD-PLAN §3.1 hard rule).
   * listen closes any socket whose query carries `token`/`access_token` (4401,
   * refused before comparison), any socket whose header is missing or wrong (4401),
   * and any socket whose `Origin` is a non-loopback web origin (4401); dial sends the
   * header. Supply it from `ctx.secret('CORTICO_BRIDGE_TOKEN')` on the host side and
   * the same env var on the framework side — never from a config panel.
   */
  authToken: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  handshakeTimeoutMs?: number;
  pingIntervalMs?: number;
  idleTimeoutMs?: number;
  /** dedupe inbound msg frames by conv+message_id. default true. */
  dedupeInbound?: boolean;
  /**
   * WS frame byte cap. Default is the pins read `caps.cbp.frame_bytes` (F13 §4.4) —
   * the 100 MiB `ws` default is never acceptable. Tests may lower it; raising above the
   * pinned cap would violate the single source, so nothing in-tree does.
   */
  maxPayloadBytes?: number;
  onFrame?: (f: Frame) => void;
  onState?: (s: DriverState) => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface Peer {
  ws: WebSocket;
  hello: HelloFrame | ReadyFrame | null;
  /** peer-announced caps, kept for the effective-caps intersection (self_echo removed on caps-lie). */
  caps: string[];
  /** peer-declared account identity from its handshake frame (F1/F2). */
  self: SelfDecl | null;
  /** tools the peer declared in its handshake frame. A later catalog frame supersedes it in the
   *  consumer's own copy; here it stays the handshake record so a bridge that never sends one is
   *  still visible (CBP-v1.json:499 accepts ready/catalog). */
  tools: ToolAnn[];
  /** msg ids seen on this connection — the bridge-side record a call's turn resolves against. */
  turns: TurnLedger;
  ready: boolean;
  lastSeen: number;
}

/** Loopback hosts, verbatim from SECURITY-CBP §3 rule 2. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** Shared secret from the HTTP Upgrade header, `Authorization: Bearer <token>` (§3.1). */
function authHeaderOf(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

/** Name of a credential-bearing query key (`token` / `access_token`) in the request URL. */
function queryTokenKeyOf(req: IncomingMessage): string | null {
  try {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    if (q.has('token')) return 'token';
    if (q.has('access_token')) return 'access_token';
  } catch {
    return null;
  }
  return null;
}

/**
 * 2026-11-19 (11-13 判例): WebSocket handshakes carry `Origin` from browsers and
 * are NOT subject to CORS preflight. A page on any site can dial a loopback port,
 * so we allow only (a) no Origin — native clients such as the Python bridges — and
 * (b) loopback web origins. Everything else is refused before any frame is read.
 * `null` (opaque origin, e.g. file://) and malformed values are refused too.
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

/** Log-safe form: scheme + host only, never a path, query or credential. */
function originHostOf(origin: string): string {
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '<malformed-origin>';
  }
}

export class BridgeDriver {
  readonly counters: DriverCounters = {
    framesIn: 0,
    framesOut: 0,
    framesBad: 0,
    dupsDropped: 0,
    reconnectScheduled: 0,
    handshakeFailed: 0,
    listenErrors: 0,
  };
  readonly pending = new PendingTable();
  readonly dedup = new TtlDedup();
  readonly idem = new RidReplyCache();
  private readonly opts: Required<Pick<DriverOptions, 'reconnectBaseMs' | 'reconnectMaxMs' | 'handshakeTimeoutMs' | 'pingIntervalMs' | 'idleTimeoutMs' | 'dedupeInbound'>> & DriverOptions;
  private server: WebSocketServer | undefined;
  private client: WebSocket | undefined;
  private readonly peers = new Set<Peer>();
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private backoffMs: number;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private connected = false;

  constructor(options: DriverOptions) {
    this.opts = {
      dedupeInbound: true,
      reconnectBaseMs: RECONNECT_BASE_MS,
      reconnectMaxMs: RECONNECT_MAX_MS,
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      pingIntervalMs: PING_INTERVAL_MS,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      ...options,
    };
    this.backoffMs = this.opts.reconnectBaseMs;
  }

  /** Resolves once the transport has started; never rejects (prior-art rule: start() 永不 reject). */
  async start(): Promise<void> {
    if (this.opts.role === 'listen') {
      await this.listen();
    } else {
      this.dial();
    }
    this.startPingLoop();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pending.closeAll(err(RET.PEER_UNREACHABLE, 'driver stopped'));
    // close() only works on an OPEN/CLOSING socket; a CONNECTING one would keep
    // retrying and hold the event loop, so those get terminate().
    const hard = (ws: WebSocket) => {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) ws.close();
        else ws.terminate();
      } catch {
        /* already gone */
      }
    };
    for (const p of this.peers) hard(p.ws);
    this.peers.clear();
    if (this.client) hard(this.client);
    this.server?.close();
    this.emitState();
  }

  /** True when at least one peer has completed the hello/ready handshake. */
  get isReady(): boolean {
    return this.connected;
  }

  /** Caps common to this side and the first ready peer (empty when nobody is connected). */
  effectiveCaps(): string[] {
    const p = [...this.peers].find((x) => x.ready);
    return p ? intersectCaps(this.opts.caps, p.caps) : [];
  }

  /** Tools the first ready peer declared in hello/ready. Empty when nobody is ready.
   *  Worlds union this with any catalog frame they received: hello alone is a valid
   *  announcement, and ignoring it made hello-only bridges refuse every own tool name. */
  peerTools(): ToolAnn[] {
    const p = [...this.peers].find((x) => x.ready);
    return p ? p.tools : [];
  }

  /** First ready peer's declared self — the envelope's echo-suppression input (F1/F2). */
  peerSelf(): SelfDecl | null {
    const p = [...this.peers].find((x) => x.ready);
    return p?.self ?? null;
  }

  /** True when echo suppression may be trusted: some ready peer's self is proven. */
  selfEchoActive(): boolean {
    return this.peerSelf()?.proven === true;
  }

  /** Bound port in listen role (0 before start or when the bind failed). */
  get listenPort(): number {
    const a = this.server?.address();
    return typeof a === 'object' && a ? a.port : 0;
  }

  /** F13: the pinned CBP frame cap, the one value `ws` enforces on both roles. */
  get maxPayloadBytes(): number {
    return this.opts.maxPayloadBytes ?? loadPins().caps.cbp.frame_bytes ?? PINS.caps.cbp.frame_bytes;
  }

  /** Send one frame to every ready peer; false when nobody was reachable (caller maps to 60006). */
  send(frame: Frame): boolean {
    // §5.1: outbound replies feed the rid→reply cache so a redelivered call replays
    // the answer instead of re-running the consumer.
    if (frame.t === 'reply') this.idem.answer(frame.rid, frame);
    const raw = encodeFrame(frame);
    let sent = 0;
    for (const p of this.peers) {
      if (p.ready && p.ws.readyState === WebSocket.OPEN) {
        try {
          p.ws.send(raw);
          sent++;
        } catch {
          /* close handler will sweep */
        }
      }
    }
    if (sent > 0) this.counters.framesOut++;
    return sent > 0;
  }

  /**
   * Out-bound `call` with rid correlation; resolves to the reply frame or rejects with a CbpError.
   * F3: `turn` and `actor` are required. The caller (world/bridge layer) fills them from its own
   * inbound record — host-proven values only; a peer receiving this call treats its local record
   * as truth and reconciles the wire copy.
   */
  async callTool(tool: string, args: Record<string, unknown>, turn: string, actor: Actor): Promise<Frame> {
    const head = newHead('call');
    const key = head.id;
    const p = this.pending.add(key, PendingTable.timeoutError);
    const ok = this.send({ v: 1, t: 'call', id: head.id, ts: head.ts, rid: key, tool, args, turn, actor });
    if (!ok) {
      this.pending.settle({ rid: key }); // drop the reservation
      throw err(RET.PEER_UNREACHABLE, 'no ready peer for call');
    }
    return p;
  }

  private helloFrame(): HelloFrame {
    const head = newHead('hello');
    return {
      ...head,
      t: 'hello',
      v: 1,
      agent: this.opts.agent,
      v_support: [1],
      caps: this.opts.caps,
      tools: this.opts.tools,
      self: this.opts.self,
    };
  }

  private readyFrame(): ReadyFrame {
    const head = newHead('ready');
    return { ...head, t: 'ready', v: 1, caps: this.opts.caps, tools: this.opts.tools, self: this.opts.self };
  }

  /** Kernel-originated reply to one peer only (60004/actor-mismatch/self-churn paths). */
  private sendTo(peer: Peer, frame: Frame): void {
    try {
      peer.ws.send(encodeFrame(frame));
      this.counters.framesOut++;
    } catch {
      /* close handler will sweep */
    }
  }

  private async listen(): Promise<void> {
    const { host = '127.0.0.1', port = 39701, path } = this.opts;
    return new Promise((resolve) => {
      // 2026-11-19 (11-13 判例): NO anonymous door, loopback included. A browser
      // page can reach ws://127.0.0.1 without CORS preflight, so a tokenless
      // listener is a local privilege-escalation surface, not a dev convenience.
      // The old behaviour (loopback = no auth, non-loopback = warn/refuse) is gone.
      if (!this.opts.authToken) {
        this.counters.listenErrors++;
        this.emitState(LOOPBACK_HOSTS.has(host)
          ? 'door_closed: token required'
          : 'door_closed: loopback required');
        resolve();
        return;
      }
      // resolve regardless of outcome: errors surface via counters/onState, never via start()
      let server: WebSocketServer;
      try {
        server = new WebSocketServer({ host, port, path: path || undefined, maxPayload: this.maxPayloadBytes });
      } catch (e) {
        this.counters.listenErrors++;
        this.emitState(String(e));
        resolve();
        return;
      }
      this.server = server;
      server.once('listening', () => {
        this.emitState();
        resolve(); // start() resolves on a successful bind too
      });
      server.once('error', (e) => {
        this.counters.listenErrors++;
        this.emitState(String(e));
        resolve();
      });
      server.on('connection', (ws, req) => {
        const origin = req.headers.origin;
        if (typeof origin === 'string' && origin !== '' && !isLoopbackOrigin(origin)) {
          // 11-13 判例: a foreign web page must never speak to a local bridge.
          // Log the origin host only — never a token, never a full URL.
          this.logLine('origin-refused', { origin: originHostOf(origin) });
          ws.close(4401, 'origin refused');
          return;
        }
        const key = queryTokenKeyOf(req);
        if (key) {
          // §3.1: refuse before any comparison — URLs land in proxy logs and error
          // strings. Log the key name only, never the value.
          this.logLine('query-token-refused', { key });
          ws.close(4401, 'query token refused');
          return;
        }
        // Token is required (enforced at listen()); a missing or wrong header is
        // refused even if a caller somehow got past the bind with an empty secret.
        if (authHeaderOf(req) !== this.opts.authToken) {
          ws.close(4401, 'bad token');
          return;
        }
        this.attach(ws);
      });
      server.on('close', () => {
        this.connected = false;
        this.emitState();
      });
    });
  }

  private dial(): void {
    if (this.stopped || !this.opts.url) return;
    // 2026-11-19 hard gate: never open an anonymous socket, even to loopback.
    // start() still never rejects — the refusal surfaces through onState/counters.
    if (!this.opts.authToken) {
      this.emitState('dial_refused: token required');
      return;
    }
    let ws: WebSocket;
    try {
      // §3.1: the secret rides the Upgrade header only — never appended to the URL.
      const headers = { authorization: `Bearer ${this.opts.authToken}` };
      // F13 §4.4: both roles carry the pinned frame cap; the 100 MiB ws default is a hole.
      ws = new WebSocket(this.opts.url, { maxPayload: this.maxPayloadBytes, headers });
    } catch (e) {
      this.emitState(String(e));
      this.scheduleReconnect();
      return;
    }
    this.client = ws;
    ws.on('open', () => {
      if (this.stopped || this.client !== ws) return;
      this.backoffMs = this.opts.reconnectBaseMs;
      // attach the frame handlers first so the peer's ready cannot land in the gap,
      // then send hello; the peer answers ready and the handshake completes.
      this.attach(ws);
      try {
        ws.send(encodeFrame(this.helloFrame()));
        this.counters.framesOut++;
      } catch {
        /* close will reconnect */
      }
    });
    ws.on('error', (e) => this.emitState(String(e)));
    ws.on('close', () => {
      if (this.client === ws) {
        this.client = undefined;
        this.scheduleReconnect();
      }
    });
  }

  private attach(ws: WebSocket): Peer {
    const peer: Peer = { ws, hello: null, caps: [], self: null, tools: [], turns: new TurnLedger(), ready: false, lastSeen: Date.now() };
    this.peers.add(peer);
    ws.on('message', (data) => {
      peer.lastSeen = Date.now();
      this.handleRaw(peer, String(data));
    });
    ws.on('ping', () => {
      peer.lastSeen = Date.now();
    });
    ws.on('pong', () => {
      peer.lastSeen = Date.now();
    });
    ws.on('close', (code) => {
      if (code === 1009) {
        // F13: over-limit is a transport fact, not a CBP code. Count it and tell the
        // consumer — the peer is gone, so the degraded note rides the local frame sink.
        this.counters.framesBad++;
        this.opts.onFrame?.({
          ...newHead('event'),
          t: 'event',
          v: 1,
          name: 'degraded',
          data: { reason: 'frame-over-limit' },
        });
      }
      this.peers.delete(peer);
      this.refreshConnected();
    });
    ws.on('error', () => {
      /* close follows */
    });
    // One handshake guard covers both roles: neither side is usable until the peer's
    // hello/ready lands, so if peer.ready is still false past the window, drop the
    // socket and let the close handler (dial) reschedule or the peer reconnect (listen).
    const guard = setTimeout(() => {
      if (!peer.ready) {
        this.counters.handshakeFailed++;
        try {
          ws.terminate();
        } catch {
          /* already dead */
        }
      }
    }, this.opts.handshakeTimeoutMs + HANDSHAKE_GUARD_MS);
    guard.unref?.();
    ws.once('close', () => clearTimeout(guard));
    return peer;
  }

  private handleRaw(peer: Peer, raw: string): void {
    const frame = parseFrame(raw);
    if (!frame) {
      this.counters.framesBad++; // swallow bad frames — prior-art hard rule
      return;
    }
    this.counters.framesIn++;
    if (frame.t === 'hello' || frame.t === 'ready') {
      this.onHandshakeFrame(peer, frame as HelloFrame | ReadyFrame);
      return;
    }
    if (frame.t === 'tick') return; // liveness already noted
    if (frame.t === 'msg') peer.turns.record(frame); // turn anchor for later calls on this connection
    if (frame.t === 'call') {
      // §5.1: call.rid is the idempotency key. A redeliver after the answer replays the
      // cache; a duplicate while the first is still running is swallowed (that answer
      // will settle the caller either way). In-process window only — no cross-restart
      // ledger promised (§6-3).
      const cached = this.idem.answerFor(frame.rid);
      if (cached) {
        this.send(cached);
        return;
      }
      // F3: identity comes from the bridge-side record only. Unknown/expired turn is
      // refused here — structural fields were already enforced by parseFrame.
      const rec = peer.turns.lookup(frame.turn);
      if (!rec) {
        this.sendTo(peer, {
          ...newHead('reply'),
          t: 'reply',
          v: 1,
          rid: frame.rid,
          ok: false,
          error: err(RET.UNKNOWN_SESSION, `unknown_session: turn ${frame.turn} has no inbound record`),
        });
        return;
      }
      if (!this.idem.claim(frame.rid)) return;
      if (rec.conv !== frame.actor.conv || rec.senderId !== frame.actor.member.id) {
        // §1: host record wins. One degraded note, to the local consumer — the world
        // surfaces `<w>.degraded`; the caller learns the truth through the corrected
        // execution and its reply. No second copy of the fact (CHANGELOG §5 line 230).
        this.opts.onFrame?.({
          ...newHead('event'),
          t: 'event',
          v: 1,
          name: 'degraded',
          data: { reason: 'actor-mismatch', turn: frame.turn },
        });
      }
      // The consumer never sees a self-reported identity: conv/member/anon are rebuilt
      // from the inbound record. platform stays as reported — the kernel cannot verify it.
      frame.actor = {
        platform: frame.actor.platform,
        conv: rec.conv,
        member: { id: rec.senderId, name: rec.senderName },
        anon: this.opts.self.id === rec.senderId ? 'self' : frame.actor.anon === 'self' ? 'identified' : frame.actor.anon,
      };
    }
    if (frame.t === 'reply' || frame.t === 'ack') {
      if (this.pending.settle(frame)) return;
      // unmatched reply/ack still goes to the consumer; a peer may be answering our id.
      // ack means inbound receipt only (§5.1): it never certifies an outbound delivery.
    }
    if (frame.t === 'msg' && this.opts.dedupeInbound && this.dedup.check(TtlDedup.keyForMsg(frame))) {
      this.counters.dupsDropped++;
      return;
    }
    this.opts.onFrame?.(frame);
  }

  private onHandshakeFrame(peer: Peer, frame: HelloFrame | ReadyFrame): void {
    // F1/F2 timing (§2.3): self.id may not change inside one connection — that is churn.
    if (peer.self !== null && peer.self.id !== frame.self.id) {
      this.sendTo(peer, {
        ...newHead('event'),
        t: 'event',
        v: 1,
        name: 'degraded',
        data: { reason: 'self-churn' },
      });
      this.logLine('self-churn: handshake dropped', { peer: peer.self.id });
      return; // swallow the frame; account changes need a reconnect
    }
    let caps = frame.caps;
    // F1/F2 (§2.3-4): self_echo co-exists with proven:true only. A lie drops the cap,
    // not the connection.
    if (caps.includes('self_echo') && frame.self.proven !== true) {
      caps = caps.filter((c) => c !== 'self_echo');
      this.sendTo(peer, {
        ...newHead('event'),
        t: 'event',
        v: 1,
        name: 'degraded',
        data: { reason: 'self-echo:caps-lie' },
      });
    }
    if (this.opts.role === 'listen' && frame.t === 'hello') {
      const neg = checkVersion(frame, this.opts.agent);
      if (neg) {
        try {
          peer.ws.send(encodeFrame({ ...newHead('event'), t: 'event', v: 1, name: 'degraded', data: neg }));
        } catch {
          /* peer already gone */
        }
        peer.ws.close(4402, 'version mismatch');
        return;
      }
      peer.hello = frame;
      peer.caps = caps; // intersection is computed on demand by effectiveCaps()
      peer.self = frame.self;
      peer.tools = frame.tools;
      try {
        peer.ws.send(encodeFrame(this.readyFrame()));
        this.counters.framesOut++;
      } catch {
        /* close follows */
      }
    } else if (this.opts.role === 'dial' && frame.t === 'ready') {
      peer.hello = frame;
      peer.caps = caps;
      peer.self = frame.self;
      peer.tools = frame.tools;
    } else {
      return; // wrong-side handshake: not applicable, ignore
    }
    const wasReady = peer.ready;
    peer.ready = true;
    this.refreshConnected();
    // §2.4 explicit degradation: an unproven self never suppresses echo, and the world
    // must see that fact instead of a silent 「no self」. One note per connection.
    if (!wasReady && frame.self.proven !== true) {
      this.opts.onFrame?.({
        ...newHead('event'),
        t: 'event',
        v: 1,
        name: 'degraded',
        data: { reason: 'self-unknown' },
      });
    }
  }

  private refreshConnected(): void {
    const any = [...this.peers].some((p) => p.ready);
    if (any !== this.connected) {
      this.connected = any;
      if (!any) this.pending.closeAll(err(RET.PEER_UNREACHABLE, 'connection closed with calls in flight'));
      this.emitState();
    }
  }

  private startPingLoop(): void {
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      for (const p of this.peers) {
        if (now - p.lastSeen > this.opts.idleTimeoutMs) {
          try {
            p.ws.terminate(); // silence 120s = declared dead, rebuild
          } catch {
            /* sweep on close */
          }
          continue;
        }
        if (p.ws.readyState === WebSocket.OPEN) {
          try {
            p.ws.ping();
            this.send({ ...newHead('tick'), t: 'tick', v: 1 });
          } catch {
            /* next tick decides */
          }
        }
      }
    }, this.opts.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.opts.role !== 'dial' || this.reconnectTimer) return;
    this.counters.reconnectScheduled++;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.dial();
    }, delay);
    this.reconnectTimer.unref?.();
    this.emitState();
  }

  private emitState(lastError?: string): void {
    this.opts.onState?.({
      role: this.opts.role,
      connected: this.connected,
      peersReady: [...this.peers].filter((p) => p.ready).length,
      // §3 rule 2: state strings leave the driver redacted (emitState(String(e)) paths).
      lastError: lastError === undefined ? undefined : redactText(lastError),
    });
  }

  /** The one log exit: §3 rule 2 keeps token values and query-bearing URLs out of logs. */
  private logLine(msg: string, extra?: Record<string, unknown>): void {
    this.opts.log?.(redactText(msg), extra ? redactJson(extra) : undefined);
  }
}
