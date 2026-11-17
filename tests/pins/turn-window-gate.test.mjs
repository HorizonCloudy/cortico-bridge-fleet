/**
 * 跨仓等值闸 · fleet 半边（工单二 F2）：turn 保留窗只有一个源值，产物必须等值。
 * 源 = spec/CBP-v1.json $defs/turnWindow.const（正整数秒）。
 * 锁 1：spec/pins.json turn.ttl_seconds == 源（gen_pins.py 写模式生成，漂移即红）。
 * 锁 2：tools/gen_table.py 的进程输出 cbp_table.py 里 TURN_TTL_SECONDS == 源；
 *       同一 tmp 副本连跑两次逐字节等幂；--check 在副本上过。
 *       生成器只写仓外 tmp 副本，不碰任何真仓工作区。
 * 锁 3：内核读数 PINS.turn.ttlSeconds == 源（编译产物 dist/src/pins.js import）。
 * 锁 4：env 覆盖口两端同名：CORTICO_TURN_TTL_SECONDS 即读生效；坏值回落并带 degraded。
 * 桥侧对偶 = 两桥仓 tests/test_table_parity.py（盘上 cbp_table.py == render 逐字节）。
 * 一端改源不重生成，对侧闸红（工单二 F2 验收「跨仓等值闸：一端改值另一端必须红」）。
 * 跑法：node --test tests/pins/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLEET = resolve(HERE, '..', '..');
const SRC = join(FLEET, 'spec', 'CBP-v1.json');
const PINS = join(FLEET, 'spec', 'pins.json');
const GEN_TABLE = join(FLEET, 'tools', 'gen_table.py');
const PY = process.env.CORTICO_PY311 ?? 'python';

function sourceTtl(t) {
  if (!existsSync(SRC)) {
    t.skip('缺 spec/CBP-v1.json');
    return null;
  }
  const d = JSON.parse(readFileSync(SRC, 'utf8'));
  const v = d.$defs && d.$defs.turnWindow ? d.$defs.turnWindow.const : undefined;
  assert.ok(Number.isInteger(v) && v > 0, `$defs/turnWindow.const 必须正整数，实为 ${JSON.stringify(v)}`);
  return v;
}

test('turn-window: spec/pins.json turn.ttl_seconds equals the frame-table source (lock 1)', (t) => {
  const src = sourceTtl(t);
  if (src === null) return;
  if (!existsSync(PINS)) {
    t.skip('缺 spec/pins.json');
    return;
  }
  const p = JSON.parse(readFileSync(PINS, 'utf8'));
  assert.equal(p.turn && p.turn.ttl_seconds, src, 'pins.json turn 漂移：重跑 tools/gen_pins.py（不许手抄）');
});

function genTableRun() {
  const scratch = mkdtempSync(join(tmpdir(), 'cbp-turnwin-'));
  cpSync(join(FLEET, 'spec'), join(scratch, 'cortico-bridge-fleet', 'spec'), { recursive: true });
  for (const repo of ['cortico-bridge-neko', 'cortico-bridge-maibot']) {
    mkdirSync(join(scratch, repo), { recursive: true });
  }
  const r = spawnSync(PY, ['-I', GEN_TABLE, '--base', scratch], { encoding: 'utf8' });
  if (r.error) return { skip: `python 不可用（${r.error.message}）——本锁需要能跑 tools/gen_table.py 的解释器` };
  if (r.status !== 0) throw new Error(`gen_table.py 退出码 ${r.status}: ${r.stderr || r.stdout}`);
  const bytes = readFileSync(join(scratch, 'cortico-bridge-neko', 'cbp_table.py'));
  const chk = spawnSync(PY, ['-I', GEN_TABLE, '--base', scratch, '--check'], { encoding: 'utf8' });
  if (chk.status !== 0) throw new Error(`tmp 副本上 --check 应过，实退出 ${chk.status}: ${chk.stdout}${chk.stderr}`);
  return { bytes };
}

test('turn-window: gen_table.py lands TURN_TTL_SECONDS equal to the source (lock 2, tmp copy only)', (t) => {
  const src = sourceTtl(t);
  if (src === null) return;
  const a = genTableRun();
  if (a.skip) {
    t.skip(a.skip);
    return;
  }
  const b = genTableRun();
  assert.ok(Buffer.compare(a.bytes, b.bytes) === 0, '生成器输出必须等幂（同一 spec 重跑逐字节相同）');
  const m = /^TURN_TTL_SECONDS = (\d+)$/m.exec(a.bytes.toString('utf8'));
  assert.ok(m, 'cbp_table.py 缺 TURN_TTL_SECONDS 行（gen_table.py 的 turn 单源腿失效）');
  assert.equal(Number(m[1]), src, 'Python 表读数与源不等——同源件断裂');
});

test('turn-window: kernel PINS reads the same value from the ledger file (lock 3)', async (t) => {
  const src = sourceTtl(t);
  if (src === null) return;
  const dist = join(FLEET, 'packages', 'cortico-bridge-core', 'dist', 'src', 'pins.js');
  if (!existsSync(dist)) {
    t.skip('core dist 未构建——先构建 cortico-bridge-core 再复跑本闸');
    return;
  }
  const prev = process.env.CORTICO_TURN_TTL_SECONDS;
  delete process.env.CORTICO_TURN_TTL_SECONDS;
  try {
    const mod = await import(pathToFileURL(dist).href);
    assert.equal(mod.PINS.turn.ttlSeconds, src, '内核读数与源不等——产物链断了');
    const eff = mod.effectiveTurnTtlSeconds();
    assert.deepEqual(eff, { ttlSeconds: src, degraded: null });
    process.env.CORTICO_TURN_TTL_SECONDS = '90';
    assert.deepEqual(mod.effectiveTurnTtlSeconds(), { ttlSeconds: 90, degraded: null }, 'env 同名覆盖即读生效');
    process.env.CORTICO_TURN_TTL_SECONDS = 'soon';
    assert.deepEqual(mod.effectiveTurnTtlSeconds(), { ttlSeconds: src, degraded: 'turn-ttl-env-invalid' }, '坏值回落 + degraded');
  } finally {
    if (prev === undefined) delete process.env.CORTICO_TURN_TTL_SECONDS;
    else process.env.CORTICO_TURN_TTL_SECONDS = prev;
  }
});

test('turn-window: the env name string is spelled identically on both sides (lock 4)', () => {
  const corePins = readFileSync(join(FLEET, 'packages', 'cortico-bridge-core', 'src', 'pins.ts'), 'utf8');
  assert.match(corePins, /TURN_TTL_ENV = 'CORTICO_TURN_TTL_SECONDS'/, '内核侧 env 名');
  const world = readFileSync(join(FLEET, 'packages', 'cortico-world-neko', 'src', 'world.ts'), 'utf8');
  assert.match(world, /CORTICO_TURN_TTL_SECONDS/, 'world 提示词面写出同名 env');
  const bridge = resolve(FLEET, '..', 'cortico-bridge-neko', 'turns.py');
  if (existsSync(bridge)) {
    assert.match(readFileSync(bridge, 'utf8'), /CORTICO_TURN_TTL_SECONDS/, '桥侧 env 名与内核侧逐字相同');
  }
});
