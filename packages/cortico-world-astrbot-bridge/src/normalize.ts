/**
 * normalize —— CBP msg/notice ↔ Cortico 事件面。
 *
 * 档位与键全部钉自 _BUILD-PLAN.md §3.2 表（本件定稿映射）：
 * - msg kind=mention/direct → `trigger:'flush'`；group/other → 缺省 debounce
 *   （缺省语义逐字 cortico types.ts:633「缺省时外部事件使用 debounce」@836238311）。
 * - notice → `{trigger:'piggyback'}`；自发回声 → `{deliver:false}` + archive-only。
 * - connection/degraded → flush、`origin:'internal'`（已认证操作员通道，types.ts:687-695 注释）。
 * - senderKey = UMO `platform:message_type:session_id`
 *   （repos/astrbot astrbot/core/platform/message_session.py:18-20 @133dd9f86 `__str__` 逐字）。
 * - at_all：ComponentTypes 25 键**无 `atall`**（components.py:1060-1086 @133dd9f86，C1-5），
 *   线上统一 `{type:'at',data:{qq:'all'}}`（_BUILD-PLAN §3.1），本文件是唯一特判点。
 *
 * shortcut: 段渲染兜底规则归内核 `cortico-bridge-core/src/segment.ts`（C1-16 唯一实现点）；
 * 内核落仓后删除本文件的 renderSegments，改 import 内核。
 */
import type { PushOptions } from 'cortico/core/types.ts';
import type { MsgFrame, NoticeFrame, Seg } from './frames.ts';

/** 事件名显式映射表（蓝图 §2.3：不从 worldId 派生）。 */
export const EVENTS = {
  message: 'astrbot.message',
  messageSelf: 'astrbot.message.self',
  notice: 'astrbot.notice',
  connection: 'astrbot.connection',
  degraded: 'astrbot.degraded',
} as const;

/** msg 帧的投递档位（_BUILD-PLAN §3.2 行 1-2）。 */
export function pushOptsForMsg(frame: MsgFrame): PushOptions {
  if (frame.kind === 'mention' || frame.kind === 'direct') return { trigger: 'flush' };
  return {};
}

/** notice 帧的投递档位（_BUILD-PLAN §3.2 行 4：piggyback 只排队）。 */
export function pushOptsForNotice(_frame: NoticeFrame): PushOptions {
  return { trigger: 'piggyback' };
}

/** 自发回声：只归档不唤醒（硬规则；PushOptions.deliver:false types.ts:631-632）。 */
export const PUSH_OPTS_SELF: PushOptions = { deliver: false };

/**
 * CBP msg.conv 直接带 UMO 串；旧私有帧的 conv 只有 {kind,id}，
 * 合成键按 MessageType 三值（GroupMessage/FriendMessage/OtherMessage，r-astrbot §4）。
 */
export function senderKeyOfMsg(frame: MsgFrame): string {
  return frame.conv;
}

export function senderKeyFromLegacyConv(conv: { kind: string; id: string }): string {
  const messageType =
    conv.kind === 'group' ? 'GroupMessage' : conv.kind === 'private' ? 'FriendMessage' : 'OtherMessage';
  return `aiocqhttp:${messageType}:${conv.id}`;
}

/** 旧帧 kind → CBP kind（mention 位优先，其余按会话类型）。 */
export function kindFromLegacy(mentioned: boolean, convKind: 'group' | 'private'): MsgFrame['kind'] {
  if (mentioned) return 'mention';
  return convKind === 'private' ? 'direct' : 'group';
}

/**
 * 段渲染：一行可读正文。未知段 `[<type>]` 兜底不吞消息（C1-16，桥侧自实现项）。
 * at_all 特判：`at` 段 `qq==='all'` 渲染 `@全体成员`，绝不产生 `atall` 段型。
 */
export function renderSegments(segments: Seg[]): { text: string; degraded: string[] } {
  const degraded: string[] = [];
  const parts: string[] = [];
  for (const seg of segments) {
    if (!seg || typeof seg.type !== 'string' || !seg.data || typeof seg.data !== 'object') {
      degraded.push('bad-segment');
      continue;
    }
    switch (seg.type) {
      case 'text':
        parts.push(seg.data.text ?? '');
        break;
      case 'at': {
        const qq = seg.data.qq ?? '';
        if (qq === 'all') parts.push('@全体成员');
        else parts.push(`@${seg.data.name || qq}`);
        break;
      }
      case 'image':
        // 图片走 blobs，不进正文；正文只留一个记号。
        parts.push('[图片]');
        break;
      case 'reply':
        parts.push(`[回复 #${seg.data.id ?? ''}]`);
        break;
      case 'face':
        parts.push(`[表情 ${seg.data.id ?? ''}]`);
        break;
      default:
        parts.push(`[${seg.type}]`);
        degraded.push(`unknown-segment:${seg.type}`);
        break;
    }
  }
  return { text: parts.join('').trim(), degraded };
}

