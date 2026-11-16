/**
 * world.ts —— Cortico 侧 `MaibotBridgeWorld` 壳：pushEvent 分档 + `maibot_streams`
 * + tools() 四件（_BUILD-PLAN §2.3 maibot 行 + §3.2 模板）。
 * 帧编解码/传输/档位/段渲染全部复用内核 cortico-bridge-core（本包零复制逻辑）；
 * 本文件只做 maibot 侧的模型字段读取（normalize.ts）与工具面。
 *
 * 方向钉法：本包 listen（桥外拨进来）。依据：MaiBot Runner 子进程只有
 * `cap.call/host.route_message/host.update_message_gateway_state` 三个原始 RPC
 * （upstream/maibot-plugin-sdk maibot_sdk/context.py:137-143 @f9984673d，蓝图 §2.2），
 * 插件侧开不了服务；端口 39702 见 _BUILD-PLAN §4.4 与内核 pins.ts:73。
 *
 * 硬规则落点（d-bridge-priorart §7；闸项=cortico dry-mount.ts:126 @836238311）：
 * create() 纯；start() 12s 放行且永不 reject（内核 driver start 同规则）；
 * 自发回声只归档（deliver:false 是唯一入口，pushEvent 入参 Omit 掉 contextDelivery
 * ——types.ts:692-695 @836238311，与先例 README 的字段级修正同断）；
 * blob 附带前问 modelFacts.accepts；tools() 名字 ⊆ describe.json；
 * 不实现 outputTap()（_BUILD-PLAN §3.3）；meta.raw 恒留（内核 envelope.ts 落）。
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  BridgeDriver,
  RET,
  eventToEnvelope,
  msgToEnvelope,
  newHead,
  noticeToEnvelope,
  renderSegments,
  sanitizeTools,
  type Actor,
  type Anon,
  type DriverState,
  type Frame,
  type Seg,
  type SelfDecl,
  type ToolAnn,
  type ToolRisk,
} from '@horizoncloudy/cortico-bridge-core';
import type { CatalogFrame, CallFrame, EventFrame, MsgFrame, NoticeFrame } from '@horizoncloudy/cortico-bridge-core/frames';
import type { Logger, ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { CONFIG_GROUP, DEFAULTS, WORLD_ID, normalizeConfig, parseListenUrl, type MaibotConfig } from './config.ts';
import { EVENTS, asMessageDict, convOf, hostSegToCbp, imageSegToBlob } from './normalize.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/**
 * 本端申报 caps —— 只报本包真有行为面的三支（tests/world.test.ts 逐支行为探针锁集合相等）。
 * 不申报：`buttons`（MaiBot 无按钮段）、`audio_out`/`history_backfill`（v1 无）、
 * `reply_tail`（neko 专属）、`files`（本包零文件附件路径；MaiBot 上传上限每次由宿主回包声明、
 * SDK 无常量，SECURITY-CBP:180 + capabilities/files.py:74-75 @f9984673d，pins maibot.media_bytes=null）、
 * `self_echo`（SECURITY-CBP:77 只能与 proven:true 同现；本端是 Cortico，无宿主实证账号位，
 * 报了会被内核 onHandshakeFrame 当 caps-lie 摘帽 + degraded，等于超发许可）。
 */
export const WORLD_CAPS: readonly string[] = ['images', 'notices', 'tools'];

/**
 * F1/F2 本端 self 申报（hello/ready 必填）。Cortico 不是 IM 账号、没有宿主实证位，
 * 按 SECURITY-CBP:72「任何来自配置/手填/对端自报的值都记 proven:false」诚实报假；
 * proven 变化的重推与 caps-lie 摘帽都在内核 driver（onHandshakeFrame）。
 */
export const WORLD_SELF: SelfDecl = { id: '', name: 'Cortico', proven: false };

/** 6xxxx 桥段标签（内核 errors.ts RET 同值；文案里代码+名成对，60005/60007 模板逐字 §3.2）。 */
const CODE_LABELS: Readonly<Record<number, string>> = {
  [RET.VERSION_MISMATCH]: 'version_mismatch',
  [RET.CAPABILITY_UNAVAILABLE]: 'capability_unavailable',
  [RET.PAYLOAD_TOO_LARGE]: 'payload_too_large',
  [RET.UNKNOWN_SESSION]: 'unknown_session',
  [RET.DOOR_CLOSED]: 'door_closed',
  [RET.PEER_UNREACHABLE]: 'peer_unreachable',
  [RET.SEND_UNCERTAIN]: 'send_uncertain',
  [RET.DEGRADED]: 'degraded',
};

