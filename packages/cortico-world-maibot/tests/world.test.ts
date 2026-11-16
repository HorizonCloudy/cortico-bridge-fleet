/**
 * world.test.ts —— 壳行为对表：档位（内核 envelope.ts §3.2 表）、egress 60005、
 * 限流 ratePerMin、peer_call catalog+turn 闸、maibot_streams → chat.get_all_streams
 * （upstream/maibot-plugin-sdk maibot_sdk/capabilities/chat.py:57-59 @f9984673d）、
 * 自发只归档、降级位。驱动用结构化假件注入（kernel BridgeDriver 同形）。
 *
 * F1/F2/F3（SECURITY-CBP §1-2，CHANGELOG F1/F2/F3，k1 已落内核）：
 * call 必带 turn+actor、hello/ready 必带 self、self_echo 只能与 proven:true 同现。
 * 回声判定改吃协商供给（driver.peerSelf），不再吃 raw.account_id 的私判。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RET, err, CAPS } from '@horizoncloudy/cortico-bridge-core';
import type { Actor, Frame, SelfDecl, ToolAnn } from '@horizoncloudy/cortico-bridge-core';
import type { MsgFrame } from '@horizoncloudy/cortico-bridge-core/frames';
import type { DriverState } from '@horizoncloudy/cortico-bridge-core';
import type { Logger, WorldHost, EventEnvelope } from 'cortico/core/types.ts';
import {
  MaibotBridgeWorld,
  WORLD_CAPS,
  WORLD_SELF,
  peerToolCatalog,
  PEER_CAPABILITIES,
  type MaibotDriverLike,
  type WorldHandlers,
} from '../src/world.ts';
import { imageSegToBlob } from '../src/normalize.ts';
import { DEFAULTS, type MaibotConfig } from '../src/config.ts';

const log: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, emit() {}, child() { return log; } };
type PushIn = Parameters<WorldHost['pushEvent']>[0];
type Recorded = { e: PushIn; opts?: Parameters<WorldHost['pushEvent']>[1] };
type CallRec = { tool: string; args: Record<string, unknown>; turn: string; actor: Actor };

function fakeHost(accepts = (_m: string): boolean => true) {
  const events: Recorded[] = [];
  const host: WorldHost = {
    pushEvent: async (e: PushIn, opts?: Recorded['opts']) => {
      events.push({ e, opts });
      return { cursor: events.length, origin: e.origin ?? 'external', ...e } as unknown as EventEnvelope;
    },
    store: {
      get: () => undefined,
      latestCursor: () => 0,
      range: (q: { source?: string }) =>
        q.source === 'maibot' ? [{ ts: '2026-11-16T00:00:00+08:00', type: 'maibot.message', text: 'archived' }] : [],
      around: () => [],
      grep: () => [],
    },
    modelFacts: { model: () => 'fake', accepts, contextWindow: () => undefined },
    blob: () => null,
    drainPendingEvents: async () => [],
    log,
  } as unknown as WorldHost;
  return { host, events };
}

interface Fake {
  world: MaibotBridgeWorld;
  fire: (f: Frame) => void;
  calls: CallRec[];
  sentFrames: Frame[];
  setReady: (v: boolean) => void;
}

/** peerSelf 缺省 null（协商没给 self）——§2.4 的显式降级路径。 */
function makeWorld(
  cfg: Partial<MaibotConfig>,
  callImpl?: (tool: string, args: Record<string, unknown>) => Promise<Frame>,
  peerSelf: SelfDecl | null = null,
  helloTools: ToolAnn[] = [],
): Fake {
  let handlers!: WorldHandlers;
  const calls: CallRec[] = [];
  const sentFrames: Frame[] = [];
  let ready = false;
  const driver: MaibotDriverLike = {
    start: async () => {},
    stop: () => {},
    send: (f) => {
      sentFrames.push(f);
      return true;
    },
    callTool: async (tool, args, turn, actor) => {
      calls.push({ tool, args, turn, actor });
      if (callImpl) return callImpl(tool, args);
      return { v: 1, t: 'reply', id: 'r-1', ts: 0, rid: 'x', ok: true, text: 'sent' };
    },
    effectiveCaps: () => ['images', 'notices', 'tools'],
    peerSelf: () => peerSelf,
    peerTools: () => helloTools,
    get isReady() {
      return ready;
    },
  };
  const world = new MaibotBridgeWorld({
    cfg: { ...DEFAULTS, ...cfg } as MaibotConfig,
    makeDriver: (_c, _l, h) => {
      handlers = h;
      return driver;
    },
  });
  return {
    world,
    fire: (f) => handlers.onFrame(f),
    calls,
    sentFrames,
    setReady: (v) => handlers.onState({ role: 'listen', connected: v, peersReady: v ? 1 : 0 } as DriverState),
  };
}

