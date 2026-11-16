import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope, Logger, WorldHost } from 'cortico/core/types.ts';
import { ASTRBOT_BRIDGE, BRIDGE_DESCRIBE } from '../src/definition.ts';
import type { DriverHandlers, SendResult, ToolCallResult } from '../src/driver.ts';
import type { MsgFrame, ToolAnn } from '../src/frames.ts';
import { DEFAULTS, type AstrbotBridgeConfig } from '../src/config.ts';
import { AstrbotBridgeWorld } from '../src/world.ts';

const log: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, emit() {}, child() { return log; } };
type PushIn = Parameters<WorldHost['pushEvent']>[0];
type Recorded = { e: PushIn; opts?: Parameters<WorldHost['pushEvent']>[1] };

function fakeHost() {
  const events: Recorded[] = [];
  const host: WorldHost = {
    pushEvent: async (e: PushIn, opts?: Recorded['opts']) => {
      events.push({ e, opts });
      return { cursor: events.length, origin: e.origin ?? 'external', ...e } as unknown as EventEnvelope;
    },
    store: { get: () => undefined, latestCursor: () => 0, range: () => [], around: () => [], grep: () => [] },
    modelFacts: { model: () => 'fake', accepts: (m: string) => m === 'image/png', contextWindow: () => undefined },
    blob: () => null,
    drainPendingEvents: async () => [],
    log,
  } as unknown as WorldHost;
  return { host, events };
}

function makeWorld(cfg: Partial<AstrbotBridgeConfig>, behavior?: { send?: (c: string, t: string) => Promise<SendResult> }) {
  let handlers!: DriverHandlers;
  const sent: Array<{ conv: string; text: string }> = [];
  const calls: Array<{ tool: string; turn: string }> = [];
  const world = new AstrbotBridgeWorld({
    cfg,
    makeDriver: (_cfg, _log, h) => {
      handlers = h;
      return {
        start: async () => {},
        stop: () => {},
        send: async (conv, text) => {
          sent.push({ conv, text });
          return behavior?.send ? behavior.send(conv, text) : { ok: true };
        },
        callTool: async (name, _args, turn) => {
          calls.push({ tool: name, turn });
          return { ok: true, result: 'done' } satisfies ToolCallResult;
        },
      };
    },
  });
  return { world, getHandlers: () => handlers, sent, calls };
}

const cbpMsg = (over: Partial<MsgFrame>): MsgFrame => ({
  v: 1, t: 'msg', id: 'm-1', ts: 1700000000,
  conv: 'aiocqhttp:GroupMessage:123', sender: { id: '555', name: 'u' }, kind: 'group',
  segments: [{ type: 'text', data: { text: 'hi' } }], raw: { message_id: 7 }, ...over,
});

test('入口形状过 isWorldDefinition 四件；defaults().enabled=false 且每次新对象', () => {
  const d = ASTRBOT_BRIDGE;
  assert.equal(typeof d.id, 'string');
  assert.ok(d.id !== '');
  assert.equal(typeof d.label, 'string');
  assert.equal(typeof d.defaults, 'function');
  assert.equal(typeof d.create, 'function');
  assert.equal(d.defaults().enabled, false);
  assert.notEqual(d.defaults(), d.defaults());
});

test('describe.json 与 definition.describe 逐字段相等；liveTools 缺省配置对表', () => {
  const written = JSON.parse(readFileSync(fileURLToPath(new URL('../describe.json', import.meta.url)), 'utf8'));
  assert.deepEqual(written.tools, BRIDGE_DESCRIBE.tools);
  assert.deepEqual(written.events, BRIDGE_DESCRIBE.events);
  const { world } = makeWorld(DEFAULTS);
  const declared = new Map(BRIDGE_DESCRIBE.tools.map((t) => [t.name, t] as const));
  for (const t of world.tools()) {
    const decl = declared.get(t.name);
    assert.ok(decl, `tools() 出现未声明名：${t.name}`);
    assert.equal(t.description, decl.description);
    assert.deepEqual(t.parameters, decl.parameters);
  }
});

