// pins.json 与实际 sha 的自洽测试 — single-source G1 self-consistency.
// Three directions, all offline:
// (A) every pins.repos[*].sha9 equals the live git HEAD of that clone on disk
//     (read-only `git rev-parse --short=9 HEAD`; never touches the network);
// (B) pins.repos dir→sha9 matches the acquisition ledger SHA_LEDGER (_BUILD-PLAN §4.5)
//     in both directions — neither may carry a repo the other lacks;
// (C) the rest of the pin table is internally coherent: exact npm versions with a 9-hex
//     shasum and no "latest" (C1-13), required python buckets, node floor, the neko SDK
//     space ">=0.1.0,<0.2.0" never bare/wildcard (C1-9/T1), and a collision-free port
//     table where 48913 is the only non-loopback bind (C1-8).
// spec/pins.json is the G1 single source; absent = skip, never a false pass.
// Run: node --test tests/pins/
import test from 'node:test';
import assert from 'node:assert/strict';
import { SHA_LEDGER, FLEET_ROOT, gitHead9, exists, readText } from '../_lib/evidence.mjs';
import { resolve } from 'node:path';

const PINS = resolve(FLEET_ROOT, 'spec/pins.json');

function loadPins(t) {
  if (!exists(PINS)) {
    t.skip('缺 spec/pins.json（_BUILD-PLAN §2.1，G1 单一来源件）');
    return null;
  }
  return JSON.parse(readText(PINS));
}

test('ledger: every evidence repo on disk sits at its acquisition sha9', () => {
  const mismatches = [];
  for (const [rel, want] of Object.entries(SHA_LEDGER)) {
    const got = gitHead9(rel);
    if (got === null) mismatches.push(`${rel}: missing on disk`);
    else if (got !== want) mismatches.push(`${rel}: HEAD ${got} != ledger ${want}`);
  }
  assert.deepEqual(mismatches, [], 'sha9 ledger drifted from acquisition');
});

test('ledger: every sha9 is 9 lowercase hex', () => {
  for (const [rel, sha] of Object.entries(SHA_LEDGER)) {
    assert.match(sha, /^[0-9a-f]{9}$/, `${rel} sha9 malformed`);
  }
});

test('pins.repos: each sha9 equals that clone live git HEAD (the self-test)', (t) => {
  const pins = loadPins(t);
  if (!pins) return;
  assert.ok(pins.repos && typeof pins.repos === 'object', 'pins.json lacks a repos map');
  const bad = [];
  for (const [name, r] of Object.entries(pins.repos)) {
    assert.match(r.dir, /^[a-z]/, `${name}: repo lacks a dir`);
    assert.match(r.sha9, /^[0-9a-f]{9}$/, `${name}: sha9 malformed`);
    const head = gitHead9(r.dir);
    if (head === null) bad.push(`${name}: ${r.dir} missing on disk`);
    else if (head !== r.sha9) bad.push(`${name}: pins ${r.sha9} != git HEAD ${head}`);
  }
  assert.deepEqual(bad, [], 'pins.repos drifted from the on-disk clones');
});

test('pins.repos and the acquisition ledger list the same dir→sha9 set', (t) => {
  const pins = loadPins(t);
  if (!pins) return;
  const pinsByDir = {};
  for (const r of Object.values(pins.repos)) pinsByDir[r.dir] = r.sha9;
  assert.deepEqual(Object.keys(pinsByDir).sort(), Object.keys(SHA_LEDGER).sort(), 'repo dir sets differ');
  for (const [dir, sha] of Object.entries(SHA_LEDGER)) {
    assert.equal(pinsByDir[dir], sha, `pins.repos sha for ${dir} must be ${sha}`);
  }
});

test('pins.npm_pins: no floating installs — every pin is exact with a shasum9', (t) => {
  const pins = loadPins(t);
  if (!pins) return;
  assert.ok(pins.npm_pins && typeof pins.npm_pins === 'object', 'pins.json lacks the npm_pins section');
  const REQUIRED = ['koishi', '@koishijs/core', 'cordis', '@cordisjs/core',
    '@satorijs/core', '@satorijs/protocol', 'koishi-plugin-adapter-onebot', 'minato', '@koishijs/loader'];
  for (const name of REQUIRED) {
    const p = pins.npm_pins[name];
    assert.ok(p, `npm pin missing: ${name} (_BUILD-PLAN §4.1)`);
    assert.equal(typeof p.version, 'string', `${name} pin lacks an exact version`);
    assert.match(p.version, /^\d+\.\d+\.\d+/, `${name} must be pinned exact, got ${p.version}`);
    // shasum9 is carried for the byte-verified seven (§4.1 #sha column); when present it
    // must be 9-hex. @koishijs/loader is pinned version-only in the plan table.
    if (p.shasum9 !== undefined) assert.match(p.shasum9, /^[0-9a-f]{9}$/, `${name} shasum9 malformed`);
  }
  assert.equal(pins.npm_pins.cordis.version, '3.18.1', 'cordis must pin the v3 line');
  assert.equal(pins.npm_pins.minato.version, '3.7.0');
  assert.ok(!Object.values(pins.npm_pins).some((p) => JSON.stringify(p).includes('"latest"')),
    'npm_pins must refuse "latest" (C1-13)');
  const rc = pins.npm_pins['cordis-rc-rename-ledger-only'];
  assert.equal(rc?.version, '4.0.0-rc.13', 'rc rename ledger pin present');
});

test('pins.python_buckets + node floor match _BUILD-PLAN §4.2/§4.3', (t) => {
  const pins = loadPins(t);
  if (!pins) return;
  assert.ok(pins.python_buckets && pins.node, 'pins.json lacks python_buckets/node sections');
  assert.equal(pins.node.min, '22.16.0');
  const py = JSON.stringify(pins.python_buckets);
  for (const want of ['1.4.5', '2.23.0', '4.29.4', '2.5.0', '2.4.6']) {
    assert.ok(py.includes(want), `python pin ${want} missing`);
  }
});

test('pins.neko_sdk: supported space is valid SpecifierSet, never bare or wildcard (C1-9, T1)', (t) => {
  const pins = loadPins(t);
  if (!pins) return;
  assert.equal(pins.neko_sdk?.declare_supported, '>=0.1.0,<0.2.0');
  assert.equal(pins.neko_sdk?.sdk_version, '0.1.0', 'gate reads SDK_VERSION, not APP_VERSION (R1)');
  const bareOrWildcard = (s) => /^\d+(\.\d+)*$/.test(s) || s.includes('*');
  for (const clause of pins.neko_sdk.declare_supported.split(',')) {
    assert.ok(!bareOrWildcard(clause.trim()), `invalid specifier ${clause}`);
  }
});

test('pins.ports: collision-free and 48913 is the only non-loopback bind (C1-8)', (t) => {
  const pins = loadPins(t);
  if (!pins) return;
  assert.ok(Array.isArray(pins.ports), 'pins.json lacks the ports array');
  const seen = new Set();
  for (const p of pins.ports) {
    const key = `${p.proto ?? 'tcp'}:${p.port}`;
    assert.ok(!seen.has(key), `duplicate port ${key}`);
    seen.add(key);
    if (String(p.bind).includes('0.0.0.0')) {
      assert.equal(p.port, 48913, `non-loopback bind on ${key} violates C1-8`);
    }
  }
  for (const port of [39701, 39702]) assert.ok(seen.has(`tcp:${port}`), `Cortico listen port ${port} missing`);
});
