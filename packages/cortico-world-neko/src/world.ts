/**
 * world.ts —— Cortico 侧 `NekoWorld`。工具四件与档位表钉 _BUILD-PLAN.md §3.2；
 * 帧编解码、WS 双角色驱动、去重、段渲染、错误码、协商全部复用
 * cortico-bridge-core（任务红线：禁止复制粘贴一份转换逻辑）。
 *
 * 硬规则落点（d-bridge-priorart §7 八条；闸项=cortico dry-mount.ts:126 @836238311）：
 * - 构造纯：create() 只存配置与 ctx.secret 取回的密钥串（工单一 F3），加残键一次性
 *   清理落盘（工单二 F1，同步文件卫生），不连接、不 await。
 * - start() 等待上限 12s 放行；内核 driver.start() 永不 reject（driver.ts:137 注释）。
 * - 自发回声只归档：判定输入是桥握手帧的 self 声明（F1/F2），且只有 proven:true 可抑制；
 *   抑制时 pushEvent 入参 Omit 掉 contextDelivery（types.ts:692-694），唯一合法写法
 *   deliver:false，宿主落库翻 archive-only（core.ts:519）。neko 线永久 proven:false
 *   （§6.9）⇒ 常态照常投递 + self-echo:off + degraded self-unknown，不做静默。
 * - blob 附带前问 modelFacts.accepts(mime)（types.ts:602）。
 * - tools() 名字 ⊆ describe.tools（describe-export.ts:134-136）。
 * - 不实现 outputTap()（_BUILD-PLAN §3.3：桥包一律不实现；C1-10）。
 * - meta.raw 恒留原始载荷（硬规则 8，内核 envelope.ts 已保）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BridgeDriver,
  RET,
  effectiveTurnTtlSeconds,
  err,
  eventToEnvelope,
  isKnownType,
  msgToEnvelope,
  newHead,
  noticeToEnvelope,
  renderSegments,
  sanitizeTools,
  type Actor,
  type AgentId,
  type BlobInput,
  type CbpError,
  type DriverState,
  type Frame,
  type SelfDecl,
  type ToolAnn,
} from '@horizoncloudy/cortico-bridge-core';
import type { CallFrame, CatalogFrame, EventFrame, MsgFrame, NoticeFrame, ReplyFrame } from '@horizoncloudy/cortico-bridge-core/frames';
import type { ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { CONFIG_GROUP, DEFAULTS, WORLD_ID, normalizeConfig, type NekoBridgeConfig } from './config.ts';
import {
  EVENTS,
  consentLabel,
  imageSegToBlob,
  nekoFrameLimitBytes,
  parseAxes,
  planNekoSend,
  toCbpSegments,
} from './normalize.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 扩展版本读包根 package.json，不手写第二份（先例 astrbot-bridge world.ts:43-51 同法）。 */
export function readExtensionVersion(): string {
  try {
    const path = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

/** 60001..60008 → 名字（c1 §5.4 表；文案逐字 door_closed/send_uncertain/payload_too_large）。 */
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
export function codeText(code: number, message: string): string {
  return `${code} ${CODE_LABELS[code] ?? 'error'}: ${message}`;
}

/**
 * 本端 hello/ready 申报的能力位（内核词表 negotiate.ts CAPS @cortico-bridge-core）。
 * self_echo 不申报（F1/F2 §2.3 caps-lie 守卫）：N.E.K.O 线永久 `proven:false`
 * （SECURITY-CBP §2.2/§6.9，bus 面只有读与 watch、无 publish，取值口只能是
 * 会话 role 启发式，不是实证），而 self_echo 只能与 proven:true 同现——报了内核
 * 会丢该 cap 并回 `degraded self-echo:caps-lie`，与其被丢不如不报。
 * INFERENCE（本件起草，桥端工单 cortico-bridge-neko 引用即升 FACT）：
 * buttons/audio_out/files/reply_tail/history_backfill 一律不报——
 * N.E.K.O 面只有 push_message v2 + reply_tail 两道入站门（蓝图 §2.2 L83），
 * 按钮无对应 part 型、音频视频无上传 API、reply_tail 不进第一切片（L92）、
 * v1 无断线补课（history_backfill 恒 false，§6.1 U 台账）。
 */
export const NEKO_CAPS: readonly string[] = ['images', 'notices', 'tools'];

/**
 * 本端 self 声明（F1/F2）。N.E.K.O 线永久 proven:false：没有任何实证位置能给出
 * bot 主键（§2.2 明记），配置里的 selfId 是部署者手填、`role=="assistant"` 是启发式，
 * 都记 proven:false。空 id 也诚实申报，不拿「没有 self」冒充「没有 self 需求」（F1）。
 * name 用人读串、不进授权判定。
 */
export function bridgeSelf(cfg: NekoBridgeConfig): SelfDecl {
  return { id: cfg.selfId, name: 'cortico-world-neko', proven: false };
}

/** 帧面注入位：契约测试用假驱动，不碰 WebSocket（先例 fake-bridge 同位）。 */
export interface WorldHandlers {
  onState: (s: DriverState) => void;
  onFrame: (f: Frame) => void;
}

export interface BridgeLike {
  start(): Promise<void>;
  stop(): void;
  /** 内核 BridgeDriver.send 形状（F2）：入站 call 的 60002 回帧从这里上线，rid 进内核幂等缓存。 */
  send(frame: Frame): boolean;
  /** 内核 BridgeDriver.callTool 形状（F3）：turn+actor 必填，30s 超时经 PendingTable.timeoutError → 60007。 */
  callTool(tool: string, args: Record<string, unknown>, turn: string, actor: Actor): Promise<Frame>;
  /** 内核 BridgeDriver.peerSelf 形状（F1/F2）：桥握手帧里的 self 声明，回声判定的唯一合法输入。 */
  peerSelf(): SelfDecl | null;
  effectiveCaps(): string[];
  /** 内核 BridgeDriver.peerTools 形状：握手帧申报的工具集（F1 权威面）。 */
  peerTools(): ToolAnn[];
  readonly listenPort: number;
}

export interface WorldOptions {
  cfg: Partial<NekoBridgeConfig> | undefined;
  /** 共享密钥单源 = definition.ts 的 ctx.secret('CORTICO_BRIDGE_TOKEN')。
   *  2026-11-19：空串不再是「免鉴权」，内核 listen()/dial() 直接拒（11-13 判例）。 */
  authToken?: string;
  /** 工单二 F1：残键清理的回放缓冲（create() 没有 log 口，start() 里逐条 warn）。 */
  purgeNotes?: string[];
  /** 测试接缝：turn 保留窗秒数与时钟注入。缺省走内核同源读数（工单二 F2）。 */
  turnTtlSeconds?: number;
  now?: () => number;
  makeDriver?: (cfg: NekoBridgeConfig, log: WorldHost['log'], handlers: WorldHandlers, authToken?: string) => BridgeLike;
}

export type ToolDecl = Omit<ToolDef, 'handler'>;

export const NEKO_SEND_DECL: ToolDecl = {
  name: 'neko_send_message',
  description:
    'Send text (plus optional inline image segments) into a N.E.K.O conversation via the bridge. ' +
    'Only works while egress is open; closed door returns 60005 door_closed. Needs a live bridge ' +
    'message in this turn: without one, or after the turn retention window passes, it returns 60004 ' +
    'unknown_session (the call identity comes from the inbound record, never from arguments; the ' +
    'window has one source in the spec, default 300 seconds, CORTICO_TURN_TTL_SECONDS overrides it). ' +
    'While the peer has not announced neko_send, this tool returns 60002 capability_unavailable and ' +
    'sends no frame (SECURITY-CBP §7). External-URL images and audio/video segments are refused ' +
    'locally (host has no upload API for them).',
  tags: ['write'],
  barrierAfter: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      conv: { type: 'string', description: 'neko conversation_id（neko.message 的 senderKey/conv）。' },
      text: { type: 'string' },
      segments: { type: 'array', description: 'CBP v11 形段（image 只认内联 base64）。' },
    },
    required: ['conv', 'text'],
  },
};

