/**
 * CBP v1 frame codec. Shapes are the _BUILD-PLAN §3.1 ten-type union; the common
 * head `{v,t,id,ts}` is generalized from the astrbot private frame v1
 * (driver.ts:417 t:'hello', :708 parseFrame @4725feee6). No framework knowledge here.
 *
 * parseFrame mirrors the prior-art defensive rule (driver.ts:704-717 @4725feee6):
 * valid JSON that is not a plain object is rejected, so `frame.t` never throws on a
 * bare `null`. Bad frames are swallowed by the driver, not raised.
 */
import { randomUUID } from 'node:crypto';

/** ToolTag six values, verbatim from cortico types.ts:202 @836238311. */
export type ToolRisk = 'read' | 'write' | 'speak' | 'act' | 'flow' | 'snapshot';

/** Tool announcement carried in hello/ready/catalog. G6: risk + confirm_required. */
export interface ToolAnn {
  name: string;
  risk: ToolRisk;
  confirm_required: boolean;
  description?: string;
}

/** v11-shaped segment: {type,data}, every value a string (array.md:23 @d4456ee70). */
export interface Seg {
  type: string;
  data: Record<string, string>;
}

export interface BlobPart {
  mime: string;
  name?: string;
  b64: string;
}

export interface FrameError {
  code: number;
  message: string;
}

export type FrameType =
  | 'hello'
  | 'ready'
  | 'msg'
  | 'notice'
  | 'ack'
  | 'call'
  | 'reply'
  | 'event'
  | 'tick'
  | 'catalog';

export const FRAME_TYPES: readonly FrameType[] = [
  'hello',
  'ready',
  'msg',
  'notice',
  'ack',
  'call',
  'reply',
  'event',
  'tick',
  'catalog',
];

export type MsgKind = 'mention' | 'direct' | 'group' | 'other';

/** self-declaration carried by hello/ready (F1/F2, SECURITY-CBP §2). Empty id must say proven:false. */
export interface SelfDecl {
  id: string;
  name: string;
  proven: boolean;
}

/** anon four values, verbatim from SECURITY-CBP §1 (member.id==self.id → self; …). */
export type Anon = 'identified' | 'anonymous' | 'self' | 'unknown';

/**
 * Operator identity carried by every call (F3). The bridge fills it from its own inbound
 * record — the wire copy is reconciliation material only, never the trust input.
 */
export interface Actor {
  platform: string;
  conv: string;
  member: { id: string; name: string };
  anon: Anon;
}

export interface HelloFrame {
  v: 1;
  t: 'hello';
  id: string;
  ts: number;
  agent: { name: string; version: string; sha: string };
  v_support: number[];
  caps: string[];
  tools: ToolAnn[];
  self: SelfDecl;
}
export interface ReadyFrame {
  v: 1;
  t: 'ready';
  id: string;
  ts: number;
  caps: string[];
  tools: ToolAnn[];
  self: SelfDecl;
}
export interface MsgFrame {
  v: 1;
  t: 'msg';
  id: string;
  ts: number;
  conv: string;
  sender: { id: string; name: string };
  kind: MsgKind;
  segments: Seg[];
  raw: unknown;
}
export interface NoticeFrame {
  v: 1;
  t: 'notice';
  id: string;
  ts: number;
  conv?: string;
  kind: string;
  raw: unknown;
}
export interface AckFrame {
  v: 1;
  t: 'ack';
  id: string;
  ts: number;
  rid: string;
}
export interface CallFrame {
  v: 1;
  t: 'call';
  id: string;
  ts: number;
  rid: string;
  tool: string;
  args: Record<string, unknown>;
  /** id of the inbound msg that started this turn ($defs/frameId 1..64, F3). */
  turn: string;
  actor: Actor;
}
export interface ReplyFrame {
  v: 1;
  t: 'reply';
  id: string;
  ts: number;
  rid: string;
  ok: boolean;
  text?: string;
  blobs?: BlobPart[];
  error?: FrameError;
}
export interface EventFrame {
  v: 1;
  t: 'event';
  id: string;
  ts: number;
  name: 'connection' | 'degraded';
  data: unknown;
}
export interface TickFrame {
  v: 1;
  t: 'tick';
  id: string;
  ts: number;
}
export interface CatalogFrame {
  v: 1;
  t: 'catalog';
  id: string;
  ts: number;
  tools: ToolAnn[];
}

export type Frame =
  | HelloFrame
  | ReadyFrame
  | MsgFrame
  | NoticeFrame
  | AckFrame
  | CallFrame
  | ReplyFrame
  | EventFrame
  | TickFrame
  | CatalogFrame;

const ID_MAX = 64;

/** Fresh head: v1, type, id 1..64, ts in float64 seconds (v12 `time` unit). */
export function newHead(t: FrameType): { v: 1; t: FrameType; id: string; ts: number } {
  return { v: 1, t, id: randomUUID().slice(0, ID_MAX), ts: Date.now() / 1000 };
}

/** Convert a frame ts (float seconds) to the Cortico EventEnvelope ISO-with-offset string. */
export function frameTsToIso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}
function isStr(x: unknown): x is string {
  return typeof x === 'string';
}
function isFiniteNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}
function isStrArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every(isStr);
}
function isToolArr(x: unknown): x is ToolAnn[] {
  return (
    Array.isArray(x) &&
    x.every(
      (e) =>
        isObj(e) &&
        isStr(e.name) &&
        (FRAME_TOOL_RISKS as readonly string[]).includes(e.risk as string) &&
        typeof e.confirm_required === 'boolean',
    )
  );
}
function isSegArr(x: unknown): x is Seg[] {
  return (
    Array.isArray(x) &&
    x.every((s) => isObj(s) && isStr(s.type) && isObj(s.data) && Object.values(s.data).every(isStr))
  );
}
function isHeadValid(o: Record<string, unknown>): boolean {
  return o.v === 1 && isStr(o.id) && o.id.length >= 1 && o.id.length <= ID_MAX && isFiniteNum(o.ts);
}
const FRAME_TOOL_RISKS: readonly ToolRisk[] = ['read', 'write', 'speak', 'act', 'flow', 'snapshot'];