const replyOk = (over: Partial<Frame> = {}): Frame => ({ v: 1, t: 'reply', id: 'r1', ts: 0, rid: 'q', ok: true, text: 'sent', ...over } as Frame);
const cbpMsg = (over: Partial<MsgFrame> = {}): MsgFrame => ({
  v: 1,
  t: 'msg',
  id: 'm-1',
  ts: 1700000000,
  conv: 's1',
  sender: { id: '555', name: 'u' },
  kind: 'group',
  segments: [{ type: 'text', data: { text: 'hi' } }],
  raw: {
    message_id: '9',
    platform: 'aiocqhttp',
    account_id: 'bot1',
    session_id: 's1',
    message_info: { user_info: { user_id: '555', user_nickname: 'u' }, group_info: { group_id: '1', group_name: 'g' } },
  },
  ...over,
});

/** 桥的实证 self 申报（§2.2 MaiBot 线 proven:true 的来源是 internal_chat.identity，桥侧填）。 */
const provenSelf: SelfDecl = { id: 'bot1', name: 'MaiBot', proven: true };

// ── caps 申报对表（上轮闸门的真红点）──────────────────────────────

test('caps 申报与实测兑现集合相等：files 与 self_echo 多报即红（SECURITY-CBP:77 / §4.2 maibot host-ask）', async () => {
  // 每支 cap 只在本包真有该行为面时才进 measured——名字漂出去即红，行为漂回来也红。
  const measured = new Set<string>();

  // images：唯一的附件出口 imageSegToBlob 对 image 段真出 bytes。
  if (imageSegToBlob({ type: 'image', data: { base64: 'QUJD', mime: 'image/png' } }) !== null) measured.add('images');
  // files：同一段换成 file 型没有任何附件出口。MaiBot 的上传上限每次由宿主回包声明、
  // SDK 无常量（SECURITY-CBP:180，capabilities/files.py:74-75 @f9984673d），pins maibot media_bytes=null。
  if (imageSegToBlob({ type: 'file', data: { base64: 'QUJD', mime: 'application/pdf' } }) !== null) measured.add('files');
  // self_echo：§2.3-4 只能与 proven:true 同现；本端是 Cortico，没有宿主实证账号位。
  if (WORLD_SELF.proven === true) measured.add('self_echo');

  // notices：真喂一条 notice 帧，看 .notice 事件落不落。
  const fN = makeWorld({});
  const hN = fakeHost();
  await fN.world.start(hN.host);
  fN.fire({ v: 1, t: 'notice', id: 'n1', ts: 1, kind: 'recall', raw: {} });
  await new Promise((r) => setImmediate(r));
  if (hN.events.some((x) => x.e.type === 'maibot.notice')) measured.add('notices');

  // tools：handler 面与 catalog 面都在才算兑现。
  const fT = makeWorld({});
  await fT.world.start(fakeHost().host);
  if (fT.world.tools().every((t) => typeof t.handler === 'function') && peerToolCatalog(DEFAULTS).length > 0) measured.add('tools');

  assert.deepEqual(new Set(WORLD_CAPS), measured, `申报 [${WORLD_CAPS.join(',')}] ≠ 实测 [${[...measured].join(',')}]`);
});

test('申报的每个 cap 名都在内核词表内（词表外名字协商会静默丢弃）', () => {
  const vocab = new Set<string>(CAPS);
  for (const c of WORLD_CAPS) assert.ok(vocab.has(c), `${c} 不在 capsVocab`);
});

