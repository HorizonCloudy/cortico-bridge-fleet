/** frames: ten-type decode, defensive parseFrame (null/array/scalar rejected), round-trip. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_TYPES, encodeFrame, frameTsToIso, newHead, parseFrame, type Frame } from '../src/frames.js';

const head = { v: 1 as const, id: 'a'.repeat(36), ts: 1731000000.5 };
const tool = { name: 'neko_send', risk: 'write' as const, confirm_required: true };
const ACTOR = { platform: 'onebot', conv: 'group_5_4', member: { id: '2002', name: 'nick' }, anon: 'identified' as const };
const SELF = { id: 'bot-1', name: 'Cortico', proven: true };

const samples: Frame[] = [
  { ...head, t: 'hello', agent: { name: 'p', version: '0.1.0', sha: 'x'.repeat(40) }, v_support: [1], caps: ['images'], tools: [tool], self: SELF },
  { ...head, t: 'ready', caps: ['images', 'buttons'], tools: [], self: SELF },
  { ...head, t: 'msg', conv: 'g:1', sender: { id: 'u1', name: 'n' }, kind: 'mention', segments: [{ type: 'text', data: { text: 'hi' } }], raw: { message_id: 7 } },
  { ...head, t: 'notice', conv: 'g:1', kind: 'recall', raw: null },
  { ...head, t: 'ack', rid: 'r1' },
  { ...head, t: 'call', rid: 'r1', tool: 'x', args: { a: 1 }, turn: 'm-1', actor: ACTOR },
  { ...head, t: 'reply', rid: 'r1', ok: false, error: { code: 60007, message: 'uncertain' } },
  { ...head, t: 'event', name: 'connection', data: { up: true } },
  { ...head, t: 'tick' },
  { ...head, t: 'catalog', tools: [tool] },
];

test('all ten frame types decode', () => {
  for (const f of samples) {
    assert.deepEqual(parseFrame(JSON.stringify(f)), f, `type ${f.t}`);
  }
  assert.equal(FRAME_TYPES.length, 10);
});

test('parseFrame rejects null, arrays, scalars and garbage', () => {
  for (const bad of ['null', '[1,2]', '"str"', '5', 'true', 'not json', '{}']) {
    assert.equal(parseFrame(bad), null, bad);
  }
});

test('parseFrame rejects bad heads and bad bodies', () => {
  assert.equal(parseFrame(JSON.stringify({ ...head, v: 2, t: 'tick' })), null);
  assert.equal(parseFrame(JSON.stringify({ ...head, id: '', t: 'tick' })), null);
  assert.equal(parseFrame(JSON.stringify({ ...head, id: 'z'.repeat(65), t: 'tick' })), null);
  assert.equal(parseFrame(JSON.stringify({ ...head, ts: 'now', t: 'tick' })), null);
  assert.equal(parseFrame(JSON.stringify({ ...head, t: 'nope' })), null);
  assert.equal(parseFrame(JSON.stringify({ ...head, t: 'msg', conv: 'c', sender: { id: 's', name: 'n' }, kind: 'mention', segments: 'not-array', raw: 1 })), null);
  assert.equal(parseFrame(JSON.stringify({ ...head, t: 'msg', conv: 'c', sender: { id: 's', name: 'n' }, kind: 'mention', segments: [{ type: 'text', data: { x: 5 } }], raw: 1 })), null);
  assert.equal(parseFrame(JSON.stringify({ ...head, t: 'reply', rid: 'r', ok: true, error: { code: 'x', message: 'm' } })), null);
});

test('encode/newHead/tsToIso', () => {
  const h = newHead('tick');
  assert.equal(h.v, 1);
  assert.ok(h.id.length >= 1 && h.id.length <= 64);
  assert.equal(typeof h.ts, 'number');
  assert.equal(typeof encodeFrame({ ...head, t: 'tick' }), 'string');
  assert.equal(frameTsToIso(1731000000.5), new Date(1731000000500).toISOString());
});

// ---- K1 batch: F3 (call turn+actor) and F1/F2 (hello/ready self). Red first, then codec.
const callBase = { ...head, t: 'call', rid: 'r1', tool: 'x', args: {}, turn: 'm-1', actor: ACTOR };

test('call without turn is a bad frame (F3 required)', () => {
  const { turn: _t, ...noTurn } = callBase;
  assert.equal(parseFrame(JSON.stringify(noTurn)), null);
});

test('call without actor is a bad frame (F3 required)', () => {
  const { actor: _a, ...noActor } = callBase;
  assert.equal(parseFrame(JSON.stringify(noActor)), null);
});

test('call actor shape is enforced four-key-closed by the decoder', () => {
  for (const actor of [
    undefined,
    null,
    'self',
    { ...ACTOR, anon: 'root' }, // anon outside identified|anonymous|self|unknown
    { ...ACTOR, member: { id: '2002' } }, // member must be {id,name} verbatim $defs/sender
    { ...ACTOR, conv: 'c'.repeat(257) }, // $defs/conv maxLength 256
    { ...ACTOR, platform: '' }, // platform 1..64
  ]) {
    assert.equal(parseFrame(JSON.stringify({ ...callBase, actor })), null, JSON.stringify(actor));
  }
  assert.equal(parseFrame(JSON.stringify({ ...callBase, turn: '' })), null, 'turn is $defs/frameId 1..64');
  assert.equal(parseFrame(JSON.stringify({ ...callBase, turn: 't'.repeat(65) })), null);
});

test('hello and ready without self are bad frames (F1/F2 required)', () => {
  assert.equal(
    parseFrame(
      JSON.stringify({ ...head, t: 'hello', agent: { name: 'p', version: '1', sha: 's' }, v_support: [1], caps: [], tools: [] }),
    ),
    null,
  );
  assert.equal(parseFrame(JSON.stringify({ ...head, t: 'ready', caps: [], tools: [] })), null);
});

test('self shape: id/name strings up to 256, proven boolean; empty id is legal with proven:false', () => {
  assert.equal(parseFrame(JSON.stringify({ ...head, t: 'ready', caps: [], tools: [], self: { id: 'x', name: 'n' } })), null, 'proven missing');
  assert.equal(parseFrame(JSON.stringify({ ...head, t: 'ready', caps: [], tools: [], self: { id: 'x', name: 'n', proven: 'yes' } })), null, 'proven not boolean');
  assert.equal(parseFrame(JSON.stringify({ ...head, t: 'ready', caps: [], tools: [], self: { id: 'i'.repeat(257), name: 'n', proven: true } })), null, 'id over 256');
  const ok = parseFrame(JSON.stringify({ ...head, t: 'ready', caps: [], tools: [], self: { id: '', name: '', proven: false } }));
  assert.notEqual(ok, null, 'proven:false may carry an empty id honestly (SECURITY-CBP §2)');
});
