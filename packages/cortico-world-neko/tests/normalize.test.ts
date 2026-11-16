/**
 * normalize.test.ts —— CBP 段 ↔ N.E.K.O 面的纯函数断言。
 * 钉值出处：upstream/neko @52e973ed2 ——
 *   push_message_schema.py:63-66（两轴元组与缺省）、:60-61（schema 版本与弃用线）、
 *   plugin/settings.py:588（宿主帧上限）与 plugin/core/context.py:248（信封余量）——
 *   两者折算后的字节数不写在这里：单一来源是 spec/pins.json 的 caps.neko（F13，
 *   SECURITY-CBP §4.1），代码经 cortico-bridge-core loadPins() 读数。
 *   docs/plugins/push-message.md（外链 URL 图模型路拒收；audio/video 无上传 API；
 *   ctx.images.upload 归一 JPEG≤2048，归一只有宿主那一个位）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPins } from '@horizoncloudy/cortico-bridge-core';
import {
  AI_BEHAVIOR_VALUES,
  EVENTS,
  SCHEMA_VERSION,
  VISIBILITY_VALUES,
  consentLabel,
  imageSegToBlob,
  parseAxes,
  planNekoSend,
} from '../src/normalize.ts';

/** 出站帧上限的唯一读数口（caps.neko.frame_bytes = 524288 − 227 的折算结果）。 */
const NEKO_LIMIT = loadPins().caps.neko.frame_bytes!;
const AXES = { visibility: ['chat'] as string[], ai_behavior: 'respond' };

test('事件名表逐字：五条显式常量，不从 worldId 派生', () => {
  assert.deepEqual(EVENTS, {
    message: 'neko.message',
    messageSelf: 'neko.message.self',
    notice: 'neko.notice',
    connection: 'neko.connection',
    degraded: 'neko.degraded',
  });
});

test('两轴取值逐字 push_message_schema.py:63-64，schema 版本 push_message.v2', () => {
  assert.deepEqual(VISIBILITY_VALUES, ['chat', 'hud']);
  assert.deepEqual(AI_BEHAVIOR_VALUES, ['respond', 'read', 'blind']);
  assert.equal(SCHEMA_VERSION, 'push_message.v2');
});

test('parseAxes：非法 visibility 条目丢弃、非法 ai_behavior 回缺省 respond', () => {
  assert.deepEqual(parseAxes('chat,hud', 'read'), { visibility: ['chat', 'hud'], ai_behavior: 'read' });
  // SDK 两轴客户端强校验（r-neko §5 实测 ValueError），本侧等效：脏值不进载荷。
  assert.deepEqual(parseAxes('chat,sms', 'ignore').visibility, ['chat']);
  assert.equal(parseAxes('chat', 'ignore').ai_behavior, 'respond');
  assert.deepEqual(parseAxes('', 'blind'), { visibility: [], ai_behavior: 'blind' });
});

test('planNekoSend：纯文本通过，载荷字节 < caps.neko.frame_bytes', () => {
  const plan = planNekoSend('你好', [], AXES);
  assert.equal(plan.tooLarge, false);
  assert.equal(plan.dropped.length, 0);
  assert.ok(plan.packedBytes < NEKO_LIMIT);
});

test('planNekoSend：外部 URL 图直接拒（只认 upload 句柄/内联 base64 位）', () => {
  const plan = planNekoSend(
    '看图',
    [{ type: 'image', data: { url: 'https://example.com/a.png', mime: 'image/png' } }],
    { visibility: ['chat'], ai_behavior: 'respond' },
  );
  assert.equal(plan.kept.length, 0, 'URL 图段不得出站');
  assert.deepEqual(plan.dropped, [{ type: 'image', reason: 'external-url-image' }]);
});

test('planNekoSend：base64 图段保留；audio/record/video 无上传 API 全部拒', () => {
  const plan = planNekoSend(
    'x',
    [
      { type: 'image', data: { mime: 'image/png', base64: 'aGVsbG8=' } },
      { type: 'record', data: { file: 'a.wav' } },
      { type: 'video', data: { url: 'https://x/y.mp4' } },
      { type: 'text', data: { text: 'y' } },
    ],
    { visibility: ['chat'], ai_behavior: 'respond' },
  );
  assert.deepEqual(
    plan.kept.map((s) => s.type),
    ['image', 'text'],
  );
  assert.deepEqual(
    plan.dropped.map((d) => d.reason),
    ['no-upload-api', 'no-upload-api'],
  );
});

test('planNekoSend：packed 载荷（含 base64 4/3 膨胀）超 caps.neko → tooLarge 本地先拒', () => {
  const bigB64 = 'A'.repeat(NEKO_LIMIT); // base64 文本 ≈ packed 主体
  const plan = planNekoSend('', [{ type: 'image', data: { mime: 'image/jpeg', base64: bigB64 } }], AXES);
  assert.equal(plan.tooLarge, true);
});

test('F13 caps 单源边界：恰界通过、超 1 字节拒（阈值 = pins caps.neko.frame_bytes，v1 不分片）', () => {
  const base = planNekoSend('', [], AXES).packedBytes; // JSON 壳开销
  const at = planNekoSend('x'.repeat(NEKO_LIMIT - base), [], AXES);
  assert.equal(at.packedBytes, NEKO_LIMIT);
  assert.equal(at.tooLarge, false, '规则是 > frame_bytes，恰界放行');
  const over = planNekoSend('x'.repeat(NEKO_LIMIT - base + 1), [], AXES);
  assert.equal(over.tooLarge, true, '超 1 字节本地先拒，不分片（SECURITY-CBP §4.5）');
});

test('F13 纪律闸：src 里不得出现媒体字节字面量（单一来源 spec/pins.json caps）', () => {
  for (const f of ['normalize.ts', 'world.ts']) {
    const src = readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /524_?288/, `${f} 出现 524288 字面量`);
    assert.doesNotMatch(src, /\b227\b/, `${f} 出现 227 字面量`);
    assert.doesNotMatch(src, /8_?388_?608/, `${f} 出现 8388608 字面量`);
  }
});

test('imageSegToBlob：内联 base64 → BlobInput；URL-only 图不成 blob（宿主模型路拒外链）', () => {
  const b = imageSegToBlob({ type: 'image', data: { mime: 'image/png', base64: 'aGk=' } });
  assert.ok(b);
  assert.equal(b.mime, 'image/png');
  assert.deepEqual(Array.from(b.bytes ?? []), [104, 105]);
  assert.equal(imageSegToBlob({ type: 'image', data: { url: 'https://x/y.png', mime: 'image/png' } }), null);
  assert.equal(imageSegToBlob({ type: 'text', data: { text: 'x' } }), null);
});

test('consentLabel：decision 缺失时看 status，未知回 unknown（consent_policy.py:12-44 面）', () => {
  assert.equal(consentLabel({ status: 'pending', decision: 'waiting' }), 'waiting');
  assert.equal(consentLabel({ status: 'awaiting_review' }), 'awaiting_review');
  assert.equal(consentLabel(null), 'unknown');
});
