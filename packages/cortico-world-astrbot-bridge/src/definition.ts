/**
 * definition.ts —— 入口形状件（Cortico 装载器只认这个形状）。
 *
 * 校验点（cortico src @836238311，逐条亲核行号）：
 * - 默认导出必须过 isWorldDefinition：`id/label/defaults/create` 四件
 *   （extensions.ts:143-150；缺任一形状 = 拒载）。入口解析走 package.json main
 *   （extensions.ts:130-141，模板 main 直接指 .ts 文件即合法，d-cortico-side §4.3）。
 * - package.json `cortico` 段 kind:"world" + api:6 是装载硬要求
 *   （manifest.ts:23-27 EXTENSION_API_VERSIONS.world=6；`api < expected` 拒载 :143；
 *   api=上一版 5 装载有过渡层（previous-contract.ts:28-32）但 check:extension 直接 fail
 *   ——d-cortico-side §6.2 第 3 条）。
 * - tools() 名字必须 ⊆ describe.tools（describe-export.ts:134-136）；
 *   describe.tools 由 world.ts 的 TOOL_DECLS 单源拼装，describe.json 由测试对表。
 * - 事件名是显式常量（normalize.ts EVENTS），不从 worldId 拼串
 *   （d-bridge-priorart §8.7：三桥命名并存的前车之鉴）。
 * - describe 手拼、不 import describeTools 值：先例 telegram definition.ts:14-19
 *   的理由成立——运行时值导入框架包会让本包脱离 Cortico 不可 import、离线冒烟跑不了。
 */
import type { WorldDefinition, WorldDescribe } from 'cortico/world.ts';
import type { DescribeText } from 'cortico/core/types.ts';
import { DEFAULTS, type AstrbotBridgeConfig } from './config.ts';
import { EVENTS } from './normalize.ts';
import { AstrbotBridgeWorld, TOOL_DECLS } from './world.ts';

/** 给人看的一句话（市场卡片用；不进提示词）。 */
const TOOL_SUMMARIES: Readonly<Record<string, DescribeText>> = {
  astrbot_send_message: {
    zh: '经桥向一个会话发消息；出站门关着时直接回 60005。',
    en: 'Send text through the bridge; 60005 while the egress door is closed.',
  },
  astrbot_status: {
    zh: '报连接态、协商到的 caps、对端 catalog 与降级清单。',
    en: 'Reports connection, negotiated caps, peer catalog, degraded list.',
  },
  astrbot_history: {
    zh: '读 Cortico 事件库里本 world 的归档，不查对端。',
    en: "Reads this world's archive from the event store, never the peer.",
  },
  astrbot_peer_call: {
    zh: '按名字调对端已申报的工具，用本轮触发消息的身份执行。',
    en: "Calls a catalog-declared peer tool with this turn's identity.",
  },
};

const EVENT_DESCRIPTIONS: Readonly<Record<string, DescribeText>> = {
  [EVENTS.message]: {
    zh: '桥送来的消息；点名/私聊立即投递，其余合批。',
    en: 'Bridge message; flush when mentioned or direct, otherwise batched.',
  },
  [EVENTS.messageSelf]: {
    zh: '自报账号发出的回声，只归档不唤醒。',
    en: 'Echo of the bridge account itself; archived without waking the model.',
  },
  [EVENTS.notice]: {
    zh: '状态通知（群事件、掉线等），只排队。',
    en: 'Status notice relayed by the bridge; queued only.',
  },
  [EVENTS.connection]: {
    zh: '桥连接/断开与协商结果变化。',
    en: 'Bridge up/down and negotiation changes.',
  },
  [EVENTS.degraded]: {
    zh: '保真降级位：未知段、能力缺失、门未开等。',
    en: 'Fidelity degraded: unknown segment, missing capability, door closed.',
  },
};

/** 事件声明顺序 = 消费面顺序；全部显式列出（不从 worldId 派生）。 */
const EVENT_ORDER: readonly string[] = [
  EVENTS.message,
  EVENTS.messageSelf,
  EVENTS.notice,
  EVENTS.connection,
  EVENTS.degraded,
];

export const BRIDGE_DESCRIBE: WorldDescribe = {
  tools: TOOL_DECLS.map(({ name, description, parameters, tags }) => ({
    name,
    description,
    parameters,
    tags,
    summary: TOOL_SUMMARIES[name],
  })),
  events: EVENT_ORDER.map((type) => ({
    type,
    description: EVENT_DESCRIPTIONS[type],
  })),
};

export const ASTRBOT_BRIDGE: WorldDefinition<AstrbotBridgeConfig> = {
  // 收编先例同 id（4725feee6 definition.ts:10 `id:'astrbot'`）：
  // 已部署实例的 worlds.astrbot 配置段、事件命名空间、记忆检索键跨版本连续。
  id: 'astrbot',
  label: 'AstrBot（CBP 收编版）',
  defaults: () => ({ ...DEFAULTS }),
  // create() 纯：装配层会为未启用的 World 也调一次（硬规则 1；先例 definition.ts:14 注释同断）。
  create: (ctx) => new AstrbotBridgeWorld({ cfg: ctx.cfg }),
  describe: BRIDGE_DESCRIBE,
};

export default ASTRBOT_BRIDGE;
