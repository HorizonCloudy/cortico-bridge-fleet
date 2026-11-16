/**
 * driver 环回契约测试：同进程起 dial+listen（蓝图 §5.1「CBP 环回」口径）。
 * 只连 127.0.0.1 随机端口，不碰任何 IM/宿主；对端用测试代码模拟旧桥与 CBP 桥两种形状。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from 'cortico/core/types.ts';
import { BridgeDriver, type DriverHandlers, type Negotiated } from '../src/driver.ts';
import type { MsgFrame, ToolAnn } from '../src/frames.ts';

const log: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, emit() {}, child() { return log; } };

function collect() {
  const ready: Negotiated[] = [];
  const msgs: MsgFrame[] = [];
  const notices: unknown[] = [];
  const events: unknown[] = [];
  const catalogs: ToolAnn[][] = [];
  const states: boolean[] = [];
  const handlers: DriverHandlers = {
    onReady: (n) => ready.push(n),
    onMsg: (m) => msgs.push(m),
    onNotice: (n) => notices.push(n),
    onEvent: (e) => events.push(e),
    onCatalog: (t) => catalogs.push(t),
    onState: (s) => states.push(s),
  };
  return { handlers, ready, msgs, notices, events, catalogs, states };
}

async function withServer(
  onClient: (ws: WebSocket, reply: (obj: unknown) => void) => void,
  run: (url: string) => Promise<void>,
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  server.on('connection', (ws) => onClient(ws, (obj) => ws.send(JSON.stringify(obj))));
  try {
    await run(`ws://127.0.0.1:${port}`);
  } finally {
    for (const c of server.clients) c.terminate();
    await new Promise<void>((r) => {
      server.close(() => r());
    });
  }
}

test('旧桥形态：ready 无 caps → cbp=false、caps 交集空、v 按 1 放行', async () => {
  let helloSeen: Record<string, unknown> | null = null;
  await withServer(
    (ws, reply) => {
      ws.on('message', (raw) => {
        helloSeen = JSON.parse(String(raw));
        // 旧桥 ready（37c1e6ccd bridge.py:272-283）：v 是标量、无 caps、tts 是对象。
        reply({ t: 'ready', channel: 'qq', self: { id: '999', name: 'bot' }, admins: ['111', ' 222 '], tts: { ready: true, provider: 'edge' }, v: 1 });
      });
    },
    async (url) => {
      const c = collect();
      const d = new BridgeDriver(
        { url, token: 'tk', agent: { name: 'w', version: '0.1.0', sha: 'aaaa11111' }, caps: ['msg-v2'], tools: [], reconnectBaseMs: 200, reconnectMaxMs: 1000, log },
        c.handlers,
      );
      await d.start();
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(helloSeen, 'hello 必须发出');
      assert.equal((helloSeen as { t?: string }).t, 'hello');
      assert.equal((helloSeen as { token?: string }).token, 'tk', '旧字段必须并集带上');
      assert.deepEqual((helloSeen as { v_support?: number[] }).v_support, [1]);
      assert.equal(c.ready.length, 1);
      assert.equal(c.ready[0]!.cbp, false);
      assert.equal(c.ready[0]!.version, 1);
      assert.deepEqual(c.ready[0]!.caps, []);
      assert.deepEqual(c.ready[0]!.ownerIds, ['111', '222']);
      assert.deepEqual(c.ready[0]!.tts, { ready: true, provider: 'edge' });
      d.stop();
    },
  );
});

test('旧 msg 帧（dict conv）兼容读成 CBP MsgFrame', async () => {
  await withServer(
    (_ws, reply) => {
      reply({ t: 'ready', v: 1, self: { id: '9' } });
      reply({ t: 'msg', id: 'b1', ts: '2026-11-15T10:00:00Z', conv: { kind: 'group', id: '123' }, sender: { id: '5', name: 'u' }, text: '你好', mentioned: true, images: [{ mime: 'image/png', base64: 'aGk=' }] });
    },
    async (url) => {
      const c = collect();
      const d = new BridgeDriver({ url, token: '', agent: { name: 'w', version: '1', sha: 's' }, caps: [], tools: [], reconnectBaseMs: 200, reconnectMaxMs: 1000, log }, c.handlers);
      await d.start();
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(c.msgs.length, 1);
      assert.equal(c.msgs[0]!.conv, 'aiocqhttp:GroupMessage:123');
      assert.equal(c.msgs[0]!.kind, 'mention');
      assert.equal(c.msgs[0]!.segments[0]!.type, 'text');
      assert.equal(c.msgs[0]!.segments[1]!.type, 'image');
      d.stop();
    },
  );
});

test('CBP 桥形态：ready 带 caps → 交集生效；send 用 CBP 形并由 ack 回执闭环', async () => {
  const inbound: Record<string, unknown>[] = [];
  await withServer(
    (ws, reply) => {
      ws.on('message', (raw) => {
        const f = JSON.parse(String(raw)) as Record<string, unknown>;
        inbound.push(f);
        if (f.t === 'hello') reply({ t: 'ready', v: 1, v_support: [1], caps: ['msg-v2', 'catalog', 'unknown-cap'], self: { id: '9' } });
        if (f.t === 'send') reply({ t: 'reply', rid: f.rid, ok: true });
      });
    },
    async (url) => {
      const c = collect();
      const d = new BridgeDriver({ url, token: '', agent: { name: 'w', version: '1', sha: 's' }, caps: ['msg-v2', 'catalog'], tools: [], reconnectBaseMs: 200, reconnectMaxMs: 1000, log }, c.handlers);
      await d.start();
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(c.ready[0]!.cbp, true);
      assert.deepEqual(c.ready[0]!.caps, ['msg-v2', 'catalog']);
      const res = await d.send('aiocqhttp:GroupMessage:123', 'yo');
      assert.equal(res.ok, true);
      const sendFrame = inbound.at(-1)!;
      assert.equal(sendFrame.t, 'send');
      assert.equal(typeof sendFrame.conv, 'string', 'CBP 形 conv 必须是 UMO 串');
      assert.ok(Array.isArray(sendFrame.segments));
      d.stop();
    },
  );
});

test('版本不相交 → 断连，不产 ready', async () => {
  await withServer(
    (ws, reply) => {
      ws.on('message', (raw) => {
        const f = JSON.parse(String(raw)) as Record<string, unknown>;
        if (f.t === 'hello') reply({ t: 'ready', v_support: [2, 3] });
      });
    },
    async (url) => {
      const c = collect();
      const d = new BridgeDriver({ url, token: '', agent: { name: 'w', version: '1', sha: 's' }, caps: [], tools: [], reconnectBaseMs: 200, reconnectMaxMs: 1000, log }, c.handlers);
      await d.start();
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(c.ready.length, 0);
      assert.ok(c.states.includes(false), '断线状态必须上报');
      d.stop();
    },
  );
});

test('旧桥 tools 帧 items 收敛成 ToolAnn；坏项丢弃', async () => {
  await withServer(
    (_ws, reply) => {
      reply({ t: 'ready', v: 1 });
      reply({ t: 'tools', items: [{ name: 'song', risk: 'write', desc: '点歌' }, { name: '' }, null, { name: 'look', risk: 'read' }] });
    },
    async (url) => {
      const c = collect();
      const d = new BridgeDriver({ url, token: '', agent: { name: 'w', version: '1', sha: 's' }, caps: [], tools: [], reconnectBaseMs: 200, reconnectMaxMs: 1000, log }, c.handlers);
      await d.start();
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(c.catalogs.length, 1);
      assert.deepEqual(c.catalogs[0], [
        { name: 'song', risk: 'write', confirm_required: true, description: '点歌' },
        { name: 'look', risk: 'read', confirm_required: false, description: undefined },
      ]);
      d.stop();
    },
  );
});

test('send 在未连接时不回悬案：直接确定失败', async () => {
  const c = collect();
  const d = new BridgeDriver({ url: 'ws://127.0.0.1:1', token: '', agent: { name: 'w', version: '1', sha: 's' }, caps: [], tools: [], reconnectBaseMs: 200, reconnectMaxMs: 1000, log }, c.handlers);
  const res = await d.send('aiocqhttp:GroupMessage:1', 'x');
  assert.equal(res.ok, false);
  assert.equal(res.uncertain, undefined);
  d.stop();
});