test('self 申报三键闭合且诚实 proven:false（F1/F2；Cortico 无宿主实证账号位）', () => {
  assert.deepEqual(Object.keys(WORLD_SELF).sort(), ['id', 'name', 'proven']);
  assert.equal(WORLD_SELF.proven, false);
});

// ── N3 能力目录交集闸：K1 接线后两支靠桥工具与桥 hello.tools 同步在场 ───────────

test('接线后：maibot_send_message / maibot_streams 进目录、进申报清单、进提示词（SECURITY-CBP §7 N3）', async () => {
  const f = makeWorld({});
  await f.world.start(fakeHost().host);
  const live = f.world.tools().map((t) => t.name);
  assert.ok(live.includes('maibot_send_message'), '发信腿已接线，tools() 该有 send_message');
  assert.ok(live.includes('maibot_streams'), '流清单腿已接线，tools() 该有 streams');
  const announced = peerToolCatalog(DEFAULTS).map((t) => t.name);
  assert.deepEqual(
    announced,
    ['maibot_send_message', 'maibot_status', 'maibot_history', 'maibot_streams', 'maibot_peer_call'],
    '申报清单 = 五支固定工具',
  );
  assert.deepEqual(
    [...PEER_CAPABILITIES],
    ['maibot_send', 'chat.get_all_streams'],
    'fleet 镜像必须随桥 hello.tools 两支同步（跨仓闸 hello-authority.test.ts）',
  );
  const describe = JSON.parse(readFileSync(fileURLToPath(new URL('../describe.json', import.meta.url)), 'utf8')) as {
    tools: { name: string }[];
    prompts: { content: string }[];
  };
  for (const n of ['maibot_send_message', 'maibot_streams']) {
    assert.ok(describe.tools.some((t) => t.name === n), `describe.json 缺 ${n}`);
  }
  const prompt = readFileSync(fileURLToPath(new URL('../src/ENV_PROMPT.md', import.meta.url)), 'utf8');
  assert.ok(prompt.includes('maibot_send_message') && prompt.includes('maibot_streams'), 'ENV_PROMPT 该写两支靠桥工具');
  assert.ok(!prompt.includes('桥的 hello.tools 为空'), 'ENV_PROMPT 仍写未接线口径');
  assert.ok(!describe.prompts[0]!.content.includes('桥的 hello.tools 为空'), 'describe 提示词仍写未接线口径');
});

// ── K1 发信腿：门关 60005、conv 必填、限流、streams 下发能力名逐字 ──────────────

test('maibot_send_message / maibot_streams：门、参数、限流与下发名', async () => {
  const ann: ToolAnn[] = [
    { name: 'maibot_send', risk: 'write', confirm_required: true },
    { name: 'chat.get_all_streams', risk: 'read', confirm_required: false },
  ];
  const txt = (r: unknown): string => (typeof r === 'string' ? r : String((r as { text?: string }).text ?? ''));
  const send = (f: Fake, args: Record<string, unknown>) =>
    f.world
      .tools()
      .find((t) => t.name === 'maibot_send_message')!
      .handler!(args, { role: 'p', log } as never);

  const closed = makeWorld({ egress: false }, undefined, null, ann);
  await closed.world.start(fakeHost().host);
  closed.fire(cbpMsg());
  assert.match(txt(await send(closed, { conv: 's1', text: 'hi' })), new RegExp(String(RET.DOOR_CLOSED)));
  assert.equal(closed.calls.length, 0, '门关不许下发 call');

  const open = makeWorld({ egress: true, ratePerMin: 1 }, undefined, null, ann);
  await open.world.start(fakeHost().host);
  open.fire(cbpMsg());
  assert.match(txt(await send(open, { conv: '  ', text: 'hi' })), /bad_args/);
  assert.equal(await send(open, { conv: 's1', text: 'hi' }), 'sent');
  assert.equal(open.calls[0]!.tool, 'maibot_send', '下发能力名必须与桥 hello.tools 逐字一致');
  assert.equal(open.calls[0]!.args.conv, 's1');
  assert.equal(open.calls[0]!.args.text, 'hi');
  assert.match(txt(await send(open, { conv: 's1', text: 'hi2' })), /rate_limited/, '限流窗内第二次必须拒');

  const streams = open.world.tools().find((t) => t.name === 'maibot_streams')!;
  await streams.handler!({ platform: 'qq' }, { role: 'p', log } as never);
  assert.equal(open.calls.at(-1)!.tool, 'chat.get_all_streams', '流清单能力名逐字（chat.py:57-59 @f9984673d）');
  assert.equal(open.calls.at(-1)!.args.platform, 'qq');
});

