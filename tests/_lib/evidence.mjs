// Shared evidence paths and the sha9 ledger for the fleet contract tests.
// Evidence root = the fresh acquisition of 2026-11-15. Override with BOTFW_EVIDENCE_ROOT.
// sha9 source: reports/_BUILD-PLAN.md §4.5 (00-ACQUISITION ledger; AstrBot = 133dd9f86,
// it replaced eee9f81ca by fast-forward, so the task map's old value is not used).
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVIDENCE_ROOT =
  process.env.BOTFW_EVIDENCE_ROOT ?? 'C:/Users/54301/tmp/botfw-compat-20261115';
// Fleet root = parent of tests/. My agent may only write tests/, so every other
// artifact (spec/, packages/, src/) is read here and owned by another work order.
export const FLEET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const SHA_LEDGER = {
  'upstream/neko': '52e973ed2',
  'upstream/maibot': '478f671e6',
  'upstream/maibot-plugin-sdk': 'f9984673d',
  'upstream/onebot-11': 'd4456ee70',
  'upstream/onebot': 'd533f0fca',
  'repos/cortico': '836238311',
  'repos/astrbot': '133dd9f86',
  'repos/koishi': '97d5c3957',
  'repos/cordis': '820b8e5a2',
  'repos/cordis-v3': '4658414e9',
  'repos/satori': 'db22bb3c2',
  'repos/satori-v4.6.1': 'fa5ec61ac',
  'repos/nonebot2': '2450b67a1',
  'repos/adapter-onebot': '8e0d1145a',
  'repos/koishi-plugin-adapter-onebot': '4109eb95c',
  'repos/world-astrbot': '4725feee6',
  'repos/astrbot-plugin-bridge': '37c1e6ccd',
  'repos/onebot': '2e91b7fb1',
  'repos/telegram': '6bc05cb0e',
  'repos/qq-lite': 'f908b0357',
};

export function evidencePath(rel) {
  return resolve(EVIDENCE_ROOT, rel);
}

export function readText(abs) {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

export function readReport(rel) {
  return readText(evidencePath(joinPosix('reports', rel)));
}

function joinPosix(...parts) {
  return parts.join('/');
}

export function exists(abs) {
  return existsSync(abs);
}

// Read-only local git query. Offline: rev-parse never touches the network.
export function gitHead9(repoRel) {
  const abs = evidencePath(repoRel);
  if (!existsSync(abs)) return null;
  return execFileSync('git', ['-C', abs, 'rev-parse', '--short=9', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}
