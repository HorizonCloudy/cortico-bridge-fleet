/**
 * world.ts —— Cortico 侧 `AstrbotBridgeWorld`。工具四件与档位表钉 _BUILD-PLAN.md §3.2；
 * 帧映射与兼容读在 normalize.ts / driver.ts。
 *
 * 硬规则落点（d-bridge-priorart §7 八条；闸项=cortico dry-mount.ts:126 @836238311）：
 * - 构造纯：create() 只存配置，不连接、不读密钥、不 await。
 * - start() 等待上限 12s 放行；driver.start() 永不 reject。
 * - 自发回声只归档：PushOptions{deliver:false} 是唯一合法入口
 *   （pushEvent 入参 Omit 掉 contextDelivery，types.ts:692-694；宿主侧翻成
 *   archive-only，core.ts:519）。
 * - blob 附带前先问 modelFacts.accepts(mime)（types.ts:602；先例 §5-6）。
 * - tools() 名字 ⊆ describe.json tools（describe-export.ts:134-136）。
 * - 不实现 outputTap()（_BUILD-PLAN §3.3：桥包一律不实现）。
 * - meta.raw 恒留原始载荷（硬规则 8）。
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import type {
  BlobInput,
  ToolDef,
  ToolOutcome,
  World,
  WorldHost,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import { BridgeDriver, type BridgeLike, type DriverHandlers, type Negotiated } from './driver.ts';
import { tsToIso, type Actor, type MsgFrame, type ToolAnn } from './frames.ts';
import {
  EVENTS,
  PUSH_OPTS_SELF,
  imageSegToBlob,
  metaForMsg,
  pushOptsForMsg,
  pushOptsForNotice,
  renderSegments,
  senderKeyOfMsg,
} from './normalize.ts';
import { CONFIG_GROUP, DEFAULTS, WORLD_ID, normalizeConfig, type AstrbotBridgeConfig } from './config.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 扩展版本：读包根 package.json，不在代码里手写第二份（收编先例 src/version.ts:4-15 同法）。 */
export function readExtensionVersion(): string {
  try {
    const path = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

/**
 * 工具静态声明（名字/描述/parameters/tags/barrierAfter）。
 * 单一来源：tools() 与 definition.describe 共用；描述与 parameters 必须和
 * describe.json 逐字一致（describe-export.ts:141-152 在缺省配置下 diff 不一致即警）。
 */
export type ToolDecl = Omit<ToolDef, 'handler'>;

export const ASTRBOT_SEND_DECL: ToolDecl = {
  name: 'astrbot_send_message',
  description:
    'Send text into an AstrBot-side conversation via the bridge. Only works while egress is open; ' +
    'closed door returns 60005 door_closed. conv is the conversation key from an astrbot.message event.',
  tags: ['write'],
  barrierAfter: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      conv: { type: 'string', description: '会话键（astrbot.message 的 senderKey/conv）。' },
      text: { type: 'string' },
    },
    required: ['conv', 'text'],
  },
};

export const ASTRBOT_STATUS_DECL: ToolDecl = {
  name: 'astrbot_status',
  description: 'Report bridge connection, negotiated CBP caps, peer tool catalog and degraded list.',
  tags: ['read'],
  parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
};

export const ASTRBOT_HISTORY_DECL: ToolDecl = {
  name: 'astrbot_history',
  description: 'Read archived astrbot.* events from the Cortico event store. Never queries the peer.',
  tags: ['read'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { conv: { type: 'string' }, limit: { type: 'integer' } },
    required: [],
  },
};

export const ASTRBOT_PEER_CALL_DECL: ToolDecl = {
  name: 'astrbot_peer_call',
  description:
    'Call a peer tool by name. Only names in the peer catalog are accepted. Runs with the identity ' +
    'of the message that started this turn; a turn without a bridge message is refused.',
  tags: ['write'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { tool: { type: 'string' }, args: { type: 'object' } },
    required: ['tool'],
  },
};

export const TOOL_DECLS: readonly ToolDecl[] = [
  ASTRBOT_SEND_DECL,
  ASTRBOT_STATUS_DECL,
  ASTRBOT_HISTORY_DECL,
  ASTRBOT_PEER_CALL_DECL,
];

export interface WorldOptions {
  cfg: Partial<AstrbotBridgeConfig> | undefined;
  /** 注入点：契约测试用假驱动，不碰 WebSocket（先例 tests/helpers/fake-bridge.ts 同位）。 */
  makeDriver?: (cfg: AstrbotBridgeConfig, log: WorldHost['log'], handlers: DriverHandlers) => BridgeLike;
}