// ── F3：call 带 turn + actor，__turn 私位退场；交集闸决定能否下发 ───────────────

test('对端没申报的能力：peer_call 本地判 60002 capability_unavailable，绝不发出 call（删掉盲下发通路）', async () => {
  const f = makeWorld({});
  await f.world.start(fakeHost().host);
  f.fire(cbpMsg({ id: 'm-9' }));
  await new Promise((r) => setImmediate(r));
  const out = await f.world.tools().find((t) => t.name === 'maibot_peer_call')!.handler({ tool: 'maibot_send' }, { role: 'p', log } as never);
  assert.match(typeof out === 'string' ? '' : out.text, /60002 capability_unavailable/);
  assert.equal(f.calls.length, 0, '对端未申报 → 不许下发 call 帧');
});

test('peer_call：对端 catalog 申报某能力后才下发；call 带本轮 turn 与 actor，args 不带 __turn 私位', async () => {
  const f = makeWorld({});
  await f.world.start(fakeHost().host);
  f.fire(cbpMsg({ id: 'm-42' }));
  await new Promise((r) => setImmediate(r));
  // 交集闸：没申报的名单先拒，申报了才放行（证明权威=对端 hello/catalog）。
  const cold = await f.world.tools().find((t) => t.name === 'maibot_peer_call')!.handler({ tool: 'neko_nope' }, { role: 'p', log } as never);
  assert.match(typeof cold === 'string' ? '' : cold.text, /60002 capability_unavailable/);
  f.fire({ v: 1, t: 'catalog', id: 'c1', ts: 0, tools: [{ name: 'maibot_send', risk: 'write', confirm_required: true }] as ToolAnn[] });
  const out = await f.world.tools().find((t) => t.name === 'maibot_peer_call')!.handler({ tool: 'maibot_send', args: { conv: 'c1', text: '你好' } }, { role: 'p', log } as never);
  assert.equal(out, 'sent');
  assert.equal(f.calls.length, 1);
  const c = f.calls[0]!;
  assert.equal(c.tool, 'maibot_send');
  assert.ok(!('__turn' in c.args), '__turn 私位必须退场：turn 走协议位（收口）');
  assert.equal(c.turn, 'm-42');
  assert.equal(c.actor.platform, 'aiocqhttp');
  assert.equal(c.actor.conv, 's1');
  assert.deepEqual(c.actor.member, { id: '555', name: 'u' });
  assert.equal(c.actor.anon, 'identified');
});

test('本轮没有桥消息 → peer_call 直接拒（no turn identity），不发出 call', async () => {
  const f = makeWorld({});
  await f.world.start(fakeHost().host);
  const out = await f.world.tools().find((t) => t.name === 'maibot_peer_call')!.handler({ tool: 'maibot_send' }, { role: 'p', log } as never);
  assert.match(typeof out === 'string' ? '' : out.text, /no turn identity/);
  assert.equal(f.calls.length, 0);
});

test('reply.ok=false 带 error.code：逐字带码返回', async () => {
  const f = makeWorld({}, async () => replyOk({ ok: false, error: { code: RET.SEND_UNCERTAIN, message: '结果未知' } } as Frame));
  await f.world.start(fakeHost().host);
  f.fire(cbpMsg());
  await new Promise((r) => setImmediate(r));
  f.fire({ v: 1, t: 'catalog', id: 'c1', ts: 0, tools: [{ name: 'maibot_send', risk: 'write', confirm_required: true }] as ToolAnn[] });
  const out = await f.world.tools().find((t) => t.name === 'maibot_peer_call')!.handler({ tool: 'maibot_send' }, { role: 'p', log } as never);
  assert.match(typeof out === 'string' ? '' : out.text, /60007 send_uncertain: 结果未知/);
});

