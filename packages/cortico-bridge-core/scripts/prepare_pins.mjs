#!/usr/bin/env node
// prepack：把 fleet 唯一的 spec/pins.json 复制进包内 spec/。
// 为什么需要：发布后的包不在 monorepo 里，包内没有 pins.json 就拒绝读数，
// 依赖它的每个 world 包都会在宿主里报「加载失败」。仓内测试测不到这一层，因为它总在仓库里。
import { copyFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const canonical = resolve(pkgRoot, '..', '..', 'spec', 'pins.json');
const target = join(pkgRoot, 'spec', 'pins.json');

if (!existsSync(canonical)) {
  console.error(`prepack 失败：找不到唯一来源 ${canonical}`);
  process.exit(1);
}
const doc = JSON.parse(readFileSync(canonical, 'utf8'));
for (const k of ['caps', 'vocab', 'schema', 'generated', 'turn']) {
  if (!(k in doc)) {
    console.error(`prepack 失败：spec/pins.json 缺 ${k} 段，这份不能进产物`);
    process.exit(1);
  }
}
mkdirSync(dirname(target), { recursive: true });
copyFileSync(canonical, target);
// 产物里的来源可追溯：记下打包时用的仓库根文件路径与生成日期。
const note = join(pkgRoot, 'spec', 'SOURCE.md');
writeFileSync(
  note,
  `spec/pins.json 由 prepack 从 fleet 仓库根 ${'../../spec/pins.json'} 复制而来。\n` +
    `generated=${doc.generated} schema=${doc.schema}\n` +
    `不要手工编辑包内这份：改 fleet 根的那一份并重跑 gen_pins.py。\n`,
  'utf8',
);
console.log(`prepack：已复制 spec/pins.json（generated=${doc.generated}）`);
