/**
 * world.test.ts —— Cortico 侧 NekoWorld 契约测试。假驱动注入（先例
 * cortico-world-astrbot-bridge tests/world.test.ts 同位 makeDriver），
 * 不碰 WebSocket、不启动任何宿主。帧面/档位/错误码全部来自 cortico-bridge-core。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RET, err, type Frame, type ToolAnn } from '@horizoncloudy/cortico-bridge-core';
import type { Actor, MsgFrame, SelfDecl } from '@horizoncloudy/cortico-bridge-core/frames';
import WebSocket from 'ws';
import type { EventEnvelope, Logger, WorldHost } from 'cortico/core/types.ts';
import { BRIDGE_DESCRIBE, NEKO_WORLD } from '../src/definition.ts';
import type { BridgeLike, WorldHandlers } from '../src/world.ts';
import { CONFIG_GROUP, DEFAULTS, normalizeConfig, purgeLegacyTokenSection, type NekoBridgeConfig } from '../src/config.ts';
import { NekoWorld, peerToolCatalog } from '../src/world.ts';

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

interface Call {
  tool: string;
  args: Record<string, unknown>;
  turn?: string;
  actor?: Actor;
}

function makeWorld(
  cfg: Partial<NekoBridgeConfig>,
  behavior?: { reply?: Frame; reject?: (c: Call) => unknown; peerSelf?: SelfDecl | null; peerTools?: ToolAnn[] },
  inject?: { authToken?: string; turnTtlSeconds?: number; now?: () => number },
) {
  let handlers!: WorldHandlers;
  let authTokenSeen: string | undefined;
  const calls: Call[] = [];
  const sent: Frame[] = [];
  const world = new NekoWorld({
    cfg,
    authToken: inject?.authToken,
    turnTtlSeconds: inject?.turnTtlSeconds,
    now: inject?.now,
    makeDriver: (_cfg, _log, h, auth) => {
      handlers = h;
      authTokenSeen = auth;
      const driver: BridgeLike = {
        start: async () => {},
        stop: () => {},
        send: (f) => {
          sent.push(f);
          return true;
        },
        effectiveCaps: () => ['images', 'notices', 'tools'],
        listenPort: 0,
        peerSelf: () => behavior?.peerSelf ?? null,
        peerTools: () => behavior?.peerTools ?? [],
        callTool: async (tool, args, turn, actor) => {
          const c = { tool, args, turn, actor };
          calls.push(c);
          if (behavior?.reject) throw behavior.reject(c);
          return behavior?.reply ?? { v: 1, t: 'reply', id: 'r-' + calls.length, ts: 1, rid: 'x', ok: true, text: 'submitted' } satisfies Frame;
        },
      };
      return driver;
    },
  });
  return { world, getHandlers: () => handlers, calls, sent, getAuthToken: () => authTokenSeen };
}

const cbpMsg = (over: Partial<MsgFrame>): MsgFrame => ({
  v: 1, t: 'msg', id: 'm-1', ts: 1700000000,
  conv: 'conv-42', sender: { id: 'user-7', name: 'u' }, kind: 'group',
  segments: [{ type: 'text', data: { text: 'hi' } }], raw: { message_id: 'neko-msg-1' }, ...over,
});

test('入口形状四件；defaults().enabled=false 且每次新对象；缺省角色 listen 端口 39701', () => {
  const d = NEKO_WORLD;
  assert.equal(typeof d.id, 'string');
  assert.ok(d.id !== '');
  assert.equal(typeof d.label, 'string');
  assert.equal(typeof d.defaults, 'function');
  assert.equal(typeof d.create, 'function');
  assert.equal(d.defaults().enabled, false);
  assert.notEqual(d.defaults(), d.defaults());
  // 39701 = _BUILD-PLAN §4.4 + spec/pins.json「cortico-world-neko listen」行；蓝图 §3.2 neko=39701 listen。
  assert.equal(DEFAULTS.role, 'listen');
  assert.equal(DEFAULTS.port, 39701);
});

test('describe.json 与 definition.describe 逐字段相等；liveTools 名字全 ⊆ 声明', () => {
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

test('档位落地：mention/direct→flush、group→缺省 debounce 不传 trigger、self→deliver:false 改名 .self', async () => {
  const { world, getHandlers } = makeWorld({ ...DEFAULTS, enabled: true, selfId: 'bot-9' });
  const { host, events } = fakeHost();
  await world.start(host);
  const h = getHandlers();
  h.onFrame(cbpMsg({ kind: 'mention' }));
  h.onFrame(cbpMsg({ id: 'm-2', kind: 'group' }));
  h.onFrame(cbpMsg({ id: 'm-3', kind: 'direct', sender: { id: 'bot-9', name: 'self' } }));
  await new Promise((r) => setImmediate(r));
  const msgs = events.filter((x) => String(x.e.type).startsWith('neko.message'));
  assert.equal(msgs[0]?.e.type, 'neko.message');
  assert.deepEqual(msgs[0]?.opts, { trigger: 'flush' });
  // group/other：缺省 debounce（types.ts:633），不传 trigger 键。
  assert.deepEqual(msgs[1]?.opts, {});
  assert.equal(msgs[2]?.e.type, 'neko.message.self');
  assert.deepEqual(msgs[2]?.opts, { deliver: false });
  assert.equal('contextDelivery' in (msgs[2]!.e as object), false, 'pushEvent 入参不带 contextDelivery（types.ts:692-694）');
  assert.equal(msgs[2]?.e.meta && 'raw' in (msgs[2]!.e.meta as object), true, 'meta.raw 恒留');
  assert.equal(msgs[0]?.e.senderKey, 'conv-42', 'conv = neko conversation_id 原样作 senderKey');
});

test('notice→piggyback；consent notice 记入 consent 态；连接→flush+internal；未知段→degraded', async () => {
  const { world, getHandlers } = makeWorld(DEFAULTS);
  const { host, events } = fakeHost();
  await world.start(host);
  const h = getHandlers();
  h.onState({ role: 'listen', connected: true, peersReady: 1 });
  h.onFrame({ v: 1, t: 'notice', id: 'n', ts: 1700000000, kind: 'consent', raw: { status: 'pending', decision: 'waiting' } });
  h.onFrame(cbpMsg({ segments: [{ type: 'pdf', data: { name: 'a.pdf' } }] }));
  await new Promise((r) => setImmediate(r));
  const conn = events.find((x) => x.e.type === 'neko.connection');
  assert.equal(conn?.e.origin, 'internal');
  assert.deepEqual(conn?.opts, { trigger: 'flush' });
  const notice = events.find((x) => x.e.type === 'neko.notice');
  assert.deepEqual(notice?.opts, { trigger: 'piggyback' });
  assert.equal(world.envPromptVars()['neko.consent'], 'waiting');
  const deg = events.find((x) => x.e.type === 'neko.degraded');
  assert.ok(deg, '未知段必须触发 degraded 事件');
});

test('出站门与工具名：缺省关→60005 不动桥；开→call neko_send 带两轴；回执 60007 文案透传', async () => {
  const closed = makeWorld({ ...DEFAULTS, egress: false });
  const hc = fakeHost();
  await closed.world.start(hc.host);
  const send = closed.world.tools()[0]!;
  const r1 = await send.handler({ conv: 'c', text: 't' }, { role: 'p', log } as never);
  assert.match(typeof r1 === 'string' ? '' : r1.text, /60005 door_closed/);
  assert.equal(closed.calls.length, 0, '门未开不得动桥');

  const open = makeWorld({ ...DEFAULTS, egress: true, visibility: 'chat', aiBehavior: 'read' });
  const ho = fakeHost();
  await open.world.start(ho.host);
  open.getHandlers().onFrame(cbpMsg({ id: 'turn-open' }));
  const r2 = await open.world.tools()[0]!.handler({ conv: 'conv-1', text: 'yo' }, { role: 'p', log } as never);
  assert.match(String(r2), /submitted|sent/);
  assert.equal(open.calls[0]!.tool, 'neko_send', 'CBP call 工具名 = _BUILD-PLAN §3.2 call(<w>_send)');
  assert.deepEqual(open.calls[0]!.args.visibility, ['chat']);
  assert.equal(open.calls[0]!.args.ai_behavior, 'read');

  const unsure = makeWorld(
    { ...DEFAULTS, egress: true },
    { reject: () => err(RET.SEND_UNCERTAIN, 'no reply for call inside timeout, delivery uncertain') },
  );
  const hu = fakeHost();
  await unsure.world.start(hu.host);
  unsure.getHandlers().onFrame(cbpMsg({ id: 'turn-unsure' }));
  const r3 = await unsure.world.tools()[0]!.handler({ conv: 'c', text: 't' }, { role: 'p', log } as never);
  assert.match(typeof r3 === 'string' ? '' : r3.text, /60007 send_uncertain/);
});

test('reply.error 帧透传码：bridge 回 60005 时 Cortico 侧原码上报', async () => {
  const { world, getHandlers } = makeWorld(
    { ...DEFAULTS, egress: true },
    {
      reply: {
        v: 1, t: 'reply', id: 'r', ts: 1, rid: 'x', ok: false,
        error: { code: RET.DOOR_CLOSED, message: 'bridge egress disabled' },
      },
    },
  );
  const { host } = fakeHost();
  await world.start(host);
  getHandlers().onFrame(cbpMsg({ id: 'turn-err' }));
  const r = await world.tools()[0]!.handler({ conv: 'c', text: 't' }, { role: 'p', log } as never);
  assert.match(typeof r === 'string' ? '' : r.text, /60005/);
  assert.equal(typeof r === 'string' ? false : r.failed, true);
});

test('524288 本地先拒：超限载荷 call 都不发（镜像 SDK context.py:1306 先拒语义）', async () => {
  const bigBase64 = 'A'.repeat(530_000);
  const { world, calls } = makeWorld({ ...DEFAULTS, egress: true });
  const { host } = fakeHost();
  await world.start(host);
  const r = await world.tools()[0]!.handler(
    { conv: 'c', text: 'x', segments: [{ type: 'image', data: { mime: 'image/png', base64: bigBase64 } }] },
    { role: 'p', log } as never,
  );
  assert.match(typeof r === 'string' ? '' : r.text, /60003 payload_too_large/);
  assert.equal(calls.length, 0);
});

test('外部 URL 图出站：段被丢、degraded 事件上报、文本仍发', async () => {
  const { world, calls, getHandlers } = makeWorld({ ...DEFAULTS, egress: true });
  const { host, events } = fakeHost();
  await world.start(host);
  getHandlers().onFrame(cbpMsg({ id: 'turn-url' }));
  await world.tools()[0]!.handler(
    { conv: 'c', text: '看图', segments: [{ type: 'image', data: { url: 'https://x/y.png', mime: 'image/png' } }] },
    { role: 'p', log } as never,
  );
  await new Promise((r) => setImmediate(r));
  assert.equal((calls[0]!.args.segments as unknown[]).length, 0, 'URL 图段不得出站');
  const deg = events.find((x) => x.e.type === 'neko.degraded');
  assert.ok(deg, '外部 URL 图必须报 degraded');
  assert.match(JSON.stringify(deg?.e.meta ?? {}), /external-url-image/);
});

test('限流：ratePerMin=2 第三条拒', async () => {
  const { world, calls, getHandlers } = makeWorld({ ...DEFAULTS, egress: true, ratePerMin: 2 });
  const { host } = fakeHost();
  await world.start(host);
  getHandlers().onFrame(cbpMsg({ id: 'turn-rate' }));
  const tool = world.tools()[0]!;
  await tool.handler({ conv: 'c', text: '1' }, { role: 'p', log } as never);
  await tool.handler({ conv: 'c', text: '2' }, { role: 'p', log } as never);
  const third = await tool.handler({ conv: 'c', text: '3' }, { role: 'p', log } as never);
  assert.match(typeof third === 'string' ? '' : third.text, /rate_limited/);
  assert.equal(calls.length, 2);
});

test('peer_call：只认 catalog 报名 + 本轮桥消息身份；冷轮次与未报名均拒', async () => {
  const { world, getHandlers, calls } = makeWorld(DEFAULTS);
  const { host } = fakeHost();
  await world.start(host);
  const h = getHandlers();
  const tool = world.tools()[3]!;
  const cold = await tool.handler({ tool: 'ping' }, { role: 'p', log } as never);
  assert.match(typeof cold === 'string' ? '' : cold.text, /60004 unknown_session/);

  h.onFrame(cbpMsg({ id: 'turn-7' }));
  const unknown = await tool.handler({ tool: 'nope' }, { role: 'p', log } as never);
  assert.match(typeof unknown === 'string' ? '' : unknown.text, /unknown tool/);

  const ann: ToolAnn[] = [{ name: 'ping', risk: 'read', confirm_required: false }];
  h.onFrame({ v: 1, t: 'catalog', id: 'c-1', ts: 1, tools: ann });
  const ok = await tool.handler({ tool: 'ping' }, { role: 'p', log } as never);
  assert.equal(ok, 'submitted');
  assert.equal(calls.at(-1)!.tool, 'ping');
  assert.equal(calls.at(-1)!.turn, 'turn-7', 'F3：peer_call 同带本轮入站 id');
  assert.equal(calls.at(-1)!.actor?.member.id, 'user-7');
  assert.equal(calls.at(-1)!.actor?.conv, 'conv-42');
});

test('去重在核心驱动内：world 不自建第二套去重（复用 cortico-bridge-core dedup 行）', async () => {
  const { world } = makeWorld(DEFAULTS);
  const { host, events } = fakeHost();
  await world.start(host);
  const src = readFileSync(fileURLToPath(new URL('../src/world.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /new Map<[^>]*>\(\)\s*;\s*\/\/\s*seen/, 'world.ts 不得自造去重表');
  assert.match(src, /cortico-bridge-core/, 'world.ts 必须 import 内核（任务：帧编解码复用 core）');
  assert.ok(events.length === 0);
});

test('envPromptVars 键 = ENV_PROMPT.md 占位符 = promptDocs.vars 三方一致', async () => {
  const { world } = makeWorld(DEFAULTS);
  const { host } = fakeHost();
  await world.start(host);
  const keys = Object.keys(world.envPromptVars()).sort();
  const tpl = readFileSync(fileURLToPath(new URL('../src/ENV_PROMPT.md', import.meta.url)), 'utf8');
  const placeholders = [...tpl.matchAll(/\{\{(neko\.[a-zA-Z]+)[^}]*\}\}/g)].map((m) => m[1]!);
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

test('history 只查 host.store 不查对端；空 segments 不炸', async () => {
  const { world, getHandlers } = makeWorld(DEFAULTS);
  const { host, events } = fakeHost();
  await world.start(host);
  const out = await world.tools()[2]!.handler({ limit: 5 }, { role: 'p', log } as never);
  assert.equal(out, '[]');
  getHandlers().onFrame(cbpMsg({ segments: [] }));
  await new Promise((r) => setImmediate(r));
  const msg = events.find((x) => x.e.type === 'neko.message');
  assert.ok(msg);
  assert.equal(msg.e.text, '');
});

test('双角色配置面：listen 缺省端口可 env 覆盖说明在 config；dial 用 url 字段', async () => {
  const { world } = makeWorld({ ...DEFAULTS, role: 'dial', url: 'ws://127.0.0.1:39701' });
  const { host } = fakeHost();
  await world.start(host);
  const vars = world.envPromptVars();
  assert.match(vars['neko.connection']!, /dial|未连接/);
});

// ── F1/F2/F3 新帧表对接（本批落地；先红后绿） ──────────────────────

test('F3：出站 call 带 turn 与 actor；actor 从 N.E.K.O 实证入站记录填，conv 是身份不是目的地', async () => {
  const { world, calls, getHandlers } = makeWorld({ ...DEFAULTS, egress: true });
  const { host } = fakeHost();
  await world.start(host);
  getHandlers().onFrame(cbpMsg({ id: 'turn-1', conv: 'conv-A', sender: { id: 'user-7', name: 'u7' } }));
  await world.tools()[0]!.handler({ conv: 'conv-B', text: 'hi' }, { role: 'p', log } as never);
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.turn, 'turn-1', 'turn = 触发本轮的入站 msg 帧 id（SECURITY-CBP §1.2）');
  assert.ok(c.actor, 'call 必须带 actor');
  assert.equal(c.actor.platform, 'neko');
  assert.equal(c.actor.conv, 'conv-A', 'actor.conv = 入站消息的会话（实证身份），不是 args.conv（目的地）');
  assert.deepEqual(c.actor.member, { id: 'user-7', name: 'u7' }, 'member = 入站 sender（宿主实证值）');
  assert.equal(c.actor.anon, 'identified');
});

test('负例：自报 actor 被拒——本轮没有桥消息 ⇒ 60004 unknown_session，不动桥', async () => {
  const { world, calls } = makeWorld({ ...DEFAULTS, egress: true });
  const { host } = fakeHost();
  await world.start(host);
  const r = await world.tools()[0]!.handler({ conv: 'c', text: 't' }, { role: 'p', log } as never);
  assert.match(typeof r === 'string' ? '' : r.text, /60004 unknown_session/);
  assert.equal(typeof r === 'string' ? false : r.failed, true);
  assert.equal(calls.length, 0, '没有实证 turn 就不许发 call（帧里 turn/actor 必填，伪造即违例）');
});

test('负例：args 里的自报身份键不进帧——turn/actor 只认入站记录', async () => {
  const { world, calls, getHandlers } = makeWorld({ ...DEFAULTS, egress: true });
  const { host } = fakeHost();
  await world.start(host);
  getHandlers().onFrame(cbpMsg({ id: 'turn-2', conv: 'conv-A', sender: { id: 'user-7', name: 'u7' } }));
  await world.tools()[0]!.handler(
    {
      conv: 'conv-A',
      text: 'hi',
      actor: { platform: 'forge', member: { id: 'admin', name: 'admin' }, anon: 'self' },
      member: { id: 'admin' },
      turn: 'fake-turn',
    } as Record<string, unknown>,
    { role: 'p', log } as never,
  );
  const c = calls[0]!;
  assert.equal(c.turn, 'turn-2', 'args.turn 不得覆盖入站记录');
  assert.equal(c.actor?.member.id, 'user-7', 'args.member / args.actor 自报身份不得进帧');
  assert.equal(c.actor?.platform, 'neko');
  assert.equal(c.actor?.anon, 'identified');
});

test('F3 断线清轮次：桥侧 TurnLedger 随连接走，旧 turn 不跨连接复用', async () => {
  const { world, calls, getHandlers } = makeWorld({ ...DEFAULTS, egress: true });
  const { host } = fakeHost();
  await world.start(host);
  const h = getHandlers();
  h.onFrame(cbpMsg({ id: 'turn-3' }));
  h.onState({ role: 'listen', connected: false, peersReady: 0 });
  const r = await world.tools()[0]!.handler({ conv: 'c', text: 't' }, { role: 'p', log } as never);
  assert.match(typeof r === 'string' ? '' : r.text, /60004 unknown_session/);
  assert.equal(calls.length, 0);
});

test('F1/F2 self 声明：bridgeSelf 恒 proven:false（neko 线永久无实证，§6-9）；caps 不申报 self_echo（§2.3 caps-lie 守卫）', async () => {
  const m = (await import('../src/world.ts')) as typeof import('../src/world.ts') & {
    bridgeSelf?: (cfg: NekoBridgeConfig) => SelfDecl;
  };
  assert.equal(typeof m.bridgeSelf, 'function', 'world.ts 必须导出 bridgeSelf（hello/ready self 位单源）');
  assert.deepEqual(m.bridgeSelf!({ ...DEFAULTS, selfId: 'bot-9' }), { id: 'bot-9', name: 'cortico-world-neko', proven: false });
  assert.equal(m.bridgeSelf!({ ...DEFAULTS, selfId: '' }).proven, false, '空 id 也诚实报 proven:false，不许拿「没有 self」冒充「没有 self 需求」（F1）');
  assert.ok(!m.NEKO_CAPS.includes('self_echo'), 'proven:false 报 self_echo = caps-lie，内核会丢该 cap 并记 degraded');
  const src = readFileSync(fileURLToPath(new URL('../src/world.ts', import.meta.url)), 'utf8');
  assert.match(src, /self:\s*bridgeSelf\(/, '真实 BridgeDriver 构造必须带 self 位');
});

test('proven:false 的 self 声明 ⇒ 同 id 入站照常投递（不吞、不改名 .self），self-echo:off 常驻提示词', async () => {
  const { world, getHandlers } = makeWorld({ ...DEFAULTS, selfId: 'bot-9' }, { peerSelf: { id: 'bot-9', name: '', proven: false } });
  const { host, events } = fakeHost();
  await world.start(host);
  getHandlers().onFrame(cbpMsg({ id: 'm-echo', kind: 'direct', sender: { id: 'bot-9', name: 'self' } }));
  await new Promise((r) => setImmediate(r));
  const msgs = events.filter((x) => String(x.e.type).startsWith('neko.message'));
  assert.equal(msgs[0]?.e.type, 'neko.message', 'neko 线实证 self 永不可得 ⇒ 不做回声抑制、不出 .self 事件');
  assert.notDeepEqual(msgs[0]?.opts, { deliver: false }, 'proven:false 必须照常投递（SECURITY-CBP §2.4）');
  assert.match(world.envPromptVars()['neko.self'] ?? '', /self-echo:off/);
});

test('peer self proven:true 时才抑制回声：同 id 入站 → .self + deliver:false + 剥 contextDelivery', async () => {
  const { world, getHandlers } = makeWorld({ ...DEFAULTS }, { peerSelf: { id: 'bot-9', name: '', proven: true } });
  const { host, events } = fakeHost();
  await world.start(host);
  getHandlers().onFrame(cbpMsg({ id: 'm-prov', kind: 'direct', sender: { id: 'bot-9', name: 'self' } }));
  await new Promise((r) => setImmediate(r));
  const msgs = events.filter((x) => String(x.e.type).startsWith('neko.message'));
  assert.equal(msgs[0]?.e.type, 'neko.message.self');
  assert.deepEqual(msgs[0]?.opts, { deliver: false });
  assert.equal('contextDelivery' in (msgs[0]!.e as object), false, 'pushEvent 入参不带 contextDelivery');
});

// ── F2/F3（FIXORDER 2026-11-17 批次）：申报面退空、入站 call 秒回 60002、token 走 secret ──

test('F2：被调面未开 ⇒ peerToolCatalog 申报空集，BridgeDriver 构造仍走单源', () => {
  assert.deepEqual(peerToolCatalog({ ...DEFAULTS, egress: true }), [], '四支名字不得再进 hello/ready tools[]');
  const src = readFileSync(fileURLToPath(new URL('../src/world.ts', import.meta.url)), 'utf8');
  assert.match(src, /tools:\s*peerToolCatalog\(/, 'tools 位保持单源，退化只发生在目录函数里');
});

test('F2：真握手下 ready.tools 为空集；入站 call 远小于 30s 拿到 60002 回帧', async () => {
  // FIXORDER F2 验收两条都落在真内核驱动 + 真 socket 上；端口避开 39701/39711 在册位。
  const port = 39741;
  const world = new NekoWorld({ cfg: { ...DEFAULTS, enabled: true, host: '127.0.0.1', port } });
  const { host } = fakeHost();
  await world.start(host);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  type Wire = { t?: string; tools?: { name: string }[]; rid?: string; ok?: boolean; error?: { code?: number } };
  const wire: Wire[] = [];
  ws.on('message', (d: unknown) => wire.push(JSON.parse(String(d)) as Wire));
  const until = async (pred: () => boolean, ms: number, what: string) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`超时等不到：${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  try {
    await new Promise<void>((res, rej) => {
      ws.on('open', () => res());
      ws.on('error', (e: unknown) => rej(e));
    });
    const ts = Math.floor(Date.now() / 1000);
    ws.send(JSON.stringify({
      v: 1, t: 'hello', id: 'h-f2', ts,
      agent: { name: 'negctl-bridge', version: '0', sha: '' },
      v_support: [1], caps: ['images', 'notices', 'tools'], tools: [],
      self: { id: 'peer-1', name: 'peer', proven: false },
    }));
    await until(() => wire.some((f) => f.t === 'ready'), 5000, 'ready 帧');
    const ready = wire.find((f) => f.t === 'ready')!;
    const four = ['neko_send_message', 'neko_status', 'neko_history', 'neko_peer_call'];
    const names = (ready.tools ?? []).map((x) => x.name);
    for (const n of four) assert.ok(!names.includes(n), `ready.tools 不得含 ${n}（申报而不服务=F2 违例）`);
    // 先立 turn 记录，再打 call：内核认得 turn，回帧必须由被调面分支立即给出。
    // 同一条 TCP 上 msg 先于 call 送达，内核 handleRaw 同步记账，无需等待位。
    ws.send(JSON.stringify({
      v: 1, t: 'msg', id: 'm-f2', ts, conv: 'conv-f2',
      sender: { id: 'user-f2', name: 'u' }, kind: 'group', segments: [], raw: {},
    }));
    const t0 = Date.now();
    ws.send(JSON.stringify({
      v: 1, t: 'call', id: 'k-f2', ts, rid: 'k-f2', tool: 'neko_status', args: {}, turn: 'm-f2',
      actor: { platform: 'neko', conv: 'conv-f2', member: { id: 'user-f2', name: 'u' }, anon: 'identified' },
    }));
    await until(() => wire.some((f) => f.t === 'reply' && f.rid === 'k-f2'), 5000, '60002 回帧');
    const reply = wire.find((f) => f.t === 'reply' && f.rid === 'k-f2')!;
    const elapsedMs = Date.now() - t0;
    assert.ok(elapsedMs < 3000, `回帧耗时必须远小于内核 30s call 超时，实测 ${elapsedMs}ms`);
    assert.equal(reply.ok, false);
    assert.equal(reply.error?.code, 60002, '入站 call 在被调面未开期必须立即 60002 capability_unavailable');
  } finally {
    ws.close();
    await world.stop();
  }
});

test('F3：create() 只从 ctx.secret(CORTICO_BRIDGE_TOKEN) 取凭据；配置面三处删净', () => {
  const seen: string[] = [];
  const ctx = {
    cfg: { ...DEFAULTS },
    secret: (name: string) => {
      seen.push(name);
      return 'sekret-value';
    },
    storeSecret: () => {},
    persist: () => {},
  };
  const inst = NEKO_WORLD.create(ctx as never);
  assert.ok(inst && typeof inst.tools === 'function', 'create() 必须返回 World 实例');
  assert.deepEqual(seen, ['CORTICO_BRIDGE_TOKEN'], '凭据只许走 ctx.secret，键名与桥侧 CORTICO_BRIDGE_TOKEN 对称');
  assert.equal('token' in DEFAULTS, false, 'DEFAULTS 里不得再有 token');
  const leaky = { token: 'leak' } as unknown as Partial<NekoBridgeConfig>;
  assert.equal('token' in normalizeConfig(leaky), false, 'normalizeConfig 必须丢弃 worlds.neko.token');
  const panelKeys = Object.keys((CONFIG_GROUP.schema.properties ?? {}) as Record<string, unknown>);
  assert.ok(!panelKeys.includes('worlds.neko.token'), '配置面板项里不得再有 token 字段');
});

test('F3：secret 值经 WorldOptions 注入驱动构造；cfg.token 通道已删', async () => {
  const { world, getAuthToken } = makeWorld(DEFAULTS, undefined, { authToken: 'sekret-value' });
  const { host } = fakeHost();
  await world.start(host);
  assert.equal(getAuthToken(), 'sekret-value', 'makeDriver 注入位必须收到 create() 取回的 secret 值');
  const src = readFileSync(fileURLToPath(new URL('../src/world.ts', import.meta.url)), 'utf8');
  assert.match(src, /authToken:\s*this\.opts\.authToken/, '真实 BridgeDriver 的 authToken 只许来自 opts.authToken');
  assert.doesNotMatch(src, /cfg\.token/, 'world.ts 不得再读配置串里的 token');
});

// ── 工单二 F1–F6（FIXORDER2.md 2026-11-17，批内修 + 一次性清理 + turn 窗口可调） ──

/** 引擎落盘同款的规范化 config.json 夹具；`root` 与 `canonical` 一一对应。 */
function f1Fixture(dir: string, tokenValue: unknown): { root: Record<string, unknown>; canonical: string } {
  const root: Record<string, unknown> = {
    version: 1,
    timezone: 'UTC',
    worlds: {
      maibot: { enabled: true, port: 39702 },
      neko: { enabled: true, role: 'listen', token: tokenValue, egress: false },
    },
  };
  const canonical = `${JSON.stringify(root, null, 2)}\n`;
  writeFileSync(join(dir, 'config.json'), canonical, 'utf8');
  return { root, canonical };
}