test('档位落地：mention→flush、group→缺省（不传 trigger）、self→deliver:false', async () => {
  const { world, getHandlers } = makeWorld({ ...DEFAULTS, enabled: true });
  const { host, events } = fakeHost();
  await world.start(host);
  const h = getHandlers();
  h.onReady({ cbp: true, version: 1, caps: ['msg-v2'], ownerIds: [], self: { id: '999', name: 'bot' }, tts: { ready: false } });
  h.onMsg(cbpMsg({ kind: 'mention' }));
  h.onMsg(cbpMsg({ id: 'm-2', kind: 'group' }));
  h.onMsg(cbpMsg({ id: 'm-3', kind: 'direct', sender: { id: '999', name: 'bot' } }));
  const msgs = events.filter((x) => String(x.e.type).startsWith('astrbot.message'));
  assert.equal(msgs[0]?.e.type, 'astrbot.message');
  assert.deepEqual(msgs[0]?.opts, { trigger: 'flush' });
  assert.deepEqual(msgs[1]?.opts, {});
  assert.equal(msgs[2]?.e.type, 'astrbot.message.self');
  assert.deepEqual(msgs[2]?.opts, { deliver: false });
  assert.equal(msgs[2]?.e.meta && 'raw' in (msgs[2]!.e.meta as object), true, 'meta.raw 恒留');
});

test('notice→piggyback；连接事件→flush+internal；未知段→degraded 上报', async () => {
  const { world, getHandlers } = makeWorld(DEFAULTS);
  const { host, events } = fakeHost();
  await world.start(host);
  const h = getHandlers();
  h.onState(true);
  h.onNotice({ v: 1, t: 'notice', id: 'n', ts: 1700000000, kind: 'recall', raw: { x: 1 } });
  h.onMsg(cbpMsg({ segments: [{ type: 'markdown', data: { text: 'x' } }] }));
  // degraded 在 msg 事件投递之后排队（onMsg 先 await pushEvent 再补状态事件），让链条排空。
  await new Promise((r) => setImmediate(r));
  const conn = events.find((x) => x.e.type === 'astrbot.connection');
  assert.equal(conn?.e.origin, 'internal');
  assert.deepEqual(conn?.opts, { trigger: 'flush' });
  const notice = events.find((x) => x.e.type === 'astrbot.notice');
  assert.deepEqual(notice?.opts, { trigger: 'piggyback' });
  const deg = events.find((x) => x.e.type === 'astrbot.degraded');
  assert.ok(deg, '未知段必须触发 degraded 事件');
});

test('egress 门：缺省关 → 60005；开 → driver.send；结果未知 → 60007', async () => {
  const closed = makeWorld({ ...DEFAULTS, egress: false });
  const { host } = fakeHost();
  await closed.world.start(host);
  const send = closed.world.tools()[0]!;
  const r1 = await send.handler({ conv: 'c', text: 't' }, { role: 'p', log } as never);
  assert.match(typeof r1 === 'string' ? '' : r1.text, /60005 door_closed/);
  assert.equal(typeof r1 === 'string' ? false : r1.failed, true);

  const open = makeWorld({ ...DEFAULTS, egress: true });
  const h2 = fakeHost();
  await open.world.start(h2.host);
  const r2 = await open.world.tools()[0]!.handler({ conv: 'aiocqhttp:GroupMessage:9', text: 'yo' }, { role: 'p', log } as never);
  assert.equal(r2, 'sent to aiocqhttp:GroupMessage:9');
  assert.deepEqual(open.sent.at(-1), { conv: 'aiocqhttp:GroupMessage:9', text: 'yo' });

  const slow = makeWorld({ ...DEFAULTS, egress: true }, { send: async () => ({ ok: false, uncertain: true, error: 'ack timeout' }) });
  const h3 = fakeHost();
  await slow.world.start(h3.host);
  const r3 = await slow.world.tools()[0]!.handler({ conv: 'c', text: 't' }, { role: 'p', log } as never);
  assert.match(typeof r3 === 'string' ? '' : r3.text, /60007 send_uncertain/);
});

