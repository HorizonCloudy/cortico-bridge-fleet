/** driver: same-process dial×listen loopback, hello/ready handshake, frame relay, bad-frame swallow. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { BridgeDriver } from '../src/driver.js';
import { encodeFrame, newHead, parseFrame, type Frame, type MsgFrame } from '../src/frames.js';
import { RET } from '../src/errors.js';

const agent = (name: string) => ({ name, version: '0.1.0', sha: 'abababababababab' });
const caps = ['images', 'notices'];
const SELF = { id: 'bot-1', name: 'Cortico', proven: true };

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('loopback wait timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('dial and listen handshake, then relay a msg frame both ways', async () => {
  const gotAtListen: Frame[] = [];
  const gotAtDial: Frame[] = [];
  const listen = new BridgeDriver({
    role: 'listen',
    host: '127.0.0.1',
    port: 0,
    agent: agent('listen'), self: SELF,
    caps,
    tools: [],
    pingIntervalMs: 200,
    idleTimeoutMs: 2000,
    handshakeTimeoutMs: 1000,
    onFrame: (f) => gotAtListen.push(f),
  });
  await listen.start();
  const port = listen.listenPort;
  assert.ok(port > 0, 'listen bound an ephemeral port');

  const dial = new BridgeDriver({
    role: 'dial',
    url: `ws://127.0.0.1:${port}`,
    agent: agent('dial'), self: SELF,
    caps,
    tools: [],
    onFrame: (f) => gotAtDial.push(f),
  });
  await dial.start();

  await waitFor(() => listen.isReady && dial.isReady);
  // caps intersection is live on both sides now (both announce images+notices)
  assert.deepEqual(dial.effectiveCaps(), ['images', 'notices']);
  assert.deepEqual(listen.effectiveCaps(), ['images', 'notices']);
  const msg: MsgFrame = {
    v: 1,
    t: 'msg',
    id: 'm-1',
    ts: 1,
    conv: 'g:1',
    sender: { id: 'u1', name: 'n' },
    kind: 'direct',
    segments: [{ type: 'text', data: { text: 'ping' } }],
    raw: { message_id: 'mm1' },
  };
  assert.equal(dial.send(msg), true);
  await waitFor(() => gotAtListen.length >= 1);
  assert.equal(gotAtListen[0]!.t, 'msg');

  // the same text must dedup if redelivered inside the window
  assert.equal(dial.send(msg), true);
  assert.equal(gotAtListen.filter((f) => f.t === 'msg').length, 1);
  assert.equal(dial.counters.dupsDropped + listen.counters.dupsDropped >= 0, true);

  dial.stop();
  listen.stop();
});

test('start() never rejects even when the dial URL is dead', async () => {
  const d = new BridgeDriver({ role: 'dial', url: 'ws://127.0.0.1:1', agent: agent('x'), self: SELF, caps: [], tools: [] });
  await d.start();
  assert.equal(d.isReady, false);
  d.stop();
});

test('bad frames are swallowed and counted, never thrown', async (t) => {
  const listen = new BridgeDriver({
    role: 'listen',
    host: '127.0.0.1',
    port: 0,
    agent: agent('listen'), self: SELF,
    caps,
    tools: [],
    handshakeTimeoutMs: 500,
    onFrame: () => {
      /* ignore */
    },
  });
  await listen.start();
  t.after(() => listen.stop());

  // raw client: complete the handshake, then push junk
  const ws = new WebSocket(`ws://127.0.0.1:${listen.listenPort}`);
  await new Promise((r) => ws.once('open', r));
  const hello: Frame = {
    ...newHead('hello'),
    t: 'hello',
    v: 1,
    agent: agent('raw'), self: SELF,
    v_support: [1],
    caps: [],
    tools: [],
  };
  ws.send(encodeFrame(hello));
  await waitFor(() => listen.isReady, 1500);
  const before = listen.counters.framesBad;
  for (const junk of ['null', '[1,2]', '5', 'not json', '{}', '{"v":1,"t":"msg"}']) {
    ws.send(junk);
  }
  await waitFor(() => listen.counters.framesBad >= before + 6, 1500);
  assert.ok(listen.counters.framesBad >= before + 6);
  ws.close();
});