function loggingSinkHost() {
  const sink: string[] = [];
  const events: Recorded[] = [];
  const log: Logger = { trace() {}, debug() {}, info() {}, warn(m: string) { sink.push(String(m)); }, error() {}, emit() {}, child() { return log; } };
  const host: WorldHost = {
    pushEvent: async (e: PushIn, opts?: Recorded['opts']) => {
      events.push({ e, opts });
      return { cursor: events.length, origin: e.origin ?? 'external', ...e } as unknown as EventEnvelope;
    },
    store: { get: () => undefined, latestCursor: () => 0, range: () => [], around: () => [], grep: () => [] },
    modelFacts: { model: () => 'fake', accepts: () => false, contextWindow: () => undefined },
    blob: () => null,
    drainPendingEvents: async () => [],
    log,
  } as unknown as WorldHost;
  return { host, sink, events };
}

function notesWorld(notes: string[]) {
  return new NekoWorld({
    cfg: DEFAULTS,
    purgeNotes: notes,
    makeDriver: () => ({
      start: async () => {},
      stop: () => {},
      send: () => true,
      callTool: async () => {
        throw new Error('unused');
      },
      peerSelf: () => null,
      effectiveCaps: () => [],
      peerTools: () => [],
      listenPort: 0,
    }),
  });
}

