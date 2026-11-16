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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PEER_CAPABILITIES } from '../src/world.ts';

// 默认取 fleet 的兄弟目录（tests → 包 → packages → fleet → 上层），装机位置无关；
// 跨盘/改名时用 CORTICO_MAIBOT_BRIDGE 覆盖。原先硬编个人路径，换机即假绿或假红。
const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = process.env.CORTICO_MAIBOT_BRIDGE ?? join(HERE, '..', '..', '..', '..', 'cortico-bridge-maibot');

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
  // K1 接线后桥申报两支。这一条锁「读到的确实是 hello 那处 tools」而非误抓；
  // 桥改申报面时，这里与 src/world.ts 的 PEER_CAPABILITIES 必须同批改（N3）。
  assert.deepEqual(
    names,
    ['maibot_send', 'chat.get_all_streams'],
    '桥申报面漂移：改桥必须同批改 fleet 镜像与本期望（SECURITY-CBP §7 N3）',
  );
  // 闸盲区记账：本解析按文本回读常量，若 _BRIDGE_TOOLS 加类型注解，正则里的 `]` 会截断它。
  // 因此这条额外锁死：桥侧那行常量声明不许带注解。
  assert.match(
    src,
    /^_BRIDGE_TOOLS = \[/m,
    '桥 _BRIDGE_TOOLS 声明形状漂移（加了类型注解会让本闸正则读空 → 假绿），改桥先改这里',
  );
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