export class AstrbotBridgeWorld implements World {
  readonly id = WORLD_ID;
  private readonly cfg: AstrbotBridgeConfig;
  private host: WorldHost | null = null;
  private driver: BridgeLike | null = null;
  private connected = false;
  private negotiated: Negotiated = { cbp: false, version: 0, caps: [], ownerIds: [], tts: { ready: false } };
  private seenConvs = new Set<string>();
  /** F3：本轮入站 msg 的实证记录（宿主经桥帧带进来的值），出站 call 的 turn/actor 唯一来源。 */
  private lastTurn: { id: string; conv: string; member: { id: string; name: string } } | null = null;
  private catalog: ToolAnn[] = [];
  /**
   * 对端可调用工具集 = 握手申报 ∪ 最近一次 catalog 帧（同名为准）。
   * 只看 catalog 帧会让「只在 hello/ready 申报、不发 catalog」的桥把自己报的能力全判 60002。
   */
  private announcedTools(): ToolAnn[] {
    const byName = new Map<string, ToolAnn>();
    for (const t of this.negotiated.tools ?? []) byName.set(t.name, t);
    for (const t of this.catalog) byName.set(t.name, t);
    return [...byName.values()];
  }

  private degradedList: string[] = [];
  private sendWindow: number[] = [];

  constructor(opts: WorldOptions) {
    this.cfg = normalizeConfig(opts.cfg);
    this.opts = opts;
  }

  private readonly opts: WorldOptions;