test('F1：带明文 token 残键的旧 config，装载后残键消失、其余字节逐行不动、日志只记键名', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbp-f1-'));
  const { canonical } = f1Fixture(dir, 'sekret-plain-value');
  const cfgSection: Record<string, unknown> = { enabled: true, role: 'listen', token: 'sekret-plain-value', egress: false };
  const notes = purgeLegacyTokenSection(dir, cfgSection);
  const after = readFileSync(join(dir, 'config.json'), 'utf8');
  assert.ok(!after.includes('sekret-plain-value'), '值必须随键一起消失');
  assert.equal(after, canonical.replace('      "token": "sekret-plain-value",\n', ''), '只删那一行，其余字节不动');
  assert.deepEqual(Object.keys(cfgSection), ['enabled', 'role', 'egress'], '活配置对象同步删键');
  const joined = notes.join('\n');
  assert.match(joined, /worlds\.neko\.token/, '日志记键名');
  assert.ok(!joined.includes('sekret-plain-value'), '日志不得记值');
  assert.match(joined, /泄露|轮换/, '非空旧值必须带泄露处置提示');
  const { host, sink } = loggingSinkHost();
  await notesWorld(notes).start(host);
  assert.ok(sink.some((s) => s.includes('worlds.neko.token')), 'start() 把提示回放进宿主日志');
  assert.ok(!sink.some((s) => s.includes('sekret-plain-value')), '宿主日志同样不出现值');
});

