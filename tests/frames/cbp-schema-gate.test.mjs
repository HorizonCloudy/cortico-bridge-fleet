// Real CBP schema gate: runs tools/validate_cbp.mjs (ajv draft 2020-12 strict) over
// spec/conformance.json positive + negative frame vectors and requires exit 0.
// This is the replacement for text-containment checks like the one still present in
// frames-segments.test.mjs:96 — grepping for a string is not validating vectors.
// Run: node --test tests/frames/   (or npm test from tools/)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FLEET_ROOT } from '../_lib/evidence.mjs';

test('ajv gate: tools/validate_cbp.mjs passes every spec/conformance.json frame vector', (t) => {
  const script = resolve(FLEET_ROOT, 'tools/validate_cbp.mjs');
  if (!existsSync(script)) return t.skip('缺 tools/validate_cbp.mjs（校验器工单产出）');
  if (!existsSync(resolve(FLEET_ROOT, 'tools/node_modules/ajv'))) {
    return t.skip('缺 tools/node_modules/ajv（npm install --prefix tools --registry=https://registry.npmmirror.com --ignore-scripts）');
  }
  let out;
  try {
    out = execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    assert.fail(`validate_cbp.mjs exited ${e.status}:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
  }
  assert.match(out, /(\d+)\/\1 pass/, `validator did not report full pass: ${out}`);
});
