// 帧表与段词表一致性测试 — CBP frame types vs the OneBot v11 segment vocabulary.
// Canonical frame table = _BUILD-PLAN.md §3.1 (十型); canonical seg table =
// r-nonebot-onebot.md §2.3 (24 factories → 20 wire types, 4 sugar names).
// At-run-time parts are cross-checked against spec/CBP-v1.json, spec/conformance.json
// and packages/cortico-bridge-core/src/{frames,segment}.ts as soon as those work
// orders land; their absence is reported as a skip, never as a pass.
// Run: node --test tests/frames/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readReport, readText, exists, FLEET_ROOT } from '../_lib/evidence.mjs';
import { resolve } from 'node:path';

// _BUILD-PLAN.md:120-136 (十型, header v/t/id/ts). Source: c1 §5.1 + G8 (4725feee6 帧表泛化).
export const FRAME_TYPES = ['hello', 'ready', 'msg', 'notice', 'ack', 'call', 'reply', 'event', 'tick', 'catalog'];
export const FRAME_HEAD = ['v', 't', 'id', 'ts'];
// per-type required payload keys beyond the head, _BUILD-PLAN §3.1 verbatim fields
export const FRAME_REQUIRED = {
  hello: ['agent', 'v_support', 'caps', 'tools'],
  ready: ['caps', 'tools'],
  msg: ['conv', 'sender', 'kind', 'segments', 'raw'],
  notice: ['kind', 'raw'],
  ack: ['rid'],
  call: ['rid', 'tool', 'args'],
  reply: ['rid', 'ok'],
  event: ['name', 'data'],
  tick: [],
  catalog: ['tools'],
};
// ToolTag 六值逐字 — repos/cortico src/core/types.ts:202 @836238311 (d-cortico-side §2.1)
export const TOOL_TAG_RISKS = ['read', 'write', 'speak', 'act', 'flow', 'snapshot'];
// msg.kind 四值 — _BUILD-PLAN §3.1
export const MSG_KINDS = ['mention', 'direct', 'group', 'other'];

// r-nonebot-onebot.md:140-141 @ acquisition (24 factories, 20 wire types, 4 sugars)
export const SEG_FACTORIES = ['text', 'face', 'image', 'record', 'video', 'at', 'rps', 'dice', 'shake', 'poke', 'anonymous', 'share', 'contact', 'contact_user', 'contact_group', 'location', 'music', 'music_custom', 'reply', 'forward', 'node', 'node_custom', 'json', 'xml'];
export const SEG_WIRE = ['text', 'face', 'image', 'record', 'video', 'at', 'rps', 'dice', 'shake', 'poke', 'anonymous', 'share', 'contact', 'location', 'music', 'reply', 'forward', 'node', 'json', 'xml'];
export const SEG_SUGAR = { contact_user: 'contact', contact_group: 'contact', music_custom: 'music', node_custom: 'node' };
// C1-5 / r-astrbot §4: at_all has no `atall` key anywhere — it goes over the wire as at{qq:'all'}
export const AT_ALL_WIRE = { type: 'at', data: { qq: 'all' } };

test('frame table: exactly ten unique types, each with a head and required list', () => {
  assert.equal(new Set(FRAME_TYPES).size, 10);
  for (const t of FRAME_TYPES) assert.ok(t in FRAME_REQUIRED, `frame ${t} has no required-field list`);
  for (const k of FRAME_HEAD) assert.ok(!FRAME_TYPES.includes(k), `head key ${k} must not double as a frame type`);
});

test('frame table: msg carries segments, ToolTag risk set is the six verbatim values', () => {
  assert.ok(FRAME_REQUIRED.msg.includes('segments'));
  assert.equal(TOOL_TAG_RISKS.length, 6);
  assert.ok(MSG_KINDS.length === 4 && new Set(MSG_KINDS).size === 4);
});

test('segment table: 24 factories = 20 wire + 4 sugar, sugars map into wire', () => {
  assert.equal(SEG_FACTORIES.length, 24);
  assert.equal(SEG_WIRE.length, 20);
  assert.equal(new Set(SEG_WIRE).size, 20);
  const sugarNames = Object.keys(SEG_SUGAR);
  assert.deepEqual(sugarNames, ['contact_user', 'contact_group', 'music_custom', 'node_custom']);
  const wireSet = new Set(SEG_WIRE);
  for (const f of SEG_FACTORIES) {
    const onWire = wireSet.has(f) ? f : SEG_SUGAR[f];
    assert.ok(onWire !== undefined, `factory ${f} maps to no wire type`);
    assert.ok(wireSet.has(onWire), `sugar target ${onWire} is not a wire type`);
  }
  assert.deepEqual([...SEG_FACTORIES].sort(), [...SEG_WIRE, ...sugarNames].sort());
});