test('F1：空串残键照删键，但不写泄露提示', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbp-f1-'));
  f1Fixture(dir, '');
  const notes = purgeLegacyTokenSection(dir, { enabled: true, token: '' });
  assert.equal(notes.length, 1, '只有一条删键提示');
  assert.doesNotMatch(notes.join(''), /泄露|轮换/, '空值不构成泄露断言');
  assert.ok(!readFileSync(join(dir, 'config.json'), 'utf8').includes('"token"'), '键本身照删');
});

test('F1：幂等——第二次装载零读零写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbp-f1-'));
  f1Fixture(dir, 'sekret-plain-value');
  purgeLegacyTokenSection(dir, { token: 'sekret-plain-value' });
  const before = statSync(join(dir, 'config.json'));
  const bytes = readFileSync(join(dir, 'config.json'));
  const again = (JSON.parse(bytes.toString('utf8')).worlds.neko ?? {}) as Record<string, unknown>;
  const notes2 = purgeLegacyTokenSection(dir, again);
  const after = statSync(join(dir, 'config.json'));
  assert.equal(notes2.length, 0, '第二次调用不产生任何提示');
  assert.equal(after.mtimeMs, before.mtimeMs, '第二次装载不得写文件');
  assert.ok(Buffer.compare(readFileSync(join(dir, 'config.json')), bytes) === 0);
});