export const NEKO_STATUS_DECL: ToolDecl = {
  name: 'neko_status',
  description: 'Report bridge connection, role, negotiated CBP caps, peer tool catalog, consent state and degraded list.',
  tags: ['read'],
  parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
};

export const NEKO_HISTORY_DECL: ToolDecl = {
  name: 'neko_history',
  description: "Read archived neko.* events from the Cortico event store. Never queries the peer (convmap lives in the bridge plugin and is host-invisible).",
  tags: ['read'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { conv: { type: 'string' }, limit: { type: 'integer' } },
    required: [],
  },
};

export const NEKO_PEER_CALL_DECL: ToolDecl = {
  name: 'neko_peer_call',
  description:
    "Call a peer tool by name. Only names in the peer catalog are accepted. Runs with the identity of the message that started this turn; a turn without a bridge message is refused.",
  tags: ['write'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { tool: { type: 'string' }, args: { type: 'object' } },
    required: ['tool'],
  },
};

export const TOOL_DECLS: readonly ToolDecl[] = [NEKO_SEND_DECL, NEKO_STATUS_DECL, NEKO_HISTORY_DECL, NEKO_PEER_CALL_DECL];

/** 出站 call 的工具名 = _BUILD-PLAN.md:182 `call('<w>_send', args)` 的 neko 实例。 */
export const NEKO_SEND_TOOL = 'neko_send';

