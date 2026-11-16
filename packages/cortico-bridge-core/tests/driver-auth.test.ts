/**
 * SECURITY-CBP §3 / CHANGELOG F4, transport credentials: shared secret rides the HTTP
 * Upgrade header `Authorization: Bearer <token>` only; any `token`/`access_token` URL
 * query is refused with close 4401 and logged by key name only; non-loopback bind needs
 * a token; no credential value ever reaches log() or onState.lastError.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { BridgeDriver, type DriverState } from '../src/driver.js';
import { encodeFrame, newHead, type Frame } from '../src/frames.js';

const agent = (name: string) => ({ name, version: '0.1.0', sha: 'abababababababab' });
const SELF = { id: 'bot-1', name: 'Cortico', proven: true };

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

function closedCode(ws: WebSocket, ms = 2000): Promise<number> {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('socket stayed open, no close inside window')), ms);
    ws.once('close', (code) => {
      clearTimeout(to);
      resolve(code);
    });
  });
}

test('?token= query is refused with close 4401 and logged by key name only', async (t) => {
  const secret = 'sekrit-' + Math.random().toString(36).slice(2);
  const lines: string[] = [];
  const listen = new BridgeDriver({
    role: 'listen',
    host: '127.0.0.1',
    port: 0,
    agent: agent('listen'), self: SELF,
    caps: [],
    tools: [],
    authToken: secret,
    log: (m, e) => lines.push(`${m}|${JSON.stringify(e ?? null)}`),
  });
  await listen.start();
  t.after(() => listen.stop());

  const ws = new WebSocket(`ws://127.0.0.1:${listen.listenPort}/?token=${secret}`);
  assert.equal(await closedCode(ws), 4401);
  assert.equal(listen.isReady, false);
  // §3.1: refused before any comparison — a valid header alongside the query still dies.
  const sneaky = new WebSocket(`ws://127.0.0.1:${listen.listenPort}/?token=${secret}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(await closedCode(sneaky), 4401);
  assert.ok(lines.some((l) => l.startsWith('query-token-refused')), 'driver must log query-token-refused');
  assert.ok(!lines.join('|').includes(secret), 'the log line carries the key name, never the value');
});

test('Authorization: Bearer completes the handshake; missing or wrong header gets 4401', async (t) => {
  const secret = 'sekrit-' + Math.random().toString(36).slice(2);
  const listen = new BridgeDriver({
    role: 'listen',
    host: '127.0.0.1',
    port: 0,
    agent: agent('listen'), self: SELF,
    caps: [],
    tools: [],
    authToken: secret,
  });
  await listen.start();
  t.after(() => listen.stop());
  const url = `ws://127.0.0.1:${listen.listenPort}`;

  const hello: Frame = {
    ...newHead('hello'),
    t: 'hello',
    v: 1,
    agent: agent('peer'), self: SELF,
    v_support: [1],
    caps: [],
    tools: [],
  };
  const ok = new WebSocket(url, { headers: { authorization: `Bearer ${secret}` } });
  await new Promise((r) => ok.once('open', r));
  ok.send(encodeFrame(hello));
  await waitFor(() => listen.isReady);
  ok.close();
  await waitFor(() => !listen.isReady);

  const missing = new WebSocket(url);
  assert.equal(await closedCode(missing), 4401);
  const wrong = new WebSocket(url, { headers: { authorization: 'Bearer nope' } });
  assert.equal(await closedCode(wrong), 4401);
});

test('a dial-role driver authenticates with the header, not the URL', async (t) => {
  const secret = 'sekrit-' + Math.random().toString(36).slice(2);
  const listen = new BridgeDriver({
    role: 'listen',
    host: '127.0.0.1',
    port: 0,
    agent: agent('listen'), self: SELF,
    caps: [],
    tools: [],
    authToken: secret,
  });
  await listen.start();
  const dial = new BridgeDriver({
    role: 'dial',
    url: `ws://127.0.0.1:${listen.listenPort}`,
    agent: agent('dial'), self: SELF,
    caps: [],
    tools: [],
    authToken: secret,
  });
  await dial.start();
  t.after(() => {
    dial.stop();
    listen.stop();
  });
  await waitFor(() => listen.isReady && dial.isReady);
});

test('non-loopback bind without a token is refused: door_closed', async (t) => {
  const states: DriverState[] = [];
  const listen = new BridgeDriver({
    role: 'listen',
    host: '0.0.0.0',
    port: 0,
    agent: agent('listen'), self: SELF,
    caps: [],
    tools: [],
    onState: (s) => states.push(s),
  });
  await listen.start();
  t.after(() => listen.stop());
  assert.equal(listen.listenPort, 0, 'no bind may happen');
  assert.equal(listen.counters.listenErrors, 1);
  assert.ok(states.some((s) => s.lastError === 'door_closed: loopback required'));
});

test('non-loopback bind with a token is allowed', async (t) => {
  const listen = new BridgeDriver({
    role: 'listen',
    host: '0.0.0.0',
    port: 0,
    agent: agent('listen'), self: SELF,
    caps: [],
    tools: [],
    authToken: 'a-real-secret',
  });
  await listen.start();
  t.after(() => listen.stop());
  assert.ok(listen.listenPort > 0, 'bind succeeds when a token guards the door');
  assert.equal(listen.counters.listenErrors, 0);
});

test('no credential value ever reaches onState.lastError or log()', async (t) => {
  const secret = 'sekret-' + Math.random().toString(36).slice(2);
  const captured: string[] = [];
  const record = (s?: string) => {
    if (s !== undefined) captured.push(s);
  };
  const logSink = (m: string, e?: Record<string, unknown>) => record(`${m}|${JSON.stringify(e ?? null)}`);
  // door_closed path (public bind, refused)
  const listen = new BridgeDriver({
    role: 'listen', host: '0.0.0.0', port: 0, agent: agent('listen'), self: SELF, caps: [], tools: [],
    onState: (s) => record(s.lastError), log: logSink,
  });
  await listen.start();
  // query-token refusal path
  const listen2 = new BridgeDriver({
    role: 'listen', host: '127.0.0.1', port: 0, agent: agent('listen'), self: SELF, caps: [], tools: [], authToken: secret,
    onState: (s) => record(s.lastError), log: logSink,
  });
  await listen2.start();
  const ws = new WebSocket(`ws://127.0.0.1:${listen2.listenPort}/?token=${secret}`);
  await closedCode(ws).catch(() => {
    /* refused or not — the capture assertions below run either way */
  });
  // dial error path against a url that carries the secret in its query
  const dial = new BridgeDriver({
    role: 'dial', url: `ws://127.0.0.1:1/?token=${secret}`, agent: agent('dial'), self: SELF, caps: [], tools: [],
    onState: (s) => record(s.lastError), log: logSink,
  });
  await dial.start();
  await new Promise((r) => setTimeout(r, 300));
  t.after(() => {
    listen.stop();
    listen2.stop();
    dial.stop();
  });
  const blob = captured.join('|');
  assert.ok(!blob.includes(secret), `credential value leaked into driver output: ${blob}`);
  for (const s of captured) {
    assert.ok(!/[?&](?:access_)?token=(?!<redacted>)[^\s&"]/.test(s), `unredacted token tail: ${s}`);
  }
});