test('F1：config.json 读不到或坏 JSON 就不写，残键留待下次装载', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbp-f1-'));
  const missing = purgeLegacyTokenSection(dir, { token: 'x' });
  assert.match(missing.join(''), /不写|下次装载/);
  assert.equal(existsSync(join(dir, 'config.json')), false, '不得凭空造 config.json');
  writeFileSync(join(dir, 'config.json'), 'not-json{', 'utf8');
  const corrupt = purgeLegacyTokenSection(dir, { token: 'x' });
  assert.match(corrupt.join(''), /不写|下次装载/);
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), 'not-json{', '坏文件原样保留');
});

test('F1：create() 装载路径真调清理，且不碰 secret 通道', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbp-f1-'));
  f1Fixture(dir, 'sekret-plain-value');
  const cfgSection: Record<string, unknown> = { ...DEFAULTS, token: 'sekret-plain-value' };
  const seen: string[] = [];
  const inst = NEKO_WORLD.create({
    cfg: cfgSection,
    botDir: dir,
    secret: (name: string) => {
      seen.push(name);
      return '';
    },
  } as never);
  assert.ok(inst && typeof inst.tools === 'function');
  assert.deepEqual(seen, ['CORTICO_BRIDGE_TOKEN'], '清理不得另开凭据通道');
  assert.equal('token' in cfgSection, false, 'create() 必须同步清活配置残键');
  assert.ok(!readFileSync(join(dir, 'config.json'), 'utf8').includes('sekret-plain-value'));
});

