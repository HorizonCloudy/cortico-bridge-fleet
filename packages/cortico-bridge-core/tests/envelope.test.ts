/** envelope: TriggerMode tiering, meta keeps raw, ts float-seconds to ISO with offset. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eventNamesFor,
  eventToEnvelope,
  msgToEnvelope,
  noticeToEnvelope,
  tsToIso,
} from '../src/envelope.js';
import type { MsgFrame, NoticeFrame, EventFrame } from '../src/frames.js';

const base = { v: 1 as const, id: 'x1', ts: 1731000000 };
const mk = (kind: MsgFrame['kind'], senderId = 'u9'): MsgFrame => ({
  ...base,
  t: 'msg',
  conv: 'c1',
  sender: { id: senderId, name: 'Zed' },
  kind,
  segments: [{ type: 'text', data: { text: 'yo' } }],
  raw: { message_id: 'm-9', post_type: 'message' },
});

test('mention/direct flush, group/other host default, self archive-only', () => {
  const m = msgToEnvelope(mk('mention'), { worldId: 'neko' });
  assert.equal(m.push.trigger, 'flush');
  const g = msgToEnvelope(mk('group'), { worldId: 'neko' });
  assert.equal(g.push.trigger, undefined);
  assert.equal(g.push.deliver, undefined);
  const s = msgToEnvelope(mk('direct', 'me'), { worldId: 'neko', selfId: 'me' });
  assert.equal(s.push.deliver, false);
  assert.equal(s.envelope.contextDelivery, 'archive-only');
});

test('notice is piggyback and event frames are flush with internal origin', () => {
  const n: NoticeFrame = { ...base, t: 'notice', kind: 'recall', raw: { a: 1 } };
  const r = noticeToEnvelope(n, { worldId: 'neko' });
  assert.equal(r.push.trigger, 'piggyback');
  assert.equal(r.envelope.type, 'neko.notice');
  const ev: EventFrame = { ...base, t: 'event', name: 'degraded', data: { why: 'button' } };
  const e = eventToEnvelope(ev, { worldId: 'neko' });
  assert.equal(e.push.trigger, 'flush');
  assert.equal(e.envelope.origin, 'internal');
  assert.equal(e.envelope.type, 'neko.degraded');
});

test('meta keeps conv/sender/kind/platformMsgId/raw; names come from the fixed table', () => {
  const names = eventNamesFor('maibot');
  assert.deepEqual(names, {
    message: 'maibot.message',
    notice: 'maibot.notice',
    connection: 'maibot.connection',
    degraded: 'maibot.degraded',
  });
  const m = msgToEnvelope(mk('direct'), { worldId: 'maibot' });
  const meta = m.envelope.meta!;
  assert.equal(meta.conv, 'c1');
  assert.deepEqual(meta.sender, { id: 'u9', name: 'Zed' });
  assert.equal(meta.kind, 'direct');
  assert.equal(meta.platformMsgId, 'm-9');
  assert.deepEqual(meta.raw, { message_id: 'm-9', post_type: 'message' });
  assert.equal(m.envelope.senderKey, 'c1');
});

test('ts float seconds renders ISO with offset', () => {
  assert.equal(tsToIso(base.ts), new Date(1731000000000).toISOString());
});

test('self echo needs a proven declaration; unproven or missing self delivers and degrades', () => {
  // proven:true + match → archive-only (the only silent-suppression case)
  const hit = msgToEnvelope(mk('direct', 'me'), { worldId: 'neko', self: { id: 'me', name: 'Me', proven: true } });
  assert.equal(hit.push.deliver, false);
  assert.equal(hit.envelope.contextDelivery, 'archive-only');
  assert.equal(hit.degraded, undefined);
  // proven:false + same id → deliver normally and say self-unknown (no silent archive)
  const unproven = msgToEnvelope(mk('direct', 'me'), { worldId: 'neko', self: { id: 'me', name: 'Me', proven: false } });
  assert.equal(unproven.push.deliver, undefined, 'proven:false must never suppress (SECURITY-CBP §2.4)');
  assert.equal(unproven.envelope.contextDelivery, undefined);
  assert.deepEqual(unproven.degraded, { reason: 'self-unknown' });
  // no self at all → deliver + degrade, never a quiet drop
  const none = msgToEnvelope(mk('mention'), { worldId: 'neko' });
  assert.equal(none.push.deliver, undefined);
  assert.equal(none.push.trigger, 'flush');
  assert.deepEqual(none.degraded, { reason: 'self-unknown' });
  // config selfId remains the fallback when negotiation supplied nothing (impl row 9)
  const cfg = msgToEnvelope(mk('direct', 'me'), { worldId: 'neko', selfId: 'me' });
  assert.equal(cfg.push.deliver, false);
  assert.equal(cfg.degraded, undefined);
});

// SECURITY-CBP §3.4: 「恒留原始载荷」now means 「恒留剥除后的原始载荷」— credentials never reach the prompt.
test('msg meta.raw drops credential keys and strips credential strings', () => {
  const f = mk('direct');
  f.raw = {
    message_id: 1,
    access_token: 'abc',
    token: 'abc',
    url: 'ws://h?access_token=abc&x=1',
    login: 'ws://user:pass@h',
    nested: { Cookie: 'x', Authorization: 'Bearer z', safe: 'ok' },
    list: [{ api_key: 'k' }, { keep: 2 }],
  };
  const m = msgToEnvelope(f, { worldId: 'neko' });
  const raw = m.envelope.meta!.raw as Record<string, unknown>;
  const blob = JSON.stringify(raw);
  assert.ok(!blob.includes('abc'), 'token values are gone');
  assert.ok(!blob.includes('user:pass'), 'URL userinfo is gone');
  assert.ok(!blob.includes('Bearer z'), 'authorization value is gone');
  assert.equal(raw.access_token, undefined);
  assert.equal(raw.token, undefined);
  assert.equal((raw.nested as Record<string, unknown>).Cookie, undefined);
  assert.equal((raw.nested as Record<string, unknown>).safe, 'ok', 'non-sensitive keys survive verbatim');
  assert.equal((raw.list as unknown[]).length, 2);
  assert.equal(((raw.list as Record<string, unknown>[])[0] ?? {}).api_key, undefined);
  assert.equal(((raw.list as Record<string, unknown>[])[1] ?? {}).keep, 2);
  assert.ok(String(raw.url).includes('x=1'), 'only the token tail is stripped from the string');
  assert.equal(m.envelope.meta!.platformMsgId, '1');
});

test('notice meta.raw is redacted on the same rules', () => {
  const n: NoticeFrame = {
    ...base,
    t: 'notice',
    kind: 'recall',
    raw: { password: 'p', secret: 's', group_id: 7 },
  };
  const env = noticeToEnvelope(n, { worldId: 'neko' });
  const raw = env.envelope.meta!.raw as Record<string, unknown>;
  assert.equal(raw.password, undefined);
  assert.equal(raw.secret, undefined);
  assert.equal(raw.group_id, 7);
});
