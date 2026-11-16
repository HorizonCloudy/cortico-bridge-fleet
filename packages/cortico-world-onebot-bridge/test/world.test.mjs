/**
 * 纯逻辑 + 工具 handler 单测（不连 WS、不起宿主）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyInbound, decodeResponse, nextBackoff } from '../src/driver.js';
import { EVENT_MESSAGE, EVENT_NOTICE } from '../src/config.js';
import { actionInfo } from '../src/catalog.js';
import { gateAction, projectEvent } from '../src/world.js';
import definition from '../src/definition.js';

test('projectEvent: 自发回声只归档', () => {
  const p = projectEvent(
    { post_type: 'message', message_type: 'group', user_id: 10, group_id: 2, message_id: 1,
      raw_message: 'hi', font: {}, message: [{ type: 'text', data: { text: 'hi' } }] },
    { selfId: 10 },
  );
  assert.equal(p.type, EVENT_MESSAGE);
  assert.equal(p.deliver, false);
  assert.equal(p.meta.self, true);
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

// F3 门序基准输入（SECURITY-CBP.md:36-40）：msg = 本轮入站消息实证记录，selfId = get_login_info 实证 self。
const TURN = { messageId: 100, userId: 7, anonymous: false };
const SELF = 9;
const callGate = (o = {}) => gateAction({
  name: 'send_group_msg', entry: actionInfo('send_group_msg'), readOnly: false, writePolicy: 'confirm', msg: TURN, selfId: SELF, ...o,
});

test('gateAction: 写动作策略（身份齐备为底）', () => {
  assert.equal(callGate({ readOnly: true }).block, true);
  assert.equal(callGate({ writePolicy: 'deny' }).block, true);
  assert.equal(callGate({ writePolicy: 'confirm', confirm: false }).block, true);
  assert.equal(callGate({ writePolicy: 'confirm', confirm: true }).block, false);
  assert.equal(gateAction({ name: 'get_status', entry: actionInfo('get_status'), readOnly: false, writePolicy: 'deny', msg: null, selfId: null }).block, false);
  // 未知/扩展动作按写处理
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

test('driver 纯函数：分类 / 退避 / 回执', () => {
  assert.equal(classifyInbound({ echo: 'a', retcode: 0 }), 'response');
  assert.equal(classifyInbound({ post_type: 'message' }), 'event');
  assert.equal(classifyInbound({}), 'ignore');
  assert.equal(nextBackoff(1000, 30000), 2000);
  assert.equal(nextBackoff(20000, 30000), 30000);
  assert.equal(decodeResponse({ retcode: 0, data: { x: 1 } }).ok, true);
  assert.equal(decodeResponse({ status: 'failed', retcode: 1400 }).ok, false);
});

test('onebot_status handler 报出 reality v11 覆盖面', async () => {
  const inst = definition.create({ cfg: definition.defaults(), timezone: '', persist: () => {} });
  const status = inst.tools().find((t) => t.name === 'onebot_status');
  const out = status.handler({});
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.coverage.actions, 35);
  assert.equal(parsed.coverage.events, 17);
  assert.equal(parsed.coverage.segments, 20);
  assert.deepEqual(parsed.tools.sort(), ['onebot_actions', 'onebot_call', 'onebot_events', 'onebot_status']);
});

test('onebot_call handler：写动作缺 confirm 被拦、只读未连接报错（都不出网）', async () => {
  const inst = definition.create({ cfg: definition.defaults(), timezone: '', persist: () => {} });
  const call = inst.tools().find((t) => t.name === 'onebot_call');
  assert.equal((await call.handler({ action: 'send_group_msg', params: {} })).failed, true);
  const r = await call.handler({ action: 'get_login_info' });
  assert.equal(r.failed, true);
  assert.match(r.text, /未连接/);
});

test('onebot_call handler：凭证名回 10002，名字闸排在连接判定之前、不出网', async () => {
  const inst = definition.create({ cfg: definition.defaults(), timezone: '', persist: () => {} });
  const call = inst.tools().find((t) => t.name === 'onebot_call');
  for (const n of ['get_credentials', 'get_cookies', 'get_csrf_token']) {
    const r = await call.handler({ action: n, confirm: true });
    assert.equal(r.failed, true, n);
    assert.match(r.text, /10002 unsupported_action/, n);
  }
});

test('onebot_call handler：冷轮写动作回 60004，args 自报 actor/turn 不进闸', async () => {
  const inst = definition.create({ cfg: definition.defaults(), timezone: '', persist: () => {} });
  const call = inst.tools().find((t) => t.name === 'onebot_call');
  const r = await call.handler({
    action: 'send_group_msg', params: {}, confirm: true,
    actor: { platform: 'qq', member: { id: '1', name: 'admin' }, anon: 'identified' }, turn: 'fake-turn',
  });
  assert.equal(r.failed, true);
  assert.match(r.text, /60004 unknown_session/);
});