test('callTool 超时拒绝（60007）→ send_uncertain 文案', async () => {
  const f = makeWorld({}, async () => {
    throw err(RET.SEND_UNCERTAIN, 'no reply inside timeout');
  });
  await f.world.start(fakeHost().host);
  f.fire(cbpMsg());
  await new Promise((r) => setImmediate(r));
  f.fire({ v: 1, t: 'catalog', id: 'c1', ts: 0, tools: [{ name: 'maibot_send', risk: 'write', confirm_required: true }] as ToolAnn[] });
  const out = await f.world.tools().find((t) => t.name === 'maibot_peer_call')!.handler({ tool: 'maibot_send' }, { role: 'p', log } as never);
  assert.match(typeof out === 'string' ? '' : out.text, /60007 send_uncertain/);
});

test('driver 抛 60006（内核 callTool 无 ready 对端即拒）→ 逐字带码返回', async () => {
  const f = makeWorld({}, async () => {
    throw err(RET.PEER_UNREACHABLE, 'no ready peer for call');
  });
  await f.world.start(fakeHost().host);
  f.fire(cbpMsg());
  await new Promise((r) => setImmediate(r));
  f.fire({ v: 1, t: 'catalog', id: 'c1', ts: 0, tools: [{ name: 'maibot_send', risk: 'write', confirm_required: true }] as ToolAnn[] });
  const out = await f.world.tools().find((t) => t.name === 'maibot_peer_call')!.handler({ tool: 'maibot_send' }, { role: 'p', log } as never);
  assert.match(typeof out === 'string' ? '' : out.text, /60006 peer_unreachable: no ready peer for call/);
});

test('status：连接态 + caps 交集 + self-echo 位 + catalog + degraded + egress（§3.2 tools 模板行 2；§2.4）', async () => {
  const f = makeWorld({ egress: true }, undefined, provenSelf);
  await f.world.start(fakeHost().host);
  f.fire({ v: 1, t: 'catalog', id: 'c1', ts: 0, tools: [{ name: 'maibot_send', risk: 'write', confirm_required: true }] as ToolAnn[] });
  const st = JSON.parse((await f.world.tools().find((t) => t.name === 'maibot_status')!.handler({}, { role: 'p', log } as never)) as string);
  assert.equal(st.egress, true);
  assert.deepEqual(st.caps, ['images', 'notices', 'tools']);
  assert.equal(st.selfEcho, 'on');
  assert.deepEqual(st.catalog.map((x: ToolAnn) => x.name), ['maibot_send']);
  const cold = JSON.parse((await makeWorld({}).world.tools().find((t) => t.name === 'maibot_status')!.handler({}, { role: 'p', log } as never)) as string);
  assert.equal(cold.selfEcho, 'off', '没连上/没实证 → self-echo:off 常驻一位（§2.4）');
});

test('history 只查 host.store(source=maibot)，不查对端', async () => {
  const f = makeWorld({});
  await f.world.start(fakeHost().host);
  const rows = JSON.parse((await f.world.tools().find((t) => t.name === 'maibot_history')!.handler({ limit: 5 }, { role: 'p', log } as never)) as string);
  assert.equal(rows.length, 1);
  assert.equal(f.calls.length, 0);
});

// ── F1/F2：回声抑制吃协商供给 ────────────────────────────────────

test('msg mention/direct → flush；group/other → 缺省（types.ts:633 debounce）', async () => {
  const f = makeWorld({});
  const { host, events } = fakeHost();
  await f.world.start(host);
  f.fire(cbpMsg({ kind: 'mention' }));
  f.fire(cbpMsg({ id: 'm-2', kind: 'group' }));
  await new Promise((r) => setImmediate(r));
  const msgs = events.filter((x) => x.e.type === 'maibot.message');
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0]!.opts, { trigger: 'flush' });
  assert.deepEqual(msgs[1]!.opts, {});
  assert.equal(msgs[0]!.e.meta?.platformMsgId, '9');
});