test('F2：lastTurn 按同源窗口过期——超窗出站回 60004，不动桥', async () => {
  let t = 1_000_000;
  const { world, calls, getHandlers } = makeWorld({ ...DEFAULTS, egress: true }, undefined, { turnTtlSeconds: 300, now: () => t });
  const { host } = fakeHost();
  await world.start(host);
  getHandlers().onFrame(cbpMsg({ id: 'turn-exp' }));
  t += 299_000;
  const ok = await world.tools()[0]!.handler({ conv: 'c', text: 't' }, { role: 'p', log } as never);
  assert.match(String(ok), /submitted/, '窗内出站正常');
  t += 2_000; // 301 s > 300 s
  const r = await world.tools()[0]!.handler({ conv: 'c', text: 't2' }, { role: 'p', log } as never);
  assert.match(typeof r === 'string' ? '' : r.text, /60004/);
  assert.match(typeof r === 'string' ? '' : r.text, /保留窗/);
  assert.equal(calls.length, 1, '超窗后一帧 call 都不许多发');
  const peer = await world.tools()[3]!.handler({ tool: 'ping' }, { role: 'p', log } as never);
  assert.match(typeof peer === 'string' ? '' : peer.text, /60004/, 'peer_call 同受过期闸');
  assert.match(world.envPromptVars()['neko.degraded'] ?? '', /turn-expired/, '过期记降级位');
});

