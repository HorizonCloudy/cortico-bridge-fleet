/**
 * normalize.ts —— CBP 段/事件 ↔ N.E.K.O 面。帧表、段渲染、未知段兜底、档位分档
 * 一律复用 cortico-bridge-core（任务红线：禁止复制粘贴一份转换逻辑）；本文件只放
 * neko 专属映射。钉值逐字出处（upstream/neko @52e973ed2）：
 * - push_message_schema.py:60 SCHEMA_VERSION = "push_message.v2"；:61 DEPRECATION_REMOVAL_VERSION =
 *   "v0.9"（v1 十关键词按已删处理，蓝图 §1.3-3——本包不写任何 v1 兼容位）。
 * - :63 VISIBILITY_VALUES = ("chat","hud")；:64 AI_BEHAVIOR_VALUES = ("respond","read","blind")；
 *   :65 DEFAULT_VISIBILITY = []；:66 DEFAULT_AI_BEHAVIOR = "respond"。
 * - 两轴是 SDK 客户端强校验面（r-neko §5：脏值 ValueError）；parts 的 type 反而不校验
 *   （C1-16），所以「未知段」兜底归内核 segment.ts 唯一实现点，这里不重复。
 * - 载荷硬界：settings.py:588 宿主帧上限 + core/context.py:248 信封余量折算出的字节数
 *   **不写在代码里**（F13，SECURITY-CBP §4.1）：单一来源是 spec/pins.json 的
 *   caps.neko.frame_bytes，经内核 loadPins() 读数；SDK 本地先拒在 context.py:1306，
 *   本包等效先拒（60003），桥侧再拒一次是双保险。
 * - docs/plugins/push-message.md：外部 URL 图模型路直接拒（只认 ctx.images.upload()
 *   句柄）；audio/video 无上传 API；upload 归一 JPEG ≤2048 只在宿主那一个位
 *   ——Cortico 侧不重编码，JPEG 归一一位原则照写进拒收面。
 */
import { coerceSegments, loadPins, type BlobInput, type Seg } from 'cortico-bridge-core';

/** 事件名显式映射表（蓝图 §2.3：不从 worldId 派生；先例 astrbot 包 EVENTS 同型）。 */
export const EVENTS = {
  message: 'neko.message',
  messageSelf: 'neko.message.self',
  notice: 'neko.notice',
  connection: 'neko.connection',
  degraded: 'neko.degraded',
} as const;

export const SCHEMA_VERSION = 'push_message.v2'; // push_message_schema.py:60
export const VISIBILITY_VALUES: readonly string[] = ['chat', 'hud']; // :63
export const AI_BEHAVIOR_VALUES: readonly string[] = ['respond', 'read', 'blind']; // :64
export const DEFAULT_AI_BEHAVIOR = 'respond'; // :66

/**
 * 出站帧上限的唯一读数口（F13 caps 单源）：`caps.neko.frame_bytes`，即宿主
 * settings.py:588 上限减 core/context.py:248 信封余量的折算值。neko 行未测时
 * 退 cbp 行（内核保证非 null）；两边都不许在调用方抄数字。
 */
export function nekoFrameLimitBytes(): number {
  const caps = loadPins().caps;
  return caps.neko.frame_bytes ?? caps.cbp.frame_bytes;
}

export interface NekoAxes {
  visibility: string[];
  ai_behavior: string;
}

/** CSV → 合法两轴；脏值丢弃 / 回落缺省（等效 SDK :285/:轴校验的 ValueError 面）。 */
export function parseAxes(visibilityCsv: string, aiBehavior: string): NekoAxes {
  const visibility = String(visibilityCsv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => VISIBILITY_VALUES.includes(s));
  const ai_behavior = AI_BEHAVIOR_VALUES.includes(aiBehavior) ? aiBehavior : DEFAULT_AI_BEHAVIOR;
  return { visibility, ai_behavior };
}

export interface DroppedSeg {
  type: string;
  reason: string;
}

export interface NekoSendPlan {
  /** 允许出站的 CBP 段（image 只剩内联 base64 位）。 */
  kept: Seg[];
  dropped: DroppedSeg[];
  /** packed 载荷字节估算。 */
  packedBytes: number;
  tooLarge: boolean;
}

/** neko 侧无上传 API 的媒体段：出站必拒（push-message.md「audio/video 无上传 API yet」）。 */
const NO_UPLOAD_TYPES = new Set(['record', 'audio', 'video', 'file']);

/**
 * 出站载荷计划：外部 URL 图直接拒、无上传 API 媒体拒、caps.neko 帧上限本地先拒。
 * packedBytes = JSON 字节数（inline 图已是 base64 字符串，4/3 膨胀已经发生，
 * 与 SDK packed 口径近似同量）。上限从 nekoFrameLimitBytes() 单源读数（F13）。
 * shortcut: 精确 packed 尺寸以桥侧打包为准（ingress.py 工单），这里只做起点拒。
 */
export function planNekoSend(text: string, segments: readonly Seg[], axes: NekoAxes): NekoSendPlan {
  const kept: Seg[] = [];
  const dropped: DroppedSeg[] = [];
  for (const seg of segments) {
    if (NO_UPLOAD_TYPES.has(seg.type)) {
      dropped.push({ type: seg.type, reason: 'no-upload-api' });
      continue;
    }
    if (seg.type === 'image') {
      const b64 = seg.data.base64 ?? '';
      if (b64 !== '') {
        kept.push(seg);
        continue;
      }
      dropped.push({ type: 'image', reason: seg.data.url ? 'external-url-image' : 'empty-image' });
      continue;
    }
    kept.push(seg);
  }
  const packedBytes = Buffer.byteLength(
    JSON.stringify({ schema: SCHEMA_VERSION, visibility: axes.visibility, ai_behavior: axes.ai_behavior, text, segments: kept }),
    'utf8',
  );
  return { kept, dropped, packedBytes, tooLarge: packedBytes > nekoFrameLimitBytes() };
}

/** 入站 image 段 → BlobInput：只认内联 base64；URL 句柄不过桥（U7）。 */
export function imageSegToBlob(seg: Seg): BlobInput | null {
  if (seg.type !== 'image') return null;
  const b64 = seg.data.base64 ?? '';
  const mime = seg.data.mime ?? '';
  if (b64 === '' || !mime.startsWith('image/')) return null;
  try {
    return { bytes: Uint8Array.from(Buffer.from(b64, 'base64')), mime, fallbackText: '[图片]' };
  } catch {
    return null;
  }
}

/**
 * consent 等待态取值：decision 优先、status 次之、否则 unknown。
 * 形状钉自 plugin/server/domain/consent_policy.py:12-44（ConsentView{decision,status} @52e973ed2；
 * 蓝图引的 consent_policy.py:19 在另一个 sha 3985eea0b，本地按钉住的 52e973ed2 面读）。
 */
export function consentLabel(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'unknown';
  const r = raw as Record<string, unknown>;
  if (typeof r.decision === 'string' && r.decision !== '') return r.decision;
  if (typeof r.status === 'string' && r.status !== '') return r.status;
  return 'unknown';
}

/**
 * 桥 call 的 args.segments 入参收敛：非对象条目直接丢，值全字符串化
 * （内核 coerceSegments 转发，不在这里再造一遍）。
 */
export function toCbpSegments(input: unknown): Seg[] {
  return coerceSegments(input);
}
