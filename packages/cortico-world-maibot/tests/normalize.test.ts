/**
 * normalize.test.ts —— 归一化表逐字节断言。表里的每个键名都是 r-maibot 实测值：
 * - 宿主 MessageDict 17 键：upstream/maibot src/plugin_runtime/host/message_utils.py:45-62 @478f671e6
 * - SDK MaiMessages 15 字段：upstream/maibot-plugin-sdk maibot_sdk/messages.py:22-60 @f9984673d
 * - 段形态（含 text/image/voice 的 data 是字符串这种坑）：message_utils.py:97-168 @478f671e6
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENTS,
  HOST_COMPONENT_TYPES,
  HOST_MESSAGE_KEYS,
  SDK_MAIMESSAGES_FIELDS,
  asMessageDict,
  convOf,
  hostSegToCbp,
  imageSegToBlob,
  isSelfEcho,
  mimeFromHint,
} from '../src/normalize.ts';

test('宿主 MessageDict 17 键逐字（message_utils.py:45-62 @478f671e6）', () => {
  assert.deepEqual([...HOST_MESSAGE_KEYS], [
    'message_id',
    'timestamp',
    'received_at',
    'platform',
    'account_id',
    'scope',
    'message_info',
    'raw_message',
    'is_mentioned',
    'is_at',
    'is_emoji',
    'is_picture',
    'is_command',
    'is_notify',
    'session_id',
    'reply_to',
    'processed_plain_text',
  ]);
  assert.equal(HOST_MESSAGE_KEYS.length, 17);
});

test('SDK MaiMessages 15 字段逐字（messages.py:22-60 @f9984673d）', () => {
  assert.deepEqual([...SDK_MAIMESSAGES_FIELDS], [
    'message_segments',
    'plain_text',
    'llm_prompt',
    'llm_response_content',
    'llm_response_reasoning',
    'llm_response_model',
    'llm_response_tool_call',
    'stream_id',
    'is_group_message',
    'is_private_message',
    'message_base_info',
    'raw_message',
    'action_usage',
    'additional_data',
    'modify_flags',
  ]);
  assert.equal(SDK_MAIMESSAGES_FIELDS.length, 15);
});

test('raw_message 同名不同义：两套表都含它（蓝图 L197 禁混提醒）', () => {
  assert.ok(HOST_MESSAGE_KEYS.includes('raw_message'));
  assert.ok(SDK_MAIMESSAGES_FIELDS.includes('raw_message'));
});

test('宿主段类型全集 = _component_to_dict 分支（message_utils.py:97-168 @478f671e6）', () => {
  assert.deepEqual([...HOST_COMPONENT_TYPES], ['text', 'image', 'emoji', 'voice', 'file', 'at', 'reply', 'forward', 'dict']);
});

test('host 段 text：data 是裸字符串，必须包成 {text}（:97-98）', () => {
  const { seg } = hostSegToCbp({ type: 'text', data: '你好' });
  assert.deepEqual(seg, { type: 'text', data: { text: '你好' } });
});

test('host 段 image → CBP image，二进制进 base64（:100-110）', () => {
  const { seg } = hostSegToCbp({ type: 'image', data: 'media/a.png', hash: 'h1', binary_data_base64: 'QUJD' });
  assert.deepEqual(seg, { type: 'image', data: { file: 'media/a.png', hash: 'h1', base64: 'QUJD' } });
});

test('host 段 voice 改名 v11 record（segment.md @d4456ee70；voice 是宿主名）', () => {
  const { seg } = hostSegToCbp({ type: 'voice', data: 'v.amr', binary_data_base64: 'QQ==' });
  assert.deepEqual(seg, { type: 'record', data: { file: 'v.amr', base64: 'QQ==' } });
});

test('host 段 emoji 保留原名，渲染走内核 [emoji] 兜底（C1-16）', () => {
  const { seg, degraded } = hostSegToCbp({ type: 'emoji', data: 'e.gif', hash: 'h' });
  assert.deepEqual(seg, { type: 'emoji', data: { file: 'e.gif', hash: 'h' } });
  assert.equal(degraded, 'unknown-segment:emoji');
});

test('host 段 at：target_user_id→qq、cardname 优先 name（:137-145）', () => {
  const { seg } = hostSegToCbp({
    type: 'at',
    data: { target_user_id: '123', target_user_nickname: 'nick', target_user_cardname: 'card' },
  });
  assert.deepEqual(seg, { type: 'at', data: { qq: '123', name: 'card' } });
});

test('at_all：target_user_id==="all" → {qq:"all"}（_BUILD-PLAN L138，无 atall 键）', () => {
  const { seg } = hostSegToCbp({ type: 'at', data: { target_user_id: 'all' } });
  assert.deepEqual(seg, { type: 'at', data: { qq: 'all' } });
});

test('host 段 reply：target_message_id→id（:147-157）', () => {
  const { seg } = hostSegToCbp({
    type: 'reply',
    data: { target_message_id: '9', target_message_content: 'x', target_message_sender_id: '1' },
  });
  assert.deepEqual(seg, { type: 'reply', data: { id: '9' } });
});

test('host 段 file：payload 值全字符串化，嵌套 JSON（:134-135 to_payload dict）', () => {
  const { seg } = hostSegToCbp({ type: 'file', data: { name: 'a.txt', size: 10, extra: { k: 1 } } });
  assert.deepEqual(seg, { type: 'file', data: { name: 'a.txt', size: '10', extra: '{"k":1}' } });
});

test('host 段 forward：data 是节点数组，收进 {count,nodes}（:159-166）', () => {
  const { seg } = hostSegToCbp({ type: 'forward', data: [{ user_id: '1' }, { user_id: '2' }] });
  assert.equal(seg?.type, 'forward');
  assert.equal(seg?.data.count, '2');
  assert.deepEqual(JSON.parse(seg?.data.nodes ?? ''), [{ user_id: '1' }, { user_id: '2' }]);
});

test('host 段 dict 兜底：保留原 data，记降级（:168）', () => {
  const { seg, degraded } = hostSegToCbp({ type: 'dict', data: { k: 'v' } });
  assert.deepEqual(seg, { type: 'dict', data: { k: 'v' } });
  assert.equal(degraded, 'unknown-segment:dict');
});

test('已是 CBP 形（data 全字符串）的段原样通过', () => {
  const { seg } = hostSegToCbp({ type: 'image', data: { url: 'http://x/y.png' } });
  assert.deepEqual(seg, { type: 'image', data: { url: 'http://x/y.png' } });
});

test('坏段：非对象/无 type/空 type → seg=null + bad-segment', () => {
  assert.equal(hostSegToCbp('x').seg, null);
  assert.equal(hostSegToCbp({}).seg, null);
  assert.equal(hostSegToCbp({ type: '', data: {} }).seg, null);
  assert.equal(hostSegToCbp({ type: 'text' }).degraded, undefined); // data 缺省 = 空段仍可渲染
});

test('asMessageDict：认 17 键对象、拒 null/数组', () => {
  assert.ok(asMessageDict({ message_id: '1', platform: 'aiocqhttp', session_id: 's' }));
  assert.equal(asMessageDict(null), null);
  assert.equal(asMessageDict([1, 2]), null);
});

test('isSelfEcho：sender.id === raw.account_id（MessageDict.account_id :50）', () => {
  const f = { sender: { id: 'bot1', name: 'me' }, raw: { account_id: 'bot1' } };
  const g = { sender: { id: '555', name: 'u' }, raw: { account_id: 'bot1' } };
  assert.equal(isSelfEcho(f), true);
  assert.equal(isSelfEcho(g), false);
  assert.equal(isSelfEcho({ sender: { id: 'x', name: '' }, raw: null }), false);
});

test('convOf：conv 空时回落 session_id（MessageDict.session_id :60）', () => {
  assert.equal(convOf({ conv: 'c1', raw: { session_id: 's' } }), 'c1');
  assert.equal(convOf({ conv: '', raw: { session_id: 's1' } }), 's1');
  assert.equal(convOf({ conv: '', raw: {} }), '');
});

test('mimeFromHint：扩展名 → MIME；未知扩展 null', () => {
  assert.equal(mimeFromHint('a/b.PNG'), 'image/png');
  assert.equal(mimeFromHint('b/avif'), null);
  assert.equal(mimeFromHint('x.jpeg'), 'image/jpeg');
  assert.equal(mimeFromHint(undefined), null);
});

test('imageSegToBlob：base64+可判 mime 出 bytes；无 mime 出 null（附件宁缺勿错）', () => {
  const seg = { type: 'image', data: { file: 'a.png', base64: 'QUJD' } };
  const blob = imageSegToBlob(seg);
  assert.equal(blob?.mime, 'image/png');
  assert.deepEqual([...(blob?.bytes ?? [])], [65, 66, 67]);
  assert.equal(imageSegToBlob({ type: 'image', data: { file: 'a.xyz', base64: 'QUJD' } }), null);
  assert.equal(imageSegToBlob({ type: 'text', data: { text: 'x' } }), null);
});

test('事件名五件显式表（蓝图 §2.3：不从 worldId 派生逻辑之外再造名）', () => {
  assert.deepEqual(EVENTS, {
    message: 'maibot.message',
    messageSelf: 'maibot.message.self',
    notice: 'maibot.notice',
    connection: 'maibot.connection',
    degraded: 'maibot.degraded',
  });
});
