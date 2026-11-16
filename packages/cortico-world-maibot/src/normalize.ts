/**
 * normalize.ts —— MaiBot 模型字段 ↔ CBP 段/事件表。
 * 每个键名都来自隔离环境实测（r-maibot.md，安装件 maibot==1.4.5 @478f671e6 +
 * maibot-plugin-sdk==2.23.0 @f9984673d，wheel ≡ 仓库件见 r-maibot §0），不抄文档名。
 *
 * 两套消息模型（同名不同义，禁混 —— _BUILD-PLAN §3.2 差异表 maibot 行）：
 * - 宿主 MessageDict 17 键：upstream/maibot src/plugin_runtime/host/message_utils.py:45-62
 *   （total=False TypedDict）。`raw_message` 在这里是「段列表」。
 * - SDK MaiMessages 15 字段：upstream/maibot-plugin-sdk maibot_sdk/messages.py:22-60。
 *   `raw_message` 在那里是「原始消息对象」（Any|None）。
 * 桥（cortico-bridge-maibot）把宿主 MessageDict 翻成 CBP msg 帧，raw 恒留原 dict；
 * 本文件负责把「宿主形段」与「已是 CBP 形的段」统一收敛成内核 Seg，并读 raw 里的
 * account_id/session_id 做自发回声与会话键回落。
 * 段渲染与未知段 `[<type>]` 兜底不在这里 —— 唯一实现点是内核 segment.ts（C1-16）。
 */
import { isKnownType } from 'cortico-bridge-core';
import type { MsgFrame, Seg } from 'cortico-bridge-core/frames';

/** 宿主 MessageDict 键全集，逐字 message_utils.py:45-62 @478f671e6。 */
export const HOST_MESSAGE_KEYS: readonly string[] = [
  'message_id',
  'timestamp',
  'received_at',
  'platform',
  'account_id',
  'scope',
  'message_info',
  'raw_message',
  'is_mentioned',
  'is_at',
  'is_emoji',
  'is_picture',
  'is_command',
  'is_notify',
  'session_id',
  'reply_to',
  'processed_plain_text',
];

/** SDK MaiMessages 字段全集，逐字 messages.py:22-60 @f9984673d（r-maibot §4 运行时枚举）。 */
export const SDK_MAIMESSAGES_FIELDS: readonly string[] = [
  'message_segments',
  'plain_text',
  'llm_prompt',
  'llm_response_content',
  'llm_response_reasoning',
  'llm_response_model',
  'llm_response_tool_call',
  'stream_id',
  'is_group_message',
  'is_private_message',
  'message_base_info',
  'raw_message',
  'action_usage',
  'additional_data',
  'modify_flags',
];

/** _component_to_dict 的分支型名，逐字 message_utils.py:97-168 @478f671e6。 */
export const HOST_COMPONENT_TYPES: readonly string[] = ['text', 'image', 'emoji', 'voice', 'file', 'at', 'reply', 'forward', 'dict'];

/** 事件名显式表（蓝图 §2.3：不从 worldId 拼串之外的再造名；.message.self 是 §3.2 行 3）。 */
export const EVENTS = {
  message: 'maibot.message',
  messageSelf: 'maibot.message.self',
  notice: 'maibot.notice',
  connection: 'maibot.connection',
  degraded: 'maibot.degraded',
} as const;

