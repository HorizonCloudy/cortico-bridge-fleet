/**
 * rid/echo correlation: the in-flight table for call→reply and msg→ack, plus the app-level
 * tick heartbeat. The table is a TTL map capped at 200 (same shape as the dedup map,
 * telegram world.ts:361-372 @6bc05cb0e; cap rule _BUILD-PLAN §2.2 「correlate.ts rid↔Promise，TTL 200」).
 * Onebot-style HTTP reports bring their own `echo` token instead of a rid
 * (r-nonebot §3.4 `{action,params,echo}`) — that string keys the same table.
 */
import type { AckFrame, MsgFrame, ReplyFrame } from './frames.js';
import { RET, err, type CbpError } from './errors.js';
import { DEDUP_MAX } from './dedup.js';
import { effectiveTurnTtlSeconds } from './pins.js';

export const PENDING_MAX = 200;
export const PENDING_TTL_MS = 30_000;

export interface PendingEntry {
  resolve: (v: ReplyFrame | AckFrame) => void;
  reject: (e: CbpError) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  expiresAt: number;
}

export class PendingTable {
  private readonly map = new Map<string, PendingEntry>();
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(max = PENDING_MAX, ttlMs = PENDING_TTL_MS) {
    this.max = max;
    this.ttlMs = ttlMs;
  }

  get size(): number {
    return this.map.size;
  }

  /** Reserve a key; rejects with 60006 if the key is already in flight. */
  add(key: string, onTimeout?: (key: string) => CbpError): Promise<ReplyFrame | AckFrame> {
    if (this.map.has(key)) {
      return Promise.reject(err(RET.PEER_UNREACHABLE, `duplicate in-flight key ${key}`));
    }
    let entry: PendingEntry;
    const p = new Promise<ReplyFrame | AckFrame>((resolve, reject) => {
      entry = { resolve, reject, timer: undefined, expiresAt: Date.now() + this.ttlMs };
    });
    // settle-by-timeout is optional so tests can drive expiry manually
    if (onTimeout !== undefined) {
      entry!.timer = setTimeout(() => {
        const e = this.map.get(key);
        if (e) {
          this.map.delete(key);
          e.reject(onTimeout(key));
        }
      }, this.ttlMs);
      entry!.timer.unref?.();
    }
    this.map.set(key, entry!);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.drop(oldest, err(RET.PEER_UNREACHABLE, 'in-flight table overflow, oldest dropped'));
    }
    return p;
  }

  /** Resolve a reply/ack frame by its rid; returns false when nothing was waiting. */
  settle(frame: { rid: string }): boolean {
    const e = this.map.get(frame.rid);
    if (!e) return false;
    this.map.delete(frame.rid);
    if (e.timer) clearTimeout(e.timer);
    e.resolve(frame as ReplyFrame | AckFrame);
    return true;
  }

  private drop(key: string, reason: CbpError): void {
    const e = this.map.get(key);
    if (!e) return;
    this.map.delete(key);
    if (e.timer) clearTimeout(e.timer);
    e.reject(reason);
  }

  /** Reject everything (driver closed) — 60006 per row, caller re-sends after reconnect. */
  closeAll(reason?: CbpError): void {
    const keys = [...this.map.keys()];
    for (const k of keys) this.drop(k, reason ?? err(RET.PEER_UNREACHABLE, 'connection closed with calls in flight'));
  }

  /** Default timeout error for a send whose reply never arrived: outcome uncertain. */
  static timeoutError(key: string): CbpError {
    return err(RET.SEND_UNCERTAIN, `no reply for ${key} inside timeout, delivery uncertain`);
  }
}

/**
 * Turn ledger: msg id → the inbound record a call's `turn` must resolve against
 * (SECURITY-CBP §1: the bridge identifies the operator only from its own record; the
 * wire actor is reconciliation material). Same TTL map discipline as dedup, separate window.
 * The window is the single-source turn retention window (工单二 F2): spec/CBP-v1.json
 * $defs/turnWindow → gen_pins.py → spec/pins.json → pins.ts, with the
 * CORTICO_TURN_TTL_SECONDS env override applied at construction. It is NOT the dedup TTL
 * (dedup.ts:14, 10 minutes) and NOT the rid reply cache (idempotency.ts, §5.1) — the old
 * shortcut that borrowed DEDUP_TTL_MS here is cleared by that batch.
 */
export interface TurnRecord {
  conv: string;
  senderId: string;
  senderName: string;
}

export class TurnLedger {
  private readonly map = new Map<string, { rec: TurnRecord; at: number }>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(max = DEDUP_MAX, ttlMs = effectiveTurnTtlSeconds().ttlSeconds * 1000, now: () => number = Date.now) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  record(msg: Pick<MsgFrame, 'id' | 'conv' | 'sender'>): void {
    this.prune();
    this.map.set(msg.id, {
      rec: { conv: msg.conv, senderId: msg.sender.id, senderName: msg.sender.name },
      at: this.now(),
    });
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  lookup(id: string): TurnRecord | null {
    this.prune();
    return this.map.get(id)?.rec ?? null;
  }

  get size(): number {
    this.prune();
    return this.map.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, e] of this.map) {
      if (t - e.at > this.ttlMs) this.map.delete(k);
    }
  }
}

/** tick bookkeeping: a peer that stops ticking past the window is dead (driver decides). */
export class TickWatch {
  private last = 0;
  private readonly timeoutMs: number;
  private readonly clock: () => number;

  constructor(timeoutMs = 120_000, now: () => number = Date.now) {
    this.timeoutMs = timeoutMs;
    this.clock = now;
  }

  start(): void {
    this.last = this.clock();
  }
  note(now = this.clock()): void {
    this.last = now;
  }
  dead(now = this.clock()): boolean {
    return now - this.last > this.timeoutMs;
  }
}
