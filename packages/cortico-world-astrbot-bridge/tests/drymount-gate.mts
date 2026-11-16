/**
 * drymount-gate.mts —— 直接跑 Cortico 框架自带的装载闸（不是复刻）：
 * `dryMountWorld`（cortico src/extensions/dry-mount.ts:126 @836238311）+
 * `checkDescribe`（describe-export.ts:110）。等价于蓝图 §4.1 的
 * `tools/check_ext.ts`（工具件属别的工单；这里先用 tsx 直调框架函数）。
 * 运行：`npx tsx tests/drymount-gate.mts`（框架 .ts 在 node_modules，
 * 纯 node --test 会 ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING，实测）。
 * `--regen`：用框架自带 exportDescribe 重写 describe.json
 * （正规通道即 `pnpm describe:extension`；本包用同一函数直调）。
 */
import { writeFileSync } from 'node:fs';
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts';
import { checkDescribe, exportDescribe } from 'cortico/extensions/describe-export.ts';
import def from '../src/definition.ts';

const opts = { scratchDir: '.drymount-scratch', packageDir: '.' };
let bad = 0;

if (process.argv.includes('--regen')) {
  const file = await exportDescribe('world', def, opts);
  if (!file) throw new Error('exportDescribe returned null');
  writeFileSync('describe.json', JSON.stringify(file, null, 2) + '\n');
  console.log('describe.json regenerated:', Object.keys(file));
  process.exit(0);
}

const report = await dryMountWorld(def as never, opts);
console.log(`dryMountWorld: failures=${report.failures.length} warnings=${report.warnings.length} ok=${report.ok.length}`);
for (const f of report.failures) { console.log('  FAIL', f); bad++; }
for (const w of report.warnings) console.log('  WARN', w);

const desc = await checkDescribe('world', def, 'describe.json', opts as never);
console.log(`checkDescribe: failures=${desc.failures.length} warnings=${desc.warnings.length} ok=${desc.ok.length}`);
for (const f of desc.failures) { console.log('  FAIL', f); bad++; }
for (const w of desc.warnings) console.log('  WARN', w);

process.exit(bad === 0 ? 0 : 1);
