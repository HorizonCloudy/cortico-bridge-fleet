/**
 * KoishiBridgeWorld：Cortico 侧 Koishi 插件兼容入口的 v1 薄壳。
 *
 * 口径（gate.md C-7）：本包不写 Koishi 协议码——它用 OneBot v11 正向 WS 拨
 * NapCat 类实现端，再叠 catalog 选择逻辑（连上后 get_version_info → app_name →
 * 实现 id → 扩展白名单展示）。线协议与先例 cortico-world-onebot-bridge 同源。
 *
 * 工具名强制 koishi_* 前缀（gate C-1）：两 world 同装时 cortico 的 byWorld 按
 * 工具名建 Map、后装覆盖前装且全程不报错（bot.ts:1146-1155 @836238311），
 * 撞名会静默劫持先例包的调用路由，所以本包从命名上钉死 koishi 前缀不撞。
 *
 * 不实现 outputTap()（蓝图 §3.3：桥包一律不实现），出站只经工具 handler。
 * gateAction 三门顺序与未知即写原样 copy 自先例 src/world.js:34 @c85a87b24（gate C-6）。
 */
import {
  DEFAULTS, EVENT_CONNECTION, EVENT_MESSAGE, EVENT_NOTICE, EVENT_REQUEST, ID, REQUIRED_MESSAGE_FIELDS, readConfig,
} from './config.js';
import { actionInfo, coverage, extensionsFor, listCategories, searchActions, V11_EVENT_KINDS } from './catalog.js';
import { detectImplementation } from './implementations.js';
import { OneBotDriver } from './driver.js';
import { guardParams, guardActionName } from './guard.js';

const fail = (text) => ({ text, failed: true });

/** 凭证动作名（SECURITY-CBP.md:125）：不进目录，dispatcher 名字闸命中即拒 10002（errors.ts:11 在册）。 */
export const FORBIDDEN_CREDENTIAL_ACTIONS = Object.freeze(['get_cookies', 'get_csrf_token', 'get_credentials']);

/**
 * 纯函数：koishi_call 门序，按 SECURITY-CBP §1.3（:36-40）与 §3.5（:125）固定顺序：
 * 1. 名字闸：凭证动作一律 10002，排最前，不看其余条件也不出网（摘目录后 entry=null，
 *    若无此闸会被「未知动作按写」在 writePolicy=allow 下透传，正是 §3.5 要堵的路）。
 * 2. 写动作身份闸（错序→缺 actor→缺 self→anon）：身份只认本轮入站记录 msg 与实证 self，
 *    查无回 60004（§1.3-2）；member 缺位 anon=unknown、self 未实证无法判 anon，均只许只读。
 * 3. 策略闸：readOnly / writePolicy / confirm；confirm 只在 anon=="identified" 走到（§1.3-3，
 *    堵掉 koishi_call 自报 confirm 的洞——args 自报的 actor/turn 根本进不了本函数）。
 * 目录外动作已由 #callTool 第 1 闸拒掉；走到这里时 entry 必非 null。
 */
export function gateAction({ name, entry, readOnly, writePolicy, confirm, msg = null, selfId = null }) {
  if (FORBIDDEN_CREDENTIAL_ACTIONS.includes(name)) {
    return { block: true, reason: `${name}: 10002 unsupported_action: 凭证动作不进桥。` };
  }
  const isWrite = entry ? !entry.readOnly : true;
  if (isWrite) {
    if (!msg) return { block: true, reason: `${name}: 60004 unknown_session: 本轮没有入站消息记录，发起方无从实证。` };
    if (msg.userId === undefined || msg.userId === null || msg.userId === '') {
      return { block: true, reason: `${name}: 入站记录缺发起方（anon=unknown），只允许只读动作。` };
    }
    if (!(Number(selfId) > 0)) return { block: true, reason: `${name}: self 未实证（无 get_login_info 结果），anon 无从判定，写动作不执行。` };
    const anon = Number(msg.userId) === Number(selfId) ? 'self' : (msg.anonymous ? 'anonymous' : 'identified');
    if (anon !== 'identified') {
      return { block: true, reason: `${name}: 发起方是 ${anon}，写动作不收自报 confirm，只允许只读动作。` };
    }
  }
  if (isWrite && readOnly) return { block: true, reason: `${name} 是写动作，当前处于只读模式。` };
  if (isWrite && writePolicy === 'deny') return { block: true, reason: `${name} 是写动作，写策略为 deny。` };
  if (isWrite && writePolicy === 'confirm' && confirm !== true) {
    return { block: true, reason: `${name} 需要 confirm=true 才能执行写操作。` };
  }
  return { block: false, isWrite };
}