/** 出站段构造：at_all 还原同走 `{at, qq:'all'}`，与入站特判对称。 */
export function buildSegsFromLegacyText(text: string): Seg[] {
  return [{ type: 'text', data: { text } }];
}

/** 事件 meta 五键（_BUILD-PLAN §3.2：conv/sender/kind/platformMsgId/raw；raw 恒留，硬规则 8）。 */
export function metaForMsg(frame: MsgFrame): Record<string, unknown> {
  return {
    conv: frame.conv,
    sender: frame.sender,
    kind: frame.kind,
    platformMsgId: (frame.raw as { message_id?: unknown } | null)?.message_id,
    raw: frame.raw,
  };
}

/**
 * 旧帧 msg → MsgFrame（两阶段升级第 1 态的兼容读）。
 * 旧帧形状逐字 4725feee6 driver.ts:720-756：conv 是 dict `{kind,id}`、text 顶层、
 * sender{id,name}、mentioned bool、id/ts 可缺。收不进来返回 null（吞帧不吞错）。
 */
export function legacyMsgToCbp(frame: Record<string, unknown>): MsgFrame | null {
  const convRaw = frame.conv as Record<string, unknown> | undefined;
  if (!convRaw || typeof convRaw !== 'object') return null;
  const kind = convRaw.kind === 'private' ? 'private' : convRaw.kind === 'group' ? 'group' : null;
  if (!kind) return null;
  const id = convRaw.id === undefined || convRaw.id === null ? '' : String(convRaw.id);
  if (!id) return null;
  const senderRaw = frame.sender as Record<string, unknown> | undefined;
  const text = typeof frame.text === 'string' ? frame.text : '';
  const ts =
    typeof frame.ts === 'string' && !Number.isNaN(Date.parse(frame.ts))
      ? Date.parse(frame.ts) / 1000
      : Date.now() / 1000;
  const images = Array.isArray(frame.images)
    ? frame.images.filter(
        (x): x is { mime: string; base64: string } =>
          !!x && typeof x === 'object' &&
          typeof (x as { base64?: unknown }).base64 === 'string' &&
          typeof (x as { mime?: unknown }).mime === 'string' &&
          (x as { mime: string }).mime.startsWith('image/'),
      )
    : [];
  return {
    v: 1,
    t: 'msg',
    id: frame.id === undefined ? '' : String(frame.id),
    ts,
    conv: `aiocqhttp:${kind === 'group' ? 'GroupMessage' : 'FriendMessage'}:${id}`,
    sender: { id: senderRaw?.id === undefined ? '' : String(senderRaw.id), name: typeof senderRaw?.name === 'string' ? senderRaw.name : '' },
    kind: kindFromLegacy(frame.mentioned === true, kind),
    segments: [
      ...(text ? [{ type: 'text' as const, data: { text } }] : []),
      ...images.map((img) => ({ type: 'image' as const, data: { mime: img.mime, base64: img.base64 } })),
    ],
    raw: frame,
  };
}

/** UMO 串 → 旧桥 send 帧要的 conv dict（`platform:message_type:session_id` 反解）。 */
export function umoToLegacyConv(umo: string): { kind: 'group' | 'private'; id: string } | null {
  const parts = umo.split(':');
  if (parts.length < 3) return null;
  const [, messageType, ...rest] = parts;
  const id = rest.join(':');
  if (!id) return null;
  if (messageType === 'GroupMessage') return { kind: 'group', id };
  if (messageType === 'FriendMessage') return { kind: 'private', id };
  return null;
}

/** 旧帧 image 段（base64 在内）→ BlobInput bytes；mime 白名单只有 image/*。 */
export function imageSegToBlob(seg: Seg): { bytes: Uint8Array; mime: string; fallbackText: string } | null {
  if (seg.type !== 'image') return null;
  const b64 = seg.data.base64 ?? '';
  const mime = seg.data.mime ?? '';
  if (!b64 || !mime.startsWith('image/')) return null;
  try {
    return { bytes: Uint8Array.from(Buffer.from(b64, 'base64')), mime, fallbackText: '[图片]' };
  } catch {
    return null;
  }
}