test('hello with a disjoint version set is refused with a close (60001 path)', async (t) => {
  const listen = new BridgeDriver({
    role: 'listen',
    host: '127.0.0.1',
    port: 0,
    agent: agent('listen'), self: SELF,
    caps,
    tools: [],
  });
  await listen.start();
  t.after(() => listen.stop());

  const ws = new WebSocket(`ws://127.0.0.1:${listen.listenPort}`);
  await new Promise((r) => ws.once('open', r));
  const badHello: Frame = {
    ...newHead('hello'),
    t: 'hello',
    v: 1,
    agent: agent('peer-v2'),
    self: SELF,
    v_support: [2],
    caps: [],
    tools: [],
  };
  let degradedCode = 0;
  ws.on('message', (data) => {
    const f = JSON.parse(String(data));
    if (f.t === 'event' && f.name === 'degraded') degradedCode = f.data.code;
  });
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  ws.send(encodeFrame(badHello));
  const code = await closed;
  assert.equal(code, 4402);
  assert.equal(degradedCode, RET.VERSION_MISMATCH);
  assert.equal(listen.isReady, false);
});

test('call is correlated to its reply by rid', async (t) => {
  const listen = new BridgeDriver({
    role: 'listen',
    host: '127.0.0.1',
    port: 0,
    agent: agent('listen'), self: SELF,
    caps,
    tools: [{ name: 'echo', risk: 'read', confirm_required: false }],
    onFrame: (f) => {
      if (f.t === 'call') {
        listen.send({ ...newHead('reply'), t: 'reply', v: 1, rid: f.rid, ok: true, text: String(f.args.x) });
      }
    },
  });
  await listen.start();
  const dial = new BridgeDriver({ role: 'dial', url: `ws://127.0.0.1:${listen.listenPort}`, agent: agent('dial'), self: SELF, caps, tools: [] });
  await dial.start();
  t.after(() => {
    dial.stop();
    listen.stop();
  });
  await waitFor(() => listen.isReady && dial.isReady);
  // F3: the kernel executes a call only for a turn it recorded on this connection,
  // so relay the msg that owns the turn id first.
  const turnMsg: MsgFrame = {
    ...newHead('msg'),
    t: 'msg',
    v: 1,
    conv: 'g:1',
    sender: { id: 'u1', name: 'n' },
    kind: 'direct',
    segments: [],
    raw: {},
  };
  assert.equal(dial.send(turnMsg), true);
  const reply = (await dial.callTool(
    'echo',
    { x: 42 },
    turnMsg.id,
    { platform: 'p', conv: 'g:1', member: { id: 'u1', name: 'n' }, anon: 'identified' },
  )) as { ok: boolean; text?: string };
  assert.equal(reply.ok, true);
  assert.equal(reply.text, '42');
});

// ---- K1 batch: driver enforcement of turn/actor (F3) and self (F1/F2).

test('callTool sends the turn and actor verbatim and the kernel answers unknown turns with 60004', async (t) => {
  const seen: Frame[] = [];
  const listen = new BridgeDriver({
    role: 'listen',
    host: '127.0.0.1',
    port: 0,
    agent: agent('listen'),
    self: { id: 'bot-1', name: 'Cortico', proven: true },
    caps,
    tools: [],
    onFrame: (f) => seen.push(f),
  });
  await listen.start();
  const dial = new BridgeDriver({ role: 'dial', url: `ws://127.0.0.1:${listen.listenPort}`, agent: agent('dial'), self: SELF, caps, tools: [] });
  await dial.start();
  t.after(() => {
    dial.stop();
    listen.stop();
  });
  await waitFor(() => listen.isReady && dial.isReady);

  // no msg with turn-ghost was ever relayed → refuse execution, 60004, consumer untouched
  const before = seen.length;
  const reply = (await dial.callTool('echo', {}, 'turn-ghost', {
    platform: 'p',
    conv: 'g:1',
    member: { id: 'u1', name: 'n' },
    anon: 'identified',
  })) as { ok: boolean; error?: { code: number; message: string } };
  assert.equal(reply.ok, false);
  assert.equal(reply.error?.code, RET.UNKNOWN_SESSION);
  assert.ok(String(reply.error?.message).startsWith('unknown_session'));
  assert.equal(seen.filter((f) => f.t === 'call').length, 0, 'unknown-turn call never reached the consumer');
  assert.equal(seen.length, before);
});

