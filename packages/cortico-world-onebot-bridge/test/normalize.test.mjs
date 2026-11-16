/**
 * 纯函数单测：v11 事件判别、消息渲染、未知段兜底、裁剪。
 * 运行：node --test 或 node --test test/normalize.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { capText, compactJson, eventKind, isWellFormedMessage, renderMessage, renderSegment } from '../src/normalize.js';

test('eventKind: 消息不并入 sub_type', () => {
  assert.equal(eventKind({ post_type: 'message', message_type: 'group', sub_type: 'normal' }), 'message/group');
  assert.equal(eventKind({ post_type: 'message', message_type: 'private' }), 'message/private');
});

test('eventKind: notice/request/meta 并 sub_type，poke 走 notify 细分', () => {
  assert.equal(eventKind({ post_type: 'notice', notice_type: 'group_recall' }), 'notice/group_recall');
  assert.equal(eventKind({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke' }), 'notice/notify/poke');
  assert.equal(eventKind({ post_type: 'request', request_type: 'group', sub_type: 'add' }), 'request/group/add');
  assert.equal(eventKind({ post_type: 'meta_event', meta_event_type: 'heartbeat' }), 'meta_event/heartbeat');
  assert.equal(eventKind({}), 'unknown');
});

test('renderSegment: 关键段与未知段兜底', () => {
  assert.equal(renderSegment({ type: 'text', data: { text: 'hi' } }), 'hi');
  assert.equal(renderSegment({ type: 'at', data: { qq: 'all' } }), '@全体成员');
  assert.equal(renderSegment({ type: 'at', data: { qq: '123', name: '张三' } }), '@张三');
  assert.equal(renderSegment({ type: 'image', data: { file: 'x.png' } }), '[图片 x.png]');
  assert.equal(renderSegment({ type: 'image', data: {} }), '[图片]');
  // 硬规则：未知段不吞消息，给占位
  assert.equal(renderSegment({ type: 'light_app', data: {} }), '[light_app]');
  assert.equal(renderSegment('raw string'), 'raw string');
});

test('renderMessage: 群/私聊一行可读，空消息有占位', () => {
  const line = renderMessage({
    message_type: 'group', group_id: 5, user_id: 42, message_id: 7,
    sender: { nickname: 'Alice' }, message: [{ type: 'text', data: { text: 'hello' } }],
  });
  assert.match(line, /群5\]/);
  assert.match(line, /Alice\(42\): hello #7/);
  assert.match(renderMessage({ message_type: 'private', user_id: 9, message: [] }), /\[空消息\]/);
});

test('isWellFormedMessage: 缺 raw_message/font 判畸形', () => {
  const full = { post_type: 'message', message_type: 'group', message_id: 1, user_id: 2, raw_message: '[CQ:at]', font: {}, group_id: 3 };
  assert.equal(isWellFormedMessage(full), true);
  assert.equal(isWellFormedMessage({ ...full, font: undefined }), false);
  assert.equal(isWellFormedMessage({ post_type: 'notice', notice_type: 'group_recall' }), false);
});

test('capText / compactJson 裁剪', () => {
  assert.equal(capText('short', 10), 'short');
  assert.match(capText('x'.repeat(20), 5), /truncated 15 chars/);
  assert.equal(compactJson({ a: 1 }, 100), '{"a":1}');
});
