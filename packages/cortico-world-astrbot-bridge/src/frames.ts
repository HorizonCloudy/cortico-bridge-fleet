/**
 * CBP v1 帧表 —— 收编 `cortico-world-astrbot @4725feee6` 私有帧 v1 的泛化型。
 *
 * 对接点（写码日以此为准，勿凭记忆）：
 * - 帧表十型逐字：_BUILD-PLAN.md §3.1（L120-136），`spec/CBP-v1.json` 为 schema 单一来源。
 * - 防御解析形状：repos/world-astrbot/src/driver.ts:704-717 @4725feee6
 *   （合法 JSON 不代表是对象；`null`/数组/标量必须挡，否则 `frame.t` 在 null 上抛错）。
 * - `risk` 六值逐字 cortico/src/core/types.ts:202 @836238311（ToolTag）。
 * - 协商位规则：_BUILD-PLAN.md §2.3 —— 旧 hello 无 `v:[..]` 支持集按 `v:1` 放行；
 *   §3.4-3：旧私有帧客户端连新 Cortico 侧不断线（两阶段升级第 1 态）。
 *
 * shortcut: 本文件是内核 `cortico-bridge-core/src/frames.ts`+`negotiate.ts` 的包内替身，
 * 内核件（_BUILD-PLAN §2.2）落仓后把这里的 import 逐个改指内核并删除本文件。
 */

export const CBP_VERSION = 1 as const;

/** 错误码走内核 errors.ts 口径；这里是本包用到的三支（蓝图 §2.1 桥专用段）。 */
export const ERR_VERSION_GATE = 60001;
export const ERR_DOOR_CLOSED = 60005;
export const ERR_SEND_UNCERTAIN = 60007;

/** ToolTag 六值逐字（cortico types.ts:202 @836238311）。 */
export type ToolRisk = 'read' | 'write' | 'speak' | 'act' | 'flow' | 'snapshot';

/** CBP §3.1：hello/ready/catalog 的 tools[] 条目。 */
export interface ToolAnn {
  name: string;
  risk: ToolRisk;
  confirm_required: boolean;
  description?: string;
}

/** CBP §3.1：Seg 线上型 = v11 `{type,data}`，值全字符串；at 参数名 `qq`。 */
export interface Seg {
  type: string;
  data: Record<string, string>;
}

/** 公共头逐型必有：`{v:1, t, id(1..64), ts}`；ts 为 float64 秒。 */
export interface FrameHead {
  v: 1;
  t: string;
  id: string;
  ts: number;
}

/** 本包实际消费/产出的帧面（十型的子集形状；其余型透传给内核）。 */
export interface HelloFrame extends FrameHead {
  t: 'hello';
  agent: { name: string; version: string; sha: string };
  v_support: number[];
  caps: string[];
  tools: ToolAnn[];
  /** 旧私有帧字段（4725feee6 driver.ts:417-423）：两阶段升级第 1 态必须继续带。 */
  token?: string;
  name?: string;
  capabilities?: Record<string, unknown>;
}

/** CBP §3.1：hello/ready 的 self 声明位（F1/F2 三键 {id,name,proven}；旧私有帧 ready 无 proven）。 */
export interface SelfDecl {
  id: string;
  name: string;
  proven?: boolean;
}

/** anon 四值逐字（SECURITY-CBP §1.2；member.id==self.id → self）。 */
export type Anon = 'identified' | 'anonymous' | 'self' | 'unknown';

/**
 * F3：call 的操作者身份，四键闭合（内核 frames.ts:81-86 的包内替身，
 * 键界同 $defs/actor：platform 1..64、conv $defs/conv、member $defs/sender、anon 枚举）。
 */
export interface Actor {
  platform: string;
  conv: string;
  member: { id: string; name: string };
  anon: Anon;
}

const ANON_VALUES: readonly string[] = ['identified', 'anonymous', 'self', 'unknown'];

