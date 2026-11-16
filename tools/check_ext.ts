#!/usr/bin/env node
/**
 * check_ext.ts — Cortico `pnpm check:extension` 语义的 fleet 本地复刻（_BUILD-PLAN §2.1 工单件）。
 *
 * 闸项清单逐条照抄 d-cortico-side §6.2 的 拒/警 全表；行号按 `repos/cortico @ 836238311`
 * （scripts/extension-check.ts、src/extensions/manifest.ts、dry-mount.ts、
 * describe-export.ts、extensions.ts、previous-contract.ts、webui-protocol.ts、core/loop.ts）。
 * 边界与选型（为什么是工具件而不是把 drymount 闸再落进 tests）：
 *  - dryMountWorld 的权威调用已经落在包测试里（packages/cortico-world-astrbot-bridge/
 *    tests/drymount-gate.mts 直调框架函数本体，蓝图 §4.3 的代位项已兑现）；
 *  - 本件补的是缺的那半：manifest/入口形状/describe 对表，一条命令对任意包目录跑，
 *    CI 不装宿主也能红（§5.1 四闸之一）；
 *  - 本工单只准写 tools/ 目录，包内 tests 不是本件可落盘的路径。
 * 本件不含帧/段转换逻辑：转换唯一实现点是内核 cortico-bridge-core（任务红线：禁止复制粘贴）。
 * 复刻不含 start()（extension-check.ts:3-4 注释：不启动扩展）；不实现/不断言 outputTap
 * （_BUILD-PLAN §3.3：桥包一律不实现，复刻闸不因此加断言）。
 *
 * 跑法（离线）：
 *   node tools/check_ext.ts packages/cortico-world-astrbot-bridge   # 本机 node v27-alpha 实测；
 *     Node ≥22.18 / 23.6+ 自带 type stripping；计划里的 `npx tsx tools/check_ext.ts <包>` 同义。
 *   node tools/check_ext.ts --selftest                              # 红/绿自检（内置夹具）
 * 退出码：有 FAIL 即 1。
 *
 * 已知不覆盖面（如实登记）：内置 World 的工具名占用只查 BUILTIN_WORLD_IDS 的 id 面，
 * 内置件 tools() 占用需宿主本体；provider/bot 两类的 dryMount 分支未复刻（fleet v1 无此类包）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

/* ---------------- 闸常量（逐条带出处，@836238311） ---------------- */