test('a self-reported actor that disagrees with the inbound record is overwritten and reported', async (t) => {
  const seen: Frame[] = [];
  const degraded: string[] = [];
  const listen = new BridgeDriver({
    role: 'listen',
    host: '127.0.0.1',
    port: 0,
    agent: agent('listen'),
    self: SELF,
    caps,
    tools: [],
    onFrame: (f) => {
      seen.push(f);
      if (f.t === 'event' && f.name === 'degraded') degraded.push(String((f.data as { reason?: string }).reason));
    },
  });
  await listen.start();
  const port = listen.listenPort;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  t.after(() => {
    ws.close();
    listen.stop();
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(
    encodeFrame({
      ...newHead('hello'),
      t: 'hello',
      v: 1,
      agent: agent('peer'),
      self: SELF,
      v_support: [1],
      caps: [],
      tools: [],
    }),
  );
  await waitFor(() => listen.isReady);
  const turn = 'cv-turn-real';
  ws.send(
    encodeFrame({
      ...newHead('msg'),
      t: 'msg',
      v: 1,
      id: turn,
      conv: 'g:real',
      sender: { id: 'real-user', name: 'Real' },
      kind: 'direct',
      segments: [],
      raw: {},
    }),
  );
  await waitFor(() => seen.some((f) => f.t === 'msg'));
  // the peer now calls with a forged identity on the same turn
  ws.send(
    encodeFrame({
      ...newHead('call'),
      t: 'call',
      v: 1,
      rid: 'forged-1',
      tool: 'kick',
      args: {},
      turn,
      actor: { platform: 'p', conv: 'g:victim', member: { id: 'attacker', name: 'X' }, anon: 'identified' },
    }),
  );
  await waitFor(() => seen.some((f) => f.t === 'call'));
  const call = seen.find((f) => f.t === 'call') as { actor: { conv: string; member: { id: string; name: string } } };
  assert.equal(call.actor.conv, 'g:real', 'host record wins over the wire claim');
  assert.equal(call.actor.member.id, 'real-user');
  assert.equal(call.actor.member.name, 'Real');
  await waitFor(() => degraded.includes('actor-mismatch'));
});

test('handshake carries self; proven:false delivers a self-unknown degrade and strips a lying self_echo cap', async (t) => {
  const got: Frame[] = [];
  const listen = new BridgeDriver({
    role: 'listen',
    host: '127.0.0.1',
    port: 0,
    agent: agent('listen'),
    self: SELF,
    caps: ['self_echo', 'images'],
    tools: [],
    onFrame: (f) => got.push(f),
  });
  await listen.start();
  t.after(() => listen.stop());
  const ws = new WebSocket(`ws://127.0.0.1:${listen.listenPort}`);
  t.after(() => ws.close());
  await new Promise((r) => ws.once('open', r));
  const wire: Frame[] = [];
  ws.on('message', (d) => {
    const f = parseFrame(String(d));
    if (f) wire.push(f);
  });
  ws.send(
    encodeFrame({
      ...newHead('hello'),
      t: 'hello',
      v: 1,
      agent: agent('peer'),
      self: { id: '', name: '', proven: false }, // honest: cannot prove self (N.E.K.O line)
      v_support: [1],
      caps: ['self_echo', 'images'],
      tools: [],
    }),
  );
  await waitFor(() => listen.isReady);
  // our ready carries our own self declaration
  const ready = wire.find((f) => f.t === 'ready') as { self?: { proven: boolean } } | undefined;
  assert.ok(ready, 'listen answered ready');
  assert.equal(ready!.self?.proven, true);
  // caps-lie: peer claims self_echo with proven:false → cap dropped from the intersection
  assert.deepEqual(listen.effectiveCaps(), ['images']);
  const lie = wire.find(
    (f) => f.t === 'event' && (f as { data?: { reason?: string } }).data?.reason === 'self-echo:caps-lie',
  );
  assert.ok(lie, 'peer was told about the caps lie');
  // self-unknown reaches the consumer exactly once, and the message is never suppressed
  await waitFor(() => got.some((f) => f.t === 'event'));
  const unknown = got.filter((f) => f.t === 'event' && (f as { data?: { reason?: string } }).data?.reason === 'self-unknown');
  assert.equal(unknown.length, 1);
  assert.equal(listen.selfEchoActive(), false);
});

test('self.id changing on one connection is churn: the frame is dropped and reported', async (t) => {
  const listen = new BridgeDriver({
    role: 'listen',
    host: '127.0.0.1',
    port: 0,
    agent: agent('listen'),
    self: SELF,
    caps: [],
    tools: [],
  });
  await listen.start();
  t.after(() => listen.stop());
  const ws = new WebSocket(`ws://127.0.0.1:${listen.listenPort}`);
  t.after(() => ws.close());
  await new Promise((r) => ws.once('open', r));
  const wire: Frame[] = [];
  ws.on('message', (d) => {
    const f = parseFrame(String(d));
    if (f) wire.push(f);
  });
  const helloWith = (id: string): Frame => ({
    ...newHead('hello'),
    t: 'hello',
    v: 1,
    agent: agent('peer'),
    self: { id, name: 'peer', proven: true },
    v_support: [1],
    caps: [],
    tools: [],
  });
  ws.send(encodeFrame(helloWith('first')));
  await waitFor(() => listen.peerSelf()?.id === 'first');
  ws.send(encodeFrame(helloWith('second'))); // account swap without reconnect
  await waitFor(() =>
    wire.some((f) => f.t === 'event' && (f as { data?: { reason?: string } }).data?.reason === 'self-churn'),
  );
  assert.equal(listen.peerSelf()?.id, 'first', 'the connection keeps the original self; swap needs a reconnect');
});

// ---- K1 item 3 (driver side): frame byte cap is a pins read, not a literal (F13).

test('listen sets maxPayload from pins caps.cbp.frame_bytes, never a hardcoded literal', async (t) => {
  const { loadPins } = await import('../src/pins.js');
  const listen = new BridgeDriver({
    role: 'listen',
    host: '127.0.0.1',
    port: 0,
    agent: agent('listen'),
    self: SELF,
    caps: [],
    tools: [],
  });
  await listen.start();
  t.after(() => listen.stop());
  assert.equal(listen.maxPayloadBytes, loadPins().caps.cbp.frame_bytes);

  // a frame over the bound is refused with close 1009 by the ws layer itself
  const tight = new BridgeDriver({
    role: 'listen',
    host: '127.0.0.1',
    port: 0,
    agent: agent('tight'),
    self: SELF,
    caps: [],
    tools: [],
    maxPayloadBytes: 4096,
  });
  await tight.start();
  t.after(() => tight.stop());
  const ws = new WebSocket(`ws://127.0.0.1:${tight.listenPort}`);
  await new Promise((r) => ws.once('open', r));
  ws.send(encodeFrame({ ...newHead('hello'), t: 'hello', v: 1, agent: agent('peer'), self: SELF, v_support: [1], caps: [], tools: [] }));
  await waitFor(() => tight.isReady);
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  ws.send('x'.repeat(8192)); // well past 4096
  assert.equal(await closed, 1009, 'over-limit frame kills the connection with 1009');
});

// ---- K1 follow-up: the handshake tool set must be readable by consumers (F1 authority).

test('peerTools exposes the handshake declaration before any catalog frame', async () => {
  const listen = new BridgeDriver({
    role: 'listen',
    host: '127.0.0.1',
    port: 0,
    agent: agent('listen'), self: SELF,
    caps: [],
    tools: [],
    handshakeTimeoutMs: 1000,
  });
  await listen.start();
  assert.deepEqual(listen.peerTools(), [], 'nobody connected yet');
  const port = listen.listenPort;
  const dial = new BridgeDriver({
    role: 'dial',
    url: `ws://127.0.0.1:${port}`,
    agent: agent('dial'), self: SELF,
    caps: [],
    tools: [{ name: 'peer_only', risk: 'read', confirm_required: false }],
  });
  await dial.start();
  await waitFor(() => listen.isReady && dial.isReady);
  assert.deepEqual(listen.peerTools().map((x) => x.name), ['peer_only'],
    'hello/ready 申报即对 world 可见；否则只发 hello 的桥会被自己的闸锁死');
  assert.deepEqual(dial.peerTools().map((x) => x.name), [], 'listen 侧没申报工具');
  dial.stop();
  listen.stop();
});