test('F2：提示词窗口位读数来自同源，env 覆盖即读生效、坏值明说回落', async () => {
  const prev = process.env.CORTICO_TURN_TTL_SECONDS;
  try {
    delete process.env.CORTICO_TURN_TTL_SECONDS;
    const { world } = makeWorld(DEFAULTS);
    const { host } = fakeHost();
    await world.start(host);
    const w1 = world.envPromptVars()['neko.window'] ?? '';
    assert.match(w1, /300 秒/);
    assert.match(w1, /CORTICO_TURN_TTL_SECONDS/);
    process.env.CORTICO_TURN_TTL_SECONDS = '42';
    assert.match(world.envPromptVars()['neko.window'] ?? '', /42 秒/, 'env 覆盖即读生效');
    process.env.CORTICO_TURN_TTL_SECONDS = 'nope';
    assert.match(world.envPromptVars()['neko.window'] ?? '', /回落/, '坏值必须明说回落');
  } finally {
    if (prev === undefined) delete process.env.CORTICO_TURN_TTL_SECONDS;
    else process.env.CORTICO_TURN_TTL_SECONDS = prev;
  }
});

test('F2：world.ts 的窗口走内核读数口，不写死数字、不挂 dedup', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/world.ts', import.meta.url)), 'utf8');
  assert.match(src, /effectiveTurnTtlSeconds\(\)/, '窗长必须走内核同源读数');
  assert.doesNotMatch(src, /600_000/, '不得把 dedup 的 600 秒搬进 world');
});

