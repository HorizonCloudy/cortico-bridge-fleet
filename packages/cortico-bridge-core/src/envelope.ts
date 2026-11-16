/**
 * msg/notice frames → Cortico-side event envelope. The envelope shape mirrors
 * cortico EventEnvelope verbatim (src/core/types.ts:30-67, PushOptions :630-635,
 * TriggerMode :612-628, all @836238311 — d-cortico-side §2.1). The kernel does not
 * import cortico; these are the literal unions copied with their source lines.
 *
 * Mapping table is _BUILD-PLAN §3.2 (the work-order authority):
 *   msg mention/direct        → <w>.message  trigger flush
 *   msg group/other           → <w>.message  host default (debounce, types.ts:633)
 *   msg self echo             → <w>.message  deliver:false + archive-only (只归档)
 *   notice                    → <w>.notice   trigger piggyback
 * meta keeps {conv,sender,kind,platformMsgId,raw}; `raw` is always present but in its
 * credential-redacted form (SECURITY-CBP §3.4 turns prior-art hard rule 8 「original
 * payload never dropped」 into 「the stripped original payload is kept」).
 */
import type { MsgFrame, NoticeFrame, Seg, SelfDecl } from './frames.js';
import { frameTsToIso } from './frames.js';
import { redactJson } from './redact.js';

/** Verbatim cortico types.ts:612-628 @836238311. */
export type TriggerMode = 'preempt' | 'interrupt' | 'flush' | 'debounce' | 'piggyback';
/** Verbatim cortico types.ts:16 @836238311. */
export type EventOrigin = 'external' | 'internal';
/** Verbatim cortico types.ts:47 @836238311. */
export type ContextDelivery = 'deliver' | 'archive-only';

/** Attachment handed to the host; the world normalize layer produces these, not the frame. */
export interface BlobInput {
  mime: string;
  name?: string;
  fallbackText: string;
  bytes?: Uint8Array;
  b64?: string;
  handle?: string;
}

/** pushEvent input mirror (cortico types.ts:693 — cursor/origin/contextDelivery are host-side). */
export interface EventEnvelopeLike {
  type: string;
  /** ISO 8601 with offset, from the frame float-seconds ts. */
  ts: string;
  source: string;
  origin?: EventOrigin;
  text: string;
  senderKey?: string;
  meta?: Record<string, unknown>;
  contextDelivery?: ContextDelivery;
  blobs?: BlobInput[];
}

/** Verbatim cortico types.ts:630-635 @836238311. */
export interface PushOptionsLike {
  deliver?: boolean;
  trigger?: TriggerMode;
}

/**
 * Explicit event-name table (blueprint §2.3: names come from this fixed suffix map,
 * never by parsing the worldId — the three prior bridges each invented their own
 * marker key, d-bridge-priorart §6.1/§8.7).
 */
export const EVENT_SUFFIXES = {
  message: '.message',
  notice: '.notice',
  connection: '.connection',
  degraded: '.degraded',
} as const;

export function eventNamesFor(worldId: string): Record<keyof typeof EVENT_SUFFIXES, string> {
  return {
    message: `${worldId}${EVENT_SUFFIXES.message}`,
    notice: `${worldId}${EVENT_SUFFIXES.notice}`,
    connection: `${worldId}${EVENT_SUFFIXES.connection}`,
    degraded: `${worldId}${EVENT_SUFFIXES.degraded}`,
  };
}

/** Frame seconds (float64) → ISO string, the §3.1 header rule. */
export function tsToIso(tsSeconds: number): string {
  return frameTsToIso(tsSeconds);
}

export interface EnvelopeOptions {
  worldId: string;
  /**
   * F1/F2: the peer's self declaration, supplied from its hello/ready handshake.
   * Echo suppression is honored only when proven:true; an unproven declaration
   * delivers normally and degrades explicitly (SECURITY-CBP §2.4).
   */
  self?: SelfDecl;
  /** Deployment fallback used only when no negotiated self exists at all (impl list row 9). */
  selfId?: string;
  /** Optional already-rendered text; default = caller renders segments via segment.ts. */
  render?: (segs: Seg[]) => string;
  /** Attachments the world normalize layer extracted (image bytes, file handles). */
  blobs?: BlobInput[];
}

