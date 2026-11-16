/**
 * driver.js 复制件对表闸（gate C-2 的牙）。
 *
 * 本包的 src/driver.js 是 `cortico-world-onebot-bridge/src/driver.js` 的整文件复制件，
 * 因为那边 package.json 的 exports 挡 subpath import，跨包引不到（蓝图 L172 的 v11 薄壳
 * 只能带走一份）。复制件的病是「各自演化」：先例是四份 Python 桥各自手抄 CBP 帧表，
 * 抄出 neko 桥强制 self/actor、maibot 桥却放行同一帧的分裂（CHANGELOG-CBP.md 记为
 * 「漂移检测」欠账，后来用 tools/gen_table.py 生成件加逐字节等闸收口）。
 * 升级时机：v11 驱动进内核 exports 或单列一个 v11 profile 包时，删本文件与复制件。
 *
 * 跑法：node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIBLING = join(PKG, '..', 'cortico-world-onebot-bridge', 'src', 'driver.js');
const OWN = join(PKG, 'src', 'driver.js');

/** 去掉 provenance 注释行，只比真代码。 */
const stripProvenance = (text) =>
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/^\/\/ copy from /.test(l))
    .join('\n')
    .trim();

test('复制件必须带 provenance 头，写明来源件与钉住的 sha', () => {
  const head = readFileSync(OWN, 'utf8').replace(/\r\n/g, '\n').split('\n')[0];
  assert.match(head, /^\/\/ copy from @horizoncloudy\/cortico-world-onebot-bridge\/src\/driver\.js @[0-9a-f]{9}/,
    `provenance 头漂移：${head}`);
  assert.match(head, /gate C-2/, '头里必须写明是哪条门禁要求复制的');
});

test('driver.js 与 onebot 先例件除 provenance 外逐字节相等', () => {
  const mine = stripProvenance(readFileSync(OWN, 'utf8'));
  const theirs = stripProvenance(readFileSync(SIBLING, 'utf8'));
  assert.equal(
    mine,
    theirs,
    '两份 v11 驱动已各自演化。要么把改动双向同步并更新 provenance 的 sha，' +
      '要么把驱动收进内核 exports 后删掉本包复制件（升级时机见文件头）。',
  );
});