test('F3（工单二）：链路已立而对端没申报 neko_send ⇒ 本地 60002，不发 call 帧', async () => {
  const { world, calls, getHandlers } = makeWorld({ ...DEFAULTS, egress: true });
  const { host } = fakeHost();
  await world.start(host);
  const h = getHandlers();
  h.onState({ role: 'listen', connected: true, peersReady: 1 });
  h.onFrame(cbpMsg({ id: 'turn-ann' }));
  const r = await world.tools()[0]!.handler({ conv: 'c', text: 't' }, { role: 'p', log } as never);
  assert.match(typeof r === 'string' ? '' : r.text, /60002 capability_unavailable/);
  assert.equal(calls.length, 0, '未申报能力绝不发 call 帧（§7 规则 3）');
});

test('F3（工单二）：对端申报了 neko_send 则出站照常', async () => {
  const ann: ToolAnn[] = [{ name: 'neko_send', risk: 'write', confirm_required: true }];
  const { world, calls, getHandlers } = makeWorld({ ...DEFAULTS, egress: true }, { peerTools: ann });
  const { host } = fakeHost();
  await world.start(host);
  const h = getHandlers();
  h.onState({ role: 'listen', connected: true, peersReady: 1 });
  h.onFrame(cbpMsg({ id: 'turn-ann2' }));
  const r = await world.tools()[0]!.handler({ conv: 'c', text: 't' }, { role: 'p', log } as never);
  assert.match(String(r), /submitted/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.tool, 'neko_send');
});

test('F3（工单二）：未连接时不判申报闸——空申报不误伤 60002', async () => {
  const { world, calls, getHandlers } = makeWorld({ ...DEFAULTS, egress: true });
  const { host } = fakeHost();
  await world.start(host);
  getHandlers().onFrame(cbpMsg({ id: 'turn-off' })); // onState(connected:true) 不发
  const r = await world.tools()[0]!.handler({ conv: 'c', text: 't' }, { role: 'p', log } as never);
  assert.match(String(r), /submitted/, '未连接路径照旧交给驱动，由内核报网络类错误');
  assert.equal(calls.length, 1);
});

test('F4/F6：文档口径闸——README 枚举补齐、有 F 编号图例、无写死条数、无禁写句', () => {
  const rm = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  assert.match(rm, /60002 capability_unavailable/, 'README 枚举必须含 60002（工单二 F4）');
  assert.match(rm, /60004 unknown_session/, 'README 枚举必须含 60004（工单二 F4）');
  assert.match(rm, /F 编号图例/, 'F 号必须带图例（工单二 F4）');
  assert.match(rm, /CORTICO_TURN_TTL_SECONDS/, 'turn 窗口口径写进 README（工单二 F2）');
  assert.doesNotMatch(rm, /\d+ pass \/ \d+ fail/, '不得写死测试条数（X3 §2.5）');
  assert.doesNotMatch(rm, /config\.json 不再落这个键/, '现在时态的迁移断言禁写（X3 §2.6）');
  const env = readFileSync(fileURLToPath(new URL('../src/ENV_PROMPT.md', import.meta.url)), 'utf8');
  assert.doesNotMatch(env, /协商成功/, '禁写「能力协商成功」（X3 §2.1）');
  assert.match(env, /neko\.window/, '窗口位进提示词模板');
  const desc = readFileSync(fileURLToPath(new URL('../describe.json', import.meta.url)), 'utf8');
  assert.doesNotMatch(desc, /协商成功/);
  assert.match(desc, /60002/, 'describe 写出申报闸错误码（工单二 F4）');
});
