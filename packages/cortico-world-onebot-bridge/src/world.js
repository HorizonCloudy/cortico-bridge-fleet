/**
 * OneBotBridgeWorld：Cortico 侧 OneBot v11 World 实例与工具声明。
 *
 * 两个通用面（对齐 reality 先例 cortico-world-onebot@2e91b7fb1）：
 *   action —— 一个 onebot_call dispatcher + onebot_actions 查目录；
 *   event  —— 一条 WS 全量收，message 可读化，其余压成一行 JSON，原始留 meta.raw。
 * 没有 per-action 的 send_xxx 工具；新增能力只改 catalog 或配置。
 *
 * 不实现 outputTap()（蓝图 §3.3：桥包一律不实现），出站只经工具 handler。
 * 入站写事件只经 host.pushEvent 家族；World 无 send/on/storage（d-cortico-side §1.1）。
 */
import {
  DEFAULTS, EVENT_CONNECTION, EVENT_MESSAGE, EVENT_NOTICE, EVENT_REQUEST, ID, readConfig,
} from './config.js';
import { actionInfo, coverage, listCategories, searchActions, V11_EVENT_KINDS } from './catalog.js';
import { compactJson, eventKind, eventTs, isWellFormedMessage, renderMessage, capText } from './normalize.js';
import { OneBotDriver } from './driver.js';

const fail = (text) => ({ text, failed: true });

/** 凭证动作名（SECURITY-CBP.md:125）：不进目录，dispatcher 名字闸命中即拒 10002（errors.ts:11 在册）。 */
export const FORBIDDEN_CREDENTIAL_ACTIONS = Object.freeze(['get_cookies', 'get_csrf_token', 'get_credentials']);

/**
 * 纯函数：onebot_call 门序，按 SECURITY-CBP §1.3（:36-40）与 §3.5（:125）固定顺序：
 * 1. 名字闸：凭证动作一律 10002，排最前，不看其余条件也不出网（摘目录后 entry=null，
 *    若无此闸会被「未知动作按写」在 writePolicy=allow 下透传，正是 §3.5 要堵的路）。
 * 2. 写动作身份闸（错序→缺 actor→缺 self→anon）：身份只认本轮入站记录 msg 与实证 self，
 *    查无回 60004（§1.3-2）；member 缺位 anon=unknown、self 未实证无法判 anon，均只许只读。
 * 3. 策略闸：readOnly / writePolicy / confirm；confirm 只在 anon=="identified" 走到（§1.3-3，
 *    堵掉 onebot_call 自报 confirm 的洞——args 自报的 actor/turn 根本进不了本函数）。
 * 未知/扩展动作按写处理（entry==null → isWrite=true），交给策略拦。
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
  const meta = { kind, raw: ev, ...(isSelf ? { self: true } : {}), ...(malformed ? { malformed: true } : {}) };
  return {
    drop: false, kind, post, type, deliver,
    ts: post === 'message' ? eventTs(ev) : new Date().toISOString(),
    senderKey: ev?.user_id !== undefined ? String(ev.user_id) : undefined,
    text, meta,
  };
}

/** 工具声明：definition.describe.tools 与 world.tools() 都由它派生，避免漂移。 */
export const ONEBOT_TOOL_DECLS = [
  {
    name: 'onebot_call',
    tags: ['act'],
    description: 'Call any OneBot v11 action. Read-only actions run immediately. Write actions run only on a turn with an identified inbound sender (a turn without an inbound message is refused, 60004) and follow writePolicy (default: confirm=true required). Credential actions get_cookies/get_csrf_token/get_credentials are not served (10002).',
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
    name: 'onebot_actions',
    tags: ['read'],
    description: 'Look up the OneBot v11 action catalog. No args lists categories; query searches name/summary; name returns one entry.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search action name or summary.' },
        name: { type: 'string', description: 'Return the catalog entry for this action.' },
      },
    },
  },
  {
    name: 'onebot_events',
    tags: ['read'],
    description: 'Read archived OneBot events by kind/time. kind supports * globs (e.g. notice/*).',
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
    name: 'onebot_status',
    tags: ['read'],
    description: 'OneBot connection, account, v11 coverage and current write policy.',
    parameters: { type: 'object', properties: {} },
  },
];

const TOOL_NAMES = ONEBOT_TOOL_DECLS.map((t) => t.name);
const KNOWN_EVENTS = V11_EVENT_KINDS.map((e) => e.kind);

