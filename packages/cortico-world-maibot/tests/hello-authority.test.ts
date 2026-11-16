/**
 * hello-authority.test.ts —— N3 跨仓一致性闸：工具申报只有一侧为权威。
 *
 * 事实来源（优先级 spec/SECURITY-CBP.md:499 call 规则 + 桥实测 > 手写名单）：对端 hello.tools
 * 申报什么能力，Cortico 才允许把固定工具下发给谁。本闸同时读两侧源码，断言两个集合相等：
 *   桥侧   = cortico-bridge-maibot/client.py 的 `hello()` 里 `tools=` 入参解析出的能力名；
 *   fleet  = src/world.ts 导出的 PEER_CAPABILITIES（桥申报能力在 fleet 侧的镜像）。
 * 两侧各说各话（桥 tools=[]，fleet 却下发 maibot_send/chat.get_all_streams）即红。
 * 桥仓对我只读：本测试只读桥源码，不改桥、不联网、不起宿主。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PEER_CAPABILITIES } from '../src/world.ts';

const BRIDGE = process.env.CORTICO_MAIBOT_BRIDGE ?? 'C:/Users/54301/cortico-bridge-maibot';

/**
 * 解析桥 `hello()` 的 `tools=` 申报集合。支持两种写法：
 *   tools=[]                 → 空集；
 *   tools=list(_X) / tools=_X → 回读模块常量 `_X = [{ "name": "..." }, ...]` 取名。
 * 只认 hello 方法体内那一处 tools 入参，避免抓到 caps/agent 等其它形参。
 */
function bridgeHelloToolNames(clientSrc: string): string[] {
  const hello = clientSrc.slice(clientSrc.indexOf('def hello('));
  const block = hello.slice(0, hello.indexOf('\n    def ') > 0 ? hello.indexOf('\n    def ', 1) : hello.length);
  const m = block.match(/tools\s*=\s*(\[[^\]]*\]|list\(\s*_?[A-Za-z0-9_]+\s*\)|_[A-Za-z0-9_]+)/);
  assert.ok(m, '桥 hello() 里没有可解析的 tools= 入参（hello 构造漂移，需人看）');
  const rhs = m[1]!.trim();
  if (rhs.startsWith('[')) return namesIn(rhs);
  const varName = rhs.replace(/^list\(\s*/, '').replace(/\s*\)$/, '').trim();
  const decl = clientSrc.match(new RegExp(`^${varName}\\s*[:=].*?\\]`, 'ms'));
  assert.ok(decl, `桥 tools 引用 ${varName}，但找不到它的声明`);
  return namesIn(decl[0]);
}

function namesIn(src: string): string[] {
  return [...src.matchAll(/["']name["']\s*:\s*["']([^"']+)["']/g)].map((x) => x[1]!);
}

test('桥 hello.tools 申报集合存在且可解析（先证明读得到桥侧事实）', () => {
  const src = readFileSync(join(BRIDGE, 'client.py'), 'utf8');
  const names = bridgeHelloToolNames(src);
  assert.ok(Array.isArray(names));
  // 发信腿未接线 → 桥申报空集；这一条锁「读到的确实是 hello 那处 tools」而非误抓。
  assert.deepEqual(names, [], '发信腿未接线期桥必须申报空 tools；若变红说明桥侧 hello 构造改了，跟着改 fleet 镜像');
});

test('跨仓一致：fleet PEER_CAPABILITIES 必须与桥 hello.tools 申报名集合相等', () => {
  const bridge = bridgeHelloToolNames(readFileSync(join(BRIDGE, 'client.py'), 'utf8')).sort();
  const fleet = [...PEER_CAPABILITIES].sort();
  assert.deepEqual(
    fleet,
    bridge,
    `两侧各说各话：fleet 下发能力 [${fleet.join(',')}] ≠ 桥申报 [${bridge.join(',')}]（SECURITY-CBP 反 caps-lie）`,
  );
});
