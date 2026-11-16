/** segment: whitelist, unknown-segment fallback, at_all, CQ round-trip, value coercion. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WIRE_SEGMENT_TYPES,
  atAllSegment,
  coerceSegments,
  cqToSegments,
  isAtAll,
  isWireType,
  renderSegment,
  renderSegments,
  segmentsToCq,
} from '../src/segment.js';

test('whitelist is the 20 measured online types', () => {
  assert.equal(WIRE_SEGMENT_TYPES.length, 20);
  assert.ok(isWireType('text') && isWireType('node'));
  assert.ok(!isWireType('file') && !isWireType('button'));
});

test('unknown segment renders [type] and never swallows the message', () => {
  assert.equal(renderSegment({ type: 'pdf', data: { file: 'a.pdf' } }), '[pdf]');
  assert.equal(
    renderSegments([
      { type: 'text', data: { text: 'body ' } },
      { type: 'pdf', data: {} },
    ]),
    'body [pdf]',
  );
});

test('render follows the onebot prior-art table', () => {
  assert.equal(renderSegment({ type: 'text', data: { text: 'hi' } }), 'hi');
  assert.equal(renderSegment(atAllSegment()), '@全体成员');
  assert.ok(isAtAll(atAllSegment()));
  assert.equal(renderSegment({ type: 'at', data: { qq: '123', name: 'bob' } }), '@bob');
  assert.equal(renderSegment({ type: 'image', data: {} }), '[图片]');
  assert.equal(renderSegment({ type: 'button', data: { label: 'go' } }), '[Button unavailable] go');
});

test('CQ round-trip matches the r-nonebot §2.3 sample', () => {
  const src = '[CQ:at,qq=123] hi [CQ:image,file=abc]';
  const segs = cqToSegments(src);
  assert.deepEqual(segs, [
    { type: 'at', data: { qq: '123' } },
    { type: 'text', data: { text: ' hi ' } },
    { type: 'image', data: { file: 'abc' } },
  ]);
  // byte-exact round trip, as measured in r-nonebot §2.3
  assert.equal(segmentsToCq(segs), src);
});

test('coerce turns values into strings and drops non-objects', () => {
  assert.deepEqual(
    coerceSegments([{ type: 'music', data: { id: 7, url: null } }, 'junk', null]),
    [{ type: 'music', data: { id: '7' } }],
  );
});