/** 扩展版本读包根 package.json，不手写第二份（先例同法）。 */
export function readExtensionVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

export type ToolDecl = Omit<ToolDef, 'handler'>;

export const MAIBOT_STATUS_DECL: ToolDecl = {
  name: 'maibot_status',
  description: 'Report bridge connection, negotiated CBP caps, peer tool catalog and degraded list.',
  tags: ['read'],
  parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
};

export const MAIBOT_HISTORY_DECL: ToolDecl = {
  name: 'maibot_history',
  description: 'Read archived maibot.* events from the Cortico event store. Never queries the peer.',
  tags: ['read'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { conv: { type: 'string' }, limit: { type: 'integer' } },
    required: [],
  },
};

export const MAIBOT_PEER_CALL_DECL: ToolDecl = {
  name: 'maibot_peer_call',
  description:
    'Call a peer tool by name. Only names in the peer catalog are accepted. Runs with the identity ' +
    'of the message that started this turn; a turn without a bridge message is refused.',
  tags: ['write'],
  barrierAfter: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { tool: { type: 'string' }, args: { type: 'object' } },
    required: ['tool'],
  },
};

/** 桥特有件 `maibot_streams`（转 `chat.get_all_streams` call）在发信腿接线后随 `PEER_CAPABILITIES` 恢复，见 §7 与 hello-authority 闸。 */

export const TOOL_DECLS: readonly ToolDecl[] = [MAIBOT_STATUS_DECL, MAIBOT_HISTORY_DECL, MAIBOT_PEER_CALL_DECL];

/**
 * 桥侧 hello.tools 申报的 CBP 能力名，在 fleet 侧的镜像。唯一权威=对端 hello.tools
 * （spec/CHANGELOG-CBP.md N3 决策；CBP-v1.json:499「call.tool 必须在 ready/catalog tools[] 申报，
 * 否则 60002」）。发信腿未接线：`cortico-bridge-maibot/client.py:56` 申报 `tools=[]` → 本镜像必须空。
 * 跨仓闸 hello-authority.test.ts 锁两侧相等；桥若开始申报某能力，先改桥、再同步这里，并按
 * 跨仓闸 hello-authority.test.ts 锁两侧相等；桥若开始申报某能力，先改桥、再同步这里，并把对应
 * 固定工具加回 `TOOL_DECLS`/`describe.json`/`ENV_PROMPT.md`（发信腿 = `maibot_send`，流清单 = `chat.get_all_streams`）。
 */
export const PEER_CAPABILITIES: readonly string[] = [];

/** 内核 BridgeDriver 的本包用到的面（结构化，测试塞假件 —— 先例同位手法）。 */
export interface MaibotDriverLike {
  start(): Promise<void>;
  stop(): void;
  send(frame: Frame): boolean;
  /** F3：turn = 触发本轮的入站 msg 帧 id，actor = 本端入站记录里的发起方位。 */
  callTool(tool: string, args: Record<string, unknown>, turn: string, actor: Actor): Promise<Frame>;
  effectiveCaps(): string[];
  /** 内核 BridgeDriver.peerTools 形状：握手帧申报的工具集（F1 权威面）。 */
  peerTools(): ToolAnn[];
  /** F1/F2：对端 hello/ready 报来的 self —— 回声判定的唯一供给源。 */
  peerSelf(): SelfDecl | null;
  readonly isReady: boolean;
}

export interface WorldHandlers {
  onFrame(f: Frame): void;
  onState(s: DriverState): void;
}

export interface WorldOptions {
  cfg: Partial<MaibotConfig> | undefined;
  makeDriver?: (cfg: MaibotConfig, log: Logger, handlers: WorldHandlers) => MaibotDriverLike;
}