/** 出站 call 前的结构闸：缺位/空 member.id/越界/坏 anon 都算未实证（缺 actor 不发）。 */
export function isActor(x: unknown): x is Actor {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const a = x as Record<string, unknown>;
  if (typeof a.platform !== 'string' || a.platform.length < 1 || a.platform.length > 64) return false;
  if (typeof a.conv !== 'string' || a.conv.length < 1 || a.conv.length > 256) return false;
  const m = a.member as Record<string, unknown> | undefined;
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || m.id.length < 1 || m.id.length > 256 || typeof m.name !== 'string' || m.name.length > 256) return false;
  return typeof a.anon === 'string' && ANON_VALUES.includes(a.anon);
}

/** 对端 ready：CBP 全形 + 旧私有帧字段（37c1e6ccd bridge.py:272-283 逐字）。 */
export interface ReadyFrame {
  t: 'ready';
  v?: number;
  v_support?: number[];
  id?: string;
  ts?: number;
  caps?: string[];
  tools?: ToolAnn[];
  self?: SelfDecl;
  admins?: unknown[];
  tts?: unknown;
}

export interface MsgFrame extends FrameHead {
  t: 'msg';
  conv: string;
  sender: { id: string; name: string };
  kind: 'mention' | 'direct' | 'group' | 'other';
  segments: Seg[];
  raw: unknown;
}

export interface NoticeFrame extends FrameHead {
  t: 'notice';
  conv?: string;
  kind?: string;
  /** 旧桥 notice 的人读正文（4725feee6 driver.ts:655-659）。 */
  text?: string;
  raw?: unknown;
}

export interface EventFrame extends FrameHead {
  t: 'event';
  name: 'connection' | 'degraded';
  data: unknown;
}

export interface CatalogFrame extends FrameHead {
  t: 'catalog';
  tools: ToolAnn[];
}

/** ts（float64 秒）→ Cortico EventEnvelope 的 ISO 带偏移时刻（内核 envelope.ts 规则）。 */
export function tsToIso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

/**
 * 防御解析：合法 JSON 不一定能往下走（null、数字、字符串、数组都会让
 * `frame.t` 抛 TypeError）。坏帧返回 null，调用方吞掉并记 warn，绝不让它升级成进程级错误。
 */
export function parseFrame(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** hello/ready 的版本支持集读取：缺 `v_support` 的旧端按 `v:1` 放行（_BUILD-PLAN §2.3）。 */
export function readVersionSupport(frame: Record<string, unknown>): number[] {
  if (Array.isArray(frame.v_support)) {
    return frame.v_support.filter((x): x is number => typeof x === 'number');
  }
  if (typeof frame.v === 'number') return [frame.v];
  return [CBP_VERSION];
}

/** 对端 caps 读取：旧私有帧端无 `caps` 数组 → 空集 = 只剩帧层保真、功能位全关。 */
export function readCaps(frame: Record<string, unknown>): string[] {
  return Array.isArray(frame.caps)
    ? frame.caps.filter((x): x is string => typeof x === 'string')
    : [];
}

export interface Negotiation {
  ok: boolean;
  /** 协商到的 CBP 版本；ok=false 时无意义。 */
  version?: number;
  /** 支持集不相交 → 60001，文案必须带两侧包名/版本/sha（蓝图 §2.1 协商行）。 */
  code?: number;
  message?: string;
}

export function negotiateVersions(
  localSupport: number[],
  peerSupport: number[],
  local: { name: string; version: string; sha: string },
  peer: { name: string; version: string; sha?: string },
): Negotiation {
  const shared = localSupport.filter((v) => peerSupport.includes(v));
  if (shared.length === 0) {
    return {
      ok: false,
      code: ERR_VERSION_GATE,
      message:
        `CBP version gate: ${local.name}@${local.version}#${local.sha} supports [${localSupport}]` +
        `, ${peer.name}${peer.version ? `@${peer.version}` : ''}${peer.sha ? `#${peer.sha}` : ''}` +
        ` supports [${peerSupport}]`,
    };
  }
  return { ok: true, version: Math.max(...shared) };
}

export function intersectCaps(a: string[], b: string[]): string[] {
  return a.filter((x) => b.includes(x));
}
