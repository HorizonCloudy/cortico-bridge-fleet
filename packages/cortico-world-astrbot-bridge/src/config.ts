/**
 * `worlds.astrbot-bridge` 配置段 —— 形状钉自两份先例 + _BUILD-PLAN §3.2 模板：
 * - 旧旋钮逐字收编自 cortico-world-astrbot@4725feee6 src/config.ts:9-50
 *   （mode/nameAliases/includeTime/reconnect/maxSendsPerMinute/channelHint）。
 * - egress（出站门，缺省 false）来自 _BUILD-PLAN §3.2 definition 模板行。
 * - ConfigGroup 路径必须全部落在 `worlds.<id>.` 段内，否则 dryMountWorld 判 fail
 *   （cortico src/extensions/dry-mount.ts:47-63,217 @836238311）；
 *   x-hot 语义：false=改完需重启实例。
 *
 * 2026-11-19（SECURITY-CBP.md:121，10-22 / 11-13 索引仓判例）：`token` 配置串与
 * 面板项一并删除。CBP 共享密钥单源 = `ctx.secret('CORTICO_BRIDGE_TOKEN')`，只走
 * HTTP Upgrade 的 `Authorization: Bearer` 头；不落 config.json、不进面板、不进日志。
 * 缺密钥时 driver 直接拒拨（fail-shut），不再有「环回免鉴权」这条降级路。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';

// 收编件保持先例 id（4725feee6 definition.ts:10 `id:'astrbot'`）：
// 已部署实例的 `worlds.astrbot` 配置段、事件名、记忆检索键跨版本连续。
export const WORLD_ID = 'astrbot';

export interface AstrbotBridgeConfig {
  enabled: boolean;
  /** 桥（AstrBot 侧插件）的 WS 监听地址；本包是客户端拨过去。 */
  url: string;
  /** 出站门；缺省关（_BUILD-PLAN §3.2）。关着时发送工具直接回 60005。 */
  egress: boolean;
  /** 每分钟出站上限，0 不限；缺省 20（§3.2 模板 ratePerMin）。 */
  maxSendsPerMinute: number;
  /** A：只投递点名；B：全投递。缺省 mention（先例 config.ts:42）。 */
  mode: 'all' | 'mention';
  nameAliases: string;
  includeTime: boolean;
  channelHint: boolean;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

export const DEFAULTS: AstrbotBridgeConfig = {
  enabled: false,
  // 对端监听口钉先例 metadata.yaml help 文案的 17999（37c1e6ccd help：ws://<本机地址>:17999）。
  url: 'ws://127.0.0.1:17999',
  egress: false,
  maxSendsPerMinute: 20,
  mode: 'mention',
  nameAliases: '',
  includeTime: true,
  channelHint: true,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30_000,
};

export function normalizeConfig(raw: Partial<AstrbotBridgeConfig> | undefined): AstrbotBridgeConfig {
  const c = raw ?? {};
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    enabled: c.enabled === true,
    url: typeof c.url === 'string' && c.url !== '' ? c.url : DEFAULTS.url,
    egress: c.egress === true,
    maxSendsPerMinute: Math.max(0, Math.floor(num(c.maxSendsPerMinute, DEFAULTS.maxSendsPerMinute))),
    mode: c.mode === 'all' ? 'all' : 'mention',
    nameAliases: typeof c.nameAliases === 'string' ? c.nameAliases : '',
    includeTime: c.includeTime !== false,
    channelHint: c.channelHint !== false,
    reconnectBaseMs: Math.max(200, num(c.reconnectBaseMs, DEFAULTS.reconnectBaseMs)),
    reconnectMaxMs: Math.max(1000, num(c.reconnectMaxMs, DEFAULTS.reconnectMaxMs)),
  };
}

/** 面板与 WebUI 配置组：owner 必须是 `world:<id>`，键路径全在段内。 */
export const CONFIG_GROUP: ConfigGroup = {
  id: `world:${WORLD_ID}`,
  owner: `world:${WORLD_ID}`,
  schema: {
    type: 'object',
    title: 'AstrBot 桥（CBP）',
    description: 'Cortico 侧拨 AstrBot 桥的连接、出站门与消息范围。共享密钥不在此处配置，见部署环境 CORTICO_BRIDGE_TOKEN。',
    properties: {
      [`worlds.${WORLD_ID}.url`]: {
        type: 'string',
        title: '桥地址',
        'x-hot': false,
        description: '形如 ws://192.0.2.10:17999。改完重启本 World 生效。',
      },
      [`worlds.${WORLD_ID}.egress`]: {
        type: 'boolean',
        title: '出站门',
        'x-hot': true,
        'x-warning': true,
        description: '关着时 astrbot_send_message 直接回 60005 door_closed，不动对端。',
      },
      [`worlds.${WORLD_ID}.maxSendsPerMinute`]: {
        type: 'integer',
        title: '每分钟发送上限',
        minimum: 0,
        maximum: 600,
        'x-hot': true,
        description: '0 表示不限。缺省 20。',
      },
      [`worlds.${WORLD_ID}.mode`]: {
        type: 'string',
        title: '消息范围',
        enum: ['all', 'mention'],
        'x-hot': true,
        description: 'mention（默认）只投递点名；all 全投递。',
      },
      [`worlds.${WORLD_ID}.nameAliases`]: {
        type: 'string',
        title: '叫我的称呼',
        'x-hot': true,
        description: '逗号分隔；除 @ 之外命中即算点名。',
      },
      [`worlds.${WORLD_ID}.reconnectBaseMs`]: {
        type: 'integer',
        title: '重连起点',
        minimum: 200,
        maximum: 60_000,
        'x-suffix': 'ms',
        'x-hot': false,
      },
      [`worlds.${WORLD_ID}.reconnectMaxMs`]: {
        type: 'integer',
        title: '重连上限',
        minimum: 1000,
        maximum: 600_000,
        'x-suffix': 'ms',
        'x-hot': false,
      },
    },
  },
};
