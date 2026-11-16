// 改名账（rename ledger）— the four rows of reports/d-break-change.md §9.1, verbatim.
// Rule: 旧名兼容读、新名唯一写. Compat read = new name first, old name fallback.
// Unique write = only the new name is ever emitted; the old name is dropped.
// Evidence per row: repo + path + line + sha9, quoted ≤80 chars from the ledger row cell.
// d-break-change.md:252-257 @sha of reports (acquisition 2026-11-15).

// Entry kinds:
//  prop   — dotted object path, mechanically read/written (default)
//  id     — a bare identifier value that maps old→new (e.g. built-in World id)
//  split  — one old path, two new paths; write must drop old, targets listed
//  prefix — string prefix rewrite (npm package names / config entry names)
//  expr   — recorded only, not mechanically readable (bracket-syntax member)
export const RENAME_ROWS = [
  {
    id: 'cortico',
    repo: 'Pal-AI-Lab/Cortico',
    sha9: '836238311',
    verbatim: '`console()` → `webUi()`（World/Persona/provider）', // d-break-change:254 cell head
    source: 'docs/upgrading.md:13-22; src/extensions/previous-contract.ts:41-48',
    note: '兼容层要接。过渡层只认上一版契约，且 Cortico 下一个大版本删；新代码一律写新名',
    entries: [
      { old: 'consoleClient', new: 'webUiClient', space: 'manifest-field' },
      { old: 'consoleStyle', new: 'webUiStyle', space: 'manifest-field' },
      { old: 'console', new: 'webUi', space: 'member' },
      { old: 'logging.console', new: 'logging.stdout', space: 'config-path' },
      { old: 'terminal', new: 'console', space: 'world-id', kind: 'id' },
    ],
  },
  {
    id: 'maibot-sdk',
    repo: 'Mai-with-u/maibot-plugin-sdk',
    sha9: 'f9984673d',
    verbatim: '作用域三键从 `metadata` 内 → 组件对象顶层：`platforms`、`chat_scope`、`allowed_session`', // :255
    source: 'maibot_sdk/components.py:801-805; Host src/plugin_runtime/runner/runner_main.py:1545-1551',
    note: 'SDK≥2.23.0 用 pop 上提；旧 Host 只读 metadata 会读空；顶层显式声明优先（runner_main 注释「显式顶层声明优先」）',
    entries: ['platforms', 'chat_scope', 'allowed_session'].map((k) => ({
      old: `metadata.${k}`,
      new: k,
      space: 'component-path',
    })),
  },
  {
    id: 'astrbot',
    repo: 'AstrBotDevs/AstrBot',
    sha9: '133dd9f86',
    verbatim: '键 `pages` → `views`；WebUI 概念 Pages → Views', // :256
    source: 'astrbot/core/star/star_manager.py:556-561',
    note: '半接：pages 仍是别名，可只读不写（注释逐字 "views" is the preferred key; "pages" stays as an alias）',
    entries: [{ old: 'pages', new: 'views', space: 'metadata-key' }],
  },
  {
    id: 'cordis',
    repo: 'cordisjs/cordis',
    sha9: '820b8e5a2',
    verbatim: '`ctx.plugin()` → `ctx.use()`；`entry.fiber` → `entry.innerFiber`', // :257 head
    source: 'packages/core/src/registry.ts:120-123,233-238; cordis@4.0.0-rc.13#d72bb0813 lib/index.js:1583-1597',
    note: '前瞻：Koishi 4.18.11 钉 cordis@^3.18.1 现状不受影响；v3 无 ctx.use，rc 线旧名留 deprecated 别名',
    entries: [
      { old: 'plugin', new: 'use', space: 'ctx-member' },
      { old: 'fiber', new: 'innerFiber', space: 'entry-member' },
      { old: '@cordisjs/plugin-', new: '@cordisjs/', space: 'npm-name', kind: 'prefix' },
      { old: 'root', new: 'ctx[Context.root]', space: 'ctx-member', kind: 'expr' },
      { old: 'hmr.watch', new: 'fs.watch', space: 'ctx-member' },
      { old: 'resolveConfig', new: 'resolveIntercept', space: 'service-static' },
      { old: 'merge', new: 'mergeIntercept', space: 'service-static' },
      { old: 'config', new: 'metadata', space: 'service-marker' },
      { old: 'fiber', new: 'ctx', space: 'impl-member' },
      { old: 'store', new: ['committed', 'provisions'], space: 'fiber-member', kind: 'split' },
    ],
  },
];

function getPath(obj, path) {
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// True when the dotted path resolves to an existing key (even if its value is undefined).
export function pathExists(obj, path) {
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) return false;
    cur = cur[seg];
  }
  return true;
}

function setPath(obj, path, value) {
  const segs = path.split('.');
  let cur = obj;
  for (const s of segs.slice(0, -1)) cur = cur[s] ??= {};
  cur[segs.at(-1)] = value;
}

function dropPath(obj, path) {
  const segs = path.split('.');
  let cur = obj;
  for (const s of segs.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object' || !(s in cur)) return;
    cur = cur[s];
  }
  delete cur[segs.at(-1)];
}

export function mechanical(entry) {
  return entry.kind !== 'expr';
}

// 旧名兼容读：新名优先，旧名兜底。id 型把旧标识符值映射为新标识符。
export function compatRead(row, entry, obj) {
  if (entry.kind === 'id') return obj === entry.old ? entry.new : obj;
  if (entry.kind === 'prefix') {
    return typeof obj === 'string' && obj.startsWith(entry.old)
      ? entry.new + obj.slice(entry.old.length)
      : obj;
  }
  if (entry.kind === 'split') {
    for (const n of entry.new) if (getPath(obj, n) !== undefined) return getPath(obj, n);
    return getPath(obj, entry.old);
  }
  const nv = getPath(obj, entry.new);
  return nv !== undefined ? nv : getPath(obj, entry.old);
}

// 新名唯一写：产出只含新名，旧名一律删除；新旧都在时保留新值。
export function uniqueWrite(row, entry, obj) {
  if (entry.kind === 'id') return obj === entry.old ? entry.new : obj;
  if (entry.kind === 'prefix') {
    return typeof obj === 'string' && obj.startsWith(entry.old)
      ? entry.new + obj.slice(entry.old.length)
      : obj;
  }
  const out = structuredClone(obj);
  const oldV = getPath(obj, entry.old);
  const newV = entry.kind === 'split' ? undefined : getPath(obj, entry.new);
  dropPath(out, entry.old);
  if (entry.kind !== 'split' && newV === undefined && oldV !== undefined) {
    setPath(out, entry.new, oldV);
  }
  return out;
}

// All mechanically checkable entries of all rows.
export function mechanicalEntries() {
  const all = [];
  for (const row of RENAME_ROWS) {
    for (const entry of row.entries) {
      if (entry.kind === 'expr') continue;
      all.push({ row, entry });
    }
  }
  return all;
}
