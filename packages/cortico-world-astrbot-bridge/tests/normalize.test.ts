import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENTS,
  buildSegsFromLegacyText,
  imageSegToBlob,
  kindFromLegacy,
  legacyMsgToCbp,
  pushOptsForMsg,
  pushOptsForNotice,
  renderSegments,
  senderKeyFromLegacyConv,
  umoToLegacyConv,
} from '../src/normalize.ts';
import type { MsgFrame } from '../src/frames.ts';

const msg = (over: Partial<MsgFrame>): MsgFrame => ({
  v: 1,
  t: 'msg',
  id: 'm-1',
  ts: 1700000000,
  conv: 'aiocqhttp:GroupMessage:123',
  sender: { id: '555', name: 'u' },
  kind: 'group',
  segments: [{ type: 'text', data: { text: 'hi' } }],
  raw: { message_id: 7 },
  ...over,
});

test('事件档位表：mention/direct flush、group/other 缺省 debounce、notice piggyback', () => {
  assert.deepEqual(pushOptsForMsg(msg({ kind: 'mention' })), { trigger: 'flush' });
  assert.deepEqual(pushOptsForMsg(msg({ kind: 'direct' })), { trigger: 'flush' });
  assert.deepEqual(pushOptsForMsg(msg({ kind: 'group' })), {});
  assert.deepEqual(pushOptsForMsg(msg({ kind: 'other' })), {});
  assert.deepEqual(pushOptsForNotice({ v: 1, t: 'notice', id: 'n', ts: 1, raw: {} }), { trigger: 'piggyback' });
});

test('at_all 特判只在一处：at{qq:all} → @全体成员；绝不出现 atall 段型（C1-5）', () => {
  const r = renderSegments([
    { type: 'at', data: { qq: 'all' } },
    { type: 'text', data: { text: ' 开会了' } },
  ]);
  assert.equal(r.text, '@全体成员 开会了');
  assert.deepEqual(r.degraded, []);
  assert.ok(!r.text.includes('atall'));
});

test('未知段 [类型] 兜底不吞消息 + degraded 记账（C1-16）', () => {
  const r = renderSegments([{ type: 'markdown', data: { text: 'x' } }]);
  assert.equal(r.text, '[markdown]');
  assert.deepEqual(r.degraded, ['unknown-segment:markdown']);
});

test('坏段不炸：形状不符只记 degraded', () => {
  const r = renderSegments([null as unknown as { type: string; data: Record<string, string> }]);
  assert.deepEqual(r.degraded, ['bad-segment']);
});

test('旧帧 conv → UMO 合成键；反解回 send 帧的 dict 形', () => {
  assert.equal(senderKeyFromLegacyConv({ kind: 'group', id: '123' }), 'aiocqhttp:GroupMessage:123');
  assert.equal(senderKeyFromLegacyConv({ kind: 'private', id: '9' }), 'aiocqhttp:FriendMessage:9');
  assert.deepEqual(umoToLegacyConv('aiocqhttp:GroupMessage:123'), { kind: 'group', id: '123' });
  assert.equal(umoToLegacyConv('not-umo'), null);
});

test('kindFromLegacy：mentioned 优先，其余按会话类型', () => {
  assert.equal(kindFromLegacy(true, 'group'), 'mention');
  assert.equal(kindFromLegacy(false, 'group'), 'group');
  assert.equal(kindFromLegacy(false, 'private'), 'direct');
});

test('legacy msg 帧兼容读：dict-conv + 顶层 text → CBP MsgFrame', () => {
  const f = legacyMsgToCbp({
    t: 'msg',
    id: 'b-1',
    ts: '2026-11-15T10:00:00+08:00',
    conv: { kind: 'group', id: '123', name: 'g' },
    sender: { id: '555', name: 'u' },
    text: '你好',
    mentioned: true,
  });
  assert.ok(f);
  assert.equal(f.conv, 'aiocqhttp:GroupMessage:123');
  assert.equal(f.kind, 'mention');
  assert.equal(f.segments[0]?.type, 'text');
  assert.equal(typeof f.ts, 'number');
  assert.equal((f.raw as { text?: string }).text, '你好');
  assert.equal(legacyMsgToCbp({ t: 'msg', conv: 'nope' }), null);
  assert.equal(legacyMsgToCbp({ t: 'msg', conv: { kind: 'wtf', id: '1' } }), null);
});

test('image 段 → BlobInput；非 image/* mime 拒', () => {
  const b64 = Buffer.from('abc').toString('base64');
  const blob = imageSegToBlob({ type: 'image', data: { mime: 'image/png', base64: b64 } });
  assert.ok(blob);
  assert.equal(Buffer.from(blob.bytes).toString(), 'abc');
  assert.equal(blob.fallbackText, '[图片]');
  assert.equal(imageSegToBlob({ type: 'image', data: { mime: 'application/x', base64: b64 } }), null);
  assert.equal(buildSegsFromLegacyText('t')[0]?.type, 'text');
});

test('事件名显式常量表，不从 worldId 派生', () => {
  assert.deepEqual(Object.values(EVENTS), [
    'astrbot.message',
    'astrbot.message.self',
    'astrbot.notice',
    'astrbot.connection',
    'astrbot.degraded',
  ]);
});
