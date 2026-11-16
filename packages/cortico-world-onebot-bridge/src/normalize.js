/**
 * 纯函数：v11 事件 → 判别 kind、可读正文、段渲染、正文裁剪。
 *
 * 没有 IO，不 import 驱动 / ws，所以可单独 node --test。
 * 未知段一律 `[<type>]` 兜底、不吞消息（蓝图硬规则 / C1-16）；
 * meta.raw 恒留原始载荷，正文只是给人/模型看的一行。
 */
import { REQUIRED_MESSAGE_FIELDS } from './config.js';

/** 判别键树 post_type → *_type → sub_type（r-nonebot-onebot.md:120）；消息 sub_type 不进 kind。 */
export function eventKind(ev) {
  const type = ev?.message_type ?? ev?.notice_type ?? ev?.request_type ?? ev?.meta_event_type;
  const parts = [ev?.post_type, type];
  if (ev?.post_type !== 'message' && ev?.sub_type) parts.push(ev.sub_type);
  return parts.filter((p) => p !== undefined && p !== null && p !== '').join('/') || 'unknown';
}

/** message 事件是否带齐字段；缺 raw_message/font 会退化通用 Event，此处如实标记。 */
export function isWellFormedMessage(ev) {
  if (ev?.post_type !== 'message') return false;
  return REQUIRED_MESSAGE_FIELDS.every((f) => ev[f] !== undefined && ev[f] !== null);
}

export function renderSegment(seg) {
  if (typeof seg === 'string') return seg;
  const type = seg?.type;
  const data = seg?.data && typeof seg.data === 'object' ? seg.data : {};
  switch (type) {
    case 'text': return String(data.text ?? '');
    case 'at': return `@${data.qq === 'all' ? '全体成员' : (data.name || data.qq || '')}`;
    case 'reply': return `[回复 #${data.id ?? ''}]`;
    case 'image': return data.file || data.url ? `[图片 ${data.summary || data.file || data.url}]` : '[图片]';
    case 'face': return `[表情 ${data.id ?? ''}]`;
    case 'record': return `[语音 ${data.file || data.url || ''}]`;
    case 'video': return '[视频]';
    case 'forward': return data.id ? `[转发 #${data.id}]` : '[转发]';
    case 'json':
    case 'xml': return '[卡片]';
    case 'poke': return '[戳一戳]';
    case 'dice': return data.result ? `[骰子 ${data.result}]` : '[骰子]';
    case 'rps': return data.result ? `[猜拳 ${data.result}]` : '[猜拳]';
    // 未知段兜底：保留占位，绝不返回空导致整条消息消失。
    default: return type ? `[${type}]` : '';
  }
}

export function renderMessage(ev) {
  const label = ev?.message_type === 'group'
    ? `群${ev.group_id ?? '?'}`
    : ev?.message_type === 'private'
      ? `私聊${ev.user_id ?? '?'}`
      : (ev?.message_type ?? '消息');
  const sender = ev?.sender?.card || ev?.sender?.nickname || String(ev?.user_id ?? '?');
  const raw = ev?.message;
  const body = typeof raw === 'string'
    ? raw
    : Array.isArray(raw) ? raw.map(renderSegment).join('') : '';
  const id = ev?.message_id !== undefined ? ` #${ev.message_id}` : '';
  return `[${label}] ${sender}(${ev?.user_id ?? '?'}): ${body || '[空消息]'}${id}`;
}

export function capText(value, maxChars = 4000) {
  const text = String(value ?? '');
  const max = Number(maxChars);
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

export function compactJson(value, maxChars = 4000) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return capText(text, maxChars);
}

export function eventTs(ev) {
  const seconds = Number(ev?.time);
  const date = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
  return date.toISOString();
}