  /** 连接等待上限 12s 放行（蓝图 §2.3 硬规则）。 */
  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const driver =
      this.opts.makeDriver?.(this.cfg, host.log, this.driverHandlers()) ??
      new BridgeDriver(
        {
          url: this.cfg.url,
          token: this.cfg.token,
          agent: { name: 'cortico-world-astrbot-bridge', version: readExtensionVersion(), sha: '' },
          caps: ['msg-v2', 'notice', 'peer-tools', 'catalog'],
          tools: peerToolCatalog(this.cfg),
          reconnectBaseMs: this.cfg.reconnectBaseMs,
          reconnectMaxMs: this.cfg.reconnectMaxMs,
          log: host.log,
        },
        this.driverHandlers(),
      );
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
  }

  envPromptVars(): Record<string, string> {
    return {
      'astrbot.connection': this.connected
        ? this.negotiated.cbp
          ? `已连接（CBP v${this.negotiated.version}，caps：${this.negotiated.caps.join('、') || '交集为空'}）`
          : '已连接（旧私有帧面：CBP 功能位全关）'
        : '未连接（后台重连中）',
      'astrbot.scope': `mode=${this.cfg.mode}，egress=${this.cfg.egress ? '开' : '关'}`,
      'astrbot.self': this.negotiated.self?.name ?? '',
      'astrbot.owner': this.negotiated.ownerIds.join(',') || '（无）',
      'astrbot.conversations': [...this.seenConvs].slice(-50).join('、') || '（还没有）',
      'astrbot.tools': this.announcedTools().map((t) => t.name).join('、') || '（桥没报清单）',
      'astrbot.degraded': this.degradedList.slice(-10).join('；') || '（无）',
    };
  }

  tools(): ToolDef[] {
    return [
      {
        ...ASTRBOT_SEND_DECL,
        handler: async (args): Promise<string | ToolOutcome> => {
          if (!this.cfg.egress) {
            this.noteDegraded('egress-closed');
            return { text: '60005 door_closed: 出站门未开', failed: true };
          }
          if (!this.rateAllowed()) return { text: 'rate_limited: 超出每分钟发送上限', failed: true };
          const conv = String(args.conv ?? '').trim();
          if (!conv) return { text: 'bad_args: conv 必填', failed: true };
          const res = await this.driver!.send(conv, String(args.text ?? ''));
          if (res.ok) return `sent to ${conv}`;
          if (res.uncertain) return { text: `60007 send_uncertain: ${res.error ?? '结果未知，先确认再重试'}`, failed: true };
          return { text: `send failed: ${res.error ?? '未知原因'}`, failed: true };
        },
      },
      {
        ...ASTRBOT_STATUS_DECL,
        handler: async () =>
          JSON.stringify(
            {
              connected: this.connected,
              cbp: this.negotiated.cbp,
              caps: this.negotiated.caps,
              self: this.negotiated.self,
              tts: this.negotiated.tts,
              catalog: this.announcedTools(),
              degraded: this.degradedList.slice(-10),
              egress: this.cfg.egress,
            },
            null,
            1,
          ),
      },
      {
        ...ASTRBOT_HISTORY_DECL,
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
        ...ASTRBOT_PEER_CALL_DECL,
        handler: async (args) => {
          const tool = String(args.tool ?? '');
          // F3 身份闸在 catalog 闸之前（先例 astrbot_call_tool 的拒绝顺序同型，
          // 4725feee6 world.ts:167-174：桌宠轮次没有 QQ 身份直接拒）。
          // turn/actor 只从本轮入站实证记录组装：自报、伪造、留空都是违例，本地先拒不发（§1.3）。
          const ta = this.turnActor();
          if (!ta) {
            return { text: '60004 unknown_session: 本轮没有可实证的桥消息，turn/actor 不能自报', failed: true };
          }
          const ann = this.announcedTools().find((t) => t.name === tool);
          if (!ann) return { text: `unknown tool: ${tool}（只接受 catalog 已报名）`, failed: true };
          const res = await this.driver!.callTool(tool, (args.args as Record<string, unknown>) ?? {}, ta.turn, ta.actor);
          if (res.ok) return res.result ?? 'ok';
          return { text: `peer call failed: ${res.error ?? '未知原因'}`, failed: true };
        },
      },
    ];
  }

  webUi(): WorldWebUiDecl {
    return {
      lamps: [
        {
          label: 'AstrBot 桥',
          state: this.connected ? 'online' : this.cfg.enabled ? 'error' : 'offline',
          hint: this.negotiated.cbp ? `CBP caps: ${this.negotiated.caps.join(',')}` : '旧私有帧面',
        },
      ],
      badges: [
        { label: 'egress', value: this.cfg.egress ? 'on' : 'off', tone: this.cfg.egress ? 'on' : 'off' },
        { label: '会话', value: this.seenConvs.size, tone: 'plain' },
      ],
      panels: [
        {
          id: 'status',
          title: '桥状态',
          description: '连接、协商结果、catalog、降级清单。',
          getMethods: ['get'],
        },
      ],
      // 面板只经 GET/POST /api/webui/providers/<pageId>/panels/<panel>/<method>
      // （cortico server.ts:2342-2343 @836238311；pageId=world:<id>，
      // extensions.ts:47-51 EXTENSION_PAGE_KIND）。无事件 webhook：/api/events 只 GET
      // （server.ts:1720），所以入站只有本包主动外拨这一条路，不造新路由。
      invoke: async (panel, method) => {
        if (panel === 'status' && method === 'get') {
          return { connected: this.connected, ...this.negotiated, catalog: this.catalog, degraded: this.degradedList.slice(-10) };
        }
        return { error: `unknown panel/method: ${panel}/${method}` };
      },
      config: [CONFIG_GROUP],
      promptDocs: [
        {
          key: `worlds.${WORLD_ID}.envPrompt`,
          title: 'AstrBot 桥 · 环境提示词',
          description: '桥的连接与能力协商状态、消息范围、出站门与对端工具清单。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'astrbot.connection', description: '桥的连接与协商状态。', multiline: true },
            { name: 'astrbot.scope', description: '消息范围与出站门。' },
            { name: 'astrbot.self', description: '桥自报的 bot 名字。' },
            { name: 'astrbot.owner', description: '主人（桥的管理员名单）。' },
            { name: 'astrbot.conversations', description: '见过的会话键。', multiline: true },
            { name: 'astrbot.tools', description: '对端已申报工具。', multiline: true },
            { name: 'astrbot.degraded', description: '降级清单。', multiline: true },
          ],
        },
      ],
    };
  }

  // ── 内部 ────────────────────────────────────────────────

  private driverHandlers(): DriverHandlers {
    return {
      onReady: (n) => {
        this.negotiated = n;
        void this.pushStatusEvent('connection', { connected: this.connected, ...n });
      },
      onState: (connected) => {
        this.connected = connected;
        void this.pushStatusEvent('connection', { connected });
      },
      onMsg: (f) => void this.onMsg(f),
      onNotice: (f) => {
        const text = typeof f.text === 'string' && f.text !== '' ? f.text : (f.kind ?? 'notice');
        void this.host?.pushEvent(
          {
            type: EVENTS.notice,
            ts: tsToIso(typeof f.ts === 'number' ? f.ts : Date.now() / 1000),
            source: WORLD_ID,
            origin: 'external',
            text,
            meta: { kind: f.kind, conv: f.conv, raw: f.raw ?? f },
          },
          pushOptsForNotice(f),
        );
      },
      onEvent: (f) => {
        if (f.name === 'connection' || f.name === 'degraded') void this.pushStatusEvent(f.name, f.data);
        else this.host?.log.warn('未知 event 帧名，已忽略', { name: f.name });
      },
      onCatalog: (tools) => {
        this.catalog = tools;
      },
    };
  }

  private async onMsg(frame: MsgFrame): Promise<void> {
    if (!this.host) return;
    const ts = tsToIso(typeof frame.ts === 'number' ? frame.ts : Date.now() / 1000);
    const { text, degraded } = renderSegments(frame.segments ?? []);
    for (const d of degraded) this.noteDegraded(d);
    this.seenConvs.add(frame.conv);
    const senderId = frame.sender?.id ?? '';
    this.lastTurn = { id: frame.id, conv: frame.conv, member: { id: senderId, name: frame.sender?.name ?? '' } };
    const isSelf = this.negotiated.self?.id !== undefined && senderId !== '' && senderId === this.negotiated.self?.id;
    const blobs: BlobInput[] = [];
    for (const seg of frame.segments ?? []) {
      const blob = imageSegToBlob(seg);
      if (!blob) continue;
      if (!this.host.modelFacts.accepts(blob.mime)) {
        this.noteDegraded(`model-rejects:${blob.mime}`);
        continue;
      }
      blobs.push(blob);
    }
    await this.host.pushEvent(
      {
        type: isSelf ? EVENTS.messageSelf : EVENTS.message,
        ts,
        source: WORLD_ID,
        origin: 'external',
        text,
        senderKey: senderKeyOfMsg(frame),
        meta: metaForMsg(frame),
        blobs: blobs.length ? blobs : undefined,
      },
      // 自发回声「只归档」的唯一入口 = deliver:false（core.ts:519 落库翻 archive-only）。
      isSelf ? PUSH_OPTS_SELF : pushOptsForMsg(frame),
    );
    if (degraded.length > 0) await this.pushStatusEvent('degraded', { conv: frame.conv, degraded });
  }

  /**
   * F3 出站身份：只从本轮入站 msg 的实证记录组装 turn+actor（SECURITY-CBP §1.3）。
   * 没有记录、或宿主没实证发起人（member.id 空）就返回 null——调用方本地先拒 60004，
   * 绝不自报、伪造或留空。platform 取 UMO 首段（§1.2 AstrBot 线口径）；
   * anon：member.id == 协商 self.id → 'self'，其余 'identified'。
   * astrbot 线载荷无匿名位，'anonymous' 填不出来就不冒报；空 sender 也不冒报 'unknown'。
   */
  private turnActor(): { turn: string; actor: Actor } | null {
    const rec = this.lastTurn;
    if (!rec || rec.id === '' || rec.conv === '' || rec.member.id === '') return null;
    const platform = rec.conv.split(':')[0] ?? '';
    if (platform === '' || platform.length > 64) return null;
    const selfId = this.negotiated.self?.id ?? '';
    const anon: Actor['anon'] = selfId !== '' && selfId === rec.member.id ? 'self' : 'identified';
    return {
      turn: rec.id,
      actor: { platform, conv: rec.conv, member: { id: rec.member.id, name: rec.member.name }, anon },
    };
  }

  private async pushStatusEvent(name: 'connection' | 'degraded', data: unknown): Promise<void> {
    await this.host?.pushEvent(
      {
        type: name === 'connection' ? EVENTS.connection : EVENTS.degraded,
        ts: new Date().toISOString(),
        source: WORLD_ID,
        // 桥状态是「已认证操作员通道」→ internal（types.ts:687-695 注释；先例 world.ts:574 同断）。
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

  private rateAllowed(): boolean {
    if (this.cfg.maxSendsPerMinute <= 0) return true;
    const now = Date.now();
    this.sendWindow = this.sendWindow.filter((t) => now - t < 60_000);
    if (this.sendWindow.length >= this.cfg.maxSendsPerMinute) return false;
    this.sendWindow.push(now);
    return true;
  }
}

export const DEFAULT_WORLD_OPTS: WorldOptions = { cfg: DEFAULTS };

/**
 * 本端上报给对端的工具目录（CBP hello.tools / catalog，G5 漂移对账的自报腿）。
 * risk 六值逐字 types.ts:202；send 的 confirm_required 位反映出站门状态。
 */
export function peerToolCatalog(cfg: AstrbotBridgeConfig): ToolAnn[] {
  return [
    { name: 'astrbot_send_message', risk: 'write', confirm_required: !cfg.egress },
    { name: 'astrbot_status', risk: 'read', confirm_required: false },
    { name: 'astrbot_history', risk: 'read', confirm_required: false },
    { name: 'astrbot_peer_call', risk: 'write', confirm_required: true },
  ];
}
