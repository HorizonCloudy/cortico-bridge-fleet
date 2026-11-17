/** correlate: rid reservation, settle, timeout error code, drop-on-overflow, tick liveness. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PendingTable, TickWatch, TurnLedger } from '../src/correlate.js';
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

// ── 工单二 F2：TurnLedger 默认窗从 dedup 600 秒改挂同源窗 ─────────────────────

test('TurnLedger default window follows the single-source turn ttl, not the dedup TTL (工单二 F2)', () => {
  let now = 1_000_000_000;
  const prev = process.env.CORTICO_TURN_TTL_SECONDS;
  process.env.CORTICO_TURN_TTL_SECONDS = '300';
  try {
    const led = new TurnLedger(undefined, undefined, () => now);
    led.record({ id: 'm-win', conv: 'c1', sender: { id: 'u', name: 'u' } });
    now += 299_000;
    assert.ok(led.lookup('m-win'), '299 秒仍在窗内');
    now += 2_000;
    assert.equal(led.lookup('m-win'), null, '301 秒过期——旧默认（dedup 600 秒）在这里必须判得出红');
  } finally {
    if (prev === undefined) delete process.env.CORTICO_TURN_TTL_SECONDS;
    else process.env.CORTICO_TURN_TTL_SECONDS = prev;
  }
});

test('correlate.ts must not default the ledger window to DEDUP_TTL_MS any more', () => {
  const src = readFileSync(new URL('../../src/correlate.ts', import.meta.url), 'utf8');
  assert.match(src, /ttlMs = effectiveTurnTtlSeconds\(\)\.ttlSeconds \* 1000/, '默认窗必须挂同源读数');
  assert.doesNotMatch(src, /ttlMs = DEDUP_TTL_MS/, '不得再复用 dedup 的 600 秒');
});