test('协商 proven:true → 同 id 的 msg 走 .message.self + deliver:false（不再靠 raw.account_id 私判）', async () => {
  const f = makeWorld({}, undefined, provenSelf);
  const { host, events } = fakeHost();
  await f.world.start(host);
  f.fire(cbpMsg({ sender: { id: 'bot1', name: 'me' } }));
  await new Promise((r) => setImmediate(r));
  const self = events.find((x) => x.e.type === 'maibot.message.self');
  assert.ok(self, '实证 self 命中 → 只归档');
  assert.deepEqual(self!.opts, { deliver: false });
  assert.equal((self!.e as { contextDelivery?: string }).contextDelivery, undefined);
});

test('proven:false 或没有 self → 照常投递 + 一条显式 self-unknown 降级（§2.4 禁两种静默）', async () => {
  const f = makeWorld({});
  const { host, events } = fakeHost();
  await f.world.start(host);
  f.fire(cbpMsg({ sender: { id: 'bot1', name: 'me' } }));
  f.fire(cbpMsg({ id: 'm-2', sender: { id: 'bot1', name: 'me' } }));
  await new Promise((r) => setImmediate(r));
  const delivered = events.filter((x) => x.e.type === 'maibot.message');
  assert.equal(delivered.length, 2, '没实证就不许吞消息');
  assert.ok(delivered.every((x) => x.opts?.deliver !== false));
  assert.ok(!events.some((x) => x.e.type === 'maibot.message.self'), '没有 proven 证据就不改类型');
  const deg = events.filter((x) => x.e.type === 'maibot.degraded' && String(x.e.text).includes('self-unknown'));
  assert.equal(deg.length, 1, 'self-unknown 显式记一次，不重复刷屏');
});

test('图片段：模型吃 → blobs；不吃 → model-rejects 降级、无 blobs', async () => {
  const png = { type: 'image', data: { file: 'a.png', base64: 'QUJD' } };
  const f1 = makeWorld({});
  const h1 = fakeHost((m) => m === 'image/png');
  await f1.world.start(h1.host);
  f1.fire(cbpMsg({ segments: [png] }));
  await new Promise((r) => setImmediate(r));
  assert.equal((h1.events.find((x) => x.e.type === 'maibot.message')?.e.blobs ?? []).length, 1);

  const f2 = makeWorld({});
  const h2 = fakeHost(() => false);
  await f2.world.start(h2.host);
  f2.fire(cbpMsg({ id: 'm-9', segments: [png] }));
  await new Promise((r) => setImmediate(r));
  const ev = h2.events.find((x) => x.e.type === 'maibot.message');
  assert.ok(!ev?.e.blobs?.length);
  assert.ok(h2.events.some((x) => x.e.type === 'maibot.degraded' && String(x.e.text).includes('model-rejects:image/png')));
});

test('未知段 → [type] 占位不吞消息（C1-16 渲染在内核）+ degraded 事件', async () => {
  const f = makeWorld({});
  const { host, events } = fakeHost();
  await f.world.start(host);
  f.fire(cbpMsg({ segments: [{ type: 'text', data: { text: '前' } }, { type: 'sticker', data: { id: '1' } }, { type: 'text', data: { text: '后' } }] }));
  await new Promise((r) => setImmediate(r));
  const msg = events.find((x) => x.e.type === 'maibot.message');
  assert.equal(msg?.e.text, '前[sticker]后');
  assert.ok(events.some((x) => x.e.type === 'maibot.degraded' && String(x.e.text).includes('unknown-segment:sticker')));
});

test('notice → piggyback；connection/degraded event → flush internal', async () => {
  const f = makeWorld({});
  const { host, events } = fakeHost();
  await f.world.start(host);
  f.fire({ v: 1, t: 'notice', id: 'n1', ts: 1, kind: 'recall', raw: { message_id: '9' } });
  f.fire({ v: 1, t: 'event', id: 'e1', ts: 2, name: 'connection', data: { up: true } });
  f.fire({ v: 1, t: 'event', id: 'e2', ts: 3, name: 'degraded', data: { reason: 'rate' } });
  await new Promise((r) => setImmediate(r));
  const n = events.find((x) => x.e.type === 'maibot.notice');
  assert.deepEqual(n?.opts, { trigger: 'piggyback' });
  const c = events.find((x) => x.e.type === 'maibot.connection');
  assert.deepEqual(c?.opts, { trigger: 'flush' });
  assert.equal(c?.e.origin, 'internal');
  const d = events.find((x) => x.e.type === 'maibot.degraded');
  assert.ok(d);
});

