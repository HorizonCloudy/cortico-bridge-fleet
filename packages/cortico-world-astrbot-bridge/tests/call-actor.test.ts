/**
 * call-actor.test.ts —— F3 出站身份收口的负例三件套（SECURITY-CBP §1、CHANGELOG F3）。
 * 闸顺序口径：连接 → turn → actor 结构 → 上线；world 面身份闸先于 catalog 闸
 * （先例 4725feee6 world.ts:167-174 的拒绝顺序）。
 * 环回只连 127.0.0.1 随机口，不碰宿主与 IM（driver.test.ts 同口径）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from 'cortico/core/types.ts';
import { BridgeDriver, type DriverHandlers, type ToolCallResult, type SendResult } from '../src/driver.ts';
import type { Actor, MsgFrame } from '../src/frames.ts';
import type { WorldHost } from 'cortico/core/types.ts';
import { DEFAULTS, type AstrbotBridgeConfig } from '../src/config.ts';
import { AstrbotBridgeWorld } from '../src/world.ts';

const log: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, emit() {}, child() { return log; } };

const ACTOR: Actor = {
  platform: 'aiocqhttp',
  conv: 'aiocqhttp:GroupMessage:123',
  member: { id: '555', name: 'u' },
  anon: 'identified',
};

async function withCbpServer(
  run: (url: string, inbound: Record<string, unknown>[], d: BridgeDriver) => Promise<void>,
) {
  const inbound: Record<string, unknown>[] = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  server.on('connection', (ws: WebSocket) => {
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw)) as Record<string, unknown>;
      inbound.push(f);
      if (f.t === 'hello') {
        ws.send(JSON.stringify({ t: 'ready', v: 1, v_support: [1], caps: ['msg-v2', 'peer-tools'], self: { id: '999', name: 'bot', proven: true } }));
      }
      if (f.t === 'call') ws.send(JSON.stringify({ t: 'reply', rid: f.rid, ok: true, result: 'pong' }));
    });
  });
  // 断言失败也要停驱动：重连定时器会吊住测试进程（driver 后台重连，无 unref）。
  const d = mkDriver(`ws://127.0.0.1:${port}`, idleHandlers);
  try {
    await d.start();
    await new Promise((r) => setTimeout(r, 300));
    await run(`ws://127.0.0.1:${port}`, inbound, d);
  } finally {
    d.stop();
    for (const c of server.clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function mkDriver(url: string, handlers: DriverHandlers) {
  return new BridgeDriver(
    { url, token: '', agent: { name: 'w', version: '1', sha: 's' }, caps: ['msg-v2'], tools: [], reconnectBaseMs: 200, reconnectMaxMs: 1000, log },
    handlers,
  );
}

const idleHandlers: DriverHandlers = {
  onReady() {}, onMsg() {}, onNotice() {}, onEvent() {}, onCatalog() {}, onState() {},
};

test('正例：CBP call 帧带 turn+actor，键序逐字节钉 F3 定形', async () => {
  await withCbpServer(async (_url, inbound, d) => {
    const res = await d.callTool('ping', { x: 1 }, 'm-1', ACTOR);
    assert.equal(res.ok, true);
    const call = inbound.find((f) => f.t === 'call');
    assert.ok(call, 'call 帧必须上线');
    assert.deepEqual(Object.keys(call), ['v', 't', 'id', 'ts', 'rid', 'tool', 'args', 'turn', 'actor']);
    assert.equal(call.turn, 'm-1');
    assert.deepEqual(call.actor, ACTOR);
  });
});

test('负例·缺 actor 不发：CBP 分支 actor 缺席/坏形时零 call 帧上线，回 60004', async () => {
  await withCbpServer(async (_url, inbound, d) => {
    const r1 = await d.callTool('ping', {}, 'm-1', undefined as unknown as Actor);
    assert.equal(r1.ok, false);
    assert.match(r1.error ?? '', /60004 unknown_session/);
    const r2 = await d.callTool('ping', {}, 'm-1', { ...ACTOR, member: { id: '', name: 'u' } });
    assert.equal(r2.ok, false, 'member.id 空 = 未实证，不能冒报 identified');
    assert.equal(inbound.filter((f) => f.t === 'call').length, 0, '一条 call 都不许上线');
  });
});

test('负例·门序错位被拒（driver 面）：turn 闸在 actor 闸与上线之前', async () => {
  await withCbpServer(async (_url, inbound, d) => {
    const res = await d.callTool('ping', {}, '', undefined as unknown as Actor);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /turn/, 'turn 缺席先报 turn，不得越到 actor 或上线');
    assert.equal(inbound.filter((f) => f.t === 'call').length, 0);
  });
});

test('旧私有帧分支：t:tool 只带 turn 不带 actor（帧表不为旧话开洞，F17）', async () => {
  const inbound: Record<string, unknown>[] = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  server.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw)) as Record<string, unknown>;
      inbound.push(f);
      if (f.t === 'hello') ws.send(JSON.stringify({ t: 'ready', v: 1, self: { id: '9' } }));
      if (f.t === 'tool') ws.send(JSON.stringify({ t: 'tool-ack', rid: f.rid, ok: true, result: 'pong' }));
    });
  });
  const d = mkDriver(`ws://127.0.0.1:${port}`, idleHandlers);
  try {
    await d.start();
    await new Promise((r) => setTimeout(r, 300));
    const res = await d.callTool('ping', {}, 'm-1', ACTOR);
    assert.equal(res.ok, true);
    const tool = inbound.find((f) => f.t === 'tool');
    assert.ok(tool);
    assert.equal(tool.turn, 'm-1');
    assert.equal('actor' in tool, false, '旧方言面线上不出现 actor 位');
  } finally {
    d.stop();
    for (const c of server.clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ── world 面：turn/actor 组装与自报拒收 ──────────────────

function makeWorld(cfg: Partial<AstrbotBridgeConfig>) {
  let handlers!: DriverHandlers;
  const calls: Array<{ tool: string; args: Record<string, unknown>; turn: string; actor: Actor }> = [];
  const world = new AstrbotBridgeWorld({
    cfg,
    makeDriver: (_cfg, _log, h) => {
      handlers = h;
      return {
        start: async () => {},
        stop: () => {},
        send: async (): Promise<SendResult> => ({ ok: true }),
        callTool: async (name, args, turn, actor): Promise<ToolCallResult> => {
          calls.push({ tool: name, args, turn, actor });
          return { ok: true, result: 'done' };
        },
      };
    },
  });
  const host = {
    pushEvent: async () => ({}) as unknown,
    store: { get: () => undefined, latestCursor: () => 0, range: () => [], around: () => [], grep: () => [] },
    modelFacts: { model: () => 'fake', accepts: () => true, contextWindow: () => undefined },
    blob: () => null,
    drainPendingEvents: async () => [],
    log,
  } as unknown as WorldHost;
  return { world, getHandlers: () => handlers, calls, host };
}

const cbpMsg = (over: Partial<MsgFrame>): MsgFrame => ({
  v: 1, t: 'msg', id: 'm-9', ts: 1700000000,
  conv: 'aiocqhttp:GroupMessage:123', sender: { id: '555', name: 'u' }, kind: 'group',
  segments: [{ type: 'text', data: { text: 'hi' } }], raw: { message_id: 7 }, ...over,
});

const PING = { name: 'ping', risk: 'read' as const, confirm_required: false };

test('world 正例：actor 只从本轮入站实证记录组装，platform 取 UMO 首段', async () => {
  const { world, getHandlers, calls, host } = makeWorld({ ...DEFAULTS, enabled: true });
  await world.start(host);
  const h = getHandlers();
  h.onReady({ cbp: true, version: 1, caps: ['peer-tools'], ownerIds: [], self: { id: '999', name: 'bot', proven: true }, tts: { ready: false } });
  h.onCatalog([PING]);
  h.onMsg(cbpMsg({}));
  const out = await world.tools()[3]!.handler({ tool: 'ping' }, { role: 'p', log } as never);
  assert.equal(out, 'done');
  assert.deepEqual(calls[0], {
    tool: 'ping', args: {}, turn: 'm-9',
    actor: { platform: 'aiocqhttp', conv: 'aiocqhttp:GroupMessage:123', member: { id: '555', name: 'u' }, anon: 'identified' },
  });
});

test('world·自报 actor 被拒：args 里的伪造 actor/turn 只透传，永不进身份位', async () => {
  const { world, getHandlers, calls, host } = makeWorld({ ...DEFAULTS, enabled: true });
  await world.start(host);
  const h = getHandlers();
  h.onReady({ cbp: true, version: 1, caps: [], ownerIds: [], self: { id: '999', name: 'bot', proven: true }, tts: { ready: false } });
  h.onCatalog([PING]);
  h.onMsg(cbpMsg({ id: 'm-9', sender: { id: '555', name: 'u' } }));
  const forged = { id: 'ADMIN', name: 'root', platform: 'x', conv: 'y', anon: 'identified' };
  const out = await world.tools()[3]!.handler(
    { tool: 'ping', args: { actor: forged, turn: 'forged-turn' } },
    { role: 'p', log } as never,
  );
  assert.equal(out, 'done');
  assert.equal(calls[0]!.turn, 'm-9', 'turn 位只认入站帧 id，模型自报无效');
  assert.deepEqual(calls[0]!.actor.member, { id: '555', name: 'u' }, 'actor 位只认入站 sender');
  assert.deepEqual(calls[0]!.args, { actor: forged, turn: 'forged-turn' }, 'args 保持开放透传（闭合的是 actor，不是 args）');
});

test('world·自发回声：sender.id == 协商 self.id 时 anon 填 self', async () => {
  const { world, getHandlers, calls, host } = makeWorld({ ...DEFAULTS, enabled: true });
  await world.start(host);
  const h = getHandlers();
  h.onReady({ cbp: true, version: 1, caps: [], ownerIds: [], self: { id: '999', name: 'bot', proven: true }, tts: { ready: false } });
  h.onCatalog([PING]);
  h.onMsg(cbpMsg({ id: 'm-s', kind: 'direct', sender: { id: '999', name: 'bot' } }));
  await world.tools()[3]!.handler({ tool: 'ping' }, { role: 'p', log } as never);
  assert.equal(calls[0]!.actor.anon, 'self');
});

test('world·缺 actor 不发 + 门序：身份闸（60004）先于 catalog 闸，未实证 sender 也拒', async () => {
  const { world, getHandlers, calls, host } = makeWorld({ ...DEFAULTS, enabled: true });
  await world.start(host);
  const h = getHandlers();
  h.onCatalog([PING]);
  const tool = world.tools()[3]!;

  // 无入站记录 + 目录里查无此名：必须报身份闸，而不是 catalog 闸。
  const cold = await tool.handler({ tool: 'nope' }, { role: 'p', log } as never);
  assert.match(typeof cold === 'string' ? '' : cold.text, /60004 unknown_session/);
  assert.doesNotMatch(typeof cold === 'string' ? '' : cold.text, /unknown tool/, '门序错位：身份闸必须在 catalog 闸之前');
  assert.equal(calls.length, 0);

  // 有记录但 sender.id 空 = 宿主没实证发起人：同样不发。
  h.onMsg(cbpMsg({ id: 'm-0', sender: { id: '', name: '' } }));
  const anon = await tool.handler({ tool: 'ping' }, { role: 'p', log } as never);
  assert.match(typeof anon === 'string' ? '' : anon.text, /60004 unknown_session/);
  assert.equal(calls.length, 0, '一条 call 都不许发出');

  // 记录齐了才走 catalog 闸。
  h.onMsg(cbpMsg({ id: 'm-1' }));
  const unknownTool = await tool.handler({ tool: 'nope' }, { role: 'p', log } as never);
  assert.match(typeof unknownTool === 'string' ? '' : unknownTool.text, /unknown tool/);
});