/** 判别键树 post_type → *_type → sub_type（r-nonebot-onebot.md:120）；消息 sub_type 不进 kind。 */
function eventKind(ev) {
  const type = ev?.message_type ?? ev?.notice_type ?? ev?.request_type ?? ev?.meta_event_type;
  const parts = [ev?.post_type, type];
  if (ev?.post_type !== 'message' && ev?.sub_type) parts.push(ev.sub_type);
  return parts.filter((p) => p !== undefined && p !== null && p !== '').join('/') || 'unknown';
}

function isWellFormedMessage(ev) {
  if (ev?.post_type !== 'message') return false;
  return REQUIRED_MESSAGE_FIELDS.every((f) => ev[f] !== undefined && ev[f] !== null);
}

/** 未知段一律 [<type>] 兜底、不吞消息（蓝图硬规则，同先例 normalize.js）。 */
function renderSegment(seg) {
  if (typeof seg === 'string') return seg;
  const data = seg?.data && typeof seg.data === 'object' ? seg.data : {};
  switch (seg?.type) {
    case 'text': return String(data.text ?? '');
    case 'at': return `@${data.qq === 'all' ? '全体成员' : (data.name || data.qq || '')}`;
    default: return `[${String(seg?.type ?? 'unknown')}]`;
  }
}

function renderMessage(ev) {
  if (typeof ev?.message === 'string') return ev.message;
  if (Array.isArray(ev?.message)) return ev.message.map(renderSegment).join(' ').trim();
  return String(ev?.raw_message ?? '');
}

