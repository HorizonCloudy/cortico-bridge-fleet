/**
 * 配置段与事件名常量。
 *
 * 运行中的 World 每次从活配置读取（ctx.cfg 是 worlds.<id> 的活引用，见
 * d-cortico-side §3），所以 writePolicy / events 策略改完立即生效。
 * create() 与 dryMount 必须能只靠 DEFAULTS 构造成功，不碰网络、不读密钥。
 */
import { V11_SEGMENTS } from './catalog.js';

export const ID = 'onebot-bridge';
export const LABEL = 'OneBot Bridge';

// 投递给 Cortico 的四种事件类型（见 definition.describe.events）。
export const EVENT_MESSAGE = 'onebot-bridge.message';
export const EVENT_NOTICE = 'onebot-bridge.notice';
export const EVENT_REQUEST = 'onebot-bridge.request';
export const EVENT_CONNECTION = 'onebot-bridge.connection';

/** v11 message 事件判定用的必需字段；缺 raw_message/font 会退化通用 Event（r-nonebot-onebot.md:152）。 */
export const REQUIRED_MESSAGE_FIELDS = [
  'post_type', 'message_type', 'message_id', 'user_id', 'raw_message', 'font',
];

export const DEFAULTS = Object.freeze({
  enabled: false,
  // OneBot 实现的正向 WebSocket；5700/6700 是 v11 规范缺省段，SnowLuma 常用 3001。
  wsUrl: 'ws://127.0.0.1:3001',
  // 也可用 ONEBOT_TOKEN 环境变量，环境变量优先；只用于出站握手头 Authorization。
  token: '',
  // 出站写策略：confirm=写动作必须带 confirm:true；allow=直接执行；deny=全部拒绝写。
  writePolicy: 'confirm',
  // 只允许 catalog 里 readOnly 的 action。
  readOnly: false,
  // 事件投递：drop 名单先于 deliver；自发消息只归档（deliver:false），见 world #handleEvent。
  dropEventKinds: 'meta_event/heartbeat',
  maxEventChars: 4000,
  apiTimeoutMs: 10000,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
  // start() 最长等待窗口；超时后放行并继续后台重连，start() 本身永不 reject。
  connectWaitMs: 12000,
});

/** 兼容数组与逗号/分号/换行分隔的字符串。 */
export function patterns(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(/[\n,;]+/).map((v) => v.trim()).filter(Boolean);
}

/** 把活配置补成完整形状；不冻结，保证热改能被读到。 */
export function readConfig(cfg = {}) {
  const raw = cfg && typeof cfg === 'object' ? cfg : {};
  const writePolicy = ['confirm', 'allow', 'deny'].includes(raw.writePolicy)
    ? raw.writePolicy
    : DEFAULTS.writePolicy;
  return {
    ...DEFAULTS,
    ...raw,
    writePolicy,
    readOnly: raw.readOnly === true,
    dropKinds: patterns(raw.dropEventKinds),
  };
}

export function statusLabel(language = 'zh') {
  return language === 'en' ? 'OneBot Bridge' : 'OneBot 桥';
}

export { V11_SEGMENTS };