const STR_MAX = 256; // $defs/sender.id / conv / self.id upper bounds
const ANON_VALUES: readonly string[] = ['identified', 'anonymous', 'self', 'unknown'];

/** $defs/frameId: 1..64 chars. */
function isFrameId(x: unknown): x is string {
  return isStr(x) && x.length >= 1 && x.length <= ID_MAX;
}
/** $defs/conv: 1..256 chars. */
function isConv(x: unknown): x is string {
  return isStr(x) && x.length >= 1 && x.length <= STR_MAX;
}
/** $defs/self: {id,name,proven}, id/name may be empty, three keys closed (F1/F2). */
function isSelfDecl(x: unknown): x is SelfDecl {
  return (
    isObj(x) &&
    isStr(x.id) &&
    x.id.length <= STR_MAX &&
    isStr(x.name) &&
    x.name.length <= STR_MAX &&
    typeof x.proven === 'boolean'
  );
}
/** $defs/actor: platform 1..64, conv per $defs/conv, member per $defs/sender, anon four values, four keys closed (F3). */
function isActor(x: unknown): x is Actor {
  if (!isObj(x) || !isStr(x.platform) || x.platform.length < 1 || x.platform.length > ID_MAX) return false;
  if (!isConv(x.conv)) return false;
  if (!isObj(x.member) || !isStr(x.member.id) || x.member.id.length < 1 || x.member.id.length > STR_MAX || !isStr(x.member.name) || x.member.name.length > STR_MAX) return false;
  return ANON_VALUES.includes(x.anon as string);
}

/**
 * Defensive decode. Returns null for: not-JSON, JSON that is not a plain object
 * (null / array / scalar), an invalid head, or a body that does not match its type.
 * Callers swallow null; they never get a partial object that throws on field access.
 */
export function parseFrame(raw: string): Frame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(parsed)) return null; // rejects null, arrays, scalars, booleans
  if (!isHeadValid(parsed)) return null;
  const t = parsed.t;
  if (!isStr(t) || !(FRAME_TYPES as readonly string[]).includes(t)) return null;

  // id/ts/v are known good via the head check; re-narrow per type body.
  switch (t) {
    case 'hello': {
      if (!isObj(parsed.agent) || !isStr(parsed.agent.name) || !isStr(parsed.agent.version) || !isStr(parsed.agent.sha)) return null;
      // v_support is validated as a numeric array only; the semantic version decision
      // (do the sets intersect?) belongs to negotiate.checkVersion, not the decoder.
      if (!Array.isArray(parsed.v_support) || !parsed.v_support.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
      if (!isStrArray(parsed.caps) || !isToolArr(parsed.tools)) return null;
      if (!isSelfDecl(parsed.self)) return null; // F1: hello must carry self
      return parsed as unknown as HelloFrame;
    }
    case 'ready': {
      if (!isStrArray(parsed.caps) || !isToolArr(parsed.tools)) return null;
      if (!isSelfDecl(parsed.self)) return null; // F2: ready must carry self
      return parsed as unknown as ReadyFrame;
    }
    case 'catalog': {
      if (!isToolArr(parsed.tools)) return null;
      return parsed as unknown as CatalogFrame;
    }
    case 'msg': {
      if (!isStr(parsed.conv) || !isObj(parsed.sender) || !isStr(parsed.sender.id) || !isStr(parsed.sender.name)) return null;
      if (!isStr(parsed.kind) || !['mention', 'direct', 'group', 'other'].includes(parsed.kind)) return null;
      if (!isSegArr(parsed.segments)) return null;
      if (!('raw' in parsed)) return null;
      return parsed as unknown as MsgFrame;
    }
    case 'notice': {
      if (!isStr(parsed.kind)) return null;
      if (parsed.conv !== undefined && !isStr(parsed.conv)) return null;
      if (!('raw' in parsed)) return null;
      return parsed as unknown as NoticeFrame;
    }
    case 'ack': {
      if (!isStr(parsed.rid)) return null;
      return parsed as unknown as AckFrame;
    }
    case 'call': {
      if (!isStr(parsed.rid) || !isStr(parsed.tool) || !isObj(parsed.args)) return null;
      if (!isFrameId(parsed.turn) || !isActor(parsed.actor)) return null; // F3: turn+actor required
      return parsed as unknown as CallFrame;
    }
    case 'reply': {
      if (!isStr(parsed.rid) || typeof parsed.ok !== 'boolean') return null;
      if (parsed.text !== undefined && !isStr(parsed.text)) return null;
      if (parsed.blobs !== undefined) {
        const bs = parsed.blobs;
        if (!Array.isArray(bs) || !bs.every((b) => isObj(b) && isStr(b.mime) && isStr(b.b64) && (b.name === undefined || isStr(b.name)))) return null;
      }
      if (parsed.error !== undefined) {
        const e = parsed.error;
        if (!isObj(e) || !isFiniteNum(e.code) || !isStr(e.message)) return null;
      }
      return parsed as unknown as ReplyFrame;
    }
    case 'event': {
      if (parsed.name !== 'connection' && parsed.name !== 'degraded') return null;
      if (!('data' in parsed)) return null;
      return parsed as unknown as EventFrame;
    }
    case 'tick': {
      return parsed as unknown as TickFrame;
    }
    default:
      return null;
  }
}
