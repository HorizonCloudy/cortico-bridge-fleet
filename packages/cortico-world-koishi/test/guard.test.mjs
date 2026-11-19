/**
 * 10-22 判例能力面收敛回归（2026-11-19）。
 * 纯函数级 + handler 级，不连 WS、不起宿主、不出网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { looksLocalFileRef, guardParams, guardActionName } from '../src/guard.js';
import { actionInfo } from '../src/catalog.js';
import definition from '../src/definition.js';

const MY_GUARD = fileURLToPath(new URL('../src/guard.js', import.meta.url));
const PEER_GUARD = fileURLToPath(new URL('../../cortico-world-onebot-bridge/src/guard.js', import.meta.url));
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

test('双端 guard.js 逐字一致：一端漏改即红', () => {
  assert.equal(sha(MY_GUARD), sha(PEER_GUARD));
});

test('looksLocalFileRef：本机路径形状一律命中', () => {
  for (const v of [
    'C:\\Users\\54301\\secret.txt',
    'C:/Users/54301/secret.txt',
    '\\\\NAS\\share\\a.png',
    'file:///C:/secret.txt',
    '/etc/passwd',
    '../../secret.txt',
    '..\\secret.txt',
  ]) assert.equal(looksLocalFileRef(v), true, v);
});

test('looksLocalFileRef：远端 URL / 内联数据 / 普通文本放行', () => {
  for (const v of [
    'https://x.example/a.png', 'http://x.example/a.png', 'base64://iVBORw0KGgo=',
    'data:image/png;base64,AAAA', '', 'hello world', '12345',
  ]) assert.equal(looksLocalFileRef(v), false, v);
});

test('guardParams：媒体键、段数组、CQ 码、深嵌套都拦得住', () => {
  const cases = [
    { file: 'C:\\secret.txt' },
    { message: [{ type: 'image', data: { file: '/etc/passwd' } }] },
    { message: '[CQ:image,file=C:\\secret.txt]' },
    { a: { b: { c: { file: '..\\secret.txt' } } } },
    { image: '\\\\NAS\\share\\a.png' },
    { url: 'file:///C:/secret.txt' },
  ];
  for (const params of cases) {
    const g = guardParams(params);
    assert.equal(g.block, true, JSON.stringify(params));
    assert.match(g.reason, /10002 unsupported_action/);
    assert.match(g.reason, /本机文件引用/);
    assert.doesNotMatch(g.reason, /secret\.txt/, '不得回显值');
  }
});

test('guardParams：合法参数放行，普通文本消息不受影响', () => {
  assert.equal(guardParams({}).block, false);
  assert.equal(guardParams({ message: '早上好', group_id: 123 }).block, false);
  assert.equal(guardParams({ file: 'https://x.example/a.png' }).block, false);
  assert.equal(guardParams({ message: '[CQ:image,file=https://x.example/a.png]' }).block, false);
  assert.equal(guardParams({ message: [{ type: 'text', data: { text: 'a\\b' } }] }).block, false,
    'text 段里的反斜杠不是文件引用');
});

test('guardActionName：静态目录内放行，目录外扩展动作拒 10002', () => {
  assert.equal(guardActionName('send_group_msg', actionInfo('send_group_msg')).block, false);
  const g = guardActionName('napcat_upload_group_file', actionInfo('napcat_upload_group_file'));
  assert.equal(g.block, true);
  assert.match(g.reason, /10002 unsupported_action/);
});

const callTool = () => definition
  .create({ cfg: definition.defaults(), timezone: '', persist: () => {} })
  .tools().find((t) => t.name === 'koishi_call');

test('handler：本机文件引用在连接判定之前被拒，零出网', async () => {
  const r = await callTool().handler({ action: 'send_group_msg', params: { file: 'C:\\secret.txt' }, confirm: true });
  assert.equal(r.failed, true);
  assert.match(r.text, /本机文件引用/);
  assert.doesNotMatch(r.text, /实现端未连接/);
});

test('handler：目录外扩展动作不再透传，零出网', async () => {
  const r = await callTool().handler({ action: 'napcat_upload_group_file', params: {}, confirm: true });
  assert.equal(r.failed, true);
  assert.match(r.text, /不在 v11 静态目录/);
  assert.doesNotMatch(r.text, /实现端未连接/);
});

test('handler：合法只读请求仍走原路径，未被新闸误杀', async () => {
  const r = await callTool().handler({ action: 'get_login_info' });
  assert.equal(r.failed, true);
  assert.match(r.text, /实现端未连接/);
});
