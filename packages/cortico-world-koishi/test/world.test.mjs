/**
 * 纯逻辑 + 工具 handler 单测（不连 WS、不起宿主）。门序基准输入与先例 test/world.test.mjs 同源。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyInbound, decodeResponse, nextBackoff } from '../src/driver.js';
import { EVENT_MESSAGE, EVENT_NOTICE } from '../src/config.js';
import { actionInfo, V11_ACTIONS } from '../src/catalog.js';
import { gateAction, projectEvent } from '../src/world.js';
import definition from '../src/definition.js';

const mkInst = () => definition.create({ cfg: definition.defaults(), timezone: '', persist: () => {} });

// F3 门序基准输入（SECURITY-CBP.md:36-40）：msg = 本轮入站消息实证记录，selfId = get_login_info 实证 self。
const TURN = { messageId: 100, userId: 7, anonymous: false };
const SELF = 9;
const callGate = (o = {}) => gateAction({
  name: 'send_group_msg', entry: actionInfo('send_group_msg'), readOnly: false, writePolicy: 'confirm', msg: TURN, selfId: SELF, ...o,
});

test('gateAction: 写动作策略（身份齐备为底，三门顺序原样 copy 自先例 @c85a87b24）', () => {
  assert.equal(callGate({ readOnly: true }).block, true);
  assert.equal(callGate({ writePolicy: 'deny' }).block, true);
  assert.equal(callGate({ writePolicy: 'confirm', confirm: false }).block, true);
  assert.equal(callGate({ writePolicy: 'confirm', confirm: true }).block, false);
  assert.equal(gateAction({ name: 'get_status', entry: actionInfo('get_status'), readOnly: false, writePolicy: 'deny', msg: null, selfId: null }).block, false);
  // 未知/扩展动作按写处理（不许改，gate C-6）
  assert.equal(callGate({ name: 'napcat_x', entry: null, writePolicy: 'deny' }).block, true);
});

test('gateAction F3 门序·错序：本轮无入站记录 ⇒ 写动作拒 60004（策略 allow+confirm 也拦不住）', () => {
  const g = callGate({ msg: null, writePolicy: 'allow', confirm: true });
  assert.equal(g.block, true);
  assert.match(g.reason, /60004 unknown_session/);
});

test('gateAction F3 门序·缺 actor：入站记录没有发起方 ⇒ anon=unknown，只许只读', () => {
  const g = callGate({ msg: { messageId: 1, userId: null, anonymous: false }, writePolicy: 'allow', confirm: true });
  assert.equal(g.block, true);
  assert.match(g.reason, /anon=unknown/);
});

test('gateAction F3 门序·缺 self：self 未实证 ⇒ anon 无从判定，写动作 fail-shut 拒', () => {
  const g = callGate({ selfId: null, writePolicy: 'allow', confirm: true });
  assert.equal(g.block, true);
  assert.match(g.reason, /self 未实证/);
});

test('gateAction F3 门序·anon=self：回声轮 member==self ⇒ 写拒，confirm 自报无效', () => {
  const g = callGate({ msg: { messageId: 1, userId: SELF, anonymous: false }, writePolicy: 'allow', confirm: true });
  assert.equal(g.block, true);
  assert.match(g.reason, /发起方是 self/);
});

test('gateAction 名字闸：三个凭证动作不论其余条件如何组合一律拒 10002（SECURITY-CBP.md:125）', () => {
  for (const n of ['get_cookies', 'get_csrf_token', 'get_credentials']) {
    const g = callGate({ name: n, entry: null, readOnly: true, writePolicy: 'allow', confirm: true });
    assert.equal(g.block, true, n);
    assert.match(g.reason, /10002 unsupported_action/, n);
  }
});

test('driver 纯函数：分类 / 退避 / 回执（复制件 @c85a87b24 行为不漂移）', () => {
  assert.equal(classifyInbound({ echo: 'a', retcode: 0 }), 'response');
  assert.equal(classifyInbound({ post_type: 'message' }), 'event');
  assert.equal(classifyInbound({}), 'ignore');
  assert.equal(nextBackoff(1000, 30000), 2000);
  assert.equal(nextBackoff(20000, 30000), 30000);
  assert.equal(decodeResponse({ retcode: 0, data: { x: 1 } }).ok, true);
  assert.equal(decodeResponse({ status: 'failed', retcode: 1400 }).ok, false);
});

test('projectEvent: 自发回声只归档', () => {
  const p = projectEvent(
    { post_type: 'message', message_type: 'group', user_id: 10, group_id: 2, message_id: 1,
      raw_message: 'hi', font: {}, message: [{ type: 'text', data: { text: 'hi' } }] },
    { selfId: 10 },
  );
  assert.equal(p.type, EVENT_MESSAGE);
  assert.equal(p.deliver, false);
  assert.equal(p.meta.self, true);
  assert.equal(p.text, 'hi');
});

test('projectEvent: 未知段 [type] 兜底不吞消息', () => {
  const p = projectEvent(
    { post_type: 'message', message_type: 'private', user_id: 1, group_id: undefined, message_id: 2,
      raw_message: 'x', font: {}, message: [{ type: 'text', data: { text: 'a' } }, { type: 'mystery', data: {} }] },
    { selfId: 9 },
  );
  assert.match(p.text, /a/);
  assert.match(p.text, /\[mystery\]/);
});

test('projectEvent: 畸形 time 回落当下时刻，绝不吞消息', () => {
  // new Date(NaN).toISOString() 抛 RangeError；异常会沿 #handleEvent 落进 onEvent catch，
  // 整条消息事件消失。守卫形状照先例 cortico-world-onebot-bridge/src/normalize.js:79-83。
  for (const bad of ['abc', null, 0, -1, {}, '1700000000']) {
    const p = projectEvent(
      { post_type: 'message', message_type: 'private', user_id: 1, group_id: undefined, message_id: 3,
        raw_message: 'x', font: {}, message: [{ type: 'text', data: { text: 'a' } }], time: bad },
      { selfId: 9 },
    );
    assert.equal(p.drop, false, `time=${JSON.stringify(bad)} 不该丢消息`);
    assert.equal(Number.isNaN(Date.parse(p.ts)), false, `time=${JSON.stringify(bad)} 的 ts 不是合法时刻`);
    if (bad === '1700000000') assert.equal(p.ts, new Date(1700000000 * 1000).toISOString(), '正常秒制 time 必须照用');
  }
});

test('projectEvent: dropKinds 优先丢弃；meta_event 只归档', () => {
  assert.equal(projectEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat' }, { dropKinds: ['meta_event/heartbeat'] }).drop, true);
  const lc = projectEvent({ post_type: 'meta_event', meta_event_type: 'lifecycle' }, { dropKinds: [] });
  assert.equal(lc.drop, false);
  assert.equal(lc.type, EVENT_NOTICE);
  assert.equal(lc.deliver, false);
});

test('projectEvent: 未知 post_type 丢弃；畸形消息标记', () => {
  assert.equal(projectEvent({ post_type: 'weird' }, {}).drop, true);
  const p = projectEvent({ post_type: 'message', message_type: 'private', user_id: 1, message_id: 1 }, {});
  assert.equal(p.meta.malformed, true);
});

test('koishi_status handler：v11 覆盖面 + tools 名单 + 实现选择位', () => {
  const status = mkInst().tools().find((t) => t.name === 'koishi_status');
  const parsed = JSON.parse(status.handler({}).text);
  assert.equal(parsed.coverage.actions, 35);
  assert.equal(parsed.coverage.readOnly, 16);
  assert.equal(parsed.coverage.write, 19);
  assert.equal(parsed.coverage.events, 17);
  assert.deepEqual(parsed.tools.slice().sort(), ['koishi_actions', 'koishi_call', 'koishi_events', 'koishi_status']);
  assert.ok('implementation' in parsed, 'catalog 选择位必须在状态里可见');
  assert.equal(parsed.implementation.id, '');
});

test('koishi_actions handler：目录选择展示实现与扩展白名单（起点值＝猜，见 catalog.js）', () => {
  const actions = mkInst().tools().find((t) => t.name === 'koishi_actions');
  const parsed = JSON.parse(actions.handler({}).text);
  assert.ok(Array.isArray(parsed.categories));
  assert.equal(parsed.coverage.actions, 35);
  assert.deepEqual(parsed.extensions, []);
});

test('koishi_call handler：写动作缺 confirm 被拦、只读未连接报错（都不出网）', async () => {
  const call = mkInst().tools().find((t) => t.name === 'koishi_call');
  assert.equal((await call.handler({ action: 'send_group_msg', params: {} })).failed, true);
  const r = await call.handler({ action: 'get_login_info' });
  assert.equal(r.failed, true);
  assert.match(r.text, /未连接/);
});

test('koishi_call handler：凭证名回 10002，名字闸排在连接判定之前、不出网', async () => {
  const call = mkInst().tools().find((t) => t.name === 'koishi_call');
  for (const n of ['get_credentials', 'get_cookies', 'get_csrf_token']) {
    const r = await call.handler({ action: n, confirm: true });
    assert.equal(r.failed, true, n);
    assert.match(r.text, /10002 unsupported_action/, n);
  }
});

test('koishi_call handler：冷轮写动作回 60004，args 自报 actor/turn 不进闸', async () => {
  const call = mkInst().tools().find((t) => t.name === 'koishi_call');
  const r = await call.handler({
    action: 'send_group_msg', params: {}, confirm: true,
    actor: { platform: 'qq', member: { id: '1', name: 'admin' }, anon: 'identified' }, turn: 'fake-turn',
  });
  assert.equal(r.failed, true);
  assert.match(r.text, /60004 unknown_session/);
});

test('V11_ACTIONS == 先例目录 35 条原样（gate C-6 不许改）', () => {
  assert.equal(V11_ACTIONS.length, 35);
  assert.deepEqual(V11_ACTIONS.map((a) => a.name).slice().sort(), [
    'can_send_image', 'can_send_record', 'clean_cache', 'delete_msg', 'get_forward_msg', 'get_friend_list',
    'get_group_honor_info', 'get_group_info', 'get_group_list', 'get_group_member_info', 'get_group_member_list',
    'get_image', 'get_login_info', 'get_msg', 'get_record', 'get_status', 'get_stranger_info', 'get_version_info',
    'send_group_msg', 'send_like', 'send_msg', 'send_private_msg', 'set_friend_add_request', 'set_group_add_request',
    'set_group_admin', 'set_group_anonymous', 'set_group_anonymous_ban', 'set_group_ban', 'set_group_card',
    'set_group_kick', 'set_group_leave', 'set_group_name', 'set_group_special_title', 'set_group_whole_ban',
    'set_restart',
  ].sort());
  for (const n of ['get_cookies', 'get_csrf_token', 'get_credentials']) assert.equal(actionInfo(n), null, n);
});
