/** negotiate: caps intersection order, 60001 version gate, tools[] risk/confirm validation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RET } from '../src/errors.js';
import type { HelloFrame, ReadyFrame } from '../src/frames.js';
import {
  CAPS,
  checkToolAnn,
  checkVersion,
  intersectCaps,
  negotiateHello,
  sanitizeTools,
  type AgentId,
} from '../src/negotiate.js';

const me: AgentId = { name: 'cortico-world-neko', version: '0.1.0', sha: 'deadbeefdeadbeef' };
const hello = (support: number[]): HelloFrame => ({
  v: 1,
  t: 'hello',
  id: 'h1',
  ts: 1,
  agent: { name: 'cortico-bridge-neko', version: '0.1.0', sha: 'cafe0000cafe0000' },
  self: { id: 'peer-self', name: 'Peer', proven: true },
  v_support: support,
  caps: ['images', 'notices'],
  tools: [],
});

test('caps intersect in CAPS order and drop unknown names', () => {
  assert.deepEqual(intersectCaps(['notices', 'images', 'zzz'], ['images', 'notices', 'buttons']), ['images', 'notices']);
  assert.equal(CAPS.includes('history_backfill'), true);
});

test('K1: CAPS is the pinned vocabulary, not a second hand-maintained list', async () => {
  const { PINS } = await import('../src/pins.js');
  assert.deepEqual([...CAPS], [...PINS.capsVocab]);
  for (const name of ['images', 'notices', 'self_echo', 'tools'] as const) {
    assert.ok(CAPS.includes(name), `${name} must come through from pins`);
  }
});

test('version gate: disjoint support yields 60001 naming both sides', () => {
  const bad = checkVersion(hello([2, 3]), me);
  assert.equal(bad!.code, RET.VERSION_MISMATCH);
  assert.match(bad!.message, /cortico-world-neko@0.1.0/);
  assert.match(bad!.message, /cortico-bridge-neko@0.1.0/);
  assert.equal(checkVersion(hello([1]), me), null);
});

test('hello negotiation returns caps and error for a good handshake', () => {
  const neg = negotiateHello(hello([1]), { agent: me, caps: ['images', 'notices', 'files'], tools: [] });
  assert.deepEqual(neg.caps, ['images', 'notices']);
  assert.equal(neg.error, undefined);
});

test('tool announcement validation, bad rows counted not fatal', () => {
  assert.equal(checkToolAnn({ name: 'x', risk: 'read', confirm_required: false }), true);
  assert.equal(checkToolAnn({ name: 'x', risk: 'teleport', confirm_required: false }), false);
  assert.equal(checkToolAnn({ name: '', risk: 'write', confirm_required: true }), false);
  const r = sanitizeTools([{ name: 'a', risk: 'act', confirm_required: true }, { nope: 1 }]);
  assert.equal(r.ok.length, 1);
  assert.equal(r.bad, 1);
});

test('ready negotiation is symmetric and needs no version gate', () => {
  const ready: ReadyFrame = { v: 1, t: 'ready', id: 'r1', ts: 1, caps: ['files'], tools: [], self: { id: 'peer-self', name: 'Peer', proven: true } };
  assert.deepEqual(negotiateHello(hello([1]), { agent: me, caps: [], tools: [] }).caps, []);
  assert.deepEqual(intersectCaps(['files'], ready.caps), ['files']);
});