test('桥侧 call 帧：v1 不服务，回 10002 unsupported_action 而不是让对端挂起', async () => {
  const f = makeWorld({});
  await f.world.start(fakeHost().host);
  f.fire({
    v: 1,
    t: 'call',
    id: 'x1',
    ts: 0,
    rid: 'q1',
    tool: 'anything',
    args: {},
    turn: 'm-1',
    actor: { platform: 'aiocqhttp', conv: 's1', member: { id: '555', name: 'u' }, anon: 'identified' },
  });
  const rep = f.sentFrames.find((x) => x.t === 'reply');
  assert.ok(rep && rep.t === 'reply');
  assert.equal(rep.rid, 'q1');
  assert.equal(rep.ok, false);
  assert.equal(rep.error?.code, RET.UNSUPPORTED_ACTION);
});

test('envPromptVars 键 = ENV_PROMPT.md 占位符 = promptDocs.vars（三方一致）', async () => {
  const f = makeWorld({});
  await f.world.start(fakeHost().host);
  const keys = Object.keys(f.world.envPromptVars()).sort();
  const tpl = readFileSync(fileURLToPath(new URL('../src/ENV_PROMPT.md', import.meta.url)), 'utf8');
  const placeholders = [...tpl.matchAll(/\{\{(maibot\.[a-zA-Z]+)[^}]*\}\}/g)].map((m) => m[1]!);
  const vars = (f.world.webUi!().promptDocs?.[0]?.vars ?? []).map((v) => v.name).sort();
  assert.deepEqual(keys, vars);
  for (const p of placeholders) assert.ok(keys.includes(p), `模板占位符 ${p} 没有运行时值`);
});

test('空 segments 不炸：投递仍发生、正文空串', async () => {
  const f = makeWorld({});
  const { host, events } = fakeHost();
  await f.world.start(host);
  f.fire(cbpMsg({ segments: [] }));
  await new Promise((r) => setImmediate(r));
  assert.equal(events.find((x) => x.e.type === 'maibot.message')?.e.text, '');
});

test('只在 hello/ready 申报、从不发 catalog 帧的桥：能力照样可下发（回归 F1 权威面）', async () => {
  const f = makeWorld({}, undefined, null, [{ name: 'maibot_send', risk: 'write', confirm_required: true }]);
  await f.world.start(fakeHost().host);
  f.fire(cbpMsg({ id: 'm-77' }));
  await new Promise((r) => setImmediate(r));
  const out = await f.world.tools().find((t) => t.name === 'maibot_peer_call')!.handler({ tool: 'maibot_send', args: { conv: 'c1', text: '你好' } }, { role: 'p', log } as never);
  assert.equal(out, 'sent', '握手申报即视为已申报；只看 catalog 帧会把这条判成 60002');
  assert.equal(f.calls.length, 1);
  const cold = await f.world.tools().find((t) => t.name === 'maibot_peer_call')!.handler({ tool: 'neko_nope' }, { role: 'p', log } as never);
  assert.match(typeof cold === 'string' ? '' : cold.text, /60002 capability_unavailable/, '并集不等于放开：两边都没申报的仍拒');
});

test('envPrompt 的工具行吃并集：握手申报的名单不能显示成「桥没报清单」', async () => {
  const f = makeWorld({}, undefined, null, [{ name: 'maibot_send', risk: 'write', confirm_required: true }]);
  await f.world.start(fakeHost().host);
  const vars = (f.world as unknown as { envPromptVars?: () => Record<string,string> }).envPromptVars?.() ?? {};
  if (!('maibot.tools' in vars)) {
    // 该包用 promptDocs 的函数形态时走这条路
    const docs = f.world.webUi().promptDocs ?? [];
    const hit = docs.some((d) => JSON.stringify(d).includes('maibot_send'));
    assert.ok(hit, '提示词面必须出现握手申报的工具名');
    return;
  }
  assert.match(String(vars['maibot.tools']), /maibot_send/);
});
