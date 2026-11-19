/**
 * 契约测试：装载闸四件、发布闸可离线复刻项、describe 同步、koishi_ 名字闸（gate.md C-1/C-4）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { KOISHI_TOOL_DECLS } from '../src/world.js';
import { KOISHI_BRIDGE_DESCRIBE } from '../src/definition.js';
import definition from '../src/definition.js';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const describeJson = JSON.parse(readFileSync(new URL('../describe.json', import.meta.url), 'utf8'));
const TOOL_TAGS = new Set(['read', 'write', 'speak', 'act', 'flow', 'snapshot']);
const TOOL_NAMES = ['koishi_actions', 'koishi_call', 'koishi_events', 'koishi_status'];

test('cortico 块：kind=world、api 精确=6、describe 指产物、无 webUiClient（gate C-4）', () => {
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.version, '0.1.2');
  assert.equal(pkg.cortico.kind, 'world');
  assert.equal(pkg.cortico.api, 6, 'EXTENSION_API_VERSIONS.world @836238311 = 6');
  assert.equal(pkg.cortico.describe, 'describe.json');
  assert.equal(pkg.cortico.webUiClient, undefined, 'v1 薄壳不声明 webUiClient');
  assert.equal(pkg.main, './src/definition.js');
  assert.equal(pkg.exports['.'], './src/definition.js');
  // 2026-11-19：能力面已收敛，撤回从未发布的 unsafe 声明；平台没有 safe 标签，
  // 不写词表外的字符串（TAGS.md:31/:42），缺席只代表「未声明且未审查」。
  assert.deepEqual(pkg.cortico.tags, ['qq', 'im', 'external-setup', 'unofficial-api', 'experimental']);
});

test('src 全 .js（gate C-4：装载器 main 与 exports 都指 definition.js）', () => {
  for (const f of readdirSync(new URL('../src/', import.meta.url))) {
    assert.match(f, /\.js$/, `${f} 必须 .js`);
  }
});

test('isWorldDefinition 四件（先例约定，见 gate G-K5-2）', () => {
  assert.equal(typeof definition.id, 'string');
  assert.ok(definition.id);
  assert.notEqual(definition.id, 'onebot-bridge', '世界 ID 必须区别于先例包');
  assert.equal(typeof definition.label, 'string');
  assert.equal(typeof definition.defaults, 'function');
  assert.equal(typeof definition.create, 'function');
  assert.equal(definition.defaults().enabled, false, 'defaults().enabled 必须 false');
});

test('实例六必选件形状：id / envPromptVars / tools / start / stop（types.ts:911-933 @836238311）', () => {
  const inst = definition.create({ cfg: definition.defaults(), timezone: '', persist: () => {} });
  assert.equal(typeof inst.id, 'string');
  assert.equal(inst.id, definition.id);
  for (const m of ['envPromptVars', 'tools', 'start', 'stop']) assert.equal(typeof inst[m], 'function', m);
});

test('stop() 可独立调用且幂等（未 start 时 driver 为空，C-3 的 driver.stop 由 start 后路径保证）', async () => {
  const inst = definition.create({ cfg: definition.defaults(), timezone: '', persist: () => {} });
  await inst.stop();
  await inst.stop();
});

test('tools() == describe.json == KOISHI_TOOL_DECLS 三方一字不差（gate C-1 / G-K5-5）', () => {
  const inst = definition.create({ cfg: definition.defaults(), timezone: '', persist: () => {} });
  const declared = describeJson.tools.map((t) => t.name);
  assert.deepEqual(declared.slice().sort(), TOOL_NAMES, 'describe 必须只列这四个 koishi_* 工具');
  assert.deepEqual(inst.tools().map((t) => t.name).sort(), declared.slice().sort());
  assert.deepEqual(KOISHI_TOOL_DECLS.map((t) => t.name), declared);
  for (const t of inst.tools()) {
    assert.equal(typeof t.handler, 'function');
    assert.ok(Array.isArray(t.tags) && t.tags.length);
    for (const tag of t.tags) assert.ok(TOOL_TAGS.has(tag), `ToolTag 六值外的 tag: ${tag}`);
    assert.equal(typeof t.parameters, 'object');
  }
});

test('describe.json 与 definition.describe 同源一致（防手改漂移）', () => {
  assert.deepEqual(describeJson.tools, KOISHI_BRIDGE_DESCRIBE.tools);
  assert.deepEqual(describeJson.events, KOISHI_BRIDGE_DESCRIBE.events);
});

test('禁 onebot_* 工具名：包体文本面全扫（gate C-1 全文禁 + must_not）', () => {
  const texts = [];
  for (const f of readdirSync(new URL('../src/', import.meta.url), { recursive: true })) {
    if (String(f).endsWith('.js')) texts.push([String(f), readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')]);
  }
  texts.push(['describe.json', readFileSync(new URL('../describe.json', import.meta.url), 'utf8')]);
  texts.push(['package.json', readFileSync(new URL('../package.json', import.meta.url), 'utf8')]);
  for (const [f, txt] of texts) {
    assert.ok(!/onebot_/.test(txt), `${f} 出现禁用串 onebot_*`);
  }
});

test('事件类型四件挂 koishi-bridge.* 且 ⊆ describe.events', () => {
  const evs = describeJson.events.map((e) => e.type);
  assert.deepEqual(evs.slice().sort(), [
    'koishi-bridge.connection', 'koishi-bridge.message', 'koishi-bridge.notice', 'koishi-bridge.request',
  ]);
});
