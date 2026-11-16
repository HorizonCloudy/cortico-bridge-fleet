/**
 * Version pins. spec/pins.json (owned by fleet/spec, refreshed by tools/gen_pins.py, G1) is the
 * single source for the fleet. F13 (SECURITY-CBP §4.1/§4.2) retired the old kernel-side byte
 * snapshot: `caps` and the cap vocabulary load from the JSON at module init, and a missing or
 * malformed section throws at import — the kernel never silently keeps running on stale numbers.
 * Non-caps ledger fields still merge the JSON over the module constants below.
 * sha9 values are the 00-ACQUISITION ledger.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HostPin {
  version: string;
  sha9: string;
  note?: string;
}

/** One caps line, four keys, byte limits nullable (SECURITY-CBP §4.2 verbatim shape). */
export interface CapLine {
  frame_bytes: number | null;
  text_bytes: number | null;
  media_bytes: number | null;
  action: 'reject' | 'host-ask' | 'degrade';
}

/** Cap names the negotiation vocabulary accepts (c1 §5.5). Values come from pins.json vocab.cbp.caps. */
export type CapName =
  | 'images'
  | 'buttons'
  | 'audio_out'
  | 'files'
  | 'notices'
  | 'reply_tail'
  | 'self_echo'
  | 'tools'
  | 'history_backfill';

export interface Pins {
  node: string;
  ws: string;
  cbpVersion: number;
  /**
   * Media/frame byte limits, single source spec/pins.json `caps` section (F13).
   * No package-side copy exists any more; loadPins throws when the section is absent.
   */
  caps: {
    /** frame_bytes on the CBP line is never null: the host cap is enforced, not advisory. */
    cbp: CapLine & { frame_bytes: number };
    neko: CapLine;
    maibot: CapLine;
    astrbot: CapLine;
    onebot: CapLine;
  };
  /** Capability-name vocabulary, single source spec/pins.json `vocab.cbp.caps`; order is the intersection order. */
  capsVocab: CapName[];
  cortico: { version: string; sha9: string; api: number; previousApi: number };
  hosts: {
    neko: HostPin & { sdkVersion: string; pluginSupported: string; python: string };
    maibot: HostPin & { sdk: string; python: string };
    astrbot: HostPin & { python: string; astrbotVersion: string };
    koishi: HostPin;
    nonebot: HostPin & { adapter: string; adapterSha9: string };
    cordis: { version: string };
    satori: { version: string };
    onebot11: { sha9: string };
  };
  ports: {
    nekoListen: number;
    maibotListen: number;
    defaultHost: string;
    envOverride: { neko: string; maibot: string };
  };
}

function fail(msg: string): never {
  throw new Error(`pins: ${msg}`);
}

/** Module constants for the NON-caps fields only. caps numbers live in spec/pins.json alone. */
const BASE: Omit<Pins, 'caps' | 'capsVocab'> = {
  node: '>=22.16.0',
  ws: '^8.18.0',
  cbpVersion: 1,
  cortico: { version: '0.2.15', sha9: '836238311', api: 6, previousApi: 5 },
  hosts: {
    neko: {
      version: '0.9.1',
      sha9: '52e973ed2',
      // SDK_VERSION space, not APP_VERSION — registry.py:1127-1167 gate @52e973ed2 (blueprint §1.3-2).
      sdkVersion: '0.1.0',
      pluginSupported: '>=0.1.0,<0.2.0',
      python: '==3.11.*',
    },
    maibot: { version: '1.4.5', sha9: '478f671e6', sdk: '>=2.23.0@f9984673d', python: '>=3.12' },
    astrbot: {
      version: '4.29.4',
      sha9: '133dd9f86',
      python: '>=3.12',
      astrbotVersion: '>=4.29.4,<5',
    },
    koishi: { version: '4.18.11', sha9: '97d5c3957' },
    nonebot: { version: '2.5.0', sha9: '2450b67a1', adapter: '2.4.6', adapterSha9: '8e0d1145a' },
    // stable lines only; cordis/satori main are forbidden (_BUILD-PLAN C1-13)
    cordis: { version: '^3.18.1' },
    satori: { version: '^4.6.0' },
    onebot11: { sha9: 'd4456ee70' },
  },
  ports: {
    nekoListen: 39701,
    maibotListen: 39702,
    defaultHost: '127.0.0.1',
    envOverride: { neko: 'CORTICO_BRIDGE_NEKO_PORT', maibot: 'CORTICO_BRIDGE_MAIBOT_PORT' },
  },
};

/**
 * Best-effort map of the real spec/pins.json (G1 schema) non-caps fields into the kernel Pins
 * view, over BASE. The caps path is NOT best-effort: see capsOf/capsVocabOf, which throw.
 */
