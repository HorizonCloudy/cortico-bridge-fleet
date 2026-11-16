#!/usr/bin/env node
// validate_cbp.mjs — the real gate behind spec/CBP-v1.json.
// Compiles the schema with ajv draft 2020-12 strict mode, then runs every positive
// vector in spec/conformance.json `frames.vectors` (must validate) and every negative
// vector in `frame_negatives.vectors` (must be rejected AND the rejection must hit the
// ledger entry named for that vector below). A meta-gate cross-checks the vector table
// against the ledger in both directions. Any mismatch prints the
// vector id and the run exits 1.
// Deps: ajv ^8 installed under tools/node_modules (npm --prefix tools --registry=npmmirror --ignore-scripts).
// Sabotage/diff reruns take a schema copy: CBP_SCHEMA=<path> node validate_cbp.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
let Ajv2020;
try {
  Ajv2020 = req('ajv/dist/2020');
} catch {
  console.error('FAIL: ajv not installed. Run: npm install --prefix tools --registry=https://registry.npmmirror.com --ignore-scripts');
  process.exit(1);
}

const schemaPath = process.env.CBP_SCHEMA ?? resolve(TOOLS_DIR, '../spec/CBP-v1.json');
const vectorsPath = process.env.CBP_CONFORMANCE ?? resolve(TOOLS_DIR, '../spec/conformance.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const conf = JSON.parse(readFileSync(vectorsPath, 'utf8'));

// Negative vector -> its expected rejection. A bare string asserts the ajv keyword
// appears in the flattened oneOf error set (legacy entries). An object {kw, path, prop}
// additionally pins the error instancePath and the missing/additional property name, so
// "some branch hiccuped" cannot masquerade as the asserted rule. Every vector in
// frame_negatives MUST have an entry here or the meta-gate below exits red.
const EXPECTED_KEYWORD = {
  null_scalar: 'type',
  empty_array: 'type',
  number_scalar: 'type',
  string_scalar: 'type',
  true_scalar: 'type',
  missing_ts: 'required',
  missing_id: 'required',
  wrong_v: 'const',
  unknown_t: 'const',
  extra_top_key: 'additionalProperties',
  extra_sender_key_role: 'additionalProperties',
  segment_value_numeric: 'type',
  risk_invalid: 'enum',
  id_empty: 'minLength',
  id_65_chars: 'maxLength',
  notice_missing_kind: 'required',
  call_args_array: 'type',
  reply_false_without_error: 'required',
  reply_c1_retcode_shape: 'additionalProperties',
  legacy_private_hello: 'required',
  // F3 identity closure (SECURITY-CBP 1, :40/:56): actor/turn are required on call,
  // actor.member reuses $defs/sender which closes at id+name.
  call_missing_actor: { kw: 'required', path: '', prop: 'actor' },
  call_missing_turn: { kw: 'required', path: '', prop: 'turn' },
  actor_extra_key_closed: { kw: 'additionalProperties', path: '/actor/member', prop: 'role' },
  // F1/F2 self closure (SECURITY-CBP 2, :96): self required on hello, closes at three keys.
  hello_missing_self: { kw: 'required', path: '', prop: 'self' },
  ready_self_extra_key: { kw: 'additionalProperties', path: '/self', prop: 'source' },
};

const ajv = new Ajv2020({ strict: true, allErrors: true });
let validate;
try {
  validate = ajv.compile(schema);
} catch (e) {
  console.log(`FAIL schema_compile: ${e.message}`);
  process.exit(1);
}

function walkErrors(errors, fn) {
  for (const e of errors || []) {
    fn(e);
    if (e.errors) walkErrors(e.errors, fn);
  }
}

// spec: 'keyword' (legacy membership) or {kw, path, prop} pinning the exact
// instancePath and the missing/additional property the schema complains about.
function keywordHits(errors, spec) {
  const legacy = typeof spec === 'string' ? { kw: spec } : spec;
  let hit = false;
  walkErrors(errors, (e) => {
    if (e.keyword !== legacy.kw || (legacy.path !== undefined && e.instancePath !== legacy.path)) return;
    if (legacy.prop === undefined) { hit = true; return; }
    const p = e.params || {};
    if (p.missingProperty === legacy.prop || p.additionalProperty === legacy.prop) hit = true;
  });
  return hit;
}

const specOf = (s) => (typeof s === 'string' ? s : `${s.kw} @ ${JSON.stringify(s.path)} prop=${s.prop}`);

let failed = 0;
const fail = (id, why, errors) => {
  failed += 1;
  console.log(`FAIL ${id}: ${why}`);
  for (const e of (errors || []).slice(0, 6)) console.log(`     ${e.instancePath || '#'} ${e.keyword} ${e.message ?? ''}`);
};

// Meta-gate: the ledger and the vector table must agree in both directions.
// A new negative vector without an EXPECTED_KEYWORD entry is red here, up front,
// and a stale ledger entry whose vector was deleted is red too.
{
  const names = new Set(conf.frame_negatives.vectors.map((v) => v.name));
  for (const n of names) if (!Object.hasOwn(EXPECTED_KEYWORD, n)) fail(`ledger.${n}`, 'negative vector exists in conformance.json but has no EXPECTED_KEYWORD entry');
  for (const k of Object.keys(EXPECTED_KEYWORD)) if (!names.has(k)) fail(`ledger.${k}`, 'EXPECTED_KEYWORD entry matches no vector (stale)');
  if (failed) {
    console.log(`\nCBP ledger gate: ${failed} LEDGER MISMATCH(es) — fix EXPECTED_KEYWORD before running vectors`);
    process.exit(1);
  }
}

for (const vec of conf.frames.vectors) {
  const ok = validate(vec.frame);
  if (ok !== vec.expect.valid) fail(`frames.${vec.name}`, `expected valid=${vec.expect.valid}, got ${ok}`, validate.errors);
}

for (const vec of conf.frame_negatives.vectors) {
  let input;
  try {
    input = JSON.parse(vec.input);
  } catch {
    fail(`frame_negatives.${vec.name}`, 'input wire string is not JSON at all');
    continue;
  }
  const ok = validate(input);
  if (ok) {
    fail(`frame_negatives.${vec.name}`, `expected rejection, schema accepted it (reason field: ${vec.reason})`);
    continue;
  }
  const expect = EXPECTED_KEYWORD[vec.name]; // existence guaranteed by the meta-gate above
  if (!keywordHits(validate.errors, expect)) {
    fail(`frame_negatives.${vec.name}`, `rejected, but not by ${specOf(expect)}`);
  }
}

const total = conf.frames.vectors.length + conf.frame_negatives.vectors.length;
if (failed) {
  console.log(`\nCBP vectors: ${failed}/${total} FAILED (schema ${schemaPath})`);
  process.exit(1);
}
console.log(`CBP vectors: ${total}/${total} pass (${conf.frames.vectors.length} positive, ${conf.frame_negatives.vectors.length} negative, schema ${schemaPath})`);
