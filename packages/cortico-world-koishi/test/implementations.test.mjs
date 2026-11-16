/**
 * 实现识别（catalog 选择逻辑的第一步）。样式移植自 cortico-world-onebot @2e91b7fb1 的
 * src/implementations.js:16 detectImplementation。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { detectImplementation } from '../src/implementations.js';

test('app_name 命中已知实现 ⇒ id + label', () => {
  assert.deepEqual(detectImplementation({ app_name: 'NapCat' }), { id: 'napcat', label: 'napcat' });
  assert.deepEqual(detectImplementation({ app_name: 'SnowLuma v0.9' }), { id: 'snowluma', label: 'snowluma' });
  assert.deepEqual(detectImplementation({ app_name: 'LLOneBot' }), { id: 'llonebot', label: 'llonebot' });
  assert.deepEqual(detectImplementation({ app_name: 'Lagrange' }), { id: 'lagrange', label: 'lagrange' });
  assert.deepEqual(detectImplementation({ app_name: 'Go-CQHttp v1.0.1' }), { id: 'go-cqhttp', label: 'go-cqhttp' });
});

test('认不出 ⇒ id 空串（只走标准面），label 用对端自报名', () => {
  assert.deepEqual(detectImplementation({ app_name: 'MysteryBot' }), { id: '', label: 'MysteryBot' });
  assert.deepEqual(detectImplementation(undefined), { id: '', label: 'v11-unknown' });
});