export class NekoWorld implements World {
  readonly id = WORLD_ID;
  private readonly cfg: NekoBridgeConfig;
  private host: WorldHost | null = null;
  private driver: BridgeLike | null = null;
  private connected = false;
  private caps: string[] = [];
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

  private seenConvs = new Set<string>();
  /** 工单一 F3：本轮触发消息的实证记录（入站 msg 帧带进来的宿主侧值），出站 call 的 turn/actor 唯一来源。
   * `at` 记入窗时刻：工单二 F2 起 lastTurn 不只随断线清，也按同源保留窗随时钟过期。 */
  private lastTurn: { id: string; conv: string; member: { id: string; name: string }; at: number } | null = null;
  private degradedList: string[] = [];
  private sendWindow: number[] = [];
  private consent = '';

  constructor(opts: WorldOptions) {
    this.cfg = normalizeConfig(opts.cfg);
    this.opts = opts;
    this.nowFn = opts.now ?? Date.now;
  }

  private readonly nowFn: () => number;

  private readonly opts: WorldOptions;

  /** 连接等待上限 12s 放行（蓝图 §2.3 硬规则）。 */
  async start(host: WorldHost): Promise<void> {
    this.host = host;
    // 工单二 F1：残键在 create() 里已落盘删除，这里把只含键名的提示补进运行日志。
    for (const note of this.opts.purgeNotes ?? []) host.log.warn(note);
    const handlers: WorldHandlers = {
      onState: (s) => this.onState(s),
      onFrame: (f) => this.onFrame(f),
    };
    const driver =
      this.opts.makeDriver?.(this.cfg, host.log, handlers, this.opts.authToken) ??
      new BridgeDriver({
        role: this.cfg.role,
        url: this.cfg.url,
        host: this.cfg.host,
        port: this.cfg.port,
        agent: this.agentId(),
        self: bridgeSelf(this.cfg),
        caps: [...NEKO_CAPS],
        tools: peerToolCatalog(this.cfg),
        authToken: this.opts.authToken ?? '',
        reconnectBaseMs: this.cfg.reconnectBaseMs,
        reconnectMaxMs: this.cfg.reconnectMaxMs,
        onState: (s) => this.onState(s),
        onFrame: (f) => this.onFrame(f),
        log: (m, e) => host.log.debug(m, e ?? {}),
      });
    this.driver = driver;
    let startGate: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((r) => {
        startGate = setTimeout(r, 12_000);
      }),
      driver.start(),
    ]).finally(() => {
      if (startGate) clearTimeout(startGate);
    });
  }

  async stop(): Promise<void> {
    this.driver?.stop();
    this.driver = null;
    this.connected = false;
  }

  envPromptVars(): Record<string, string> {
    const win =
      this.opts.turnTtlSeconds === undefined ? effectiveTurnTtlSeconds() : { ttlSeconds: this.opts.turnTtlSeconds, degraded: null };
    return {
      'neko.connection': this.connected
        ? `已连接（${this.cfg.role}，caps：${this.caps.join('、') || '交集为空'}）`
        : this.cfg.role === 'listen'
          ? `未连接（监听 ${this.cfg.host}:${this.cfg.port}，等待桥接入）`
          : `未连接（拨号 ${this.cfg.url}，后台重连中）`,
      'neko.scope': `egress=${this.cfg.egress ? '开' : '关'}，ratePerMin=${this.cfg.ratePerMin}，visibility=${this.cfg.visibility || '（空）'}，ai_behavior=${this.cfg.aiBehavior}`,
      'neko.window': `turn 保留窗 ${win.ttlSeconds} 秒（两端同源：spec/CBP-v1.json $defs/turnWindow；env CORTICO_TURN_TTL_SECONDS 可覆盖${win.degraded ? '；当前 env 值非法，已回落台账值' : ''}）`,
      'neko.self': this.peerEchoState(),
      'neko.conversations': [...this.seenConvs].slice(-50).join('、') || '（还没有）',
      'neko.tools': this.announcedTools().map((t) => t.name).join('、') || '（桥没报清单）',
      'neko.degraded': this.degradedList.slice(-10).join('；') || '（无）',
      'neko.consent': this.consent !== '' ? this.consent : '（桥未上报 consent 态）',
    };
  }

  tools(): ToolDef[] {
    return [
      {
        ...NEKO_SEND_DECL,
        handler: async (args): Promise<string | ToolOutcome> => {
          if (!this.cfg.egress) {
            this.noteDegraded('egress-closed');
            return { text: codeText(RET.DOOR_CLOSED, '出站门未开'), failed: true };
          }
          if (!this.rateAllowed()) return { text: 'rate_limited: 超出每分钟发送上限', failed: true };
          const conv = String(args.conv ?? '').trim();
          if (!conv) return { text: 'bad_args: conv 必填', failed: true };
          const axes = parseAxes(this.cfg.visibility, this.cfg.aiBehavior);
          const plan = planNekoSend(String(args.text ?? ''), toCbpSegments(args.segments), axes);
          if (plan.tooLarge) {
            this.noteDegraded('payload-too-large');
            return {
              text: codeText(
                RET.PAYLOAD_TOO_LARGE,
                `packed ${plan.packedBytes}B > ${nekoFrameLimitBytes()}B（caps.neko.frame_bytes 单源 spec/pins.json，本地先拒不动桥，v1 不分片）`,
              ),
              failed: true,
            };
          }
          for (const d of plan.dropped) this.noteDegraded(d.reason);
          // 工单二 F3（§7 下发扬闸的后半边）：链路已立而对端没申报 neko_send 就本地判
          // 60002，绝不发 call 帧。未连接时不判——那时申报面本就空，让内核报 60006，
          // 不把网络故障伪装成能力故障（先例 maibot runCall 同位，SECURITY-CBP §7 规则 3）。
          if (this.connected && !this.announcedTools().some((x) => x.name === NEKO_SEND_TOOL)) {
            this.noteDegraded('peer-not-announced:neko_send');
            return { text: codeText(RET.CAPABILITY_UNAVAILABLE, 'capability_unavailable: 对端没有申报 neko_send，本地先拒不发 call 帧'), failed: true };
          }
          // 工单一 F3 身份闸：turn/actor 必填，且只能从本轮入站 msg 的实证记录填（§1.3）。
          // 没有桥消息就没有可填的身份——自报、伪造、留空都是违例，本地先拒不发。
          const ta = this.turnActor();
          if (!ta) return { text: codeText(RET.UNKNOWN_SESSION, '本轮没有桥消息或超出 turn 保留窗，turn/actor 无从实证'), failed: true };
          let result: string | ToolOutcome;
          try {
            const reply = await this.driver!.callTool(
              NEKO_SEND_TOOL,
              {
                conv,
                text: String(args.text ?? ''),
                segments: plan.kept,
                visibility: axes.visibility,
                ai_behavior: axes.ai_behavior,
              },
              ta.turn,
              ta.actor,
            );
            result = this.replyToResult(reply, conv);
          } catch (e) {
            const ce = e as CbpError;
            result = { text: codeText(ce.code ?? RET.PEER_UNREACHABLE, ce.message ?? String(e)), failed: true };
          }
          if (plan.dropped.length > 0) {
            await this.pushStatusEvent('degraded', { conv, dropped: plan.dropped });
          }
          return result;
        },
      },
      {
        ...NEKO_STATUS_DECL,
        handler: async () =>
          JSON.stringify(
            {
              connected: this.connected,
              role: this.cfg.role,
              listenPort: this.driver?.listenPort ?? 0,
              caps: this.caps,
              // §2.4：self-echo 状态常驻位（neko 线常态 off）。
              self: { declared: bridgeSelf(this.cfg), peer: this.driver?.peerSelf() ?? null },
              selfEcho: this.driver?.peerSelf()?.proven === true ? 'on' : 'off',
              consent: this.consent,
              catalog: this.announcedTools(),
              degraded: this.degradedList.slice(-10),
              egress: this.cfg.egress,
            },
            null,
            1,
          ),
      },
      {
        ...NEKO_HISTORY_DECL,
        handler: async (args) => {
          const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
          const rows =
            this.host?.store.range({
              source: WORLD_ID,
              senderKey: args.conv ? String(args.conv) : undefined,
              limit,
            }) ?? [];
          return JSON.stringify(rows.map((e) => ({ ts: e.ts, type: e.type, text: e.text.slice(0, 400) })));
        },
      },
      {
        ...NEKO_PEER_CALL_DECL,
        handler: async (args) => {
          const tool = String(args.tool ?? '');
          // 轮次身份闸在 catalog 闸之前（先例 astrbot_call_tool 拒绝顺序同型，
          // _BUILD-PLAN §3.2 引用 4725feee6 world.ts:167-174）。
          const ta = this.turnActor();
          if (!ta) return { text: codeText(RET.UNKNOWN_SESSION, '本轮没有桥消息或超出 turn 保留窗，不能用桥侧身份执行'), failed: true };
          const ann = this.announcedTools().find((t) => t.name === tool);
          if (!ann) return { text: `unknown tool: ${tool}（只接受 catalog 已报名）`, failed: true };
          try {
            const reply = await this.driver!.callTool(tool, (args.args as Record<string, unknown>) ?? {}, ta.turn, ta.actor);
            if (reply.t === 'reply') {
              const r = reply as ReplyFrame;
              if (r.ok) return r.text ?? 'ok';
              if (r.error) return { text: codeText(r.error.code, r.error.message), failed: true };
            }
            return 'ok';
          } catch (e) {
            const ce = e as CbpError;
            return { text: `peer call failed: ${codeText(ce.code ?? RET.PEER_UNREACHABLE, ce.message ?? String(e))}`, failed: true };
          }
        },
      },
    ];
  }

  webUi(): WorldWebUiDecl {
    return {
      lamps: [
        {
          label: 'N.E.K.O 桥',
          state: this.connected ? 'online' : this.cfg.enabled ? 'error' : 'offline',
          hint: `${this.cfg.role} ${this.cfg.role === 'listen' ? `${this.cfg.host}:${this.cfg.port}` : this.cfg.url}`,
        },
      ],
      badges: [
        { label: 'egress', value: this.cfg.egress ? 'on' : 'off', tone: this.cfg.egress ? 'on' : 'off' },
        { label: 'consent', value: this.consent || '—', tone: 'plain' },
        { label: '会话', value: this.seenConvs.size, tone: 'plain' },
      ],
      panels: [
        {
          id: 'status',
          title: '桥状态',
          description: '连接、协商结果、consent 态、catalog、降级清单。',
          getMethods: ['get'],
        },
      ],
      // 面板只经 GET/POST /api/webui/providers/<pageId>/panels/<panel>/<method>
      // （cortico server.ts:2342-2343 @836238311）。入站数据面不走面板：CBP over WS。
      invoke: async (panel, method) => {
        if (panel === 'status' && method === 'get') {
          return {
            connected: this.connected,
            role: this.cfg.role,
            caps: this.caps,
            consent: this.consent,
            catalog: this.catalog,
            degraded: this.degradedList.slice(-10),
          };
        }
        return { error: `unknown panel/method: ${panel}/${method}` };
      },
      config: [CONFIG_GROUP],
      promptDocs: [
        {
          key: `worlds.${WORLD_ID}.envPrompt`,
          title: 'N.E.K.O 桥 · 环境提示词',
          description: '桥的连接角色与协商状态、出站门与两轴缺省、consent 等待态与降级清单。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'neko.connection', description: '桥的连接与协商状态。', multiline: true },
            { name: 'neko.scope', description: '出站门、限流与两轴缺省。' },
            { name: 'neko.window', description: 'turn 保留窗秒数与覆盖口（两端同源，工单二 F2）。' },
            { name: 'neko.self', description: '回声抑制状态与 self 声明（neko 线永久 proven:false ⇒ 常态 self-echo:off）。' },
            { name: 'neko.conversations', description: '见过的会话键。', multiline: true },
            { name: 'neko.tools', description: '对端已申报工具。', multiline: true },
            { name: 'neko.degraded', description: '降级清单。', multiline: true },
            { name: 'neko.consent', description: 'consent 等待态。' },
          ],
        },
      ],
    };
  }

  // ── 内部 ────────────────────────────────────────────────

  private agentId(): AgentId {
    return { name: 'cortico-world-neko', version: readExtensionVersion(), sha: '' };
  }

  /**
   * F3 出站身份：只从本轮入站 msg 的实证记录组装 turn+actor（§1.3）。
   * 没有记录就返回 null——调用方本地先拒（60004），绝不自报、伪造或留空。
   * actor.conv = 入站消息的会话（身份面），与 args.conv（目的地）无关；
   * platform 逐字取本线名（§1.2：neko 线 bridge 侧取 bus source，对端以自有记录对账）；
   * anon：member.id == self.id → 'self'（self 取协商声明，缺席退配置兜底），
   * 其余 'identified'。neko bus 面没有匿名位载荷，'anonymous' 在本线填不出来、不冒报。
   */
  private turnActor(): { turn: string; actor: Actor } | null {
    const rec = this.lastTurn;
    if (!rec) return null;
    // 工单二 F2（决定 3）：窗长单源 = CBP-v1.json $defs/turnWindow → gen_pins →
    // spec/pins.json → PINS.turn.ttlSeconds，缺省 300 秒；env CORTICO_TURN_TTL_SECONDS
    // 两端同名可覆盖，坏值回落并记 degraded。超窗即清实证记录：旧 turn 不得跨窗复用
    // （桥侧账本同窗同步过期，两端对账一致；与 dedup 的 600 秒无关）。
    const win =
      this.opts.turnTtlSeconds === undefined ? effectiveTurnTtlSeconds() : { ttlSeconds: this.opts.turnTtlSeconds, degraded: null };
    if (win.degraded) this.noteDegraded(win.degraded);
    if (this.nowFn() - rec.at > win.ttlSeconds * 1000) {
      this.lastTurn = null;
      this.noteDegraded('turn-expired');
      return null;
    }
    if (rec.id === '' || rec.conv === '' || rec.member.id === '') return null;
    const selfId = this.driver?.peerSelf()?.id || this.cfg.selfId;
    const anon = selfId !== '' && selfId === rec.member.id ? 'self' : 'identified';
    return {
      turn: rec.id,
      actor: { platform: 'neko', conv: rec.conv, member: { id: rec.member.id, name: rec.member.name }, anon },
    };
  }

  /**
   * §2.4 显式降级面：self-echo 状态单源 = 协商到的 peer self 声明。
   * neko 线永久 proven:false（§6.9）⇒ 常态就是 self-echo:off，不是没配好。
   */
  private peerEchoState(): string {
    const ps = this.driver?.peerSelf() ?? null;
    if (ps?.proven === true) return `self-echo:on（实证 self=${ps.id}）`;
    if (ps) return `self-echo:off（桥申报 self=${ps.id || '（空）'} proven:false，照常投递）`;
    return `self-echo:off（协商 self 缺席；配置兜底 id=${this.cfg.selfId || '（空）'}，不承诺抑制）`;
  }

  private onState(s: DriverState): void {
    this.connected = s.connected;
    // F3：桥侧 TurnLedger 挂在连接上（SECURITY-CBP §1.3 turn 查入站记录，§5.2 二顶一清缓存）。
    // 断线即清本地实证轮次，旧 turn 不得跨连接复用（复用会被桥判 60004）。
    if (!s.connected) this.lastTurn = null;
    if (this.driver && s.connected) this.caps = this.driver.effectiveCaps();
    void this.pushStatusEvent('connection', { connected: s.connected, role: s.role, peersReady: s.peersReady });
  }

  private onFrame(f: Frame): void {
    switch (f.t) {
      case 'msg':
        void this.onMsg(f as MsgFrame);
        return;
      case 'notice':
        void this.onNotice(f as NoticeFrame);
        return;
      case 'event':
        void this.onEventFrame(f as EventFrame);
        return;
      case 'catalog':
        this.catalog = sanitizeTools((f as CatalogFrame).tools).ok;
        return;
      case 'call': {
        // F2：被调面第一切片不开（CHANGELOG 阶段二项），申报面已退空（peerToolCatalog）。
        // 万一仍有 call 打进来，立即回 60002 capability_unavailable——静默不回帧会让
        // 对端空等内核 30s call 超时拿 60007（FIXORDER F2 第 2 件事）。rid 已被内核
        // idem.claim 占用，这一帧不回，同 rid 的重投也只会命中空的幂等窗口。
        const cf = f as CallFrame;
        const sent = this.driver?.send({
          ...newHead('reply'),
          t: 'reply',
          v: 1,
          rid: cf.rid,
          ok: false,
          error: err(RET.CAPABILITY_UNAVAILABLE, `capability_unavailable: Cortico 侧被调面未开，${cf.tool} 不可调`),
        });
        if (!sent) this.host?.log.warn('入站 call 的 60002 回帧没有发出', { tool: cf.tool });
        return;
      }
      default:
        // reply/ack 已在内核 PendingTable 消费；tick 由 driver 处理。
        return;
    }
  }

  private async onMsg(frame: MsgFrame): Promise<void> {
    if (!this.host) return;
    const degraded: string[] = [];
    for (const seg of frame.segments) {
      if (!isKnownType(seg.type)) degraded.push(`unknown-segment:${seg.type}`);
    }
    for (const d of degraded) this.noteDegraded(d);
    const blobs: BlobInput[] = [];
    for (const seg of frame.segments) {
      const blob = imageSegToBlob(seg);
      if (!blob) continue;
      if (!this.host.modelFacts.accepts(blob.mime)) {
        this.noteDegraded(`model-rejects:${blob.mime}`);
        continue;
      }
      blobs.push(blob);
    }
    this.seenConvs.add(frame.conv);
    // F3：本轮实证记录 = 这条入站 msg 帧本身（sender/conv 是 N.E.K.O 宿主实证侧值，
    // 桥从 bus metadata 取，watch.py:57）；出站 call 的 turn/actor 从这里填，
    // args 里的任何身份串一律不作数。改名与剥离 contextDelivery 在本层（pushEvent 入参 Omit 它）。
    this.lastTurn = { id: frame.id, conv: frame.conv, member: { id: frame.sender.id, name: frame.sender.name }, at: this.nowFn() };
    const peer = this.driver?.peerSelf() ?? null;
    const { envelope, push, degraded: selfDeg } = msgToEnvelope(frame, {
      worldId: WORLD_ID,
      // F1/F2：回声判定唯一入口 = 桥握手帧申报的 self；proven:false 时内核照常投递并显式降级。
      // 协商 self 缺席时配置值只作兜底（impl 行 9），不据它宣称实证。
      self: peer ?? undefined,
      selfId: this.cfg.selfId !== '' ? this.cfg.selfId : undefined,
      render: (segs) => renderSegments(segs),
      blobs: blobs.length ? blobs : undefined,
    });
    if (selfDeg) this.noteDegraded(selfDeg.reason);
    if (envelope.contextDelivery === 'archive-only') {
      const { contextDelivery: _omit, ...rest } = envelope;
      await this.host.pushEvent(
        { ...rest, type: EVENTS.messageSelf } as Parameters<WorldHost['pushEvent']>[0],
        push,
      );
    } else {
      await this.host.pushEvent(envelope as unknown as Parameters<WorldHost['pushEvent']>[0], push);
    }
    if (degraded.length > 0) await this.pushStatusEvent('degraded', { conv: frame.conv, degraded });
  }

  private async onNotice(frame: NoticeFrame): Promise<void> {
    if (frame.kind === 'consent') this.consent = consentLabel(frame.raw);
    const { envelope, push } = noticeToEnvelope(frame, { worldId: WORLD_ID });
    await this.host?.pushEvent(envelope as unknown as Parameters<WorldHost['pushEvent']>[0], push);
  }

  private async onEventFrame(frame: EventFrame): Promise<void> {
    const { envelope, push } = eventToEnvelope(frame, { worldId: WORLD_ID });
    if (frame.name === 'degraded') this.noteDegraded(typeof frame.data === 'string' ? frame.data : 'bridge-degraded');
    await this.host?.pushEvent(envelope as unknown as Parameters<WorldHost['pushEvent']>[0], push);
  }

  private async pushStatusEvent(name: 'connection' | 'degraded', data: unknown): Promise<void> {
    await this.host?.pushEvent(
      {
        type: name === 'connection' ? EVENTS.connection : EVENTS.degraded,
        ts: new Date().toISOString(),
        source: WORLD_ID,
        // 桥状态是「已认证操作员通道」→ internal（types.ts:687-695；先例同断）。
        origin: 'internal',
        text: JSON.stringify(data),
        meta: { data },
      },
      { trigger: 'flush' },
    );
  }

  private replyToResult(reply: Frame, conv: string): string | ToolOutcome {
    if (reply.t === 'reply') {
      const r = reply as ReplyFrame;
      if (r.ok) return typeof r.text === 'string' && r.text !== '' ? r.text : `sent to ${conv}`;
      if (r.error) return { text: codeText(r.error.code, r.error.message), failed: true };
    }
    if (reply.t === 'ack') return `queued to ${conv}`;
    return { text: `unexpected reply frame: ${reply.t}`, failed: true };
  }

  private noteDegraded(item: string): void {
    if (!this.degradedList.includes(item)) this.degradedList.push(item);
  }

  private rateAllowed(): boolean {
    if (this.cfg.ratePerMin <= 0) return true;
    const now = Date.now();
    this.sendWindow = this.sendWindow.filter((t) => now - t < 60_000);
    if (this.sendWindow.length >= this.cfg.ratePerMin) return false;
    this.sendWindow.push(now);
    return true;
  }
}

export const DEFAULT_WORLD_OPTS: WorldOptions = { cfg: DEFAULTS };

/**
 * 本端上报给桥的工具目录（CBP hello.tools / ready.tools，G5 对账自报腿）。
 * F2：被调面第一切片不开——入站 call 只会被回 60002（onFrame 的 call 分支），
 * 所以这里必须申报空集。申报而不服务 = 对端每次误调空等 30s 拿 60007，线上
 * 申报面与实供面失真（FIXORDER F2；交集推导口径同 spec/SECURITY-CBP.md §7
 * 对 maibot 同类缺陷的裁决）。阶段二开被调面时，按当时的实证面把四支加回
 * 本表（名字见 TOOL_DECLS；risk 六值逐字 cortico types.ts:202 @836238311，
 * 内核 frames.ts:13 同表；send 的 confirm_required 位反映出站门状态，
 * 先例 astrbot peerToolCatalog 同型）。
 */
export function peerToolCatalog(_cfg: NekoBridgeConfig): ToolAnn[] {
  return [];
}
