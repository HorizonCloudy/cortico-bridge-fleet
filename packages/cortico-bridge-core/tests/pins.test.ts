/** pins: spec/pins.json is the hard single source for caps (F13); snapshot fallback is gone. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINS, loadPins } from '../src/pins.js';

/** the live fleet spec file the module itself reads at init (dist/tests -> 4 up = fleet root) */
const SPEC_PINS = fileURLToPath(new URL('../../../../spec/pins.json', import.meta.url));

function fixture(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'cbp-pins-'));
  const file = join(dir, 'pins.json');
  writeFileSync(file, JSON.stringify(obj));
  return file;
}

/** a caps section the loader must accept, mirroring SECURITY-CBP §4.2 shape */
function goodCaps(): Record<string, unknown> {
  return {
    caps: {
      cbp: { frame_bytes: 524288, text_bytes: 524288, media_bytes: 8388608, action: 'reject' },
      neko: { frame_bytes: 524061, text_bytes: null, media_bytes: 8388608, action: 'reject' },
      maibot: { frame_bytes: null, text_bytes: null, media_bytes: null, action: 'host-ask' },
      astrbot: { frame_bytes: null, text_bytes: null, media_bytes: 6291456, action: 'reject' },
      onebot: { frame_bytes: null, text_bytes: 4000, media_bytes: null, action: 'degrade' },
      notes: {
        neko_frame_bytes: '524288 − 227 = 524061（plugin/settings.py:588 / core/context.py:247-252 @52e973ed2）',
        maibot_media_bytes: '宿主每包声明 max_bytes（maibot_sdk/capabilities/files.py:74-75 @f9984673d）',
        astrbot_media_bytes: 'bridge.py:50,79-80 @37c1e6ccd 折算解码 6MiB',
        onebot_media_bytes: '平台侧未测 config.js:36',
        neko_text_bytes: '[未核验] 无独立文本上限（SECURITY-CBP.md:174）',
        unit: 'media_bytes 按解码字节计',
        unverified: '未测线记 null',
      },
    },
    vocab: { cbp: { caps: ['images'] } },
  };
}

test('snapshot carries the fleet floor and the ws-only runtime dep', () => {
  assert.equal(PINS.node, '>=22.16.0');
  assert.equal(PINS.ws, '^8.18.0');
  assert.equal(PINS.cbpVersion, 1);
});

test('neko pins the SDK space, not the app version', () => {
  assert.equal(PINS.hosts.neko.sdkVersion, '0.1.0');
  assert.equal(PINS.hosts.neko.pluginSupported, '>=0.1.0,<0.2.0');
  assert.equal(PINS.hosts.neko.version, '0.9.1');
  assert.equal(PINS.hosts.neko.python, '==3.11.*');
});

test('cortico contract and previous-hop width', () => {
  assert.equal(PINS.cortico.api, 6);
  assert.equal(PINS.cortico.previousApi, 5);
  assert.equal(PINS.cortico.sha9, '836238311');
});

test('astrbot ff sha and koishi/nonebot lines', () => {
  assert.equal(PINS.hosts.astrbot.sha9, '133dd9f86');
  assert.equal(PINS.hosts.koishi.sha9, '97d5c3957');
  assert.equal(PINS.hosts.nonebot.sha9, '2450b67a1');
  assert.equal(PINS.hosts.cordis.version, '^3.18.1');
});

test('loadPins yields a complete Pins and maps the live spec/pins.json', () => {
  const p = loadPins();
  assert.equal(typeof p.node, 'string');
  assert.match(p.node, /^>=/);
  assert.equal(typeof p.ws, 'string');
  assert.equal(p.hosts.neko.pluginSupported, PINS.hosts.neko.pluginSupported); // SDK-space never overridden to APP_VERSION
  assert.equal(p.hosts.neko.python, '==3.11.*');
  assert.equal(p.ports.nekoListen, 39701);
  assert.equal(p.ports.maibotListen, 39702);
});

// ---- L6 item 3: caps 真单源 — spec/pins.json 说了算，读不到 caps 段必须明确失败。

test('PINS.caps IS the spec/pins.json caps section — no package-side numbers (F13)', () => {
  const j = JSON.parse(readFileSync(SPEC_PINS, 'utf8')) as { caps: Record<string, unknown> };
  assert.ok(j.caps && typeof j.caps === 'object', 'spec/pins.json 必须带 caps 段');
  for (const line of ['cbp', 'neko', 'maibot', 'astrbot', 'onebot'] as const) {
    assert.deepEqual(PINS.caps[line], j.caps[line], `PINS.caps.${line} 必须逐字等于文件值`);
  }
});

