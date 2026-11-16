/**
 * Segment vocabulary (OneBot v11 `{type,data}`, every value a string — array.md:23
 * @d4456ee70). The online-type whitelist is the 20 types measured live in r-nonebot §2.3;
 * `at` uses the v11 parameter name `qq` (segment.md:167 @d4456ee70).
 *
 * C1-16 (r-neko §5/§9-8): N.E.K.O's SDK does not validate part type and forwards a pdf part
 * untouched, so the "unknown segment → `[<type>]`, never swallow the message" fallback is
 * implemented here once, in the kernel. Framework adapters must not re-implement it.
 *
 * renderSegment follows the onebot-prior-art table (render.js:32-85 @2e91b7fb1). CQ-code
 * round-trip follows r-nonebot §2.3 (str() of a parsed CQ string is byte-identical).
 */
import type { Seg } from './frames.js';

/** 20 online wire types, verbatim from r-nonebot §2.3. */
export const WIRE_SEGMENT_TYPES: readonly string[] = [
  'text',
  'face',
  'image',
  'record',
  'video',
  'at',
  'rps',
  'dice',
  'shake',
  'poke',
  'anonymous',
  'share',
  'contact',
  'location',
  'music',
  'reply',
  'forward',
  'node',
  'json',
  'xml',
];

/** Types CBP keeps first-class even though no v11 channel carries them (c1 §5.2). */
export const CBP_FIRST_CLASS_TYPES: readonly string[] = ['markdown', 'button'];

const WIRE_SET = new Set(WIRE_SEGMENT_TYPES);
const CBP_SET = new Set(CBP_FIRST_CLASS_TYPES);

/** True if a v11 channel can carry this type without degradation. */
export function isWireType(type: string): boolean {
  return WIRE_SET.has(type);
}

/** True for types CBP keeps as first-class but that any v11 channel must degrade. */
export function isCbpOnlyType(type: string): boolean {
  return CBP_SET.has(type);
}

/** True for anything the kernel will render by name; everything else hits `[<type>]`. */
export function isKnownType(type: string): boolean {
  return WIRE_SET.has(type) || CBP_SET.has(type);
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Coerce any `{type,data}` input into wire form with every value a string
 * (v11 rule array.md:23). Null/undefined values are dropped; a bad input
 * becomes `{type:'text',data:{text:'[<type>]'}}`? No — returns null so the
 * caller keeps its own fallback. A `text` segment is always valid output.
 */
export function coerceSegment(input: unknown): Seg | null {
  if (!isPlainObject(input)) return null;
  const type = typeof input.type === 'string' ? input.type : '';
  if (!type) return null;
  const dataIn = isPlainObject(input.data) ? input.data : {};
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(dataIn)) {
    if (v === null || v === undefined) continue;
    data[k] = typeof v === 'string' ? v : String(v);
  }
  return { type, data };
}

/** Coerce a whole list, dropping non-object entries so the kernel never sees a bare string seg. */
export function coerceSegments(input: unknown): Seg[] {
  if (!Array.isArray(input)) return [];
  const out: Seg[] = [];
  for (const e of input) {
    const s = coerceSegment(e);
    if (s) out.push(s);
  }
  return out;
}

/** at_all → `{type:'at',data:{qq:'all'}}` (_BUILD-PLAN L138); AstrBot/neko each special-case the reverse. */
export function atAllSegment(): Seg {
  return { type: 'at', data: { qq: 'all' } };
}

/** True for the at_all wire form. */
export function isAtAll(seg: Seg): boolean {
  return seg.type === 'at' && seg.data.qq === 'all';
}