function platformMsgIdFromRaw(raw: unknown): string | undefined {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const v = (raw as Record<string, unknown>).message_id;
    if (typeof v === 'string' || typeof v === 'number') return String(v);
  }
  return undefined;
}

/** msg frame → envelope + push options, per the §3.2 tier table. */
export function msgToEnvelope(frame: MsgFrame, opts: EnvelopeOptions): {
  envelope: EventEnvelopeLike;
  push: PushOptionsLike;
  /** §2.4: no usable self — the world must surface `<w>.degraded` reason self-unknown. */
  degraded?: { reason: 'self-unknown' };
} {
  const names = eventNamesFor(opts.worldId);
  let isSelf = false;
  let degraded: { reason: 'self-unknown' } | undefined;
  if (opts.self !== undefined) {
    // proven:true is the only self that may suppress; proven:false delivers normally and
    // says so — silent suppression failure and silent archive-all are both forbidden (§2.4).
    if (opts.self.proven === true) isSelf = frame.sender.id === opts.self.id;
    else degraded = { reason: 'self-unknown' };
  } else if (opts.selfId !== undefined) {
    isSelf = frame.sender.id === opts.selfId; // config fallback, row 9
  } else {
    degraded = { reason: 'self-unknown' };
  }
  const envelope: EventEnvelopeLike = {
    type: names.message,
    ts: tsToIso(frame.ts),
    source: opts.worldId,
    origin: 'external',
    text: opts.render ? opts.render(frame.segments) : '',
    // senderKey = conversation key (§3.2; cortico side stays channel-wide, per-person filter lives in meta.sender).
    senderKey: frame.conv,
    meta: {
      conv: frame.conv,
      sender: frame.sender,
      kind: frame.kind,
      platformMsgId: platformMsgIdFromRaw(frame.raw),
      // §3.4 re-points the 「raw survives verbatim」 rule: the prompt sees the redacted
      // original — structure and non-sensitive fields kept, credentials stripped.
      raw: redactJson(frame.raw),
    },
  };
  if (opts.blobs && opts.blobs.length) envelope.blobs = opts.blobs;
  if (isSelf) {
    // §3.2 row 3: self echo → 只归档 (hard rule: never re-wake the model on our own output).
    envelope.contextDelivery = 'archive-only';
    return { envelope, push: { deliver: false } };
  }
  if (frame.kind === 'mention' || frame.kind === 'direct') return { envelope, push: { trigger: 'flush' }, degraded };
  // group/other: host default for external events is debounce (types.ts:633) — no override.
  return { envelope, push: {}, degraded };
}

/** notice frame → <w>.notice, piggyback only (never wakes the model by itself). */
export function noticeToEnvelope(frame: NoticeFrame, opts: EnvelopeOptions): {
  envelope: EventEnvelopeLike;
  push: PushOptionsLike;
} {
  const names = eventNamesFor(opts.worldId);
  const envelope: EventEnvelopeLike = {
    type: names.notice,
    ts: tsToIso(frame.ts),
    source: opts.worldId,
    origin: 'external',
    text: `[notice ${frame.kind}]`,
    senderKey: frame.conv,
    meta: {
      conv: frame.conv,
      kind: frame.kind,
      raw: redactJson(frame.raw),
    },
  };
  return { envelope, push: { trigger: 'piggyback' } };
}

/** connection/degraded frames → the two status event rows of §3.2 (both flush). */
export function eventToEnvelope(
  frame: import('./frames.js').EventFrame,
  opts: EnvelopeOptions,
): { envelope: EventEnvelopeLike; push: PushOptionsLike } {
  const names = eventNamesFor(opts.worldId);
  const envelope: EventEnvelopeLike = {
    type: frame.name === 'connection' ? names.connection : names.degraded,
    ts: tsToIso(frame.ts),
    source: opts.worldId,
    origin: 'internal',
    text: JSON.stringify(frame.data ?? null),
  };
  return { envelope, push: { trigger: 'flush' } };
}
