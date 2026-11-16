/**
 * TTL dedup map. Shape and prune-then-evict-oldest discipline are from the telegram
 * prior art (cortico-world-telegram src/world.ts:361-372 @6bc05cb0e); the 200-entry
 * cap is the kernel rule (_BUILD-PLAN §2.2 dedup row: 「TTL Map 去重上限 200」).
 *
 * The onebot prior art did not dedup at all (m-effort-risk §7.1) — NapCat-style
 * resend double-posts are a known dialect behaviour, so this is the kernel's hole fix.
 * `dedupe_key` has an external-injection slot: MaiBot's route_message form already
 * takes a `dedupe_key` param (r-maibot §3 alias signature) and the bridge hands that
 * value in instead of computing one.
 */
export const DEDUP_MAX = 200;
/** Matches the telegram prior art's window (10 minutes). */
export const DEDUP_TTL_MS = 10 * 60_000;

export interface DedupOptions {
  max?: number;
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class TtlDedup {
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** Insertion-ordered Map: JS Map keeps key order, so keys().next() is the oldest. */
  private readonly seen = new Map<string, number>();

  constructor(opts: DedupOptions = {}) {
    this.max = opts.max ?? DEDUP_MAX;
    this.ttlMs = opts.ttlMs ?? DEDUP_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Prune every entry older than the TTL. */
  private prune(): void {
    const t = this.now();
    for (const [k, at] of this.seen) {
      if (t - at > this.ttlMs) this.seen.delete(k);
    }
  }

  /**
   * True if `key` was already seen inside the window. Records it otherwise.
   * An empty/undefined key is never a duplicate (the caller had no id to offer).
   */
  check(key: string | null | undefined): boolean {
    if (!key) return false;
    this.prune();
    if (this.seen.has(key)) {
      this.seen.set(key, this.now()); // seen again → extend the window
      return true;
    }
    this.seen.set(key, this.now());
    if (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
  }

  /** Non-committing probe. */
  has(key: string): boolean {
    this.prune();
    return this.seen.has(key);
  }

  get size(): number {
    this.prune();
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
  }

  /**
   * Default key for a msg frame: conv + platform message id when present, else the
   * CBP frame id (frame ids are fresh per send, so a same-frame redeliver — the WS
   * layer replaying a buffer — still lands on one key via the id).
   */
  static keyForMsg(f: { conv: string; id: string; raw?: unknown }): string {
    const raw = f.raw;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const mid = (raw as Record<string, unknown>).message_id;
      if (mid !== undefined && mid !== null && mid !== '') return `${f.conv}|${mid}`;
    }
    return `${f.conv}|${f.id}`;
  }
}
