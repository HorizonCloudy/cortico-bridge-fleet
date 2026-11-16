/**
 * Capability negotiation (blueprint §2.1 negotiate row; c1 §5.5). hello/ready each carry a
 * caps list, the effective set is the intersection, and a missing bit closes the whole
 * feature instead of per-call trial. The `v` support set gate disconnects with 60001 and a
 * message that names both sides {包名, 版本, sha} — the fix for the "no gate on version
 * skew" hole (d-bridge-priorart §6.9, telegram 0.43.10-vs-0.43.12 real case).
 */
import { RET, err, type CbpError } from './errors.js';
import { loadPins, PINS, type CapName } from './pins.js';
import type { HelloFrame, ReadyFrame, ToolAnn, ToolRisk } from './frames.js';

/** Cap names; the value list lives in the pins source (F13), this union mirrors it for typing. */
export type Cap = CapName;
/** Pinned vocabulary (offline mirror of spec/pins.json vocab.cbp.caps); unknown names are ignored by intersection, never fatal. */
export const CAPS: readonly Cap[] = PINS.capsVocab;

let liveVocab: readonly Cap[] | null = null;
function vocab(): readonly Cap[] {
  return (liveVocab ??= loadPins().capsVocab);
}

/** CBP versions this kernel implements; hello.v_support must intersect it. */
export const V_SUPPORT: readonly number[] = [1];

export interface AgentId {
  name: string;
  version: string;
  sha: string;
}

/** Caps intersection, kept in vocabulary (pins) order so both sides compute the same array. */
export function intersectCaps(ours: readonly string[], theirs: readonly string[]): Cap[] {
  const theirsSet = new Set(theirs);
  return vocab().filter((c) => theirsSet.has(c) && ours.includes(c));
}

function fmtAgent(a: AgentId): string {
  return `${a.name}@${a.version}(${a.sha.slice(0, 9)})`;
}

/**
 * Version gate. Returns an error (caller then sends `event{name:'degraded',...}` +
 * closes) when the peer's v_support set does not intersect ours.
 */
export function checkVersion(peer: HelloFrame, ours: AgentId): CbpError | null {
  const support = Array.isArray(peer.v_support) ? peer.v_support : [];
  if (support.some((v) => V_SUPPORT.includes(v))) return null;
  return err(
    RET.VERSION_MISMATCH,
    `CBP version mismatch: local ${fmtAgent(ours)} supports v=${V_SUPPORT.join('/')}, ` +
      `peer ${fmtAgent(peer.agent)} supports v=${support.join('/')}`,
  );
}

const RISK_VALUES: readonly string[] = ['read', 'write', 'speak', 'act', 'flow', 'snapshot'];

/** Validate one announced tool entry (G6: risk six values verbatim, ToolTag @types.ts:202 @836238311). */
export function checkToolAnn(t: unknown): t is ToolAnn {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o.name === 'string' &&
    o.name.length > 0 &&
    typeof o.risk === 'string' &&
    RISK_VALUES.includes(o.risk) &&
    typeof o.confirm_required === 'boolean' &&
    (o.description === undefined || typeof o.description === 'string')
  );
}

/** Filter an announced list down to valid entries; bad rows are reported, not fatal. */
export function sanitizeTools(tools: readonly unknown[]): { ok: ToolAnn[]; bad: number } {
  const ok: ToolAnn[] = [];
  let bad = 0;
  for (const t of tools) {
    if (checkToolAnn(t)) ok.push(t);
    else bad++;
  }
  return { ok, bad };
}

export interface Negotiation {
  caps: Cap[];
  tools: ToolAnn[];
  /** 0 = accepted; otherwise a 6xxxx retcode, already carried with a message. */
  error?: CbpError;
}

/** Full hello handling on the listening side: version gate, then caps/tools merge. */
export function negotiateHello(
  hello: HelloFrame,
  ours: { agent: AgentId; caps: readonly string[]; tools: readonly ToolAnn[] },
): Negotiation {
  const error = checkVersion(hello, ours.agent);
  if (error) return { caps: [], tools: [], error };
  const { ok } = sanitizeTools(hello.tools);
  return { caps: intersectCaps(ours.caps, hello.caps), tools: ok };
}

/** ready handling on the dialing side; caps intersection is symmetric. */
export function negotiateReady(
  ready: ReadyFrame,
  ours: { caps: readonly string[] },
): Negotiation {
  const { ok } = sanitizeTools(ready.tools);
  return { caps: intersectCaps(ours.caps, ready.caps), tools: ok };
}