function capText(text, max) {
  const s = String(text ?? '');
  const n = Number(max) > 0 ? Number(max) : DEFAULTS.maxEventChars;
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function compactJson(obj, max) {
  let s;
  try { s = JSON.stringify(obj); } catch { s = String(obj); }
  return capText(s, max);
}

/**
 * 纯函数：v11 事件 → 投递决策（type / deliver / meta 标记 / 正文）。无 IO。
 * 自发回声与 meta_event 只归档（deliver:false，蓝图硬规则）；dropKinds 优先丢弃。
 */
export function projectEvent(ev, { selfId, dropKinds = [], maxChars = DEFAULTS.maxEventChars } = {}) {
  const kind = eventKind(ev);
  if (dropKinds.includes(kind)) return { drop: true, kind };

  const post = ev?.post_type;
  let type;
  let deliver = true;
  if (post === 'message') type = EVENT_MESSAGE;
  else if (post === 'request') type = EVENT_REQUEST;
  else if (post === 'notice') type = EVENT_NOTICE;
  else if (post === 'meta_event') { type = EVENT_NOTICE; deliver = false; }
  else return { drop: true, kind };

  const hasSelf = Number.isFinite(Number(selfId)) && Number(selfId) > 0;
  const isSelf = post === 'message' && hasSelf && Number(ev?.user_id) === Number(selfId);
  if (isSelf) deliver = false;

  const malformed = post === 'message' && !isWellFormedMessage(ev);
  const text = capText(
    post === 'message' ? renderMessage(ev) : `[${kind}] ${compactJson(ev, maxChars)}`,
    maxChars,
  );
  // 畸形 time（'abc'、null、0、负数）必须回落当下时刻：new Date(NaN).toISOString() 抛
  // RangeError，异常沿 #handleEvent 的 Promise 落进 onEvent catch，整条消息事件被吞。
  // 形状照先例 cortico-world-onebot-bridge/src/normalize.js:79-83 eventTs。
  const seconds = Number(ev?.time);
  const ts = (post === 'message' && Number.isFinite(seconds) && seconds > 0)
    ? new Date(seconds * 1000).toISOString()
    : new Date().toISOString();
  const meta = { kind, raw: ev, ...(isSelf ? { self: true } : {}), ...(malformed ? { malformed: true } : {}) };
  return {
    drop: false, kind, post, type, deliver, ts,
    senderKey: ev?.user_id !== undefined ? String(ev.user_id) : undefined,
    text, meta,
  };
}

/** 工具声明：definition.describe.tools 与 world.tools() 都由它派生，避免漂移。 */
export const KOISHI_TOOL_DECLS = [
  {
    name: 'koishi_call',
    tags: ['act'],
    description: 'Call only actions from the static v11 catalog on the dialed implementation (NapCat-style forward WebSocket; this world speaks no Koishi protocol). Implementation-specific extension actions are no longer forwarded (10002). Any local file reference in params - drive letters, UNC, absolute paths, .., file:// or [CQ:*,file=...] - is refused before the call leaves the process; media must be an http(s) URL or base64 data. Read-only actions run immediately. Write actions run only on a turn with an identified inbound sender (a turn without an inbound message is refused, 60004) and follow writePolicy (default: confirm=true required). Credential actions get_cookies/get_csrf_token/get_credentials are not served (10002).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'v11 action name, e.g. send_group_msg or get_group_info.' },
        params: { type: 'object', additionalProperties: true, description: 'The action params object.' },
        confirm: { type: 'boolean', description: 'Set true to execute a write action under the confirm policy.' },
        timeout_ms: { type: 'integer', description: 'Optional call timeout in milliseconds.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'koishi_actions',
    tags: ['read'],
    description: 'Look up the OneBot v11 action catalog with implementation selection. No args lists categories, coverage and the detected implementation (extensions whitelist is a guessed starting value: empty, display-only); query searches name/summary; name returns one entry.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search action name or summary.' },
        name: { type: 'string', description: 'Return the catalog entry for this action.' },
      },
    },
  },
  {
    name: 'koishi_events',
    tags: ['read'],
    description: 'Read archived OneBot v11 events by kind/time. kind supports * globs (e.g. notice/*).',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Event kind or glob: message/group, notice/group_recall, meta_event/*.' },
        limit: { type: 'integer', description: 'Max events (1-100, default 30).' },
        raw: { type: 'boolean', description: 'Include meta.raw. Default true.' },
      },
    },
  },
  {
    name: 'koishi_status',
    tags: ['read'],
    description: 'Bridge connection, account, detected implementation, v11 coverage and current write policy.',
    parameters: { type: 'object', properties: {} },
  },
];

const TOOL_NAMES = KOISHI_TOOL_DECLS.map((t) => t.name);
const KNOWN_EVENTS = V11_EVENT_KINDS.map((e) => e.kind);

export class KoishiBridgeWorld {
  #cfg; #timezone; #persist; #host = null; #driver = null; #log = null;
  #status = { connected: false, selfId: null, nickname: '' };
  #impl = { id: '', label: '' };
  /** F3：本轮最近一条入站 message 的实证记录（v11 线 turn/actor 唯一来源，§1.3-1）。 */
  #lastMsg = null;

  constructor(opts = {}) {
    this.id = ID;
    this.#cfg = opts.cfg ?? {};
    this.#timezone = opts.timezone ?? '';
    this.#persist = typeof opts.persist === 'function' ? opts.persist : null;
  }

  get #s() { return readConfig(this.#cfg); }

  envPromptVars() { return {}; }

  async start(host) {
    this.#host = host;
    this.#log = host.log ?? null;
    this.#lastConnection = null;
    const s = this.#s;
    const token = String(process.env.KOISHI_TOKEN ?? '').trim() || String(s.token ?? '');
    const driver = new OneBotDriver({
      wsUrl: String(s.wsUrl ?? DEFAULTS.wsUrl),
      token,
      log: host.log?.child?.('driver') ?? host.log,
      apiTimeoutMs: Number(s.apiTimeoutMs) || DEFAULTS.apiTimeoutMs,
      reconnectBaseMs: Number(s.reconnectBaseMs) || DEFAULTS.reconnectBaseMs,
      reconnectMaxMs: Number(s.reconnectMaxMs) || DEFAULTS.reconnectMaxMs,
    });
    this.#driver = driver;
    driver.onEvent((ev) => { void this.#handleEvent(ev).catch((err) => this.#log?.warn?.('event handling failed', { error: String(err) })); });
    driver.onReady((idn) => {
      // catalog 选择：驱动 #initIdentity 已带回 get_version_info，识别只做展示分流、不动工具集。
      this.#impl = detectImplementation(idn?.version);
      this.#status = { connected: true, selfId: idn?.selfId ?? null, nickname: idn?.nickname ?? '' };
      this.#pushConnection(true, idn);
    });
    driver.onStatus((st) => { if (!st.connected) { this.#status = { ...this.#status, connected: false }; this.#pushConnection(false, null, st.error); } });

    // start() 永不 reject：连接等待封顶 connectWaitMs，超时后放行、后台继续重连。
    await Promise.race([
      driver.start(),
      new Promise((resolve) => setTimeout(resolve, Number(s.connectWaitMs) || DEFAULTS.connectWaitMs)),
    ]);
  }

  async stop() {
    const driver = this.#driver;
    this.#driver = null; this.#host = null;
    this.#status = { ...this.#status, connected: false };
    if (driver) await driver.stop();
  }

  tools() {
    return [
      { ...KOISHI_TOOL_DECLS[0], handler: (args) => this.#callTool(args ?? {}) },
      { ...KOISHI_TOOL_DECLS[1], handler: (args) => this.#actionsTool(args ?? {}) },
      { ...KOISHI_TOOL_DECLS[2], handler: (args) => this.#eventsTool(args ?? {}) },
      { ...KOISHI_TOOL_DECLS[3], handler: () => this.#statusTool() },
    ];
  }

  async #callTool(args) {
    const s = this.#s;
    const name = String(args.action ?? '').trim();
    if (!name) return fail('koishi_call 需要 action 名。');
    const params = args.params && typeof args.params === 'object' ? args.params : {};
    // 第 0 闸：本机文件引用（10-22 判例）。排在所有判定之前，命中即拒且绝不出网。
    const fileGuard = guardParams(params);
    if (fileGuard.block) return fail(fileGuard.reason);
    // 第 1 闸：动作名白名单。能力面由包内静态目录决定，模型不能运行时发明 action。
    const entry = actionInfo(name);
    const nameGuard = guardActionName(name, entry);
    if (nameGuard.block) return fail(nameGuard.reason);
    const gate = gateAction({
      name, entry, readOnly: s.readOnly, writePolicy: s.writePolicy, confirm: args.confirm,
      msg: this.#lastMsg, selfId: this.#status.selfId,
    });
    if (gate.block) return fail(gate.reason);
    const driver = this.#driver;
    if (!driver || !driver.connected) return fail(`${name}: OneBot 实现端未连接。`);
    const res = await driver.callSafe(name, params, args.timeout_ms);
    if (!res.ok) return fail(`${name} 失败：${res.error}`);
    const note = name === 'delete_msg'
      ? '（OneBot ok 只代表撤回包已发出，不代表 QQ 已撤回；收到 notice/group_recall 前不要声称成功）'
      : '';
    return { text: capText(`${name} ok: ${JSON.stringify(res.data)}${note}`, 20000) };
  }

  #actionsTool(args) {
    if (args.name) {
      const entry = actionInfo(String(args.name));
      return { text: entry ? JSON.stringify(entry) : `未收录 ${args.name}：目录外扩展动作不再透传（10002）；如确需启用，请登记进 src/catalog.js。` };
    }
    if (args.query) {
      const hits = searchActions(String(args.query));
      return { text: hits.length ? JSON.stringify(hits.map(({ name, readOnly, summary }) => ({ name, readOnly, summary }))) : `无匹配：${args.query}` };
    }
    return { text: JSON.stringify({
      categories: listCategories(),
      coverage: coverage(),
      implementation: this.#impl,
      extensions: extensionsFor(this.#impl.id),
    }) };
  }

  #eventsTool(args) {
    const host = this.#host;
    if (!host?.store?.range) return fail('事件库不可用。');
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 30));
    const glob = args.kind ? String(args.kind) : '';
    const items = host.store.range({ limit }) ?? [];
    const matched = items.filter((e) => glob && matchKind(e?.meta?.kind, glob)).slice(0, limit);
    const out = matched.map((e) => (args.raw === false
      ? { ts: e.ts, kind: e?.meta?.kind, text: e.text }
      : { ts: e.ts, kind: e?.meta?.kind, text: e.text, raw: e?.meta?.raw }));
    return { text: JSON.stringify(out) };
  }

  #statusTool() {
    const s = this.#s;
    return {
      text: JSON.stringify({
        connected: this.#status.connected,
        selfId: this.#status.selfId,
        nickname: this.#status.nickname,
        implementation: this.#impl,
        wsUrl: s.wsUrl,
        writePolicy: s.writePolicy,
        readOnly: s.readOnly,
        coverage: coverage(),
        knownEvents: KNOWN_EVENTS.length,
        tools: TOOL_NAMES,
      }),
    };
  }

  async #handleEvent(ev) {
    const host = this.#host;
    if (!host) return;
    const s = this.#s;
    // F3 入站登记：到达即记（先于投递决策），dropKinds 丢的是投递不是实证；只存身份三件，不存正文。
    if (ev?.post_type === 'message') {
      this.#lastMsg = { messageId: ev.message_id ?? null, userId: ev.user_id ?? null, anonymous: Boolean(ev.anonymous) };
    }
    const plan = projectEvent(ev, {
      selfId: this.#driver?.identity?.selfId,
      dropKinds: s.dropKinds,
      maxChars: Number(s.maxEventChars) || DEFAULTS.maxEventChars,
    });
    if (plan.drop) return;
    // 无 blobs：v1 薄壳不下载图片；有 blob 时投递前须问 host.modelFacts.accepts（蓝图硬规则）。
    await host.pushEvent(
      { type: plan.type, ts: plan.ts, source: ID, text: plan.text, senderKey: plan.senderKey, meta: plan.meta },
      { deliver: plan.deliver, trigger: 'debounce' },
    );
  }

  #lastConnection = null;

  #pushConnection(connected, idn, error = '') {
    const host = this.#host;
    if (!host || this.#lastConnection === connected) return;
    this.#lastConnection = connected;
    // F3：断线清轮次记录，旧 turn/actor 不跨连接复用；实现识别随连接作废。
    if (!connected) { this.#lastMsg = null; this.#impl = { id: '', label: '' }; }
    const who = idn?.nickname || (idn?.selfId != null ? String(idn.selfId) : '');
    const impl = this.#impl.id ? `（实现 ${this.#impl.label}）` : '';
    const text = connected ? `[系统] Koishi 桥已连接${impl}${who ? `：${who}` : ''}` : `[系统] Koishi 桥连接断开${error ? `：${error}` : ''}`;
    void host.pushEvent({
      type: EVENT_CONNECTION, ts: new Date().toISOString(), source: ID, text,
      meta: { kind: connected ? 'connection/ready' : 'connection/closed', connected, selfId: idn?.selfId ?? null, implementation: this.#impl, error },
    }, { trigger: 'debounce' }).catch((err) => this.#log?.warn?.('connection push failed', { error: String(err) }));
  }
}

function matchKind(kind, glob) {
  if (!kind) return false;
  if (glob === '*') return true;
  if (!glob.includes('*')) return kind === glob;
  const re = new RegExp(`^${glob.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(kind);
}

export { TOOL_NAMES as KOISHI_TOOL_NAMES };
