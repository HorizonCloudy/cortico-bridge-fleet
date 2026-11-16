// 改名账映射单测 — d-break-change.md §9.1 four rows, verbatim.
// Rule under test: 旧名兼容读、新名唯一写 (old name is a read alias, only the
// new name may ever be written). Row order and count are asserted against the
// report so the ledger cannot drift from the evidence.
// Run: node --test tests/rename/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readReport, evidencePath, readText, exists } from '../_lib/evidence.mjs';
import { RENAME_ROWS, compatRead, uniqueWrite, mechanicalEntries, pathExists } from './ledger.mjs';

const REPORT = 'd-break-change.md';

// The four d-break-change §9.1 rows, in table order, each ≤80 chars verbatim cell head.
const FOUR_ROWS = [
  '| Pal-AI-Lab/Cortico | `console()` → `webUi()`（World/Persona/provider）',
  '| Mai-with-u/maibot-plugin-sdk | 作用域三键从 `metadata` 内 → 组件对象顶层：`platforms`、`chat_scope`、`allowed_session`',
  '| AstrBot | `metadata.yaml` 键 `pages` → `views`；WebUI 概念 Pages → Views',
  '| cordisjs/cordis v4 | `ctx.plugin()` → `ctx.use()`；`entry.fiber` → `entry.innerFiber`',
];

test('ledger holds exactly the four d-break-change §9.1 rows, in order', () => {
  assert.equal(RENAME_ROWS.length, 4);
  assert.deepEqual(RENAME_ROWS.map((r) => r.id), ['cortico', 'maibot-sdk', 'astrbot', 'cordis']);
  for (const row of RENAME_ROWS) {
    assert.ok(row.sha9 && row.source, `row ${row.id} missing sha9/source`);
    assert.ok(row.entries.length >= 1, `row ${row.id} has no entries`);
    for (const e of row.entries) {
      const news = Array.isArray(e.new) ? e.new : [e.new];
      assert.ok(!news.includes(e.old), `row ${row.id}: old/new name collide for ${e.old}`);
    }
  }
});

test('every ledger verbatim quote is present in d-break-change.md', () => {
  const text = readReport(REPORT);
  assert.ok(text !== null, `缺证据文件 reports/${REPORT}`);
  for (const row of RENAME_ROWS) {
    const hits = text.split(row.verbatim).length - 1;
    assert.ok(hits >= 1, `quote not found in report: ${row.verbatim}`);
    assert.ok(row.verbatim.length <= 80, `quote longer than 80 chars: ${row.id}`);
  }
});

test('d-break-change §9.1 table has exactly four data rows', () => {
  const text = readReport(REPORT);
  assert.ok(text !== null, `缺证据文件 reports/${REPORT}`);
  const section = text.slice(text.indexOf('### 9.1 改名'), text.indexOf('### 9.2'));
  const dataRows = section.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('|---') && !l.startsWith('| 仓 '));
  assert.equal(dataRows.length, 4, `expected 4 rows, got ${dataRows.length}`);
  for (const probe of FOUR_ROWS) {
    assert.ok(dataRows.some((l) => l.startsWith(probe.split(' | ')[0])), `row head missing: ${probe.slice(0, 30)}`);
  }
});

test('host-side evidence files still carry the renamed pair sources', () => {
  const checks = [
    ['repos/cortico/src/extensions/previous-contract.ts', ['consoleClient', 'webUiClient', "terminal: 'console'"]],
    ['repos/astrbot/astrbot/core/star/star_manager.py', ['"views" is the preferred key', 'metadata["views"]', 'metadata["pages"]']],
    ['upstream/maibot-plugin-sdk/maibot_sdk/components.py', ['platforms', 'chat_scope', 'allowed_session', '.pop(field)']],
  ];
  for (const [rel, needles] of checks) {
    const abs = evidencePath(rel);
    if (!exists(abs)) continue; // evidence clone absent: pins test reports that
    const text = readText(abs);
    for (const n of needles) assert.ok(text.includes(n), `${rel} lost token ${n}`);
  }
});

test('旧名兼容读: an object carrying only old names still reads', () => {
  const cases = [
    ['cortico', 0, { consoleClient: 'a.js' }, 'a.js'],
    ['cortico', 1, { consoleStyle: 'a.css' }, 'a.css'],
    ['astrbot', 0, { pages: [{ x: 1 }] }, [{ x: 1 }]],
    ['maibot-sdk', 0, { metadata: { platforms: ['qq'] } }, ['qq']],
    ['cordis', 0, { plugin() {} }, undefined], // function value: identity check below
  ];
  for (const [rowId, idx, obj, want] of cases) {
    const row = RENAME_ROWS.find((r) => r.id === rowId);
    const e = row.entries[idx];
    const got = compatRead(row, e, obj);
    if (want === undefined) assert.equal(typeof got, 'function');
    else assert.deepEqual(got, want, `${rowId}/${e.old}`);
  }
});

