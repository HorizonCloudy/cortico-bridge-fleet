/**
 * 契约测试：装载闸的可离线复刻（isWorldDefinition、api 锚、describe 一致、v11 覆盖面）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { coverage, V11_ACTIONS, V11_EVENT_KINDS, V11_SEGMENTS } from '../src/catalog.js';
import { ONEBOT_TOOL_DECLS } from '../src/world.js';
import { ONEBOT_BRIDGE_DESCRIBE } from '../src/definition.js';
import definition from '../src/definition.js';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

test('cortico 块：kind=world、api 精确=当前锚 6、describe 指产物', () => {
  assert.equal(pkg.cortico.kind, 'world');
  assert.equal(pkg.cortico.api, 6, 'EXTENSION_API_VERSIONS.world @836238311 = 6');
  assert.equal(pkg.cortico.describe, 'describe.json');
  assert.equal(pkg.type, 'module');
});

test('isWorldDefinition 四件（extensions.ts:143-150）', () => {
  assert.equal(typeof definition.id, 'string');
  assert.ok(definition.id);
  assert.equal(typeof definition.label, 'string');
  assert.equal(typeof definition.defaults, 'function');
  assert.equal(typeof definition.create, 'function');
  assert.equal(definition.defaults().enabled, false);
});

test('实例 tools() 的名字都 ⊆ describe.tools（describe-export.ts:134-136）', () => {
  const inst = definition.create({ cfg: definition.defaults(), timezone: '', persist: () => {} });
  const declared = ONEBOT_BRIDGE_DESCRIBE.tools.map((t) => t.name);
  for (const t of inst.tools()) {
    assert.ok(declared.includes(t.name), `越界工具 ${t.name}`);
    assert.equal(typeof t.handler, 'function');
    assert.ok(Array.isArray(t.tags) && t.tags.length);
    assert.equal(typeof t.parameters, 'object');
  }
  // tools() 名 == describe 名，一一对应
  assert.deepEqual(inst.tools().map((t) => t.name).sort(), declared.slice().sort());
});

test('ONEBOT_TOOL_DECLS 覆盖 describe 与实例三方一致', () => {
  const declNames = ONEBOT_TOOL_DECLS.map((t) => t.name);
  assert.deepEqual(ONEBOT_BRIDGE_DESCRIBE.tools.map((t) => t.name), declNames);
});

test('OneBot v11 目录 == reality 38 − 3 凭证动作 = 35（SECURITY-CBP.md:125 摘除）', () => {
  assert.equal(coverage().actions, 35);
  assert.equal(V11_ACTIONS.length, 35);
  assert.equal(V11_EVENT_KINDS.length, 17);
  assert.equal(V11_SEGMENTS.length, 20);
  assert.equal(coverage().readOnly, 16);
  assert.equal(coverage().write, 19);
  // 集合抽查（对齐 r-nonebot-onebot.md:133 的规范动作名）
  const names = new Set(V11_ACTIONS.map((a) => a.name));
  for (const n of ['send_private_msg', 'set_group_anonymous_ban', 'get_group_honor_info', 'get_status', 'clean_cache']) {
    assert.ok(names.has(n), `缺 ${n}`);
  }
  // 凭证动作不进目录；reality 名单（spec/pins.json:762-764）仍含它们，目录必须不含。
  for (const n of ['get_cookies', 'get_csrf_token', 'get_credentials']) {
    assert.ok(!names.has(n), `${n} 不得进目录（SECURITY-CBP.md:125）`);
  }
});