/** 宿主 dict 的宽松视图；total=False，任何键都可能缺席。 */
export interface MessageDictView {
  message_id?: string;
  platform?: string;
  account_id?: string | null;
  session_id?: string;
  is_mentioned?: boolean;
  raw_message?: unknown;
  message_info?: {
    user_info?: { user_id?: string; user_nickname?: string; user_cardname?: string | null };
    group_info?: { group_id?: string; group_name?: string } | null;
  };
  [k: string]: unknown;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/** raw 是不是宿主 MessageDict 形（认一个已知键即可；TypedDict total=False）。 */
export function asMessageDict(raw: unknown): MessageDictView | null {
  if (!isPlainObject(raw)) return null;
  return raw as MessageDictView;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** 段值全字符串化（v11 规则 array.md:23 @d4456ee70）；嵌套容器收进 JSON 串。 */
function flatten(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

/**
 * 宿主形段（data 可为裸串/数组/dict，message_utils.py:97-168）与已 CBP 形段 → 内核 Seg。
 * 型名映射：voice→record（宿主名 vs v11 名）；at 的 target_user_id→qq、
 * cardname‖nickname→name（`at` 参数名照 v11 用 qq，segment.md:167 @d4456ee70）；
 * reply 的 target_message_id→id；at_all 走 {qq:'all'}（_BUILD-PLAN L138，宿主无 atall 键）。
 * 非白名单型名照常出帧，附带降级位（渲染兜底在内核，不吞消息）。
 */
export function hostSegToCbp(input: unknown): { seg: Seg | null; degraded?: string } {
  if (!isPlainObject(input)) return { seg: null, degraded: 'bad-segment' };
  const type = typeof input.type === 'string' ? input.type : '';
  if (!type) return { seg: null, degraded: 'bad-segment' };
  const sibs: Record<string, string> = {};
  if (typeof input.hash === 'string' && input.hash) sibs.hash = input.hash;
  if (typeof input.binary_data_base64 === 'string' && input.binary_data_base64) sibs.base64 = input.binary_data_base64;
  const dataIn = input.data;
  let seg: Seg;
  if (typeof dataIn === 'string') {
    if (type === 'text') seg = { type, data: { text: dataIn } };
    else if (type === 'image' || type === 'emoji') seg = { type, data: { file: dataIn, ...sibs } };
    else if (type === 'voice') seg = { type: 'record', data: { file: dataIn, ...sibs } };
    else seg = { type, data: { value: dataIn, ...sibs } };
  } else if (Array.isArray(dataIn)) {
    seg = { type: 'forward', data: { count: String(dataIn.length), nodes: JSON.stringify(dataIn) } };
  } else if (isPlainObject(dataIn)) {
    if (type === 'at') {
      const qq = str(dataIn.target_user_id);
      const name = str(dataIn.target_user_cardname) || str(dataIn.target_user_nickname);
      seg = { type, data: name ? { qq, name } : { qq } };
    } else if (type === 'reply') {
      seg = { type, data: { id: str(dataIn.target_message_id) } };
    } else {
      seg = { type, data: flatten(dataIn) };
    }
  } else {
    seg = { type, data: { ...sibs } };
  }
  return isKnownType(seg.type) ? { seg } : { seg, degraded: `unknown-segment:${seg.type}` };
}

/** 自发回声判据：CBP sender.id === MessageDict.account_id（:50；桥不另造字段）。 */
export function isSelfEcho(f: Pick<MsgFrame, 'sender' | 'raw'>): boolean {
  const raw = asMessageDict(f.raw);
  const acct = raw ? str(raw.account_id) : '';
  return acct !== '' && f.sender.id === acct;
}

/** 会话键回落：conv 空 → session_id（:60）。§3.2 差异表 conv=stream_id 由桥侧填 conv。 */
export function convOf(f: Pick<MsgFrame, 'conv' | 'raw'>): string {
  if (f.conv) return f.conv;
  const raw = asMessageDict(f.raw);
  return raw ? str(raw.session_id) : '';
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** 扩展名 → 图片 MIME；认不出的（avif 等）返回 null，附件宁缺勿错标。 */
export function mimeFromHint(hint: string | undefined): string | null {
  if (!hint) return null;
  const m = /\.([a-zA-Z0-9]+)$/.exec(hint);
  return m ? MIME_BY_EXT[m[1]!.toLowerCase()] ?? null : null;
}

/**
 * CBP image 段 → 宿主 BlobInput（bytes+mime+fallbackText）。
 * 只认 data.base64 内联二进制；无二进制（外部 URL）或 MIME 判不出 → null，
 * 正文里的 `[图片]` 占位仍由内核 renderSegments 保留。
 */
export function imageSegToBlob(seg: Seg): { bytes: Uint8Array; mime: string; fallbackText: string } | null {
  if (seg.type !== 'image') return null;
  const b64 = seg.data.base64 ?? '';
  if (!b64) return null;
  const mime = seg.data.mime || mimeFromHint(seg.data.file || seg.data.url);
  if (!mime) return null;
  try {
    return { bytes: Uint8Array.from(Buffer.from(b64, 'base64')), mime, fallbackText: '[图片]' };
  } catch {
    return null;
  }
}
