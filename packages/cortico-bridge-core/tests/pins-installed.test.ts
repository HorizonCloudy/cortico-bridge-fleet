/**
 * 安装态回归：在临时目录里拼出发布产物该有的形状，再从那个位置加载内核。
 * 为什么必须有这条：2026-11-16 宿主里两个包「加载失败」，起因是包内没带 spec/pins.json，
 * 而内核用 `<包>/../../spec/pins.json` 读数 —— 那个位置只在 monorepo 里存在。
 * 仓内测试永远撞不到这一层。
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

// 测试可能从 tests/ 跑（tsx）也可能从 dist/tests/ 跑（npm test），两种深度都靠向上找 package.json 定包根。
function findPkgRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const cand = join(dir, 'package.json');
    if (existsSync(cand) && readFileSync(cand, 'utf8').includes('cortico-bridge-core')) return dir;
    dir = join(dir, '..');
  }
  throw new Error(`找不到包根（从 ${start} 向上六层内没有 cortico-bridge-core 的 package.json）`);
}

const PKG = findPkgRoot(import.meta.dirname);

function installedTree(): { root: string; pkgDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'cbp-installed-'));
  const pkgDir = join(root, 'node_modules', '@horizoncloudy', 'cortico-bridge-core');
  mkdirSync(pkgDir, { recursive: true });
  assert.ok(existsSync(join(PKG, 'dist', 'src', 'pins.js')), '先跑 build：缺 dist/src/pins.js');
  assert.ok(
    existsSync(join(PKG, 'spec', 'pins.json')),
    '先跑 prepack：包内必须有 spec/pins.json，否则装到 node_modules 里就读不到台账',
  );
  cpSync(join(PKG, 'dist'), join(pkgDir, 'dist'), { recursive: true });
  cpSync(join(PKG, 'package.json'), join(pkgDir, 'package.json'));
  mkdirSync(join(pkgDir, 'spec'), { recursive: true });
  cpSync(join(PKG, 'spec', 'pins.json'), join(pkgDir, 'spec', 'pins.json'));
  return { root, pkgDir };
}

test('内核从 node_modules 位置读数，不依赖仓库根的 spec', async () => {
  const { root, pkgDir } = installedTree();
  try {
    assert.ok(!existsSync(join(root, 'spec', 'pins.json')), '临时树刻意不放 ../../spec/pins.json');
    const mod = await import(pathToFileURL(join(pkgDir, 'dist', 'src', 'pins.js')).href);
    const pins = mod.loadPins();
    assert.ok(Object.keys(pins.caps).length > 0, 'caps 段必须读出来');
    assert.ok(pins.caps.cbp.frame_bytes > 0, 'frame_bytes 必须是正数');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CORTICO_PINS_JSON 指向别的台账时以它为准', async () => {
  const { root, pkgDir } = installedTree();
  try {
    const base = JSON.parse(readFileSync(join(pkgDir, 'spec', 'pins.json'), 'utf8'));
    base.caps.cbp.frame_bytes = 1234;
    const other = join(root, 'custom-pins.json');
    writeFileSync(other, JSON.stringify(base));
    process.env.CORTICO_PINS_JSON = other;
    const mod = await import(pathToFileURL(join(pkgDir, 'dist', 'src', 'pins.js')).href);
    assert.equal(mod.loadPins().caps.cbp.frame_bytes, 1234, 'env 台账必须优先于包内那份');
  } finally {
    delete process.env.CORTICO_PINS_JSON;
    rmSync(root, { recursive: true, force: true });
  }
});