test('限流：maxSendsPerMinute=2 第三条拒', async () => {
  const { world, sent } = makeWorld({ ...DEFAULTS, egress: true, maxSendsPerMinute: 2 });
  const { host } = fakeHost();
  await world.start(host);
  const tool = world.tools()[0]!;
  await tool.handler({ conv: 'c', text: '1' }, { role: 'p', log } as never);
  await tool.handler({ conv: 'c', text: '2' }, { role: 'p', log } as never);
  const third = await tool.handler({ conv: 'c', text: '3' }, { role: 'p', log } as never);
  assert.match(typeof third === 'string' ? '' : third.text, /rate_limited/);
  assert.equal(sent.length, 2);
});

test('peer_call 只认 catalog 报名 + 本轮身份；无桥消息轮次拒', async () => {
  const { world, getHandlers, calls } = makeWorld(DEFAULTS);
  const { host } = fakeHost();
  await world.start(host);
  const h = getHandlers();
  const tool = world.tools()[3]!;
  const cold = await tool.handler({ tool: 'ping' }, { role: 'p', log } as never);
  assert.match(typeof cold === 'string' ? '' : cold.text, /60004 unknown_session/);

  h.onMsg(cbpMsg({ id: 'turn-7' }));
  const unknown = await tool.handler({ tool: 'nope' }, { role: 'p', log } as never);
  assert.match(typeof unknown === 'string' ? '' : unknown.text, /unknown tool/);

  const ann: ToolAnn[] = [{ name: 'ping', risk: 'read', confirm_required: false }];
  h.onCatalog(ann);
  const ok = await tool.handler({ tool: 'ping' }, { role: 'p', log } as never);
  assert.equal(ok, 'done');
  assert.deepEqual(calls.at(-1), { tool: 'ping', turn: 'turn-7' });
});

test('envPromptVars 键 = ENV_PROMPT.md 占位符 = promptDocs.vars（三方一致）', async () => {
  const { world } = makeWorld(DEFAULTS);
  const { host } = fakeHost();
  await world.start(host);
  const keys = Object.keys(world.envPromptVars()).sort();
  const tpl = readFileSync(fileURLToPath(new URL('../src/ENV_PROMPT.md', import.meta.url)), 'utf8');
  const placeholders = [...tpl.matchAll(/\{\{(astrbot\.[a-zA-Z]+)[^}]*\}\}/g)].map((m) => m[1]!);
  const vars = (world.webUi().promptDocs?.[0]?.vars ?? []).map((v) => v.name).sort();
  assert.deepEqual(keys, vars);
  for (const p of placeholders) assert.ok(keys.includes(p), `模板占位符 ${p} 没有运行时值`);
});

test('webUi 面板 id 合 ^[a-z0-9-]+$；invoke 只应答已声明面板', async () => {
  const { world } = makeWorld(DEFAULTS);
  const { host } = fakeHost();
  await world.start(host);
  const ui = world.webUi();
  for (const p of ui.panels ?? []) assert.match(p.id, /^[a-z0-9-]+$/);
  const res = await ui.invoke!('status', 'get', []);
  assert.ok(res && typeof res === 'object' && 'connected' in res);
  const bad = await ui.invoke!('nope', 'get', []);
  assert.ok(bad && typeof bad === 'object' && 'error' in bad);
});

test('history 只查 host.store 不查对端（先例硬规则 §5-7）', async () => {
  const { world } = makeWorld(DEFAULTS);
  const { host } = fakeHost();
  await world.start(host);
  const out = await world.tools()[2]!.handler({ limit: 5 }, { role: 'p', log } as never);
  assert.equal(out, '[]');
});

test('空 segments 不炸：投递仍发生、正文为空串（解析防线在 frames/driver 测试）', async () => {
  const { world, getHandlers } = makeWorld(DEFAULTS);
  const { host, events } = fakeHost();
  await world.start(host);
  getHandlers().onMsg(cbpMsg({ segments: [] }));
  await new Promise((r) => setImmediate(r));
  const msg = events.find((x) => x.e.type === 'astrbot.message');
  assert.ok(msg);
  assert.equal(msg.e.text, '');
});
