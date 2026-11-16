/**
 * WorldDefinition：默认配置、预检、实例工厂和自描述（isWorldDefinition 四件）。
 *
 * 契约（extensions.ts:143-150 @836238311）：id 非空串、label 串、defaults 函数、create 函数。
 * create() 必须保持纯：不连 WS、不发请求、不读密钥，只造实例（蓝图硬规则）。
 * describe 是 describe.json 的唯一来源；tools() 的名字必须 ⊆ describe.tools（describe-export.ts:134-136）。
 */
import { createRequire } from 'node:module';

import {
  DEFAULTS, EVENT_CONNECTION, EVENT_MESSAGE, EVENT_NOTICE, EVENT_REQUEST, ID, LABEL,
} from './config.js';
import { OneBotBridgeWorld, ONEBOT_TOOL_DECLS } from './world.js';

const TOOL_SUMMARIES = {
  onebot_call: { zh: '调用 v11 action；只读直接执行，写动作要求本轮有实证发起方（缺入站记录回 60004）并按策略需 confirm=true；凭证动作不进桥（10002）。', en: 'Call a v11 action; reads run immediately, writes need an identified inbound sender this turn (60004 without one) and follow the write policy; credential actions are not served (10002).' },
  onebot_actions: { zh: '查 OneBot v11 动作目录、分类与覆盖数。', en: 'Look up the OneBot v11 action catalog, categories and coverage.' },
  onebot_events: { zh: '按类型和时间查已归档的 OneBot 事件。', en: 'Read archived OneBot events by kind and time.' },
  onebot_status: { zh: '看 OneBot 连接、账号、v11 覆盖面与写策略。', en: 'Show OneBot connection, account, v11 coverage and write policy.' },
};

function describeTools(decls) {
  return decls.map(({ name, description, parameters, tags }) => ({
    name, description, parameters, tags, summary: TOOL_SUMMARIES[name],
  }));
}

const DESCRIBE = {
  tools: describeTools(ONEBOT_TOOL_DECLS),
  events: [
    {
      type: EVENT_MESSAGE,
      description: { zh: '一条 QQ 消息；正文是一行可读文本，meta.raw 是原始 v11 事件。', en: 'A QQ message; text is one readable line, meta.raw is the original v11 event.' },
      trigger: 'debounce',
    },
    {
      type: EVENT_NOTICE,
      description: { zh: 'OneBot notice / meta_event；正文是一行摘要，meta.raw 是原始事件。', en: 'An OneBot notice or meta_event; text is a compact line, meta.raw is the original event.' },
      trigger: 'debounce',
    },
    {
      type: EVENT_REQUEST,
      description: { zh: 'OneBot request（加好友 / 加群）；meta.raw 是原始事件。', en: 'An OneBot request (friend / group); meta.raw is the original event.' },
      trigger: 'debounce',
    },
    {
      type: EVENT_CONNECTION,
      description: { zh: 'OneBot 连接建立或断开。', en: 'OneBot connected or disconnected.' },
      trigger: 'debounce',
    },
  ],
};

export const onebotBridgeDefinition = {
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
  create: (ctx) => new OneBotBridgeWorld({
    cfg: ctx.cfg, timezone: ctx.timezone, persist: ctx.persist,
  }),
  describe: DESCRIBE,
};

export { DESCRIBE as ONEBOT_BRIDGE_DESCRIBE };
export default onebotBridgeDefinition;
