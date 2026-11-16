/** redact (§3.4): key table verbatim, query-token tail rule, URL userinfo rule. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SENSITIVE_KEYS, redactJson, redactText } from '../src/redact.js';

test('the key table is the §3.4 list, verbatim and complete', () => {
  assert.deepEqual([...SENSITIVE_KEYS].sort(), [
    'api_key',
    'apikey',
    'access_token',
    'authorization',
    'cookie',
    'credentials',
    'csrf_token',
    'passwd',
    'password',
    'secret',
    'set-cookie',
    'signature',
    'token',
    'x-signature',
  ].sort());
});

test('redactText strips query token values and keeps neighbours', () => {
  assert.equal(redactText('ws://h?access_token=abc&x=1'), 'ws://h?access_token=<redacted>&x=1');
  assert.equal(redactText('a?token=abc b'), 'a?token=<redacted> b');
  assert.equal(redactText('https://h?Token=x'), 'https://h?Token=<redacted>');
  assert.equal(redactText('no secrets here'), 'no secrets here');
});

test('redactText replaces URL userinfo, not host ports', () => {
  assert.equal(redactText('ws://user:pass@h:9/p'), 'ws://<redacted>@h:9/p');
  assert.equal(redactText('ws://h:9/p'), 'ws://h:9/p');
});

test('redactJson deletes sensitive keys case-insensitively, recurses, keeps the rest', () => {
  const src: Record<string, unknown> = {
    message_id: 7,
    Token: 'x',
    deep: { 'Set-Cookie': 'y', keep: 'z', arr: [{ PASSWORD: 'p', n: 1 }, 'ws://u:p@h'] },
  };
  const out = redactJson(src);
  const deep = out.deep as Record<string, unknown>;
  const arr = deep.arr as [Record<string, unknown>, string];
  assert.equal(out.message_id, 7);
  assert.equal('Token' in out, false);
  assert.equal('Set-Cookie' in deep, false);
  assert.equal(deep.keep, 'z');
  assert.equal('PASSWORD' in arr[0], false);
  assert.equal(arr[0].n, 1);
  assert.equal(arr[1], 'ws://<redacted>@h');
  // the source object is not mutated (the frame stays intact for other consumers)
  assert.equal(src.Token, 'x');
});

test('redactJson passes primitives and null through', () => {
  assert.equal(redactJson(5), 5);
  assert.equal(redactJson(null), null);
  assert.equal(redactJson(undefined), undefined);
});