function str(x: unknown): string | undefined {
  return typeof x === 'string' && x.length ? x : undefined;
}
function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}
function obj(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}
function isObjRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/** owner is a free-text field; match the two Cortico-side listen rows by their world name. */
function portFor(ports: unknown[], want: RegExp): number | undefined {
  for (const raw of ports) {
    const e = obj(raw);
    if (want.test(str(e.owner) ?? '')) {
      const p = num(e.port);
      if (p !== undefined) return p;
    }
  }
  return undefined;
}

const CAP_LINE_KEYS: readonly string[] = ['frame_bytes', 'text_bytes', 'media_bytes', 'action'];

/** one caps line, hard shape check; any violation throws, nothing silently stands in. */
function capLineOf(capsJ: Record<string, unknown>, name: string): CapLine {
  const e = capsJ[name];
  if (!isObjRecord(e)) fail(`caps.${name} 缺线或不是对象（spec/pins.json 是 caps 唯一来源）`);
  const keys = Object.keys(e).sort();
  if (keys.join(',') !== [...CAP_LINE_KEYS].sort().join(','))
    fail(`caps.${name} 键集必须恰为 frame_bytes,text_bytes,media_bytes,action，实为 ${keys.join(',')}`);
  const bytes: Record<string, number | null> = {};
  for (const f of ['frame_bytes', 'text_bytes', 'media_bytes']) {
    const v = e[f];
    if (v === null) bytes[f] = null;
    else if (typeof v === 'number' && Number.isInteger(v) && v > 0) bytes[f] = v;
    else fail(`caps.${name}.${f} 必须为正整数或 null，实为 ${JSON.stringify(v)}`);
  }
  if (name === 'cbp' && bytes.frame_bytes === null)
    fail('caps.cbp.frame_bytes 不许为 null（内核 maxPayload 唯一数，F13 §4.4）');
  const action = str(e.action);
  if (action !== 'reject' && action !== 'host-ask' && action !== 'degrade')
    fail(`caps.${name}.action 必须在 reject/host-ask/degrade，实为 ${JSON.stringify(e.action)}`);
  return { frame_bytes: bytes.frame_bytes, text_bytes: bytes.text_bytes, media_bytes: bytes.media_bytes, action };
}

/** strict read of the whole caps section; missing section or line throws (fail-shut, no fallback). */
function capsOf(j: Record<string, unknown>): Pins['caps'] {
  if (!isObjRecord(j.caps)) fail('顶层缺 caps 段（F13 单源，SECURITY-CBP §4.2）——拒绝以旧值继续');
  if (!isObjRecord(j.caps.notes)) fail('caps 缺 notes 来源子段（SECURITY-CBP.md §4.2 形状）');
  return {
    cbp: capLineOf(j.caps, 'cbp') as Pins['caps']['cbp'],
    neko: capLineOf(j.caps, 'neko'),
    maibot: capLineOf(j.caps, 'maibot'),
    astrbot: capLineOf(j.caps, 'astrbot'),
    onebot: capLineOf(j.caps, 'onebot'),
  };
}

/** strict read of vocab.cbp.caps: non-empty unique non-empty-string array or throw. */
function capsVocabOf(j: Record<string, unknown>): CapName[] {
  const v = isObjRecord(j.vocab) && isObjRecord(j.vocab.cbp) ? j.vocab.cbp.caps : undefined;
  if (!Array.isArray(v) || v.length === 0 || !v.every((s) => typeof s === 'string' && s.length > 0))
    fail('缺 vocab.cbp.caps 或非「非空字符串数组」（协商词表唯一来源）——拒绝以旧值继续');
  if (new Set(v).size !== v.length) fail('vocab.cbp.caps 有重名');
  return [...v] as CapName[];
}

function pkgRootOf(here: string): string {
  return /[/\\]dist[/\\]/.test(here)
    ? join(here, '..', '..', '..') // dist/src -> dist -> package root
    : join(here, '..', '..'); // src -> package root
}

/**
 * Pins file candidates, in the order that survives being installed.
 * 1. CORTICO_PINS_JSON wins: the host or a test points at its own ledger.
 * 2. <package>/spec/pins.json — the shipped layout. prepack copies the fleet ledger here.
 * 3. <fleet>/spec/pins.json — the in-repo dev layout, so editing the ledger needs no rebuild.
 * Returning candidate 2 when nothing exists keeps the error pointing at the file that must ship.
 */
function defaultPinsFile(): string {
  const here = fileURLToPath(import.meta.url); // .../dist/src/pins.js (built) or src/pins.ts (tsx)
  const env = process.env.CORTICO_PINS_JSON;
  if (env) return env;
  const pkgRoot = pkgRootOf(here);
  const packed = join(pkgRoot, 'spec', 'pins.json');
  if (existsSync(packed)) return packed;
  const inRepo = join(pkgRoot, '..', '..', 'spec', 'pins.json');
  if (existsSync(inRepo)) return inRepo;
  return packed;
}

/**
 * Load pins from spec/pins.json. `file` defaults to the fleet spec path and exists as a test
 * seam only — production callers pass nothing. Throws when the file, the caps section, or the
 * cap vocabulary is missing or malformed (F13): a stale in-package fallback was the bug this
 * retires. Non-caps fields keep their per-field merge semantics.
 */