test('caps 六数 verbatim（SECURITY-CBP §4.2），钉住文件不漂', () => {
  assert.deepEqual(PINS.caps.cbp, { frame_bytes: 524288, text_bytes: 524288, media_bytes: 8388608, action: 'reject' });
  assert.deepEqual(PINS.caps.neko, { frame_bytes: 524061, text_bytes: null, media_bytes: 8388608, action: 'reject' });
  assert.deepEqual(PINS.caps.maibot, { frame_bytes: null, text_bytes: null, media_bytes: null, action: 'host-ask' });
  assert.deepEqual(PINS.caps.astrbot, { frame_bytes: null, text_bytes: null, media_bytes: 6291456, action: 'reject' });
  assert.deepEqual(PINS.caps.onebot, { frame_bytes: null, text_bytes: 4000, media_bytes: null, action: 'degrade' });
  for (const line of Object.values(PINS.caps)) {
    if (line && typeof line === 'object' && 'action' in line) {
      assert.ok(['reject', 'host-ask', 'degrade'].includes((line as { action: string }).action));
    }
  }
});

test('cap vocabulary comes straight from spec/pins.json vocab.cbp.caps', () => {
  const j = JSON.parse(readFileSync(SPEC_PINS, 'utf8')) as { vocab: { cbp: { caps: string[] } } };
  assert.deepEqual(PINS.capsVocab, j.vocab.cbp.caps);
  assert.equal(PINS.capsVocab.length, 9); // images…history_backfill（CBP-v1.json $defs.caps）
});

test('loadPins throws when the caps section is missing — never silently uses old values', () => {
  assert.throws(() => loadPins(fixture({ vocab: { cbp: { caps: ['images'] } } })), /caps/);
});

test('loadPins throws when vocab.cbp.caps is missing, empty, or not a string array', () => {
  assert.throws(() => loadPins(fixture({ caps: (goodCaps() as { caps: unknown }).caps })), /vocab\.cbp\.caps/);
  assert.throws(
    () => loadPins(fixture({ caps: (goodCaps() as { caps: unknown }).caps, vocab: { cbp: { caps: [] } } })),
    /vocab\.cbp\.caps/,
  );
  assert.throws(
    () => loadPins(fixture({ caps: (goodCaps() as { caps: unknown }).caps, vocab: { cbp: { caps: 'images' } } })),
    /vocab\.cbp\.caps/,
  );
});

test('loadPins throws on a malformed caps line instead of keeping a fallback', () => {
  const bad: Array<[string, (c: Record<string, unknown>) => void]> = [
    ['cbp.frame_bytes string', (c) => { (c.cbp as Record<string, unknown>).frame_bytes = '524288'; }],
    ['cbp.frame_bytes null', (c) => { (c.cbp as Record<string, unknown>).frame_bytes = null; }],
    ['action outside the three values', (c) => { (c.cbp as Record<string, unknown>).action = 'explode'; }],
    ['missing key in a line', (c) => { delete (c.neko as Record<string, unknown>).media_bytes; }],
    ['missing line', (c) => { delete c.astrbot; }],
  ];
  for (const [what, mutate] of bad) {
    const g = goodCaps() as { caps: Record<string, unknown> };
    mutate(g.caps);
    assert.throws(() => loadPins(fixture(g)), /caps/, `${what}: 必须抛错而不是静默兜底`);
  }
});

test('loadPins throws when spec/pins.json itself is unreadable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbp-pins-'));
  assert.throws(() => loadPins(join(dir, 'nope.json')), /读不到|pins/);
});

test('a well-formed external file still overrides every caps line and the vocabulary', () => {
  const g = goodCaps() as { caps: Record<string, unknown>; vocab: { cbp: { caps: string[] } } };
  g.caps.neko = { frame_bytes: 999, text_bytes: null, media_bytes: null, action: 'host-ask' };
  g.vocab.cbp.caps = ['images', 'notices'];
  const p = loadPins(fixture(g));
  assert.deepEqual(p.caps.neko, { frame_bytes: 999, text_bytes: null, media_bytes: null, action: 'host-ask' });
  assert.deepEqual(p.capsVocab, ['images', 'notices']);
});
