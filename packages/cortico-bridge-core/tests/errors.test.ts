/** errors: v12 base set, bridge 6xxxx, family cross-translation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RET,
  koishiEmptySendToCode,
  maibotCapabilityErr,
  nekoReasonToCode,
  v11RetcodeToCbp,
} from '../src/errors.js';

test('v12 four-digit base is present verbatim', () => {
  for (const c of [10001, 10002, 10003, 10004, 10005, 10006, 10007, 20001, 20002]) {
    assert.ok((Object.values(RET) as number[]).includes(c), `retcode ${c}`);
  }
  assert.equal(RET.OK, 0);
});

test('bridge range is 60001..60008 with named slots', () => {
  assert.equal(RET.VERSION_MISMATCH, 60001);
  assert.equal(RET.DOOR_CLOSED, 60005);
  assert.equal(RET.SEND_UNCERTAIN, 60007);
  assert.equal(RET.DEGRADED, 60008);
});

test('neko reason maps to the agreed codes', () => {
  assert.equal(nekoReasonToCode('backpressure'), RET.PEER_UNREACHABLE);
  assert.equal(nekoReasonToCode('transport_unavailable'), RET.PEER_UNREACHABLE);
  assert.equal(nekoReasonToCode('transport_error'), RET.INTERNAL_HANDLER_ERROR);
  assert.equal(nekoReasonToCode('payload_too_large'), RET.PAYLOAD_TOO_LARGE);
});

test('maibot and koishi cross-translations', () => {
  const e = maibotCapabilityErr('未获授权能力: gateway.route_message');
  assert.equal(e.code, RET.UNSUPPORTED_PARAM);
  assert.match(e.message, /gateway.route_message/);
  assert.equal(koishiEmptySendToCode([]), RET.SEND_UNCERTAIN);
  assert.equal(koishiEmptySendToCode([1]), RET.OK);
});

test('v11 ws retcodes collapse into the 10001 family, unknown pass through', () => {
  for (const c of [1400, 1401, 1403, 1404]) assert.equal(v11RetcodeToCbp(c), RET.BAD_REQUEST);
  assert.equal(v11RetcodeToCbp(35001), 35001);
});