export class OneBotBridgeWorld {
  #cfg; #timezone; #persist; #host = null; #driver = null; #log = null;
  #status = { connected: false, selfId: null, nickname: '' };
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
    const token = String(process.env.ONEBOT_TOKEN ?? '').trim() || String(s.token ?? '');
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
    driver.onReady((idn) => { this.#status = { connected: true, selfId: idn?.selfId ?? null, nickname: idn?.nickname ?? '' }; this.#pushConnection(true, idn); });
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
      { ...ONEBOT_TOOL_DECLS[0], handler: (args) => this.#callTool(args ?? {}) },
      { ...ONEBOT_TOOL_DECLS[1], handler: (args) => this.#actionsTool(args ?? {}) },
      { ...ONEBOT_TOOL_DECLS[2], handler: (args) => this.#eventsTool(args ?? {}) },
      { ...ONEBOT_TOOL_DECLS[3], handler: () => this.#statusTool() },
    ];
  }

  async #callTool(args) {
    const s = this.#s;
    const name = String(args.action ?? '').trim();
    if (!name) return fail('onebot_call 需要 action 名。');
    const gate = gateAction({
      name, entry: actionInfo(name), readOnly: s.readOnly, writePolicy: s.writePolicy, confirm: args.confirm,
      msg: this.#lastMsg, selfId: this.#status.selfId,
    });
    if (gate.block) return fail(gate.reason);
    const driver = this.#driver;
    if (!driver || !driver.connected) return fail(`${name}: OneBot 未连接。`);
    const params = args.params && typeof args.params === 'object' ? args.params : {};
    const res = await driver.callSafe(name, params, args.timeout_ms);
    if (!res.ok) return fail(`${name} 失败：${res.error}`);
    const note = name === 'delete_msg'
      ? '（OneBot ok 只代表撤回包已发出，不代表 QQ 已撤回；收到 notice/group_recall 前不要声称成功）'
      : '';
    return { text: capText(`${name} ok: ${JSON.stringify(res.data)}${note}`, 20000) };
  }

  /**
   * 面板「桥状态」：只读展示连接、自身账号、地址、写策略与动作覆盖度。
   * 面板方法只接受 POST，getMethods 点名的方法才接受 GET（docs/webui.md:83）。
   */
  webUi() {
    return {
      panels: [
        {
          id: 'status',
          title: '桥状态',
          description: '连接、自身账号、地址、写策略、动作覆盖度与事件数。',
          getMethods: ['get'],
        },
      ],
      invoke: async (panel, method) => {
        if (panel === 'status' && method === 'get') {
          const raw = this.#statusTool().text;
          return JSON.parse(raw);
        }
        return { error: `unknown panel/method: ${panel}/${method}` };
      },
    };
  }

  #actionsTool(args) {
    if (args.name) {
      const entry = actionInfo(String(args.name));
      return { text: entry ? JSON.stringify(entry) : `未收录 ${args.name}：可能是实现端扩展动作，可直接用 onebot_call 调用。` };
    }
    if (args.query) {
      const hits = searchActions(String(args.query));
      return { text: hits.length ? JSON.stringify(hits.map(({ name, readOnly, summary }) => ({ name, readOnly, summary }))) : `无匹配：${args.query}` };
    }
    return { text: JSON.stringify({ categories: listCategories(), coverage: coverage() }) };
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
    // 无 blobs：本骨架不下载图片；有 blob 时投递前须问 host.modelFacts.accepts（蓝图硬规则）。
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
    // F3：断线清轮次记录，旧 turn/actor 不跨连接复用（先例口径同 cortico-world-neko 断线清账）。
    if (!connected) this.#lastMsg = null;
    const who = idn?.nickname || (idn?.selfId != null ? String(idn.selfId) : '');
    const text = connected ? `[系统] OneBot 已连接${who ? `：${who}` : ''}` : `[系统] OneBot 连接断开${error ? `：${error}` : ''}`;
    void host.pushEvent({
      type: EVENT_CONNECTION, ts: new Date().toISOString(), source: ID, text,
      meta: { kind: connected ? 'connection/ready' : 'connection/closed', connected, selfId: idn?.selfId ?? null, error },
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

export { TOOL_NAMES as ONEBOT_TOOL_NAMES };
