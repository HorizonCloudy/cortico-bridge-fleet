/**
 * 静态闸：本地复刻框架 check:extension 的可离线判据（不 import 框架、不 start、不连 WS）。
 * 对应 d-cortico-side §6.2 拒项与 blueprint §2.3 硬规则；每条红即 exit 1。
 *
 * 锚点：EXTENSION_API_VERSIONS.world = 6（repos/cortico/src/extensions/manifest.ts:24 @836238311）。
 *       isWorldDefinition 判 id/label/defaults/create（src/extensions.ts:143-150 @836238311）。
 *       describe.tools ⊇ 实例 tools()（src/extensions/describe-export.ts:134-136 @836238311）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { coverage, V11_ACTIONS, V11_EVENT_KINDS, V11_SEGMENTS } from '../src/catalog.js';
import { renderSegment } from '../src/normalize.js';
import { ID } from '../src/config.js';
import { ONEBOT_TOOL_NAMES } from '../src/world.js';
import definition, { ONEBOT_BRIDGE_DESCRIBE } from '../src/definition.js';

const root = fileURLToPath(new URL('../', import.meta.url));

// --write：把 definition 的 DESCRIBE 落成 describe.json 产物（幂等；派生而非手抄，防漂移）。
if (process.argv.includes('--write')) {
  const declared = ONEBOT_BRIDGE_DESCRIBE.tools.map((t) => t.name);
  const missing = ONEBOT_TOOL_NAMES.filter((n) => !declared.includes(n));
  if (missing.length) throw new Error(`describe.tools 缺少工具：${missing.join(', ')}`);
  const doc = { tools: ONEBOT_BRIDGE_DESCRIBE.tools, events: ONEBOT_BRIDGE_DESCRIBE.events };
  writeFileSync(`${root}describe.json`, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  process.stdout.write(`wrote describe.json: ${declared.length} tools, ${ONEBOT_BRIDGE_DESCRIBE.events.length} events\n`);
}

const results = [];
function gate(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  if (!cond) throw new Error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

// —— 1. package.json cortico 块 ——
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
gate('type=module', pkg.type === 'module');
gate('cortico.kind=world', pkg.cortico?.kind === 'world');
gate('cortico.api=当前锚 6', pkg.cortico?.api === 6, `got ${pkg.cortico?.api}`);
gate('cortico.api≠上一版 5', pkg.cortico?.api !== 5, '上一版契约装载有过渡层但 check 直接 fail');
gate('engines.node>=22', />=22/.test(pkg.engines?.node ?? ''), pkg.engines?.node);
gate('deps.ws', pkg.dependencies?.ws === '^8.18.0', JSON.stringify(pkg.dependencies));
gate('cortico.describe=describe.json', pkg.cortico?.describe === 'describe.json');

// —— 2. describe.json 产物存在、可解析、与声明一致 ——
const describePath = `${root}${pkg.cortico.describe}`;
gate('describe.json 在包内', existsSync(describePath));
const describeArtifact = JSON.parse(readFileSync(describePath, 'utf8'));
const declaredToolNames = ONEBOT_BRIDGE_DESCRIBE.tools.map((t) => t.name);
const artifactToolNames = describeArtifact.tools.map((t) => t.name);
gate('describe 产物 == 声明 tools', JSON.stringify(artifactToolNames) === JSON.stringify(declaredToolNames),
  `${artifactToolNames} vs ${declaredToolNames}`);
gate('describe.events==声明 events', describeArtifact.events.length === ONEBOT_BRIDGE_DESCRIBE.events.length);
describeArtifact.tools.forEach((t) => {
  gate(`tool ${t.name} parameters 是对象`, t.parameters && typeof t.parameters === 'object');
  gate(`tool ${t.name} tags 是数组`, Array.isArray(t.tags));
});

// —— 3. isWorldDefinition 四件 ——
gate('id 非空串', typeof definition.id === 'string' && definition.id !== '');
gate('label 是串', typeof definition.label === 'string');
gate('defaults 是函数', typeof definition.defaults === 'function');
gate('create 是函数', typeof definition.create === 'function');
gate('world id 拼得出合法 pageId', /^[a-z0-9-]+$/.test(definition.id), definition.id);

// —— 4. dryMount 复刻：defaults() + create() 纯构造 ——
const defaults = definition.defaults();
gate('defaults() 返回对象', defaults && typeof defaults === 'object');
gate('defaults().enabled=false（缺省禁用）', defaults.enabled === false);
const inst = definition.create({ cfg: defaults, timezone: '', persist: () => {} });
gate('实例 id==定义 id', inst.id === definition.id, `${inst.id} vs ${definition.id}`);
gate('start 是函数', typeof inst.start === 'function');
gate('stop 是函数', typeof inst.stop === 'function');
gate('envPromptVars 是函数', typeof inst.envPromptVars === 'function');
const vars = inst.envPromptVars();
gate('envPromptVars 返回对象或 null', vars === null || (vars && typeof vars === 'object'));

// —— 5. tools() 形状 + ⊆ describe ——
const tools = inst.tools();
gate('tools() 是数组', Array.isArray(tools) && tools.length > 0);
const seen = new Set();
for (const t of tools) {
  gate(`工具 ${t.name} 有名字`, typeof t.name === 'string' && t.name !== '');
  gate(`工具 ${t.name} 不重名`, !seen.has(t.name));
  seen.add(t.name);
  gate(`工具 ${t.name} parameters 是对象`, t.parameters && typeof t.parameters === 'object');
  gate(`工具 ${t.name} 有 handler`, typeof t.handler === 'function');
  gate(`工具 ${t.name} 有 tags`, Array.isArray(t.tags) && t.tags.length > 0);
  gate(`工具 ${t.name} ⊆ describe.tools`, declaredToolNames.includes(t.name));
}

// —— 6. OneBot v11 覆盖面 == reality ——
const cov = coverage();
// v11 规范 38 个公开动作，凭证三动作按 SECURITY-CBP.md:125 摘除后目录实发 35（读 16 / 写 19）。
gate('v11 目录 35（38−3 凭证）', cov.actions === 35 && V11_ACTIONS.length === 35, `got ${cov.actions}`);
gate('v11 事件叶子 17', cov.events === 17 && V11_EVENT_KINDS.length === 17, `got ${cov.events}`);
gate('v11 消息段 20', cov.segments === 20 && V11_SEGMENTS.length === 20, `got ${cov.segments}`);
gate('v11 读/写 16/19', cov.readOnly === 16 && cov.write === 19, `${cov.readOnly}/${cov.write}`);
gate('凭证动作不进目录', ['get_cookies', 'get_csrf_token', 'get_credentials'].every((n) => !V11_ACTIONS.some((a) => a.name === n)));

// —— 7. 未知段兜底不吞消息（硬规则） ——
gate('未知段 → [<type>]', renderSegment({ type: 'hacker_tag', data: {} }) === '[hacker_tag]');

// —— 8. ID 一致性 ——
gate('config.ID 与 definition.id 一致', ID === definition.id);

for (const r of results) process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}\n`);
process.stdout.write(`\nselfcheck: ${results.length} gates passed\n`);
