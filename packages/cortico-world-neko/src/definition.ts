/**
 * definition.ts —— 入口形状件（Cortico 装载器只认这个形状）。
 *
 * 校验点（cortico src @836238311，行号转引 d-cortico-side §1/§6 与先例
 * cortico-world-astrbot-bridge/src/definition.ts:3-17 的同一批锚）：
 * - 默认导出必须过 isWorldDefinition：id/label/defaults/create 四件
 *   （extensions.ts:143-150）。入口解析走 package.json main（:130-141）。
 * - package.json `cortico` 段 kind:"world" + api:6 是装载硬要求
 *   （manifest.ts:23-27 EXTENSION_API_VERSIONS.world=6；api<expected 拒载 :137-143；
 *   过渡层上一版 5 —— previous-contract.ts:28-32，本包按当前锚 6 写）。
 * - tools() 名字必须 ⊆ describe.tools（describe-export.ts:134-136），
 *   describe 由 world.ts 的 TOOL_DECLS 单源拼装；describe.json 用框架
 *   exportDescribe 生成（tests/drymount-gate.mts --regen），测试再对表。
 * - 事件名显式常量（normalize.ts EVENTS），不从 worldId 拼串
 *   （d-bridge-priorart §8.7 三桥命名并存的前车之鉴）。
 * - describe 手拼、不 import 框架值：运行时零框架 import，离线冒烟可跑
 *   （先例 telegram definition.ts:14-19 的离线性理由，本包与 astrbot 包一致采纳）。
 */
import type { WorldDefinition, WorldDescribe } from 'cortico/world.ts';
import type { DescribeText } from 'cortico/core/types.ts';
import { DEFAULTS, type NekoBridgeConfig } from './config.ts';
import { EVENTS } from './normalize.ts';
import { NekoWorld, TOOL_DECLS } from './world.ts';

/** 给人看的一句话（市场卡片用；不进提示词）。 */
const TOOL_SUMMARIES: Readonly<Record<string, DescribeText>> = {
  neko_send_message: {
    zh: '经桥向 N.E.K.O 会话发消息；出站门关着直接回 60005，本轮没有桥消息回 60004，超 caps.neko 帧上限（pins 单源）本地先拒回 60003。',
    en: 'Send text through the bridge; 60005 while the egress door is closed, 60004 without a bridge message this turn, 60003 for oversized payloads.',
  },
  neko_status: {
    zh: '报连接角色、协商到的 caps、consent 等待态、对端 catalog 与降级清单。',
    en: 'Reports role, negotiated caps, consent state, peer catalog, degraded list.',
  },
  neko_history: {
    zh: '读 Cortico 事件库里本 world 的归档，不查对端（桥侧 convmap 宿主不可见）。',
    en: "Reads this world's archive from the event store, never the peer's convmap.",
  },
  neko_peer_call: {
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
    zh: '命中桥自报 id 的回声，只归档不唤醒。',
    en: 'Echo matching the bridge self id; archived without waking the model.',
  },
  [EVENTS.notice]: {
    zh: '状态通知（含 consent 等待态上报），只排队。',
    en: 'Status notice relayed by the bridge (incl. consent pending state); queued only.',
  },
  [EVENTS.connection]: {
    zh: '桥连接/断开与协商结果变化。',
    en: 'Bridge up/down and negotiation changes.',
  },
  [EVENTS.degraded]: {
    zh: '保真降级位：未知段、外部 URL 图、无上传 API 媒体、门未开等。',
    en: 'Fidelity degraded: unknown segment, external URL image, no-upload media, door closed.',
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

export const NEKO_WORLD: WorldDefinition<NekoBridgeConfig> = {
  // 任务钉的世界 id：`cortico-world-neko` → id 'neko'（事件名 neko.*，配置段 worlds.neko）。
  id: 'neko',
  label: 'N.E.K.O（CBP 桥）',
  defaults: () => ({ ...DEFAULTS }),
  // create() 纯：装配层会为未启用的 World 也调一次（硬规则 1）。
  create: (ctx) => new NekoWorld({ cfg: ctx.cfg }),
  describe: BRIDGE_DESCRIBE,
};

export default NEKO_WORLD;
