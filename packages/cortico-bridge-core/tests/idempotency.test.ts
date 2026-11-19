/**
 * SECURITY-CBP §5.1 / CHANGELOG F11: the outbound idempotency key is `call.rid`. A
 * redelivered call is answered from the rid→reply cache and the consumer side effect
 * runs exactly once (prior-art window bridge.py:65-66 @37c1e6ccd: TTL 300s, cap 200).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeDriver } from '../src/driver.js';
import { newHead, type Frame } from '../src/frames.js';

const agent = (name: string) => ({ name, version: '0.1.0', sha: 'abababababababab' });
const SELF = { id: 'bot-1', name: 'Cortico', proven: true };
const TEST_SECRET = 'test-bridge-secret';

function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) resolve();
      else if (Date.now() - t0 > ms) reject(new Error('wait timed out'));
      else setTimeout(tick, 10);
    };
    tick();
  });
}

test('same rid redelivered: the consumer runs once, the cache answers the second time', async (t) => {
  const calls: string[] = [];
  const replies: string[] = [];
  let msgSeen = false;
  const listen = new BridgeDriver({ authToken: TEST_SECRET,
    role: 'listen',
    host: '127.0.0.1',
    port: 0,
    agent: agent('listen'), self: SELF,
    caps: [],
    tools: [],
    onFrame: (f) => {
      if (f.t === 'msg') msgSeen = true;
      if (f.t === 'call') {
        calls.push(f.rid);
        listen.send({ ...newHead('reply'), t: 'reply', v: 1, rid: f.rid, ok: true, text: 'once' });
      }
    },
  });
  await listen.start();
  const dial = new BridgeDriver({ authToken: TEST_SECRET,
    role: 'dial',
    url: `ws://127.0.0.1:${listen.listenPort}`,
    agent: agent('dial'), self: SELF,
    caps: [],
    tools: [],
    onFrame: (f) => {
      if (f.t === 'reply') replies.push(`${f.rid}:${f.text}`);
    },
  });
  await dial.start();
  t.after(() => {
    dial.stop();
    listen.stop();
  });
  await waitFor(() => listen.isReady && dial.isReady);

  // F3: a call only executes against a turn the kernel saw on this connection, so the
  // redelivery test first relays the msg that owns the id.
  const turnMsg: Frame = {
    ...newHead('msg'),
    t: 'msg',
    v: 1,
    conv: 'c1',
    sender: { id: 'u1', name: 'n' },
    kind: 'direct',
    segments: [],
    raw: {},
  };
  assert.equal(dial.send(turnMsg), true);
  await waitFor(() => msgSeen, 500);
  const call: Frame = {
    ...newHead('call'),
    t: 'call',
    v: 1,
    rid: 'idem-1',
    tool: 'echo',
    args: {},
    turn: (turnMsg as { id: string }).id,
    actor: { platform: 'p', conv: 'c1', member: { id: 'u1', name: 'n' }, anon: 'identified' },
  };
  assert.equal(dial.send(call), true);
  await waitFor(() => replies.length >= 1);
  assert.equal(dial.send(call), true);
  await waitFor(() => replies.length >= 2);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(calls.length, 1, 'consumer side effect ran once');
  assert.equal(replies.length, 2);
  assert.deepEqual(replies, ['idem-1:once', 'idem-1:once']);
});
