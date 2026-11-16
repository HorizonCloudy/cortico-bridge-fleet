/**
 * OneBot v11 覆盖面（静态快照，非运行期发现）。35 条动作与分类原样 copy 自先例
 * cortico-world-onebot-bridge/src/catalog.js:16-55 @c85a87b24（gate C-6：不许改）。
 *
 * 口径钉死自先例运行产物：公开 action 38 个、事件叶子 17 个、线上消息段 20 个。
 * 凭证三动作（get_cookies/get_csrf_token/get_credentials）按 SECURITY-CBP §3.5 不进目录，
 * 目录实发 35（读 16 / 写 19）；命中名字由 world dispatcher 名字闸回 10002。
 * 证据（sha9）：
 *   action 38  r-nonebot-onebot.md:133   nonebot-adapter-onebot@2.4.6 2450b67a1
 *   事件 17    r-nonebot-onebot.md:121-126 同上
 *   段 20      r-nonebot-onebot.md:141     同上
 * 实现对端的扩展 action 不在本表，由 koishi_call 按写动作透传（gateAction 未知即写）。
 */

/** readOnly=true 的是取数动作；其余为写动作，受 writePolicy 约束。 */
export const V11_ACTIONS = [
  // —— 信息 / 状态（只读）——
  { name: 'get_login_info', readOnly: true, category: '信息', summary: '获取当前登录账号' },
  { name: 'get_status', readOnly: true, category: '信息', summary: '获取运行状态' },
  { name: 'get_version_info', readOnly: true, category: '信息', summary: '获取协议端版本' },
  { name: 'get_stranger_info', readOnly: true, category: '好友', summary: '获取陌生人信息' },
  { name: 'get_friend_list', readOnly: true, category: '好友', summary: '获取好友列表' },
  { name: 'get_group_info', readOnly: true, category: '信息', summary: '获取群信息' },
  { name: 'get_group_list', readOnly: true, category: '信息', summary: '获取群列表' },
  { name: 'get_group_member_info', readOnly: true, category: '信息', summary: '获取群成员信息' },
  { name: 'get_group_member_list', readOnly: true, category: '信息', summary: '获取群成员列表' },
  { name: 'get_group_honor_info', readOnly: true, category: '信息', summary: '获取群荣誉信息' },
  // get_cookies / get_csrf_token / get_credentials 已按 SECURITY-CBP.md:125 摘除（凭证动作不进桥）。
  { name: 'get_record', readOnly: true, category: '消息', summary: '获取语音' },
  { name: 'get_image', readOnly: true, category: '消息', summary: '获取图片' },
  { name: 'get_msg', readOnly: true, category: '消息', summary: '获取消息' },
  { name: 'get_forward_msg', readOnly: true, category: '消息', summary: '获取合并转发消息' },
  { name: 'can_send_image', readOnly: true, category: '扩展', summary: '检查能否发图片' },
  { name: 'can_send_record', readOnly: true, category: '扩展', summary: '检查能否发语音' },
  // —— 写动作 ——
  { name: 'send_private_msg', readOnly: false, category: '消息', summary: '发送私聊消息' },
  { name: 'send_group_msg', readOnly: false, category: '消息', summary: '发送群消息' },
  { name: 'send_msg', readOnly: false, category: '消息', summary: '发送消息（自动判断会话）' },
  { name: 'send_like', readOnly: false, category: '好友', summary: '给好友点赞' },
  { name: 'delete_msg', readOnly: false, category: '消息', summary: '撤回消息' },
  { name: 'set_group_kick', readOnly: false, category: '群管理', summary: '踢出群成员' },
  { name: 'set_group_ban', readOnly: false, category: '群管理', summary: '禁言群成员' },
  { name: 'set_group_anonymous_ban', readOnly: false, category: '群管理', summary: '匿名禁言' },
  { name: 'set_group_whole_ban', readOnly: false, category: '群管理', summary: '全局禁言' },
  { name: 'set_group_admin', readOnly: false, category: '群管理', summary: '设置管理员' },
  { name: 'set_group_anonymous', readOnly: false, category: '群管理', summary: '匿名发言' },
  { name: 'set_group_card', readOnly: false, category: '群管理', summary: '设置群名片' },
  { name: 'set_group_name', readOnly: false, category: '群管理', summary: '设置群名' },
  { name: 'set_group_leave', readOnly: false, category: '群管理', summary: '退群' },
  { name: 'set_group_special_title', readOnly: false, category: '群管理', summary: '设置专属头衔' },
  { name: 'set_friend_add_request', readOnly: false, category: '好友', summary: '处理加好友请求' },
  { name: 'set_group_add_request', readOnly: false, category: '群管理', summary: '处理加群请求' },
  { name: 'set_restart', readOnly: false, category: '扩展', summary: '重启协议端' },
  { name: 'clean_cache', readOnly: false, category: '扩展', summary: '清除缓存' },
];

