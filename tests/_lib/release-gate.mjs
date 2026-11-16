// Fleet release gate — the three pre-publish checks (README / CHANGELOG / describe).
// Rule sources, verbatim-ported from the Cortico precedent:
//  - CHANGELOG: repos/cortico src/extensions/author-guide.ts:107-113 @836238311 —
//    `changelogHasVersion`: first semver under a "## " heading must equal pkg.version.
//  - describe:  src/extensions/describe-export.ts:110-169 @836238311 (checkDescribe),
//    static offline copy: cortico.describe must point into the package, parse, every
//    tool name found in src/*.ts must be declared, tags ⊆ ToolTag 六值
//    (src/core/types.ts:202, d-cortico-side §2.1), and cortico.api must be 6 (§4.1).
//  - README: the blueprint装机面 requires it (_COMPAT-BLUEPRINT.md:98), so the gate
//    demands a heading; a bare stub is a fail.
// tools() 四件起步 = _BUILD-PLAN.md §3.2 本件定稿, required for the two NEW worlds
// (cortico-world-neko / cortico-world-maibot); 收编包 (astrbot, onebot) keep existing
// describe sets and are only checked for shape + vocabulary.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TOOL_TAGS = new Set(['read', 'write', 'speak', 'act', 'flow', 'snapshot']);
export const FOUR_TOOLS = (w) => [`${w}_send_message`, `${w}_status`, `${w}_history`, `${w}_peer_call`];
// Required advertised face, per package, keyed on what the PEER bridge actually declares in
// hello.tools (SECURITY-CBP §7 N3: hello declaration is the only authority; a world may not
// advertise a *_send_message the bridge never announced). neko bridge declares neko_send, so its
// four-tool face is required; the maibot send leg is unwired (cortico-bridge-maibot/client.py:56
// declares tools=[]), so maibot advertises only the three bridge-independent tools.
export const REQUIRED_FOUR = {
  'cortico-world-neko': FOUR_TOOLS('neko'),
  'cortico-world-maibot': ['maibot_status', 'maibot_history', 'maibot_peer_call'],
};

export function changelogHasVersion(text, version) {
  // port of author-guide.ts:107-113 (CRLF-normalise, first semver in each "## " head)
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const head = /^##\s+(.*)$/.exec(line);
    if (head && /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(head[1])?.[0] === version) return true;
  }
  return false;
}

// Runs the three checks on one package dir. Returns failure strings (empty = pass).
export function releaseGate(pkgDir) {
  const failures = [];
  const pkgFile = join(pkgDir, 'package.json');
  if (!existsSync(pkgFile)) return ['package.json missing'];
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  const name = pkg.name ?? '';
  const version = pkg.version ?? '';
  if (!name || !version) failures.push('package.json lacks name or version');

  // 1. README
  const readme = join(pkgDir, 'README.md');
  if (!existsSync(readme)) failures.push('README.md missing (发布前置一)');
  else if (!/^#\s+\S/m.test(readFileSync(readme, 'utf8'))) failures.push('README.md has no heading');

  // 2. CHANGELOG
  const chlog = join(pkgDir, 'CHANGELOG.md');
  if (!existsSync(chlog)) failures.push('CHANGELOG.md missing (发布前置二)');
  else if (version && !changelogHasVersion(readFileSync(chlog, 'utf8'), version)) {
    failures.push(`CHANGELOG.md has no "## ${version}" section`);
  }

  // 3. describe — only for Cortico extension packages (kind declared in the manifest)
  if (pkg.cortico?.kind === 'world') {
    const describePath = pkg.cortico?.describe;
    if (typeof describePath !== 'string') failures.push('cortico.describe missing (发布前置三)');
    else if (!existsSync(join(pkgDir, describePath))) failures.push(`cortico.describe points to missing ${describePath}`);
    else {
      let d = null;
      try {
        d = JSON.parse(readFileSync(join(pkgDir, describePath), 'utf8'));
      } catch (e) {
        failures.push(`${describePath} is not valid JSON: ${e.message}`);
      }
      if (d) {
        const tools = d.tools ?? [];
        const names = tools.map((t) => t.name);
        if (new Set(names).size !== names.length) failures.push('describe.tools has duplicate names');
        for (const t of tools) {
          for (const tag of t.tags ?? []) {
            if (!TOOL_TAGS.has(tag)) failures.push(`tool ${t.name} tag "${tag}" not in ToolTag six`);
          }
        }
        for (const f of ['world.ts', 'definition.ts', 'tools.ts']) {
          const abs = join(pkgDir, 'src', f);
          if (!existsSync(abs)) continue;
          // (?!\s*\|) 排除 TS 参数类型标注 `name: 'connection' | 'degraded'`——那是事件名联合，
          // 不是 tools() 申报；上游 checkDescribe 只比运行时 toolNames（describe-export.ts:134-136）。
          for (const m of readFileSync(abs, 'utf8').matchAll(/name:\s*'([a-z0-9_]+)'(?!\s*\|)/g)) {
            if (!names.includes(m[1])) failures.push(`tools() name ${m[1]} not declared in describe.tools`);
          }
        }
        const required = REQUIRED_FOUR[name];
        if (required) for (const req of required) {
          if (!names.includes(req)) failures.push(`required tool ${req} missing from describe.tools`);
        }
      }
    }
    if (pkg.cortico.api !== 6) failures.push(`cortico.api must be 6 (_BUILD-PLAN §4.1), got ${pkg.cortico.api}`);
  }
  return failures;
}
