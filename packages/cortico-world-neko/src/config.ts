/**
 * config.ts —— `worlds.neko` 配置段。形状钉自 _BUILD-PLAN.md §3.2 模板
 * （enabled/url/egress/ratePerMin）。F3 起 token 位删除：凭据走 ctx.secret
 * ('CORTICO_BRIDGE_TOKEN')，配置串与面板项不再携带（SECURITY-CBP §3 规则 2）。
 * 端口表沿用 §4.4（39701，建议缺省
 * 127.0.0.1，env 可覆盖：R6 装机以 doctor 实扫为准；内核 pins 快照同值
 * cortico-bridge-core/src/pins.ts:71 `nekoListen: 39701`，单一来源是
 * spec/pins.json 的「cortico-world-neko listen」行）。
 * 双角色（任务：world 双角色 WS 拨号/监听）：蓝图 §3.2 注 neko=39701 listen
 * 为缺省，dial 面保留（对端桥亦可反过来监听）。
 * ConfigGroup 键路径必须全在 `worlds.neko.` 段内且 defaults 有对应项，
 * 否则 dryMountWorld 判 fail（cortico src/extensions/dry-mount.ts:47-63,217
 * @836238311）。x-hot:false = 改完需重启本 World（先例 README 口径）。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigGroup } from 'cortico/core/types.ts';

export const WORLD_ID = 'neko';

export interface NekoBridgeConfig {
  enabled: boolean;
  /** listen = Cortico 侧监听、桥插件外拨进来（缺省，蓝图 §3.2）；dial = 本包拨对端。 */
  role: 'listen' | 'dial';
  /** listen 角色绑定面；建议缺省环回（§4.4 表，48913 类教训：禁听句不等于宿主 HTTP 皆环回）。 */
  host: string;
  port: number;
  /** dial 角色专用。 */
  url: string;
  // F3：token 字段已删（SECURITY-CBP §3 规则 2）。共享密钥只从
  // ctx.secret('CORTICO_BRIDGE_TOKEN') 取，由 definition.ts create() 注入实例。
  // 值不进配置串、不进面板、不进 config.json。传输面规则不变（F4）：只走
  // HTTP Upgrade 头 Authorization: Bearer；URL query 带 token 一律 close 4401。
  /** 本端 self 声明 id（hello/ready self 位）：手填值一律 proven:false（§2.2），
   * 只作申报与兜底，回声抑制只认桥握手申报且 proven:true 的 self。 */
  selfId: string;
  /** 出站门；缺省关（§3.2 模板行）。关着时 neko_send_message 直接回 60005。 */
  egress: boolean;
  /** 每分钟出站上限，0 不限；缺省 20（§3.2 模板 ratePerMin）。 */
  ratePerMin: number;
  /** push_message 两轴之一的缺省 visibility（CSV，只吃 chat/hud，r-neko §5 轴校验）。 */
  visibility: string;
  /** 缺省 ai_behavior，只吃 respond/read/blind。 */
  aiBehavior: string;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

export const DEFAULTS: NekoBridgeConfig = {
  enabled: false,
  role: 'listen',
  host: '127.0.0.1',
  port: 39701,
  url: 'ws://127.0.0.1:39701',
  selfId: '',
  egress: false,
  ratePerMin: 20,
  visibility: 'chat',
  aiBehavior: 'respond',
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30_000,
};

const ROLES: readonly NekoBridgeConfig['role'][] = ['listen', 'dial'];