/**
 * per-impl 扩展 action 白名单：起点值（猜）。
 * 未核验名单（recon.md §6-2）：NapCat / Lagrange 各家扩展无权威表，d-koishi §5-7 只有
 * 适配器侧注释证据。本表只影响 koishi_actions 展示，不做拦截——透传一律走 gateAction
 * 的「未知即写」路径。升级条件：某实现扩展动作在真实对端复现参数/语义分歧再收紧。
 * shortcut: 名单恒空, 实现分歧实跑复现后填
 */
export const IMPL_EXTENSIONS = Object.freeze({
  napcat: Object.freeze([]),
  snowluma: Object.freeze([]),
  llonebot: Object.freeze([]),
  lagrange: Object.freeze([]),
});

export function extensionsFor(implId) {
  return IMPL_EXTENSIONS[implId] ?? [];
}

/** 17 个事件叶子（post_type / *_type [ / sub_type ]）。判别键树见 r-nonebot-onebot.md:120。 */
export const V11_EVENT_KINDS = [
  { kind: 'message/private', note: '私聊消息' },
  { kind: 'message/group', note: '群消息' },
  { kind: 'notice/group_upload', note: '群内文件上传' },
  { kind: 'notice/group_admin', note: '群管理员变更' },
  { kind: 'notice/group_decrease', note: '成员减少（leave/kick/ban）' },
  { kind: 'notice/group_increase', note: '成员增加' },
  { kind: 'notice/group_ban', note: '群禁言' },
  { kind: 'notice/friend_add', note: '好友添加' },
  { kind: 'notice/group_recall', note: '群消息撤回' },
  { kind: 'notice/friend_recall', note: '好友消息撤回' },
  { kind: 'notice/notify/poke', note: '戳一戳' },
  { kind: 'notice/notify/lucky_king', note: '运气王' },
  { kind: 'notice/notify/honor', note: '群荣誉变更' },
  { kind: 'request/friend', note: '加好友请求' },
  { kind: 'request/group', note: '加群请求（add / invite）' },
  { kind: 'meta_event/lifecycle', note: '生命周期（connect/enable/disable/exit）' },
  { kind: 'meta_event/heartbeat', note: '心跳' },
];

/** 20 个线上消息段 type；contact_user/music_custom/node_custom 只是参数糖。 */
export const V11_SEGMENTS = [
  'text', 'face', 'image', 'record', 'video', 'at', 'rps', 'dice', 'shake', 'poke',
  'anonymous', 'share', 'contact', 'location', 'music', 'reply', 'forward', 'node', 'json', 'xml',
];

const ACTION_INDEX = new Map(V11_ACTIONS.map((a) => [a.name, a]));

export function actionInfo(name) {
  return ACTION_INDEX.get(String(name)) ?? null;
}

export function listCategories() {
  const counts = new Map();
  for (const a of V11_ACTIONS) counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
  return [...counts.entries()].map(([category, total]) => ({ category, total }));
}

export function searchActions(query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  return V11_ACTIONS.filter((a) => (
    a.name.toLowerCase().includes(q)
    || String(a.summary ?? '').toLowerCase().includes(q)
    || String(a.category ?? '').toLowerCase().includes(q)
  ));
}

export function coverage() {
  return {
    actions: V11_ACTIONS.length,
    readOnly: V11_ACTIONS.filter((a) => a.readOnly).length,
    write: V11_ACTIONS.filter((a) => !a.readOnly).length,
    events: V11_EVENT_KINDS.length,
    segments: V11_SEGMENTS.length,
  };
}
