/** correlate: rid reservation, settle, timeout error code, drop-on-overflow, tick liveness. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingTable, TickWatch } from '../src/correlate.js';
import { RET } from '../src/errors.js';

test('reserve then settle resolves the pending frame', async () => {
  const t = new PendingTable();
  const p = t.add('rid-1');
  assert.equal(t.size, 1);
  assert.equal(t.settle({ rid: 'rid-1' }), true);
  const got = await p;
  assert.equal(got.rid, 'rid-1');
  assert.equal(t.size, 0);
});

test('settle on an unknown key returns false', () => {
  const t = new PendingTable();
  assert.equal(t.settle({ rid: 'ghost' }), false);
});

test('duplicate key rejects with 60006', async () => {
  const t = new PendingTable();
  t.add('dup');
  await assert.rejects(t.add('dup'), (e: { code: number }) => e.code === RET.PEER_UNREACHABLE);
});

test('overflow evicts the oldest reservation with a rejection', async () => {
  const t = new PendingTable(2);
  const a = t.add('a');
  t.add('b');
  const aReject = a.catch((e) => e);
  t.add('c');
  const evicted = await aReject;
  assert.equal((evicted as { code: number }).code, RET.PEER_UNREACHABLE);
  assert.equal(t.size, 2);
});

test('timeout error is 60007 send_uncertain', () => {
  assert.equal(PendingTable.timeoutError('k').code, RET.SEND_UNCERTAIN);
});

test('tick watch declares silence dead past the window', () => {
  let now = 5000;
  const w = new TickWatch(1000, () => now);
  w.start();
  now = 5500;
  assert.equal(w.dead(), false);
  now = 6500;
  assert.equal(w.dead(), true);
  now = 6600;
  w.note();
  assert.equal(w.dead(), false);
});
