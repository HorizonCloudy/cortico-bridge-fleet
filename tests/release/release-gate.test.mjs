// README/CHANGELOG/describe 三项发布前置检查 — tests for the fleet release gate.
// The gate rules live in ../_lib/release-gate.mjs (ported from Cortico: author-guide.ts
// :107-113 + describe-export.ts:110-169 + types.ts:202 @836238311; tools() 四件 from
// _BUILD-PLAN §3.2). This file proves the gate (a) catches each violation and
// (b) agrees with the one fleet package that has all three artifacts landed.
// The gate is a pre-RELEASE check: every package that exists under packages/ must pass
// all three preconditions, or the suite fails. The old t.skip path (pending work orders
// reported, not passed) was retired by N4-release-preq on 2026-11-16 — see
// reports/N4-release-preq.md §4 for the artifacts that close it.
// Run: node --test tests/release/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLEET_ROOT } from '../_lib/evidence.mjs';
import { releaseGate, changelogHasVersion, TOOL_TAGS, MARKET_TAGS, FOUR_TOOLS } from '../_lib/release-gate.mjs';

function makePkg(root, {
  name = 'cortico-world-x', version = '0.1.0', readme = '# x\n',
  chlog = '## 0.1.0\n- init\n', describe = true, tools = ['x_status'], srcTools = [],
}) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  const pkg = { name, version, cortico: { kind: 'world', api: 6, ...(describe ? { describe: 'describe.json' } : {}) } };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  if (readme !== null) writeFileSync(join(dir, 'README.md'), readme);
  if (chlog !== null) writeFileSync(join(dir, 'CHANGELOG.md'), chlog);
  if (describe) {
    writeFileSync(join(dir, 'describe.json'), JSON.stringify({ tools: tools.map((n) => ({ name: n, tags: ['read'] })), events: [] }));
  }
  if (srcTools.length) writeFileSync(join(dir, 'src/world.ts'), srcTools.map((n) => `{ name: '${n}' }`).join('\n'));
  return dir;
}

const tmp = mkdtempSync(join(tmpdir(), 'fleet-relgate-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('gate passes a complete synthetic world package', () => {
  assert.deepEqual(releaseGate(makePkg(tmp, { tools: ['x_status', 'x_send', 'x_peek'] })), []);
});

test('gate fails on each missing precondition individually', () => {
  assert.ok(releaseGate(makePkg(join(tmp, 'a'), { readme: null })).some((f) => f.includes('README')));
  assert.ok(releaseGate(makePkg(join(tmp, 'b'), { chlog: '## 0.0.9\n- old\n' })).some((f) => f.includes('## 0.1.0')));
  assert.ok(releaseGate(makePkg(join(tmp, 'c'), { describe: false })).some((f) => f.includes('cortico.describe')));
});

test('gate needs a real panel client when cortico.webUiClient is declared', () => {
  const dir = makePkg(join(tmp, 'panel'), { tools: ['x_status'] });
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  pj.cortico.webUiClient = 'src/webui/client.js';
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pj));
  // 声明了却没产物：正是宿主「缺少面板构建产物」那张卡片的成因。
  assert.ok(releaseGate(dir).some((f) => f.includes('面板产物缺失')), '缺产物必须红');
  mkdirSync(join(dir, 'src', 'webui'), { recursive: true });
  writeFileSync(join(dir, 'src', 'webui', 'client.js'), 'export default { thing: 1 };\n');
  assert.ok(releaseGate(dir).some((f) => f.includes('panels')), '客户端形状不对必须红');
  writeFileSync(join(dir, 'src', 'webui', 'client.js'), 'export default { panels: { status: { mount: async () => {} } } };\n');
  assert.deepEqual(releaseGate(dir), [], '产物齐了就应当绿');
});

test('gate rejects undeclared tool names, out-of-vocab tags, and a wrong api', () => {
  const dir = makePkg(join(tmp, 'd'), { tools: ['x_status'], srcTools: ['x_status', 'x_secret'] });
  assert.ok(releaseGate(dir).some((f) => f.includes('x_secret')));
  const bad = makePkg(join(tmp, 'e'), { tools: ['x_status'] });
  writeFileSync(join(bad, 'describe.json'), JSON.stringify({ tools: [{ name: 'x_status', tags: ['teleport'] }], events: [] }));
  assert.ok(releaseGate(bad).some((f) => f.includes('teleport')));
  const api = makePkg(join(tmp, 'g'), { tools: ['x_status'] });
  const pj = JSON.parse(readFileSync(join(api, 'package.json'), 'utf8'));
  pj.cortico.api = 5;
  writeFileSync(join(api, 'package.json'), JSON.stringify(pj));
  assert.ok(releaseGate(api).some((f) => f.includes('api must be 6')));
});

