/** dedup: injected clock drives the TTL, cap evicts the oldest, empty keys never dedup. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEDUP_MAX, TtlDedup } from '../src/dedup.js';

function clock() {
  let now = 1_000_000;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test('same key inside the window is a duplicate, outside it is fresh', () => {
  const c = clock();
  const d = new TtlDedup({ ttlMs: 5000, now: c.now });
  assert.equal(d.check('a'), false);
  assert.equal(d.check('a'), true);
  c.advance(4000);
  assert.equal(d.check('a'), true); // window extends on recheck
  c.advance(5001);
  assert.equal(d.check('a'), false);
});

test('empty or nullish keys are never treated as duplicates', () => {
  const d = new TtlDedup();
  assert.equal(d.check(''), false);
  assert.equal(d.check(undefined), false);
});

test('cap evicts the oldest entry, kernel default is 200', () => {
  const d = new TtlDedup({ max: 3 });
  for (const k of ['k1', 'k2', 'k3', 'k4']) assert.equal(d.check(k), false);
  assert.equal(d.size, 3);
  assert.equal(d.check('k4'), true);
  assert.equal(d.check('k1'), false); // evicted
  assert.equal(DEDUP_MAX, 200);
});

test('keyForMsg prefers the platform message id', () => {
  assert.equal(TtlDedup.keyForMsg({ conv: 'c', id: 'f1', raw: { message_id: 9 } }), 'c|9');
  assert.equal(TtlDedup.keyForMsg({ conv: 'c', id: 'f1' }), 'c|f1');
  assert.equal(TtlDedup.keyForMsg({ conv: 'c', id: 'f1', raw: { message_id: '' } }), 'c|f1');
});