export function normalizeConfig(raw: Partial<NekoBridgeConfig> | undefined): NekoBridgeConfig {
  const c = raw ?? {};
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
  return {
    enabled: c.enabled === true,
    role: ROLES.includes(c.role as NekoBridgeConfig['role']) ? (c.role as NekoBridgeConfig['role']) : 'listen',
    host: str(c.host, DEFAULTS.host) || DEFAULTS.host,
    port: Math.min(65_535, Math.max(1, Math.floor(num(c.port, DEFAULTS.port)))),
    url: str(c.url, DEFAULTS.url) || DEFAULTS.url,
    selfId: str(c.selfId, ''),
    egress: c.egress === true,
    ratePerMin: Math.max(0, Math.floor(num(c.ratePerMin, DEFAULTS.ratePerMin))),
    visibility: str(c.visibility, DEFAULTS.visibility),
    aiBehavior: str(c.aiBehavior, DEFAULTS.aiBehavior),
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
    title: 'N.E.K.O 桥（CBP）',
    description: 'Cortico 侧与 N.E.K.O 桥插件（cortico-bridge-neko）的连接、出站门与两轴缺省。',
    properties: {
      [`worlds.${WORLD_ID}.role`]: {
        type: 'string',
        title: '连接角色',
        enum: ['listen', 'dial'],
        'x-hot': false,
        description: 'listen（默认）：本包监听 39701，桥插件外拨进来。dial：本包拨 url。',
      },
      [`worlds.${WORLD_ID}.host`]: { type: 'string', title: '监听绑定', 'x-hot': false, description: '建议 127.0.0.1；48913 教训：绑定面要逐口核。' },
      [`worlds.${WORLD_ID}.port`]: {
        type: 'integer',
        title: '监听端口',
        minimum: 1,
        maximum: 65_535,
        'x-hot': false,
        description: '缺省 39701（spec/pins.json ports 行）；避让段以 doctor 实扫为准（R6）。',
      },
      [`worlds.${WORLD_ID}.url`]: { type: 'string', title: '桥地址（dial）', 'x-hot': false, description: '形如 ws://127.0.0.1:39701。' },
      // F3：无 token 面板项。凭据在部署 .env 的 CORTICO_BRIDGE_TOKEN（ctx.secret）。
      [`worlds.${WORLD_ID}.selfId`]: { type: 'string', title: '本端 self 声明 id', 'x-hot': true, description: '写进 hello/ready 的 self.id（proven:false）。回声抑制只认桥握手申报且 proven:true 的 self；此值仅在协商 self 缺席时作兜底判定。' },
      [`worlds.${WORLD_ID}.egress`]: {
        type: 'boolean',
        title: '出站门',
        'x-hot': true,
        'x-warning': true,
        description: '关着时 neko_send_message 直接回 60005 door_closed，不动对端。',
      },
      [`worlds.${WORLD_ID}.ratePerMin`]: {
        type: 'integer',
        title: '每分钟发送上限',
        minimum: 0,
        maximum: 600,
        'x-hot': true,
        description: '0 表示不限。缺省 20。',
      },
      [`worlds.${WORLD_ID}.visibility`]: {
        type: 'string',
        title: '缺省 visibility',
        'x-hot': true,
        description: 'CSV，只吃 chat/hud（push_message_schema.py:63）；脏值丢弃。',
      },
      [`worlds.${WORLD_ID}.aiBehavior`]: {
        type: 'string',
        title: '缺省 ai_behavior',
        enum: ['respond', 'read', 'blind'],
        'x-hot': true,
        description: 'push_message_schema.py:64 三值；非法回落 respond（:66 缺省）。',
      },
      [`worlds.${WORLD_ID}.reconnectBaseMs`]: { type: 'integer', title: '重连起点', minimum: 200, maximum: 60_000, 'x-suffix': 'ms', 'x-hot': false },
      [`worlds.${WORLD_ID}.reconnectMaxMs`]: { type: 'integer', title: '重连上限', minimum: 1000, maximum: 600_000, 'x-suffix': 'ms', 'x-hot': false },
    },
  },
};

/**
 * 工单二 F1（用户决定 2）：一次性清理旧残键。
 * 工单一 F3 删了 `worlds.neko.token` 的字段与面板项，但引擎 `persist()` 是深合并写回，
 * 旧部署 config.json 里已经落盘的明文键不会自己消失（X3 台账 §2.6 记的正是这条）。
 * 升级装载时在 definition.create() 里删一次，规则照工单逐条落码：
 * - 只删 `worlds.neko` 段的 `token` 这一个键，其余段与字节不动——文件按引擎同款
 *   2 空格缩进 + 尾换行整体重写，对同格式文件逐行等值（测试做逐字节断言）。
 * - 删之前先读：config.json 读不到或解析失败就不写，残键留待下次装载。
 * - 幂等：活配置对象没有 token 时直接返回，第二次装载零读零写。
 * - 日志只记键名，永不记值；旧值非空 = 凭据已明文落过盘，按泄露面成立记迁移提示。
 *   本函数不清 `.env`、不调 `storeSecret`，也不把旧值写进任何地方。
 */
export function purgeLegacyTokenSection(botDir: string, cfgSection: Record<string, unknown>): string[] {
  const notes: string[] = [];
  if (!Object.hasOwn(cfgSection, 'token')) return notes; // 幂等腿：零读零写
  const file = join(botDir ?? '', 'config.json');
  let root: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) root = parsed as Record<string, unknown>;
  } catch {
    root = null; // 读不到/坏 JSON：不写，残键留待下次装载
  }
  if (root === null) {
    notes.push(`config.json 读不到或解析失败：本次不写文件，worlds.${WORLD_ID}.token 残键留待下次装载（只记键名）。`);
    delete cfgSection.token;
    return notes;
  }
  const worlds = root.worlds;
  const section = worlds && typeof worlds === 'object' ? (worlds as Record<string, unknown>)[WORLD_ID] : undefined;
  const onDisk = !!section && typeof section === 'object' && Object.hasOwn(section as object, 'token');
  if (onDisk) {
    const value = (section as Record<string, unknown>).token;
    delete (section as Record<string, unknown>).token;
    const payload = `${JSON.stringify(root, null, 2)}
`;
    const tmp = `${file}.atomic-${process.pid}`;
    writeFileSync(tmp, payload, 'utf8');
    renameSync(tmp, file);
    notes.push(`已删除 config.json 里 worlds.${WORLD_ID}.token 残键（日志只记键名，不记值）。`);
    if (typeof value === 'string' && value !== '') {
      notes.push(
        `旧 token 值非空：明文已落过盘，按凭据已泄露处理。请轮换共享密钥，并把新值放进部署 .env 的 CORTICO_BRIDGE_TOKEN；本包不清 .env、不写 secret。`,
      );
    }
  } else {
    notes.push(`活配置里残留的 worlds.${WORLD_ID}.token 已丢弃；config.json 无该键，文件未改写。`);
  }
  delete cfgSection.token; // 同步活对象：面板与后续 persist 不再带着旧键
  return notes;
}
