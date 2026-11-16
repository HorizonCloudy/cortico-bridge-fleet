/**
 * definition.test.ts —— 装载形状与 describe 对表。
 * 闸项出处（cortico @836238311，d-cortico-side §6.2）：isWorldDefinition 四件
 * （extensions.ts:143-150）、kind/api（manifest.ts:23-27）、tools() 名字 ⊆ describe.tools
 * （describe-export.ts:134-136）、defaults().enabled=false（dry-mount.ts:141-143 warn 闸）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import MAIBOT_BRIDGE, { BRIDGE_DESCRIBE } from '../src/definition.ts';
import { TOOL_DECLS } from '../src/world.ts';
import { DEFAULTS, WORLD_ID } from '../src/config.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('isWorldDefinition 四件：id/label/defaults/create', () => {
  assert.equal(typeof MAIBOT_BRIDGE.id, 'string');
  assert.equal(MAIBOT_BRIDGE.id, WORLD_ID);
  assert.equal(typeof MAIBOT_BRIDGE.label, 'string');
  assert.equal(typeof MAIBOT_BRIDGE.defaults, 'function');
  assert.equal(typeof MAIBOT_BRIDGE.create, 'function');
});

test('defaults：enabled 缺省 false；监听口 = pins maibot 39702（_BUILD-PLAN §3.2/§4.4）', () => {
  const d = MAIBOT_BRIDGE.defaults();
  assert.equal(d.enabled, false);
  assert.equal(d.url, 'ws://127.0.0.1:39702');
  assert.equal(d.egress, false);
  assert.equal(d.ratePerMin, 20);
  assert.deepEqual({ ...DEFAULTS }, { ...d });
});

test('package.json cortico 段：kind=world api=6 describe 指真文件', () => {
  const pkg = JSON.parse(read('../package.json'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.cortico.kind, 'world');
  assert.equal(pkg.cortico.api, 6);
  assert.equal(pkg.cortico.describe, 'describe.json');
  assert.match(pkg.engines.node, /^>=22\.16\.0$/);
  assert.equal(pkg.dependencies['cortico-bridge-core'], 'file:../cortico-bridge-core');
  assert.match(pkg.dependencies.ws, /^\^8\.18\.0$/);
});

test('describe.json 与代码单源逐字对表（tools 名/parameters + events 名）', () => {
  const file = JSON.parse(read('../describe.json'));
  assert.deepEqual(
    file.tools.map((t: { name: string }) => t.name),
    TOOL_DECLS.map((t) => t.name),
  );
  for (const decl of TOOL_DECLS) {
    const j = file.tools.find((t: { name: string }) => t.name === decl.name);
    assert.ok(j, `describe.json 缺工具 ${decl.name}`);
    assert.deepEqual(j.parameters, decl.parameters, `${decl.name}.parameters`);
    assert.deepEqual(j.tags, decl.tags, `${decl.name}.tags`);
    assert.equal(j.description, decl.description);
    assert.ok(j.summary?.zh && j.summary?.en, `${decl.name} 缺 summary`);
  }
  assert.deepEqual(
    file.events.map((e: { type: string }) => e.type),
    BRIDGE_DESCRIBE.events.map((e) => e.type),
  );
});

test('tools() 名字 ⊆ describe.tools（describe-export.ts:134-136 装载闸）', () => {
  const world = MAIBOT_BRIDGE.create({ cfg: { ...DEFAULTS } } as never);
  const declared = new Set(BRIDGE_DESCRIBE.tools.map((t) => t.name));
  for (const t of world.tools()) {
    assert.ok(declared.has(t.name), `未申报工具 ${t.name} 会被 check:extension 拦`);
    assert.ok(Array.isArray(t.tags) && t.tags.length > 0, `${t.name} 缺 tags`);
    assert.equal(typeof t.handler, 'function');
  }
});

test('create() 纯：默认配置下不调用任何网络/不抛错（硬规则 1）', () => {
  const w = MAIBOT_BRIDGE.create({ cfg: undefined } as never);
  assert.equal(w.id, WORLD_ID);
});