export class MaibotBridgeWorld implements World {
  readonly id = WORLD_ID;
  private readonly cfg: MaibotConfig;
  private readonly opts: WorldOptions;
  private host: WorldHost | null = null;
  private driver: MaibotDriverLike | null = null;
  private connected = false;
  private catalog: ToolAnn[] = [];
  /**
   * 对端可调用工具集 = 握手申报 ∪ 最近一次 catalog 帧（同名为准）。
   * 只看 catalog 帧会让「只在 hello/ready 申报、不发 catalog」的桥把自己报的能力全判 60002。
   */
  private announcedTools(): ToolAnn[] {
    const byName = new Map<string, ToolAnn>();
    for (const t of this.driver?.peerTools() ?? []) byName.set(t.name, t);
    for (const t of this.catalog) byName.set(t.name, t);
    return [...byName.values()];
  }

  private degradedList: string[] = [];
  private seenConvs = new Set<string>();
  private accounts = new Set<string>();
  /** F3：本轮发起方位的记录（入站 msg 提供）；没有它就不许多出 call。 */
  private turn: { id: string; platform: string; conv: string; member: { id: string; name: string }; anon: Anon } | null = null;
  private selfUnknownSurfaced = false;

  constructor(opts: WorldOptions) {
    this.cfg = normalizeConfig(opts.cfg);
    this.opts = opts;
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const handlers: WorldHandlers = {
      onFrame: (f) => this.onFrame(f),
      onState: (s) => {
        this.connected = s.connected;
        void this.pushStatusEvent('connection', { connected: s.connected, peersReady: s.peersReady });
      },
    };
    const driver =
      this.opts.makeDriver?.(this.cfg, host.log, handlers) ??
      new BridgeDriver({
        role: 'listen',
        ...parseListenUrl(this.cfg.url),
        agent: { name: 'cortico-world-maibot', version: readExtensionVersion(), sha: '' },
        self: WORLD_SELF,
        caps: [...WORLD_CAPS],
        tools: peerToolCatalog(this.cfg),
        authToken: this.cfg.token !== '' ? this.cfg.token : undefined,
        onFrame: handlers.onFrame,
        onState: handlers.onState,
        log: (m, e) => host.log.info(m, e),
      });
    this.driver = driver;
    // 连接等待上限 12s 放行（硬规则；driver.start 本身永不 reject）。
    let gate: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((r) => {
        gate = setTimeout(r, 12_000);
      }),
      driver.start(),
    ]).finally(() => {
      if (gate) clearTimeout(gate);
    });
  }

  async stop(): Promise<void> {
    this.driver?.stop();
    this.driver = null;
    this.connected = false;
    this.turn = null;
    this.selfUnknownSurfaced = false;
  }

  envPromptVars(): Record<string, string> {
    return {
      'maibot.connection': this.connected
        ? `已连接（caps：${(this.driver?.effectiveCaps() ?? []).join('、') || '交集为空'}）`
        : '未连接（等桥外拨 ws://…:39702）',
      'maibot.scope': `egress=${this.cfg.egress ? '开' : '关'}，限流=${this.cfg.ratePerMin > 0 ? `${this.cfg.ratePerMin}/分` : '不限'}`,
      'maibot.selfEcho': `self-echo:${this.selfEchoState()}`,
      'maibot.accounts': [...this.accounts].join('、') || '（还没见过号）',
      'maibot.conversations': [...this.seenConvs].slice(-50).join('、') || '（还没有）',
      'maibot.tools': this.announcedTools().map((t) => t.name).join('、') || '（桥没报清单）',
      'maibot.degraded': this.degradedList.slice(-10).join('；') || '（无）',
    };
  }

  tools(): ToolDef[] {
    // 能力目录静态面 = 恒可用的本端三支（status/history/peer_call）。
    // 靠对端发信腿的 maibot_send_message/maibot_streams 不进目录：桥 hello.tools=[]（SECURITY-CBP §7 N3）。
    // 桥申报某能力后，把对应 DELEG 加回 TOOL_DECLS/describe.json/ENV_PROMPT 并同步 PEER_CAPABILITIES；
    // peer_call 走 runCall 的 isAnnounced 闸——对端没申报的能力，本地判 60002，绝不盲下发。
    return [
      {
        ...MAIBOT_STATUS_DECL,
        handler: async () =>
          JSON.stringify(
            {
              connected: this.connected,
              caps: this.driver?.effectiveCaps() ?? [],
              selfEcho: this.selfEchoState(),
              accounts: [...this.accounts],
              catalog: this.announcedTools(),
              degraded: this.degradedList.slice(-10),
              egress: this.cfg.egress,
              ratePerMin: this.cfg.ratePerMin,
            },
            null,
            1,
          ),
      },
      {
        ...MAIBOT_HISTORY_DECL,
        handler: async (args) => {
          const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
          const rows =
            this.host?.store.range({ source: WORLD_ID, senderKey: args.conv ? String(args.conv) : undefined, limit }) ?? [];
          return JSON.stringify(rows.map((e) => ({ ts: e.ts, type: e.type, text: e.text.slice(0, 400) })));
        },
      },
      {
        ...MAIBOT_PEER_CALL_DECL,
        handler: async (args) => {
          // 轮次身份闸在前（先例 astrbot_call_tool 拒绝顺序，4725feee6 world.ts:167-174）。
          if (!this.turn) {
            return { text: 'no turn identity: 本轮没有桥消息，不能用桥侧身份执行', failed: true };
          }
          // 申报闸交给 runCall 的 isAnnounced（对端没申报 → 本地 60002，不发 call）。
          const tool = String(args.tool ?? '');
          // F3：turn/actor 走协议位，不再塞进 args.__turn（收口）。桥侧用 turn 查自己的
          // 入站记录定身份，线上 actor 仅对账（SECURITY-CBP §1 第 3 条）。
          const callArgs: Record<string, unknown> = { ...((args.args as Record<string, unknown>) ?? {}) };
          return this.runCall(tool, callArgs);
        },
      },
    ];
  }

  /** 对端申报目录（catalog 帧 + hello.tools）是否含该能力名。 */
  private isAnnounced(cap: string): boolean {
    return this.announcedTools().some((t) => t.name === cap);
  }

  webUi(): WorldWebUiDecl {
    return {
      lamps: [
        {
          label: 'MaiBot 桥',
          state: this.connected ? 'online' : this.cfg.enabled ? 'error' : 'offline',
          hint: `caps: ${(this.driver?.effectiveCaps() ?? []).join(',') || '—'}`,
        },
      ],
      badges: [
        { label: 'egress', value: this.cfg.egress ? 'on' : 'off', tone: this.cfg.egress ? 'on' : 'off' },
        { label: '会话', value: this.seenConvs.size, tone: 'plain' },
      ],
      config: [CONFIG_GROUP],
      promptDocs: [
        {
          key: `worlds.${WORLD_ID}.envPrompt`,
          title: 'MaiBot 桥 · 环境提示词',
          description: '桥的连接与协商状态、出站门、对端工具清单与降级位。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'maibot.connection', description: '桥的连接与协商状态。', multiline: true },
            { name: 'maibot.scope', description: '出站门与限流。' },
            { name: 'maibot.selfEcho', description: '回声抑制位（self-echo:on/off）。' },
            { name: 'maibot.accounts', description: '见过的桥账号（MessageDict.account_id）。', multiline: true },
            { name: 'maibot.conversations', description: '见过的会话键（stream/session id）。', multiline: true },
            { name: 'maibot.tools', description: '对端已申报工具。', multiline: true },
            { name: 'maibot.degraded', description: '降级清单。', multiline: true },
          ],
        },
      ],
    };
  }

  // ── 内部 ────────────────────────────────────────────────

  private onFrame(f: Frame): void {
    switch (f.t) {
      case 'msg':
        void this.onMsg(f);
        break;
      case 'notice':
        this.onNotice(f);
        break;
      case 'event':
        this.onEventFrame(f);
        break;
      case 'catalog':
        this.catalog = sanitizeTools(f.tools).ok;
        break;
      case 'call':
        this.onCall(f);
        break;
      default:
        // hello/ready/tick 由内核握手层消费；未配对的 reply/ack 忽略。
        break;
    }
  }

  private async onMsg(frame: MsgFrame): Promise<void> {
    if (!this.host) return;
    const degraded: string[] = [];
    const segs: Seg[] = [];
    for (const s of frame.segments) {
      const r = hostSegToCbp(s);
      if (r.seg) segs.push(r.seg);
      if (r.degraded) {
        degraded.push(r.degraded);
        this.noteDegraded(r.degraded);
      }
    }
    const raw = asMessageDict(frame.raw);
    const account = raw ? String(raw.account_id ?? '') : '';
    if (account) this.accounts.add(account);
    // F1/F2：回声判定只吃协商实证 self（内核 msgToEnvelope 内部按 proven:true 才 suppress），
    // 不再用 raw.account_id 私判（SECURITY-CBP §2：对端自报/手填一律 proven:false）。
    const conv = convOf(frame);
    if (conv) this.seenConvs.add(conv);
    // F3：本轮发起方位取入站 msg 实证值——platform 取 MessageDict.platform（mdict.py:17,58），
    // member.id 取宿主实证 message_info.user_info.user_id（mdict.py:43-46）。
    const ui = raw?.message_info?.user_info;
    const memberId = ui && ui.user_id != null ? String(ui.user_id) : '';
    const memberName = ui ? String(ui.user_nickname ?? frame.sender.name ?? '') : frame.sender.name;
    const anon: Anon = memberId === '' ? 'unknown' : 'identified';
    const platform = raw ? String(raw.platform ?? '') : '';
    const isSelfNow = this.driver?.peerSelf()?.proven === true && frame.sender.id === this.driver?.peerSelf()?.id;
    if (!isSelfNow && frame.id) {
      this.turn = { id: frame.id, platform: platform || WORLD_ID, conv: conv || frame.conv, member: { id: memberId, name: memberName }, anon };
    }
    const blobs: { bytes: Uint8Array; mime: string; fallbackText: string }[] = [];
    for (const seg of segs) {
      const b = imageSegToBlob(seg);
      if (!b) continue;
      if (!this.host.modelFacts.accepts(b.mime)) {
        degraded.push(`model-rejects:${b.mime}`);
        this.noteDegraded(`model-rejects:${b.mime}`);
        continue;
      }
      blobs.push(b);
    }
    const { envelope, push, degraded: selfDeg } = msgToEnvelope(
      { ...frame, conv: conv || frame.conv, segments: segs },
      {
        worldId: WORLD_ID,
        self: this.driver?.peerSelf() ?? undefined,
        render: renderSegments,
        blobs: blobs.map((b) => ({ ...b })),
      },
    );
    // §2.4：拿不到实证 self → 照常投递 + 显式 self-unknown 降级（每连接一次，不刷屏）。
    const firstSelfUnknown = !!selfDeg && !this.selfUnknownSurfaced;
    if (selfDeg && firstSelfUnknown) {
      this.selfUnknownSurfaced = true;
      this.noteDegraded(selfDeg.reason);
    }
    if (envelope.contextDelivery === 'archive-only') envelope.type = EVENTS.messageSelf;
    // pushEvent 入参不含 contextDelivery（types.ts:692-695）；deliver:false 是唯一入口。
    const { contextDelivery: _omit, blobs: _kb, ...env } = envelope;
    await this.host.pushEvent({ ...env, ...(blobs.length ? { blobs } : {}) }, push);
    if (firstSelfUnknown) await this.pushStatusEvent('degraded', selfDeg);
    if (degraded.length > 0) await this.pushStatusEvent('degraded', { conv, degraded });
  }

  private onNotice(frame: NoticeFrame): void {
    if (!this.host) return;
    const { envelope, push } = noticeToEnvelope(frame, { worldId: WORLD_ID });
    const { contextDelivery: _c, blobs: _b, ...env } = envelope;
    void this.host.pushEvent(env, push);
  }

  private onEventFrame(frame: EventFrame): void {
    if (!this.host) return;
    if (frame.name !== 'connection' && frame.name !== 'degraded') return;
    const { envelope, push } = eventToEnvelope(frame, { worldId: WORLD_ID });
    const { contextDelivery: _c, blobs: _b, ...env } = envelope;
    void this.host.pushEvent(env, push);
  }

  /** 桥侧 v1 不向我们发 call；来一发改 10002，绝不让对端挂到超时。 */
  private onCall(frame: CallFrame): void {
    const head = newHead('reply');
    this.driver?.send({
      ...head,
      t: 'reply',
      v: 1,
      rid: frame.rid,
      ok: false,
      error: { code: RET.UNSUPPORTED_ACTION, message: 'cortico-world-maibot does not serve bridge-initiated calls in v1' },
    });
  }

  /**
   * call → reply/错误互译（内核 errors.ts RET；reply.ok=false 带 error 时逐字带码）。
   * F3：call 必带 turn+actor，二者取本端入站记录（SECURITY-CBP §1 第 3 条：桥只用 turn
   * 查自己的入站记录定身份，线上 actor 只作对账）。本轮没有入站桥消息 → turn 无从填 →
   * 直接回 60004 unknown_session，不发出 call（§1 第 3 条 turn 查无；§5.2 先例同型）。
   */
  private async runCall(tool: string, args: Record<string, unknown>): Promise<string | ToolOutcome> {
    if (!this.driver) return { text: `${RET.PEER_UNREACHABLE} peer_unreachable: 驱动未启动`, failed: true };
    const turn = this.turn;
    if (!turn) {
      return { text: `${RET.UNKNOWN_SESSION} unknown_session: 本轮没有入站桥消息，turn 无从填`, failed: true };
    }
    // 交集闸（CBP-v1.json:499 / spec/CHANGELOG-CBP.md N3）：对端没申报的能力，绝不发下发帧——
    // 本地判 60002 capability_unavailable，消掉「桥没申报却仍然下发」这条 caps-lie 通路。
    if (!this.isAnnounced(tool)) {
      this.noteDegraded(`capability-unannounced:${tool}`);
      return { text: `${RET.CAPABILITY_UNAVAILABLE} capability_unavailable: 对端未申报 ${tool}`, failed: true };
    }
    const actor: Actor = { platform: turn.platform, conv: turn.conv, member: turn.member, anon: turn.anon };
    try {
      const f = await this.driver.callTool(tool, args, turn.id, actor);
      if (f.t === 'reply') {
        if (f.ok) return f.text ?? 'ok';
        return { text: this.fmtErr(f.error?.code ?? RET.INTERNAL_HANDLER_ERROR, f.error?.message ?? '对端未给原因'), failed: true };
      }
      return 'ok';
    } catch (e) {
      const ce = e as { code?: number; message?: string };
      return { text: this.fmtErr(ce.code ?? RET.INTERNAL_HANDLER_ERROR, ce.message ?? String(e)), failed: true };
    }
  }

  /** §2.4：proven 未证实时 self-echo 常驻 off；真拿到实证 self 才 on。 */
  private selfEchoState(): 'on' | 'off' {
    return this.driver?.peerSelf()?.proven === true ? 'on' : 'off';
  }

  private fmtErr(code: number, message: string): string {
    return `${code} ${CODE_LABELS[code] ?? 'error'}: ${message}`;
  }

  private async pushStatusEvent(name: 'connection' | 'degraded', data: unknown): Promise<void> {
    await this.host?.pushEvent(
      {
        type: name === 'connection' ? EVENTS.connection : EVENTS.degraded,
        ts: new Date().toISOString(),
        source: WORLD_ID,
        // 桥状态 = 已认证操作员通道 → internal（types.ts:687-695；先例同断）。
        origin: 'internal',
        text: JSON.stringify(data),
        meta: { data },
      },
      { trigger: 'flush' },
    );
  }

  private noteDegraded(item: string): void {
    if (!this.degradedList.includes(item)) this.degradedList.push(item);
  }
}

export const DEFAULT_WORLD_OPTS: WorldOptions = { cfg: DEFAULTS };

/**
 * 本端上报给桥的工具目录（hello/ready tools[]，G6：risk 六值逐字
 * cortico types.ts:202 @836238311）。单一来源 = `TOOL_DECLS`，与 `describe.json` 同表。
 * 交集口径见 spec/SECURITY-CBP.md §7 N3：发信腿未接线（桥 hello.tools=[]）→ 只报本端三支；
 * 桥申报某能力后把对应固定工具加进 TOOL_DECLS/describe.json，本目录随之带上。
 */
export function peerToolCatalog(_cfg: MaibotConfig): ToolAnn[] {
  return TOOL_DECLS.map((d) => ({
    name: d.name,
    risk: (d.tags[0] as ToolRisk) ?? 'read',
    confirm_required: d.tags.includes('write'),
  }));
}