test('segment table: no `atall` token anywhere; at_all renders as at{qq:"all"}', () => {
  for (const list of [SEG_FACTORIES, SEG_WIRE, Object.keys(SEG_SUGAR)]) {
    assert.ok(!list.includes('atall'), 'atall must not enter the v11 vocabulary (C1-5)');
  }
  assert.deepEqual(AT_ALL_WIRE, { type: 'at', data: { qq: 'all' } });
  assert.ok(SEG_WIRE.includes('at'));
});

test('segment table matches r-nonebot-onebot.md §2.3 verbatim', () => {
  const text = readReport('r-nonebot-onebot.md');
  assert.ok(text !== null, '缺证据文件 reports/r-nonebot-onebot.md');
  const chunks = [...text.matchAll(/`([a-z_]+(?:, [a-z_]+)+)`/g)]
    .map((m) => m[1].split(', '));
  const factoriesFromReport = chunks.find((c) => c.length === 24);
  const wireFromReport = chunks.find((c) => c.length === 20);
  assert.ok(factoriesFromReport, 'no 24-name factory list found in §2.3');
  assert.ok(wireFromReport, 'no 20-name wire list found in §2.3');
  assert.deepEqual([...factoriesFromReport].sort(), [...SEG_FACTORIES].sort());
  assert.deepEqual([...wireFromReport].sort(), [...SEG_WIRE].sort());
});

test('cross-check spec/CBP-v1.json (skips until the spec work order lands)', (t) => {
  const abs = resolve(FLEET_ROOT, 'spec/CBP-v1.json');
  if (!exists(abs)) return t.skip('缺 spec/CBP-v1.json（_BUILD-PLAN §2.1 帧表件，另一工单产出）');
  const text = readText(abs);
  const schema = JSON.parse(text); // must at least be valid JSON
  for (const ty of FRAME_TYPES) assert.ok(text.includes(`"${ty}"`), `frame type ${ty} absent from schema`);
  assert.ok(text.includes('catalog'), 'catalog frame must exist (G5)');
  assert.ok(text.includes('"additionalProperties": false'), 'spec requires additionalProperties:false');
  assert.ok(schema);
});

test('cross-check conformance.json vectors (skips until it lands)', (t) => {
  const abs = resolve(FLEET_ROOT, 'spec/conformance.json');
  if (!exists(abs)) return t.skip('缺 spec/conformance.json（_BUILD-PLAN §2.1 黄金向量件）');
  const text = readText(abs);
  for (const ty of FRAME_TYPES) assert.ok(text.includes(`"${ty}"`), `no vector for frame ${ty}`);
  for (const w of SEG_WIRE) assert.ok(text.includes(`"${w}"`), `no vector using seg ${w}`);
});

test('cross-check core src/frames.ts + src/segment.ts (skips until they land)', (t) => {
  const core = resolve(FLEET_ROOT, 'packages/cortico-bridge-core');
  const framesAbs = resolve(core, 'src/frames.ts');
  const segAbs = resolve(core, 'src/segment.ts');
  if (!exists(framesAbs) || !exists(segAbs)) {
    return t.skip('缺 packages/cortico-bridge-core/src/frames.ts|segment.ts（内核工单产出）');
  }
  const frames = readText(framesAbs);
  for (const ty of FRAME_TYPES) {
    assert.ok(frames.includes(`'${ty}'`) || frames.includes(`"${ty}"`), `frames.ts missing ${ty}`);
  }
  assert.ok(!frames.includes(`'atall'`), 'frames.ts must not mint an atall type');
  const seg = readText(segAbs);
  for (const w of SEG_WIRE) {
    assert.ok(seg.includes(`'${w}'`) || seg.includes(`"${w}"`), `segment.ts whitelist missing ${w}`);
  }
  assert.ok(!/\batall\b/.test(seg), 'segment.ts must not carry an atall key (C1-5)');
  assert.ok(/[{,(\s.]qq\s*[:=]/.test(seg), 'segment.ts must use v11 param name qq (segment.md:167)');
});