test('src type-union literals are not tools() declarations, and real undeclared names still fail', () => {
  // 真实形态（world.ts 三个包同款私有方法）：`pushStatusEvent(name: 'connection' | 'degraded', …)`
  // 是 TS 参数类型标注，不是工具申报；上游 checkDescribe 比的是 tools() 运行时返回名
  // （describe-export.ts:134-136），闸不得把它当未声明工具。
  const dir = makePkg(join(tmp, 'i'), { tools: ['x_status'] });
  writeFileSync(join(dir, 'src/world.ts'),
    "  private async pushStatusEvent(name: 'connection' | 'degraded', data: unknown): Promise<void> {}\n" +
    "  { name: 'x_status' }\n");
  assert.deepEqual(releaseGate(dir), [], 'union-type literal must not count as a tool name');
  writeFileSync(join(dir, 'src/world.ts'),
    "  private async pushStatusEvent(name: 'connection' | 'degraded', data: unknown): Promise<void> {}\n" +
    "  { name: 'x_evil' }\n");
  assert.ok(releaseGate(dir).some((f) => f.includes('x_evil')), 'lookahead must not disable the real check');
});

test('gate requires the 四件起步 tools for the two new worlds only', () => {
  const neko = makePkg(join(tmp, 'f'), { name: 'cortico-world-neko', tools: ['neko_status'] });
  assert.deepEqual(FOUR_TOOLS('neko'), ['neko_send_message', 'neko_status', 'neko_history', 'neko_peer_call']);
  assert.equal(releaseGate(neko).filter((f) => f.includes('required tool')).length, 3);
  const astro = makePkg(join(tmp, 'h'), { name: 'cortico-world-astrbot', tools: ['astrbot_call_tool'] });
  assert.deepEqual(releaseGate(astro), []);
});

test('changelogHasVersion port matches author-guide.ts:107-113 semantics', () => {
  assert.ok(changelogHasVersion('## [0.2.0] - 2026-10-15\n', '0.2.0'));
  assert.ok(changelogHasVersion('## 0.1.0-rc.1\n', '0.1.0-rc.1'));
  assert.ok(!changelogHasVersion('# 0.1.0\n', '0.1.0')); // H1 is not a section
  assert.ok(!changelogHasVersion('## Unreleased\n## 0.0.9\n', '0.1.0'));
});

test('ToolTag vocabulary is the six verbatim values from types.ts:202', () => {
  assert.deepEqual([...TOOL_TAGS], ['read', 'write', 'speak', 'act', 'flow', 'snapshot']);
});

test('market tag vocabulary is the 29 ids in cortico-extensions index.json', () => {
  assert.equal(MARKET_TAGS.size, 29);
  for (const t of ['qq', 'im', 'external-setup', 'unofficial-api', 'experimental']) {
    assert.ok(MARKET_TAGS.has(t), `词表应当含 ${t}`);
  }
  assert.ok(!MARKET_TAGS.has('onebot'), 'onebot 不在上游词表，这正是丢 tag 的成因');
});

test('gate rejects a cortico.tags entry outside the market vocabulary', () => {
  const dir = makePkg(join(tmp, 'mk'), { tools: ['x_status'] });
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  pj.cortico.tags = ['qq', 'im', 'onebot'];
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pj));
  const fails = releaseGate(dir);
  assert.ok(fails.some((f) => f.includes('"onebot"')), '词表外 tag 必须红');
  assert.ok(!fails.some((f) => f.includes('"qq"')), '词表内 tag 不得报错');
  pj.cortico.tags = ['qq', 'im'];
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pj));
  assert.deepEqual(releaseGate(dir), [], '全在词表内就应当绿');
});

test('reference package cortico-world-onebot-bridge passes all three pre-release checks', (t) => {
  const dir = join(FLEET_ROOT, 'packages', 'cortico-world-onebot-bridge');
  if (!existsSync(join(dir, 'package.json'))) return t.skip('缺 cortico-world-onebot-bridge（先例参考包）');
  assert.deepEqual(releaseGate(dir), [], 'reference package failed the release gate');
});

test('every landed fleet package is release-ready', () => {
  const pkgsDir = join(FLEET_ROOT, 'packages');
  assert.ok(existsSync(pkgsDir), '缺 packages/*（_BUILD-PLAN §2.3 world 包工单未产出）');
  const dirs = readdirSync(pkgsDir).map((n) => join(pkgsDir, n)).filter((d) => existsSync(join(d, 'package.json')));
  assert.ok(dirs.length > 0, 'packages/* 下一个包都没有');
  const failed = [];
  for (const d of dirs) {
    const fails = releaseGate(d);
    if (fails.length) failed.push(`${d.slice(FLEET_ROOT.length + 1)}: ${fails.join('; ')}`);
  }
  // 实断言：缺任一项发布前置就红。这是 N4-release-preq 的闸，不再是 skip。
  assert.deepEqual(failed, [], `发布前置缺项 — ${failed.join(' | ')}`);
});