/** src/extensions/manifest.ts:23-27 */
const EXTENSION_API_VERSIONS: Record<string, number> = { world: 6, provider: 6, bot: 7 };
/** src/extensions/previous-contract.ts:26-30 */
const PREVIOUS_CONTRACT_VERSIONS: Record<string, number> = { world: 5, provider: 5, bot: 6 };
/** src/extensions/manifest.ts:14-15 */
const EXTENSION_KINDS = ['world', 'provider', 'bot'];
/** src/worlds/index.ts:12-19（webui-fixture 不装配，index.ts:7 注释） */
const BUILTIN_WORLD_IDS = ['console', 'qq', 'bilibili', 'minecraft', 'websearch'];
/** src/core/loop.ts:198,206 */
const RESERVED_FRAME_NAMES = new Set(['external_event_frame']);
/** src/web/shared/webui-protocol.ts:30 */
const PAGE_ID_RE = /^(world|persona|llm|memory):[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** src/web/shared/webui-protocol.ts:33（dry-mount.ts:68 PANEL_ID 同源语义） */
const PANEL_ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** src/extensions/dry-mount.ts:70 */
const TOOL_PREFIX_RE = /^[a-z0-9]+_/;
/** src/core/types.ts:845 */
const MODULE_LAMP_MAX = 7;

const HERE = dirname(fileURLToPath(import.meta.url));

/* ---------------- 小工具 ---------------- */

interface Report { ok: string[]; warnings: string[]; failures: string[] }
const emptyReport = (): Report => ({ ok: [], warnings: [], failures: [] });
const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** src/extensions/manifest.ts:84-88 isSafeRelativeFile */
function isSafeRelativeFile(p: unknown): p is string {
  if (typeof p !== 'string' || p === '') return false;
  if (p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return !p.split('/').some((seg) => seg === '..' || seg === '');
}
/** src/core/config-schema.ts getByPath 的等价小复刻（点分路径）。 */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (!isPlain(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/* ---------------- 主闸 ---------------- */

export async function runCheck(pkgDirArg: string): Promise<Report> {
  const rep = emptyReport();
  const ok = (m: string): void => { rep.ok.push(m); };
  const warn = (m: string): void => { rep.warnings.push(m); };
  const fail = (m: string): void => { rep.failures.push(m); };
  const dir = resolve(pkgDirArg);

  const pkgFile = join(dir, 'package.json');
  if (!existsSync(pkgFile)) {
    fail(`${dir} does not exist or has no package.json: the argument must be the extension package root.`);
    return rep;
  }
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    fail(`package.json is not valid JSON: ${msg(e)}`);
    return rep;
  }

  // extension-check.ts:77-78 — name/version 硬项
  if (typeof pkg.name !== 'string' || !pkg.name) fail('package.json has no name: pnpm cannot install a package without one.');
  if (typeof pkg.version !== 'string' || !pkg.version) fail('package.json has no version: browser bundle URLs contain the version.');

  // manifest.ts:112-114 — type module（宿主：reasons 非空即 parsed.ok=false，check 在此早退）
  if (pkg.type !== 'module') {
    fail('package.json type must be "module": extensions and the framework share module instances through one ESM resolution.');
    return rep;
  }

  // manifest.ts:117-119 — cortico 块
  const block = pkg.cortico;
  if (!isPlain(block)) {
    fail('the package.json cortico block is missing or not an object: it declares kind/api for the loader.');
    return rep;
  }
  // manifest.ts:129-133 — kind
  const kind = block.kind;
  const kindOk = typeof kind === 'string' && EXTENSION_KINDS.includes(kind);
  if (!kindOk) {
    fail(`cortico.kind must be one of ${EXTENSION_KINDS.map((k) => `"${k}"`).join(' / ')}: got ${JSON.stringify(kind)}.`);
    return rep;
  }
  // manifest.ts:135-146 + extension-check.ts:88-92 — api 面
  {
    const expected = EXTENSION_API_VERSIONS[kind as string];
    const api = block.api;
    if (typeof api !== 'number' || !Number.isInteger(api) || api < 1) {
      fail(`cortico.api must be an integer >= 1 for a ${kind} extension: got ${JSON.stringify(api)}.`);
      return rep;
    }
    if (PREVIOUS_CONTRACT_VERSIONS[kind as string] === api) {
      fail(`cortico.api ${api} is the previous ${kind} contract; this check requires v${expected}. Apply the renames in https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/upgrading.md and set cortico.api to ${expected}.`);
      return rep;
    }
    if (api < expected) {
      fail(`cortico.api ${api} is older than the current ${kind} contract v${expected}; the loader refuses it.`);
      return rep;
    }
    if (api > expected) {
      fail(`cortico.api ${api} is newer than the current ${kind} contract v${expected}; the loader refuses it.`);
      return rep;
    }
    ok(`manifest: kind=${String(kind)}, api=${String(api)}`);
  }

  // extension-check.ts:143-144 — webUiClient 指的文件要在包里（manifest.ts:151-167 形状项）
  const hasWebUiClient = block.webUiClient !== undefined;
  if (hasWebUiClient) {
    const client = block.webUiClient;
    if (!isSafeRelativeFile(client)) fail(`cortico.webUiClient must be a safe package-relative .js/.mjs path: got ${JSON.stringify(client)}.`);
    else if (!existsSync(join(dir, client))) fail(`cortico.webUiClient points to ${client}, which is not in the package: build it, then check files / .npmignore.`);
  }
  if (block.webUiStyle !== undefined && !hasWebUiClient) fail('cortico.webUiStyle without cortico.webUiClient is meaningless: drop the style field or add the client.');
  // manifest.ts:170-171 — describe 字段形状（只 warn，同宿主）
  let describePath: string | undefined;
  if (block.describe !== undefined) {
    describePath = isSafeRelativeFile(block.describe) && (block.describe as string).endsWith('.json') ? (block.describe as string) : undefined;
    if (describePath === undefined) warn(`cortico.describe ${JSON.stringify(block.describe)} is not a package-relative .json path.`);
  }

  if (kind !== 'world') {
    warn('check_ext.ts replicates the world dryMount/checkDescribe path only (fleet v1 ships no provider/bot package); run the host pnpm check:extension for this kind.');
    return rep;
  }

  // extensions.ts:130-141 — 入口解析
  const pick = (v: unknown): string | null => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return pick(o['.'] ?? o['import'] ?? o['default'] ?? null);
    }
    return null;
  };
  const rel = pick(pkg.exports) ?? (typeof pkg.module === 'string' ? pkg.module : null)
    ?? (typeof pkg.main === 'string' ? pkg.main : null) ?? 'index.js';
  const entry = join(dir, rel);
  if (!existsSync(entry)) {
    fail(`Entry ${entry} does not exist: the file that exports / module / main points to must ship in the package.`);
    return rep;
  }
  ok(`Entry: ${entry}`);

  // extension-check.ts:96-121 — import + 默认导出形状（isWorldDefinition，extensions.ts:143-150）
  let def: Record<string, unknown>;
  try {
    const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown };
    if (!isPlain(mod.default)) {
      fail('The extension cannot load: the entry has no default export object (isWorldDefinition extensions.ts:143-150).');
      return rep;
    }
    def = mod.default;
  } catch (e) {
    fail(`Importing the entry threw: ${msg(e)}`);
    return rep;
  }
  const shaped = typeof def.id === 'string' && def.id !== '' && typeof def.label === 'string'
    && typeof def.defaults === 'function' && typeof def.create === 'function';
  if (!shaped) {
    fail('Default export does not match the world shape (needs id/label/defaults/create): the extension cannot load.');
    return rep;
  }
  const id = def.id as string;
  ok(`Default export has the world shape; id = ${id}`);

  // extension-check.ts:126-136 — page id 与内建撞名
  if (!PAGE_ID_RE.test(`world:${id}`)) {
    fail(`World id "${id}" cannot form a WebUI page id: use only lowercase letters, digits and hyphens, with a letter or digit at each end.`);
  }
  if (BUILTIN_WORLD_IDS.includes(id)) {
    fail(`World id "${id}" matches a built-in World; the loader refuses to load it.`);
  }

  // dry-mount.ts:126-235 复刻 —— 默认配置 + 无密钥，不调 start()
  const scratch = mkdtempSync(join(HERE, '.check-ext-scratch-'));
  try {
    let cfgDefault: unknown;
    try {
      cfgDefault = (def.defaults as () => unknown)();
    } catch (e) {
      fail(`defaults() threw: ${msg(e)}`);
      return rep;
    }
    if (!isPlain(cfgDefault)) {
      fail('defaults() did not return an object: it supplies the defaults of the worlds.<id> section.');
      return rep;
    }
    if (cfgDefault.enabled !== false) {
      warn('defaults().enabled is not false: the bot declares and the deployment decides whether a World is enabled, so the definition always sets false.');
    }
    ok('defaults() returns a config section.');

    const fakeCtx = {
      id, cfg: cfgDefault, timezone: 'UTC', botName: 'check-ext',
      botDir: scratch, packageDir: dir, dataDir: scratch, repoRoot: dir,
      secret: () => '', storeSecret: (): void => {},
      persist: (patch: object): void => { Object.assign(cfgDefault as object, patch); },
      restart: async (): Promise<void> => {},
    };
    let world: Record<string, unknown>;
    try {
      const w = (def.create as (ctx: unknown) => unknown)(fakeCtx);
      if (!isPlain(w)) throw new Error('create() did not return an object');
      world = w;
    } catch (e) {
      fail(`create() threw with default config and no secrets: ${msg(e)}. The assembly layer constructs every available definition.`);
      return rep;
    }
    if (world.id !== id) {
      fail(`Instance id "${String(world.id)}" differs from definition id "${id}": the assembly layer finds the slot by the definition id.`);
    } else {
      ok(`create() returns a World instance, id = ${id}.`);
    }

    let tools: unknown[];
    try {
      const t = typeof world.tools === 'function' ? (world.tools as () => unknown)() : undefined;
      if (!Array.isArray(t)) { fail('tools() did not return an array.'); return rep; }
      tools = t;
    } catch (e) {
      fail(`tools() threw: ${msg(e)}`);
      return rep;
    }
    const taken = await collectFleetToolNames(dir);
    for (const s of taken.skipped) warn(`A sibling package failed to construct, so the name collision check does not cover its tools: ${s}`);
    const seen = new Set<string>();
    for (const item of tools) {
      const tool = isPlain(item) ? item : {};
      const name = tool.name;
      if (typeof name !== 'string' || name === '') { fail('A tool has no name.'); continue; }
      if (seen.has(name)) fail(`Duplicate tool name: ${name}.`);
      seen.add(name);
      if (RESERVED_FRAME_NAMES.has(name)) fail(`Tool name "${name}" is a Core reserved frame name; the assembly layer refuses to mount it.`);
      const owner = taken.taken.get(name);
      if (owner) fail(`Tool name "${name}" is already used by World "${owner}"; the assembly layer refuses to mount it.`);
      if (!isPlain(tool.parameters)) fail(`Tool "${name}" parameters is not an object: it is the JSON Schema sent to the model.`);
      if (typeof tool.handler !== 'function') fail(`Tool "${name}" has no handler.`);
      if (!Array.isArray(tool.tags)) fail(`Tool "${name}" has no tags array: an empty array means deliberately untagged, and the field is required.`);
      else if (tool.tags.length === 0) warn(`Tool "${name}" has empty tags: tag-based tool selection never matches it.`);
      if (!TOOL_PREFIX_RE.test(name)) warn(`Tool name "${name}" has no prefix: the convention is <short id>_<verb phrase>.`);
    }
    ok(`tools(): ${tools.length} tool(s) shape-checked.`);

    try {
      const vars = await (world.envPromptVars as () => unknown)?.();
      if (vars === null || vars === undefined) ok('envPromptVars() returns null/undefined: no section added.');
      else if (isPlain(vars)) ok(`envPromptVars(): placeholder values: ${Object.keys(vars).length}.`);
      else fail('envPromptVars() must return an object or null.');
    } catch (e) {
      fail(`envPromptVars() threw: ${msg(e)}`);
    }

    checkWebUiAndDescribe(rep, def, world, dir, id, cfgDefault, tools, describePath, hasWebUiClient);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return rep;
}

/** 同进程扫 packages/ 兄弟包收集已占工具名（dry-mount.ts:103-115 collectToolNames 的 fleet 版）。 */
async function collectFleetToolNames(dir: string): Promise<{ taken: Map<string, string>; skipped: string[] }> {
  const taken = new Map<string, string>();
  const skipped: string[] = [];
  const parent = dirname(dir);
  if (basename(parent) !== 'packages') return { taken, skipped };
  for (const sib of readdirSync(parent)) {
    const sibDir = join(parent, sib);
    if (sibDir === dir || !existsSync(join(sibDir, 'package.json'))) continue;
    let sibPkg: Record<string, unknown>;
    try { sibPkg = JSON.parse(readFileSync(join(sibDir, 'package.json'), 'utf8')) as Record<string, unknown>; } catch { continue; }
    if (!isPlain(sibPkg.cortico) || sibPkg.cortico.kind !== 'world') continue;
    try {
      const pick = (v: unknown): string | null => (typeof v === 'string' ? v
        : v && typeof v === 'object' ? pick((v as Record<string, unknown>)['.'] ?? (v as Record<string, unknown>).import ?? (v as Record<string, unknown>).default ?? null) : null);
      const rel = pick(sibPkg.exports) ?? (typeof sibPkg.main === 'string' ? sibPkg.main : 'index.js');
      const mod = (await import(pathToFileURL(join(sibDir, rel)).href)) as { default?: unknown };
      const d = mod.default;
      if (!isPlain(d) || typeof d.create !== 'function' || typeof d.defaults !== 'function' || typeof d.id !== 'string') continue;
      const cfg = d.defaults();
      const w = d.create({ id: d.id, cfg, secret: () => '', persist: (): void => {}, packageDir: sibDir, botDir: sibDir, dataDir: sibDir }) as Record<string, unknown>;
      for (const t of (w.tools as () => unknown[])()) if (isPlain(t) && typeof t.name === 'string') taken.set(t.name, d.id);
    } catch (e) {
      skipped.push(`${sib}: ${msg(e)}`);
    }
  }
  return { taken, skipped };
}

/** dry-mount.ts:190-235（webUi 面）+ describe-export.ts:110-169（checkDescribe 面）复刻。 */
function checkWebUiAndDescribe(
  rep: Report,
  def: Record<string, unknown>,
  world: Record<string, unknown>,
  dir: string,
  id: string,
  defaults: Record<string, unknown>,
  tools: unknown[],
  describePath: string | undefined,
  hasWebUiClient: boolean,
): { tools: unknown[]; events: unknown[]; prompts?: unknown[] } | null {
  const ok = (m: string): void => { rep.ok.push(m); };
  const warn = (m: string): void => { rep.warnings.push(m); };
  const fail = (m: string): void => { rep.failures.push(m); };

  let decl: Record<string, unknown> | null = null;
  if (typeof world.webUi === 'function') {
    try {
      const d = (world.webUi as (lang: string) => unknown)('zh');
      decl = isPlain(d) ? d : null;
    } catch (e) {
      fail(`webUi() threw: ${msg(e)}`);
    }
  } else {
    ok('No webUi(): the WebUI shows the generic page.');
  }

  if (decl) {
    const panels = Array.isArray(decl.panels) ? decl.panels : [];
    const panelIds = new Set<string>();
    for (const p of panels) {
      const pid = isPlain(p) ? p.id : undefined;
      if (typeof pid !== 'string' || !PANEL_ID_RE.test(pid)) fail(`Panel id ${JSON.stringify(pid)} is malformed: [a-z0-9-] only, letter/digit at each end.`);
      else if (panelIds.has(pid)) fail(`Duplicate panel id: ${pid}.`);
      else panelIds.add(pid);
    }
    if (panels.length && !hasWebUiClient) warn(`webUi() declares panels (${panels.length}) but the manifest has no cortico.webUiClient; custom panels need a browser bundle.`);
    if (Array.isArray(decl.lamps) && decl.lamps.length > MODULE_LAMP_MAX) warn(`webUi().lamps has length ${decl.lamps.length}; the WebUI draws at most ${MODULE_LAMP_MAX} lamps.`);
    for (const g of (Array.isArray(decl.config) ? decl.config : [])) {
      if (!isPlain(g)) { fail('A config group is not an object; the WebUI skips it.'); continue; }
      if (g.owner !== `world:${id}`) warn(`Config group "${String(g.id)}" has owner ${JSON.stringify(g.owner)}; a World's config group owner must be world:${id}.`);
      const schema = isPlain(g.schema) ? g.schema : null;
      const props = schema && isPlain(schema.properties) ? schema.properties as Record<string, unknown> : {};
      for (const path of Object.keys(props)) {
        const prefix = `worlds.${id}.`;
        if (!path.startsWith(prefix)) {
          fail(`Config group "${String(g.id)}" declares "${path}" outside the ${prefix} section: writes follow the path, so the value lands in another owner's section.`);
          continue;
        }
        if (getByPath(defaults, path.slice(prefix.length)) === undefined) {
          fail(`Config group "${String(g.id)}" declares "${path}" with no matching entry in defaults(): the WebUI can change it, but the code still reads its fallback value.`);
        }
      }
    }
    const docs = Array.isArray(decl.promptDocs) ? decl.promptDocs : [];
    const keys = new Set<string>();
    for (const doc of docs) {
      if (!isPlain(doc)) continue;
      if (typeof doc.key === 'string') {
        if (keys.has(doc.key)) fail(`Duplicate promptDocs key: ${doc.key}.`);
        keys.add(doc.key);
      }
      if (doc.role === 'envPrompt' && typeof doc.path === 'string' && !existsSync(doc.path)) {
        warn(`Env prompt template ${doc.path} does not exist: this World's section will be empty.`);
      }
    }
    ok(`webUi(): panels: ${panels.length}, config groups: ${Array.isArray(decl.config) ? decl.config.length : 0}, prompt docs: ${docs.length}.`);
  }

  // checkDescribe（describe-export.ts:110-169）
  const dd = def.describe;
  if (!isPlain(dd) || !Array.isArray(dd.tools) || !Array.isArray(dd.events)) {
    fail('The World definition has no describe. Add describe: { tools, events } to it: every tool tools() can return and every event type the World pushes. Then run pnpm describe:extension.');
    return null;
  }
  const declared = new Set(dd.tools.map((t: unknown) => (isPlain(t) ? t.name : undefined)));
  const liveNames = tools.map((t) => (isPlain(t) ? t.name : undefined)).filter((n) => typeof n === 'string') as string[];
  const extra = liveNames.filter((n) => !declared.has(n));
  if (extra.length) fail(`tools() returns tools missing from describe.tools: ${extra.join(', ')}. Declare them; an instance may change a tool's description and parameters, not its name.`);
  else ok('tools(): every tool is declared in describe.tools.');

  const file: { tools: unknown[]; events: unknown[]; prompts?: unknown[] } = { tools: [...dd.tools], events: [...dd.events] };
  const seen = new Set<string>();
  const prompts: unknown[] = [];
  const envDocs = ((decl?.promptDocs as unknown[] | undefined) ?? []).filter((d) => isPlain(d) && d.role === 'envPrompt') as Record<string, unknown>[];
  for (const doc of envDocs) {
    if (typeof doc.key !== 'string' || seen.has(doc.key) || typeof doc.path !== 'string' || !existsSync(doc.path)) continue;
    seen.add(doc.key);
    prompts.push({ key: doc.key, title: doc.title, role: doc.role, content: readFileSync(doc.path, 'utf8') });
  }
  if (prompts.length) file.prompts = prompts;
  const want = JSON.parse(JSON.stringify(file));

  const liveByDecl = dd.tools as Record<string, unknown>[];
  const byName = new Map(liveByDecl.map((t) => [t.name as string, t]));
  const changed = tools.flatMap((t) => {
    if (!isPlain(t) || typeof t.name !== 'string') return [];
    const d = byName.get(t.name);
    if (!d) return [];
    const fields = [
      ...(d.description === t.description ? [] : ['description']),
      ...(isDeepStrictEqual(d.parameters, t.parameters) ? [] : ['parameters']),
    ];
    return fields.length ? [`${t.name} (${fields.join(', ')})`] : [];
  });
  if (changed.length) warn(`With the default config, tools() returns a description or parameters that differ from describe.tools: ${changed.join(', ')}.`);

  if (describePath === undefined) {
    fail(`package.json has no cortico.describe. Run pnpm describe:extension ${dir} and publish the result with the package.`);
    return want;
  }
  const dfile = join(dir, describePath);
  if (!existsSync(dfile)) {
    fail(`cortico.describe points to ${describePath}, which is not in the package. Run pnpm describe:extension and publish the result.`);
    return want;
  }
  let written: unknown;
  try {
    written = JSON.parse(readFileSync(dfile, 'utf8'));
  } catch (e) {
    fail(`${describePath} is not valid JSON (${msg(e)}).`);
    return want;
  }
  if (!isDeepStrictEqual(written, want)) {
    fail(`${describePath} differs from the self-description in the code. Run pnpm describe:extension and publish the result.`);
  } else {
    ok(`${describePath} matches the self-description in the code.`);
  }
  return want;
}

/* ---------------- 输出与 CLI ---------------- */

function printReport(rep: Report, pkgDir: string): void {
  console.log(`Directory: ${pkgDir}`);
  for (const m of rep.ok) console.log(`  OK ${m}`);
  for (const m of rep.warnings) console.log(`  WARN ${m}`);
  for (const m of rep.failures) console.log(`  FAIL ${m}`);
  console.log(`\nchecks: ok=${rep.ok.length} warn=${rep.warnings.length} fail=${rep.failures.length}`);
}

/* ---------------- 自检夹具（--selftest） ---------------- */

interface Case {
  name: string;
  pkg?: (p: Record<string, unknown>) => void;
  definition: string;
  describeFile?: (f: { tools: unknown[]; events: unknown[] }) => unknown;
  expectFail: string[];
  expectWarn?: string[];
}

const ECHO_DESC = { name: 'fx_echo', description: 'echo', parameters: { type: 'object', properties: {} }, tags: ['read'] };
const EMPTY_DESC = { tools: [], events: [] };
const worldSrc = (body: string): string => `const DEF = ${body};\nexport default DEF;\n`;
const goodBody = (id = 'goodworld'): string => `{
  id: ${JSON.stringify(id)}, label: 'Fixture',
  defaults: () => ({ enabled: false, url: '' }),
  create: () => ({ id: ${JSON.stringify(id)},
    tools: () => [{ name: 'fx_echo', description: 'echo', parameters: { type: 'object', properties: {} }, tags: ['read'], handler: async () => 'ok' }],
    envPromptVars: () => null }),
  describe: { tools: [{ name: 'fx_echo', description: 'echo', parameters: { type: 'object', properties: {} }, tags: ['read'] }], events: [] },
}`;

const CASES: Case[] = [
  { name: 'good-world', definition: worldSrc(goodBody()), expectFail: [] },
  { name: 'no-name-version', pkg: (p) => { delete p.name; delete p.version; }, definition: worldSrc(goodBody()), expectFail: ['has no name', 'has no version'] },
  { name: 'commonjs-type', pkg: (p) => { p.type = 'commonjs'; }, definition: worldSrc(goodBody()), expectFail: ['must be "module"'] },
  { name: 'no-cortico-block', pkg: (p) => { delete p.cortico; }, definition: worldSrc(goodBody()), expectFail: ['cortico block is missing'] },
  { name: 'bad-kind', pkg: (p) => { (p.cortico as Record<string, unknown>).kind = 'widget'; }, definition: worldSrc(goodBody()), expectFail: ['cortico.kind must be'] },
  { name: 'api-previous', pkg: (p) => { (p.cortico as Record<string, unknown>).api = 5; }, definition: worldSrc(goodBody()), expectFail: ['previous world contract'] },
  { name: 'api-too-new', pkg: (p) => { (p.cortico as Record<string, unknown>).api = 7; }, definition: worldSrc(goodBody()), expectFail: ['newer than the current world contract'] },
  { name: 'api-not-integer', pkg: (p) => { (p.cortico as Record<string, unknown>).api = '6'; }, definition: worldSrc(goodBody()), expectFail: ['integer'] },
  { name: 'missing-entry', pkg: (p) => { p.main = './src/ghost.ts'; }, definition: worldSrc(goodBody()), expectFail: ['does not exist'] },
  { name: 'bad-shape', definition: worldSrc(`{ id: 'goodworld', label: 'x', defaults: () => ({}) }`), expectFail: ['does not match the world shape'] },
  { name: 'defaults-throw', definition: worldSrc(`{ id: 'goodworld', label: 'x', defaults: () => { throw new Error('boom'); }, create: () => ({ id: 'goodworld' }), describe: { tools: [], events: [] } }`), expectFail: ['defaults() threw'] },
  { name: 'instance-id-mismatch', definition: worldSrc(`{ id: 'goodworld', label: 'x', defaults: () => ({ enabled: false }), create: () => ({ id: 'other', tools: () => [], envPromptVars: () => null }), describe: { tools: [], events: [] } }`), describeFile: () => EMPTY_DESC, expectFail: ['differs from definition id'] },
  {
    name: 'broken-tools',
    definition: worldSrc(`{ id: 'goodworld', label: 'x', defaults: () => ({ enabled: false }),
      create: () => ({ id: 'goodworld', envPromptVars: () => null, tools: () => [
        { name: 'fx_dup' },
        { name: 'fx_dup', parameters: {}, handler: async () => '', tags: [] },
        { name: 'external_event_frame', parameters: {}, handler: async () => '', tags: ['read'] },
        { name: 'fx_undesc', parameters: {}, handler: async () => '', tags: ['read'] },
      ] }),
      describe: { tools: [{ name: 'fx_dup', description: '', parameters: {}, tags: [] }], events: [] } }`),
    describeFile: () => ({ tools: [{ name: 'fx_dup', description: '', parameters: {}, tags: [] }], events: [] }),
    expectFail: ['Duplicate tool name: fx_dup', 'reserved frame name', 'has no handler',
      'missing from describe.tools', 'parameters is not an object', 'has no tags array'],
  },
  { name: 'builtin-id', definition: worldSrc(goodBody('qq')), expectFail: ['matches a built-in'] },
  { name: 'bad-page-id', definition: worldSrc(goodBody('Bad_ID')), expectFail: ['cannot form a WebUI page id'] },
  {
    name: 'describe-drift',
    definition: worldSrc(goodBody()),
    describeFile: () => ({ tools: [{ ...ECHO_DESC, description: 'DIFFERENT' }], events: [] }),
    expectFail: ['differs from the self-description'],
  },
  {
    name: 'no-describe-file', pkg: (p) => { (p.cortico as Record<string, unknown>).describe = 'describe.json'; },
    definition: worldSrc(goodBody()), describeFile: () => undefined as unknown, expectFail: ['is not in the package'],
  },
  {
    name: 'config-path-outside',
    definition: worldSrc(`{ id: 'goodworld', label: 'x', defaults: () => ({ enabled: false }),
      create: () => ({ id: 'goodworld', tools: () => [], envPromptVars: () => null,
        webUi: () => ({ config: [{ id: 'g', owner: 'world:goodworld', schema: { type: 'object', properties: { 'worlds.someone_else.url': { type: 'string' } } } }] }) }),
      describe: { tools: [], events: [] } }`),
    describeFile: () => EMPTY_DESC,
    expectFail: ['outside the worlds.goodworld. section'],
  },
  { name: 'webuiclient-missing', pkg: (p) => { (p.cortico as Record<string, unknown>).webUiClient = './dist/panel.js'; }, definition: worldSrc(goodBody()), expectFail: ['webUiClient points to'] },
  {
    name: 'enabled-warn',
    definition: worldSrc(`{ id: 'goodworld', label: 'x', defaults: () => ({ enabled: true }),
      create: () => ({ id: 'goodworld', tools: () => [], envPromptVars: () => null }),
      describe: { tools: [], events: [] } }`),
    describeFile: () => EMPTY_DESC,
    expectFail: [], expectWarn: ['enabled is not false'],
  },
];

async function selftest(): Promise<number> {
  const root = join(HERE, '.check-ext-selftest');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  let bad = 0;
  for (const c of CASES) {
    const dir = join(root, c.name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    const pkg: Record<string, unknown> = {
      name: `fx-${c.name}`, version: '0.1.0', type: 'module', main: './src/definition.ts',
      cortico: { kind: 'world', api: 6, describe: 'describe.json' },
    };
    if (c.pkg) c.pkg(pkg);
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(join(dir, 'src/definition.ts'), c.definition);
    const df = c.describeFile ? c.describeFile({ tools: [ECHO_DESC], events: [] }) : { tools: [ECHO_DESC], events: [] };
    if (df !== undefined) writeFileSync(join(dir, 'describe.json'), `${JSON.stringify(df, null, 2)}\n`);
    const rep = await runCheck(dir);
    const miss = c.expectFail.filter((needle) => !rep.failures.some((f) => f.includes(needle)));
    const unexpected = rep.failures.filter((f) => !c.expectFail.some((needle) => f.includes(needle)));
    const warnMiss = (c.expectWarn ?? []).filter((needle) => !rep.warnings.some((w) => w.includes(needle)));
    if (miss.length || unexpected.length || warnMiss.length) {
      bad += 1;
      console.log(`FAIL ${c.name}: 缺断言 ${JSON.stringify(miss)}${unexpected.length ? ` 意外 failures ${JSON.stringify(unexpected)}` : ''}${warnMiss.length ? ` 缺 warn ${JSON.stringify(warnMiss)}` : ''}`);
    } else {
      console.log(`ok   ${c.name}: ${rep.failures.length} fail / ${rep.warnings.length} warn as expected`);
    }
  }
  rmSync(root, { recursive: true, force: true });
  console.log(`\n${bad ? `SELFTEST FAILED: ${bad}/${CASES.length}` : `SELFTEST PASS (${CASES.length} fixtures)`} — check_ext.ts, gate list @cortico 836238311`);
  return bad ? 1 : 0;
}

async function main(): Promise<number> {
  const arg = process.argv[2];
  if (arg === '--selftest') return selftest();
  if (!arg) { console.error('Usage: node tools/check_ext.ts <package-dir> | --selftest'); return 1; }
  const rep = await runCheck(arg);
  printReport(rep, resolve(arg));
  return rep.failures.length ? 1 : 0;
}

process.exitCode = await main();