export function loadPins(file?: string): Pins {
  const resolved = file ?? defaultPinsFile();
  if (!existsSync(resolved)) fail(`读不到 ${resolved}（G1 单源件缺失即拒绝读数，不回落包内旧值；发布产物必须由 prepack 带上包内 spec/pins.json）`);
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(readFileSync(resolved, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    fail(`spec/pins.json 解析失败: ${e instanceof Error ? e.message : e}`);
  }
  const caps = capsOf(j);
  const capsVocab = capsVocabOf(j);
  const repos = obj(j.repos);
  const npmPins = obj(j.npm_pins);
  const buckets = obj(j.python_buckets);
  const sdk = obj(j.neko_sdk);
  const nodeObj = obj(j.node);

  const nekoRepo = obj(repos.neko);
  const maibotRepo = obj(repos.maibot);
  const astrbotRepo = obj(repos.astrbot);
  const koishiRepo = obj(repos.koishi);
  const corticoRepo = obj(repos.cortico);
  const nbRepo = obj(repos.nonebot2);
  const nbAdp = obj(repos['adapter-onebot']);

  const nodeMin = str(nodeObj.min);
  const portsArr = Array.isArray(j.ports) ? j.ports : [];

  const maibotPkg = obj(obj(buckets.maibot_py312).packages);
  const astrbotPkg = obj(obj(buckets.astrbot_py312).packages);

  return {
    ...BASE,
    caps,
    capsVocab,
    node: nodeMin ? `>=${nodeMin}` : BASE.node,
    cbpVersion: num(j.cbp_version) ?? BASE.cbpVersion,
    cortico: {
      version: str(corticoRepo.version)?.split(',')[0]?.trim() || BASE.cortico.version,
      sha9: str(corticoRepo.sha9) || BASE.cortico.sha9,
      api: BASE.cortico.api,
      previousApi: BASE.cortico.previousApi,
    },
    hosts: {
      neko: {
        version: str(nekoRepo.version) || BASE.hosts.neko.version,
        sha9: str(nekoRepo.sha9) || BASE.hosts.neko.sha9,
        sdkVersion: str(sdk.sdk_version) || BASE.hosts.neko.sdkVersion,
        pluginSupported: str(sdk.declare_supported) || BASE.hosts.neko.pluginSupported,
        python: str(obj(buckets.neko_py311).python) || BASE.hosts.neko.python,
      },
      maibot: {
        version: str(maibotRepo.version) || BASE.hosts.maibot.version,
        sha9: str(maibotRepo.sha9) || BASE.hosts.maibot.sha9,
        sdk: str(maibotPkg['maibot-plugin-sdk'])
          ? `${str(maibotPkg['maibot-plugin-sdk'])}@${str(obj(repos['maibot-sdk']).sha9) || BASE.hosts.maibot.sha9}`
          : BASE.hosts.maibot.sdk,
        python: str(obj(buckets.maibot_py312).python) || BASE.hosts.maibot.python,
      },
      astrbot: {
        version: str(astrbotRepo.version) || BASE.hosts.astrbot.version,
        sha9: str(astrbotRepo.sha9) || BASE.hosts.astrbot.sha9,
        python: str(obj(buckets.astrbot_py312).python) || BASE.hosts.astrbot.python,
        astrbotVersion: str(astrbotPkg.astrbot)?.replace(/^==/, '>=') || BASE.hosts.astrbot.astrbotVersion,
      },
      koishi: {
        version: str(obj(npmPins.koishi).version) || BASE.hosts.koishi.version,
        sha9: str(koishiRepo.sha9) || BASE.hosts.koishi.sha9,
      },
      nonebot: {
        version: str(nbRepo.version) || BASE.hosts.nonebot.version,
        sha9: str(nbRepo.sha9) || BASE.hosts.nonebot.sha9,
        adapter: str(nbAdp.version) || BASE.hosts.nonebot.adapter,
        adapterSha9: str(nbAdp.sha9) || BASE.hosts.nonebot.adapterSha9,
      },
      cordis: { version: str(obj(npmPins.cordis).version) ? `^${str(obj(npmPins.cordis).version)}` : BASE.hosts.cordis.version },
      satori: { version: str(obj(npmPins['@satorijs/core']).version) ? `^${str(obj(npmPins['@satorijs/core']).version)}` : BASE.hosts.satori.version },
      onebot11: { sha9: str(obj(repos['onebot-11']).sha9) || BASE.hosts.onebot11.sha9 },
    },
    ports: {
      ...BASE.ports,
      nekoListen: portFor(portsArr, /cortico-world-neko listen/) ?? BASE.ports.nekoListen,
      maibotListen: portFor(portsArr, /cortico-world-maibot listen/) ?? BASE.ports.maibotListen,
    },
  };
}

/** Kernel-wide pins, read from spec/pins.json at import. Throws (refuses to stand up) when caps are unreadable. */
export const PINS: Pins = loadPins();