test('旧名兼容读: new name wins when both present (previous-contract.ts:40)', () => {
  const row = RENAME_ROWS.find((r) => r.id === 'cortico');
  assert.equal(compatRead(row, row.entries[0], { consoleClient: 'old', webUiClient: 'new' }), 'new');
  const ab = RENAME_ROWS.find((r) => r.id === 'astrbot');
  assert.deepEqual(compatRead(ab, ab.entries[0], { pages: ['p'], views: ['v'] }), ['v']);
  const mb = RENAME_ROWS.find((r) => r.id === 'maibot-sdk');
  assert.deepEqual(compatRead(mb, mb.entries[0], { platforms: ['top'], metadata: { platforms: ['old'] } }), ['top']);
});

test('新名唯一写: writing an old-name object emits only the new name', () => {
  const samples = [
    ['cortico', 0, { consoleClient: 'a.js' }],
    ['cortico', 1, { consoleStyle: 'a.css' }],
    ['astrbot', 0, { pages: [{ x: 1 }] }],
    ['maibot-sdk', 0, { metadata: { platforms: ['qq'] } }],
    ['maibot-sdk', 1, { metadata: { chat_scope: 'group' } }],
    ['maibot-sdk', 2, { metadata: { allowed_session: ['g'] } }],
    ['cordis', 1, { fiber: 'f' }],
  ];
  for (const [rowId, idx, obj] of samples) {
    const row = RENAME_ROWS.find((r) => r.id === rowId);
    const e = row.entries[idx];
    const out = uniqueWrite(row, e, obj);
    assert.ok(pathExists(out, e.new), `${rowId}/${e.old}: new name missing after write`);
    assert.ok(!pathExists(out, e.old), `${rowId}/${e.old}: old name emitted by write`);
  }
});

test('新名唯一写: old value is preserved under the new name', () => {
  const ab = RENAME_ROWS.find((r) => r.id === 'astrbot');
  const out = uniqueWrite(ab, ab.entries[0], { pages: [{ x: 1 }] });
  assert.deepEqual(out, { views: [{ x: 1 }] });
  const mb = RENAME_ROWS.find((r) => r.id === 'maibot-sdk');
  const out2 = uniqueWrite(mb, mb.entries[0], { name: 'f', metadata: { platforms: ['qq'], handler_name: 'f' } });
  assert.deepEqual(out2, { name: 'f', metadata: { handler_name: 'f' }, platforms: ['qq'] });
});

test('cordis prefix rename: @cordisjs/plugin-* → @cordisjs/*, write emits new only', () => {
  const cordis = RENAME_ROWS.find((r) => r.id === 'cordis');
  const e = cordis.entries.find((x) => x.kind === 'prefix');
  assert.equal(compatRead(cordis, e, '@cordisjs/plugin-memory'), '@cordisjs/memory');
  assert.equal(uniqueWrite(cordis, e, '@cordisjs/plugin-memory'), '@cordisjs/memory');
  assert.equal(compatRead(cordis, e, 'koishi-plugin-adapter-onebot'), 'koishi-plugin-adapter-onebot');
});

test('cordis split rename: fiber.store reads from either new name, write drops old', () => {
  const cordis = RENAME_ROWS.find((r) => r.id === 'cordis');
  const e = cordis.entries.find((x) => x.kind === 'split');
  assert.deepEqual(e.new, ['committed', 'provisions']);
  assert.equal(compatRead(cordis, e, { store: 'x' }), 'x');
  assert.equal(compatRead(cordis, e, { committed: 'c' }), 'c');
  const out = uniqueWrite(cordis, e, { store: 'x', committed: 'c' });
  assert.ok(!('store' in out) && out.committed === 'c');
});

test('every mechanical entry satisfies read-compat and write-new-only', () => {
  for (const { row, entry } of mechanicalEntries()) {
    if (entry.kind === 'id' || entry.kind === 'prefix') {
      const probe = entry.kind === 'id' ? entry.old : `${entry.old}demo`;
      assert.equal(compatRead(row, entry, probe), entry.kind === 'id' ? entry.new : `${entry.new}demo`);
      continue;
    }
    const oldOnly = {};
    const segs = entry.old.split('.');
    let cur = oldOnly;
    for (const s of segs.slice(0, -1)) cur = cur[s] ??= {};
    cur[segs.at(-1)] = 'V';
    assert.equal(compatRead(row, entry, oldOnly), 'V', `${row.id}/${entry.old} compat read`);
    const out = uniqueWrite(row, entry, oldOnly);
    assert.ok(!pathExists(out, entry.old), `${row.id}/${entry.old} leaked through write`);
    if (entry.kind !== 'split') assert.ok(pathExists(out, entry.new), `${row.id}/${entry.new} missing after write`);
  }
});
