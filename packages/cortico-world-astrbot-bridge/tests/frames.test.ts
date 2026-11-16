import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CBP_VERSION,
  ERR_VERSION_GATE,
  intersectCaps,
  negotiateVersions,
  parseFrame,
  readCaps,
  readVersionSupport,
  tsToIso,
} from '../src/frames.ts';

const LOCAL = { name: 'cortico-world-astrbot-bridge', version: '0.1.0', sha: 'deadbeef1' };

test('parseFrame：坏帧一律 null，绝不抛出', () => {
  for (const bad of ['not json', '', 'null', '3', '"str"', '[1,2]']) {
    assert.equal(parseFrame(bad), null, bad);
  }
  assert.deepEqual(parseFrame('{"t":"tick"}'), { t: 'tick' });
});

test('tsToIso：float 秒 → ISO（内核 envelope 规则）', () => {
  assert.equal(tsToIso(1700000000.5), new Date(1700000000500).toISOString());
});

test('readVersionSupport：旧 hello/ready 无 v_support 按 v:1 放行（_BUILD-PLAN §2.3）', () => {
  assert.deepEqual(readVersionSupport({ v: 1 }), [1]);
  assert.deepEqual(readVersionSupport({}), [1]);
  assert.deepEqual(readVersionSupport({ v: 2 }), [2]);
  assert.deepEqual(readVersionSupport({ v_support: [1, 2], v: 1 }), [1, 2]);
});

test('readCaps：旧桥无 caps → 空集（功能位全关）', () => {
  assert.deepEqual(readCaps({}), []);
  assert.deepEqual(readCaps({ caps: ['msg-v2', 3] }), ['msg-v2']);
});

test('版本不相交 → 60001 且文案带两侧包名版本sha', () => {
  const n = negotiateVersions([CBP_VERSION], [2, 3], LOCAL, { name: 'cortico-bridge-astrbot', version: '9.9.9', sha: 'ffff00001' });
  assert.equal(n.ok, false);
  assert.equal(n.code, ERR_VERSION_GATE);
  assert.match(n.message ?? '', /cortico-world-astrbot-bridge@0.1.0#deadbeef1/);
  assert.match(n.message ?? '', /cortico-bridge-astrbot@9.9.9#ffff00001/);
});

test('版本相交取最大；caps 取交集', () => {
  assert.deepEqual(negotiateVersions([1], [1], LOCAL, { name: 'peer', version: '', sha: '' }), { ok: true, version: 1 });
  assert.deepEqual(intersectCaps(['a', 'b', 'c'], ['b', 'c', 'd']), ['b', 'c']);
});
