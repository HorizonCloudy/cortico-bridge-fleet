/**
 * WorldDefinition：默认配置、预检、实例工厂和自描述（isWorldDefinition 四件）。
 *
 * 装载器只查四件：id 非空串、label 串、defaults 函数、create 函数
 * （extensions.ts:146-149 @836238311 实读，见 gate.md §2 G-K5-1 更正）。
 * enabled=false 与 create 纯是包内先例约定（onebot-bridge src/config.js:25 @c85a87b24）。
 * describe 是 describe.json 的唯一来源；tools() 的名字必须 ⊆ describe.tools
 * （describe-export.ts:134-136 @836238311）。
 */
import { createRequire } from 'node:module';

import {
  DEFAULTS, EVENT_CONNECTION, EVENT_MESSAGE, EVENT_NOTICE, EVENT_REQUEST, ID, LABEL,
} from './config.js';
import { KoishiBridgeWorld, KOISHI_TOOL_DECLS } from './world.js';

const TOOL_SUMMARIES = {
  koishi_call: { zh: '调用 v11 action（拨 NapCat 类正向 WS，非 Koishi 协议）；只读直接执行，写动作要求本轮有实证发起方（缺入站记录回 60004）并按策略需 confirm=true；凭证动作不进桥（10002）。', en: 'Call a v11 action over the dialed v11 implementation (NapCat-style forward WS, not the Koishi protocol); reads run immediately, writes need an identified inbound sender this turn (60004 without one) and follow the write policy; credential actions are not served (10002).' },
  koishi_actions: { zh: '查 OneBot v11 动作目录、分类、覆盖数与实现识别结果。', en: 'Look up the OneBot v11 action catalog, categories, coverage and implementation detection.' },
  koishi_events: { zh: '按类型和时间查已归档的 OneBot v11 事件。', en: 'Read archived OneBot v11 events by kind and time.' },
  koishi_status: { zh: '看桥连接、账号、识别出的实现、v11 覆盖面与写策略。', en: 'Show bridge connection, account, detected implementation, v11 coverage and write policy.' },
};

function describeTools(decls) {
  return decls.map(({ name, description, parameters, tags }) => ({
    name, description, parameters, tags, summary: TOOL_SUMMARIES[name],
  }));
}

const DESCRIBE = {
  tools: describeTools(KOISHI_TOOL_DECLS),
  events: [
    {
      type: EVENT_MESSAGE,
      description: { zh: '一条 QQ 消息；正文是一行可读文本，meta.raw 是原始 v11 事件（ID 为 v11 原生数字，不做 Koishi 字符串化）。', en: 'A QQ message; text is one readable line, meta.raw is the original v11 event (native numeric IDs, no Koishi stringification).' },
      trigger: 'debounce',
    },
    {
      type: EVENT_NOTICE,
      description: { zh: 'OneBot v11 notice / meta_event；正文是一行摘要，meta.raw 是原始事件。', en: 'An OneBot v11 notice or meta_event; text is a compact line, meta.raw is the original event.' },
      trigger: 'debounce',
    },
    {
      type: EVENT_REQUEST,
      description: { zh: 'OneBot v11 request（加好友 / 加群）；meta.raw 是原始事件。', en: 'An OneBot v11 request (friend / group); meta.raw is the original event.' },
      trigger: 'debounce',
    },
    {
      type: EVENT_CONNECTION,
      description: { zh: '桥连接建立或断开（对端是 v11 实现端，非 Koishi 服务端）。', en: 'Bridge connected or disconnected (peer is a v11 implementation, not a Koishi server).' },
      trigger: 'debounce',
    },
  ],
};

export const koishiBridgeDefinition = {
  id: ID,
  label: LABEL,
  defaults: () => structuredClone(DEFAULTS),
  preflight: () => {
    try {
      createRequire(import.meta.url).resolve('ws');
    } catch {
      throw new Error('找不到 ws：先在扩展目录安装依赖（pnpm install / npm install），再重启应用。');
    }
  },
  create: (ctx) => new KoishiBridgeWorld({
    cfg: ctx.cfg, timezone: ctx.timezone, persist: ctx.persist,
  }),
  describe: DESCRIBE,
};

export { DESCRIBE as KOISHI_BRIDGE_DESCRIBE };
export default koishiBridgeDefinition;
