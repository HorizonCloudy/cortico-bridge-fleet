/**
 * rid→reply cache for inbound `call` frames (SECURITY-CBP §5.1, CHANGELOG F11): the
 * outbound idempotency key is `call.rid`; a redelivered rid is answered from the cache
 * and the consumer side effect never runs twice. Window is the prior art verbatim —
 * TTL 300 s, cap 200 (bridge.py:65-66 @37c1e6ccd).
 *
 * shortcut: the cache is in-process only. A restart inside the window lets a redeliver
 * re-execute (§6-3: no exactly-once promised); upgrade needs a persisted ledger, not scheduled for v1.
 */
import type { ReplyFrame } from './frames.js';

export const IDEM_MAX = 200;
export const IDEM_TTL_MS = 300_000;

export interface IdemOptions {
  max?: number;
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class RidReplyCache {
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** Insertion-ordered Map, same prune-then-evict-oldest discipline as TtlDedup. */
  private readonly map = new Map<string, { reply?: ReplyFrame; at: number }>();

  constructor(opts: IdemOptions = {}) {
    this.max = opts.max ?? IDEM_MAX;
    this.ttlMs = opts.ttlMs ?? IDEM_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, v] of this.map) {
      if (t - v.at > this.ttlMs) this.map.delete(k);
    }
  }

  /** Cached answer for a redelivered rid; undefined when nothing has answered yet. */
  answerFor(rid: string): ReplyFrame | undefined {
    this.prune();
    return this.map.get(rid)?.reply;
  }

  /** True → rid is fresh and now marked in flight; false → duplicate, swallow it. */
  claim(rid: string): boolean {
    this.prune();
    const cur = this.map.get(rid);
    if (cur) {
      cur.at = this.now(); // seen again → extend the window (TtlDedup rule)
      return false;
    }
    this.map.set(rid, { at: this.now() });
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return true;
  }

  /** Remember the answer so a later redelivery replays it instead of re-executing. */
  answer(rid: string, reply: ReplyFrame): void {
    const existed = this.map.has(rid);
    this.map.set(rid, { reply, at: this.now() });
    if (!existed && this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get size(): number {
    this.prune();
    return this.map.size;
  }
}