/** Render one segment to a text label; unknown type falls back to `[<type>]` (never '' → message survives). */
export function renderSegment(seg: Seg): string {
  const d = seg.data;
  switch (seg.type) {
    case 'text':
      return d.text ?? '';
    case 'at': {
      const who = d.qq === 'all' ? '全体成员' : d.name || d.qq || '';
      return `@${who}`;
    }
    case 'reply':
      return `[回复 #${d.id ?? ''}]`;
    case 'image': {
      const label = d.summary || d.file || d.url || '';
      return label ? `[图片 ${label}]` : '[图片]';
    }
    case 'face':
      return `[表情 ${d.id ?? ''}]`;
    case 'record': {
      const label = d.file || d.url || '';
      return label ? `[语音 ${label}]` : '[语音]';
    }
    case 'video': {
      const label = d.file || d.url || '';
      return label ? `[视频 ${label}]` : '[视频]';
    }
    case 'file': {
      const label = d.name || d.file || '';
      return label ? `[文件 ${label}]` : '[文件]';
    }
    case 'forward':
      return d.id ? `[转发 #${d.id}]` : '[转发]';
    case 'node':
      return '[转发节点]';
    case 'json':
    case 'xml':
      return '[卡片]';
    case 'poke':
      return '[戳一戳]';
    case 'dice':
      return d.result ? `[骰子 ${d.result}]` : '[骰子]';
    case 'rps':
      return d.result ? `[猜拳 ${d.result}]` : '[猜拳]';
    case 'shake':
      return '[抖动]';
    case 'anonymous':
      return '[匿名]';
    case 'share':
      return d.url ? `[分享 ${d.url}]` : '[分享]';
    case 'contact': {
      const label = d.qq || d.user_id || d.group_id || '';
      return label ? `[推荐 ${label}]` : '[推荐]';
    }
    case 'location':
      return d.name ? `[定位 ${d.name}]` : '[定位]';
    case 'music':
      return d.url ? `[音乐 ${d.url}]` : '[音乐]';
    case 'markdown':
      return '[Markdown]';
    case 'button':
      // aiocqhttp official degrade copy (c1 §5.2); label kept, button itself lost.
      return `[Button unavailable] ${d.label ?? ''}`.trimEnd();
    default:
      // C1-16: an unknown type keeps its name so the message is never swallowed whole.
      return `[${seg.type}]`;
  }
}

/** Render a whole message to text. Unknown segments degrade, they never erase the rest. */
export function renderSegments(segs: readonly Seg[]): string {
  return segs.map(renderSegment).join('');
}

/** Plain text only (text segments joined), for title/history previews. */
export function plainText(segs: readonly Seg[]): string {
  return segs
    .filter((s) => s.type === 'text')
    .map((s) => s.data.text ?? '')
    .join('');
}

/** CQ escape per v11: `]`→`,`, `,`→`%2C` (public CQ-code convention, r-nonebot §2.3). */
function cqEscape(value: string): string {
  return value.replace(/]/g, ',').replace(/,/g, '%2C');
}
function cqUnescape(value: string): string {
  return value.replace(/%2C/g, ',').replace(/,/g, ']');
}

/** One segment → CQ token; `text` becomes raw text with `CQ` markers still escaped. */
export function segToCq(seg: Seg): string {
  if (seg.type === 'text') return (seg.data.text ?? '').replace(/,/g, '%2C').replace(/]/g, ',');
  const parts = Object.entries(seg.data)
    .filter(([k]) => k !== 'text')
    .map(([k, v]) => `${k}=${cqEscape(v)}`);
  return `[CQ:${seg.type}${parts.length ? ',' + parts.join(',') : ''}]`;
}

export function segmentsToCq(segs: readonly Seg[]): string {
  return segs.map(segToCq).join('');
}

/**
 * Parse a CQ-code string into segments. Text runs between tokens become `text`
 * segments (verbatim, spaces kept, as measured in r-nonebot §2.3).
 */
export function cqToSegments(input: string): Seg[] {
  const out: Seg[] = [];
  const re = /\[CQ:([a-zA-Z0-9_]+)((?:,[^\]=]+=[^\],]*)*)]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (m.index > last) out.push({ type: 'text', data: { text: cqUnescape(input.slice(last, m.index)) } });
    const type = m[1];
    const data: Record<string, string> = {};
    if (m[2]) {
      for (const pair of m[2].replace(/^,/, '').split(',')) {
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        data[pair.slice(0, eq)] = cqUnescape(pair.slice(eq + 1));
      }
    }
    out.push({ type, data });
    last = m.index + m[0].length;
  }
  if (last < input.length) out.push({ type: 'text', data: { text: cqUnescape(input.slice(last)) } });
  return out;
}
