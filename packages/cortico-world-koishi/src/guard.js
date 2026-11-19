/**
 * 本机文件引用闸（2026-11-19 · 10-22 判例能力面收敛）。
 *
 * 本文件在 cortico-world-onebot-bridge 与 cortico-world-koishi 各放一份**逐字相同**副本；
 * test/guard.test.mjs 断言两侧 sha256 一致，防止一端漏改让能力面重新打开。
 *
 * 背景：OneBot v11 的媒体参数（file/image/record/voice/video/url 等）允许指向本机
 * 路径，模型可借 send_group_msg，或实现端扩展的 upload_* / get_file 之类动作，
 * 把本机任意文件发进群聊或私聊（索引仓 10-22 标签普查判例）。
 *
 * 此闸在任何出网调用之前跑：深度遍历 params，命中本地路径形状即拒 10002。
 * 只回报命中的键名，不回显值，避免路径或凭据进日志。
 */

/** 媒体 / 路径类参数键（大小写不敏感）。都是 v11 与常见实现端可能读本机文件的入口。 */
export const FILE_PARAM_KEYS = new Set([
  'file', 'image', 'record', 'voice', 'video', 'url', 'uri',
  'path', 'file_path', 'local_path', 'file_name', 'filename', 'target',
]);

/** 纯函数：判断一个字符串值是不是「本机文件引用」。远端 URL 与内联数据放行。 */
export function looksLocalFileRef(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s) return false;
  // 远端资源与内联数据：放行
  if (/^(?:https?|base64):\/\//i.test(s) || /^data:/i.test(s)) return false;
  if (/^file:\/\//i.test(s)) return true;
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;                 // C:\...  C:/...
  if (s.startsWith('\\\\')) return true;                     // \\host\share
  if (/^\/(?!\/)/.test(s)) return true;                      // /etc/passwd
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(s)) return true;      // ../ ..\
  if (s.includes('\\')) return true;                         // 任何反斜杠都按本地路径处理
  return false;
}

/**
 * 纯函数：深度遍历 action params，命中本机文件引用即拒。
 * 除对象/数组外，还扫字符串里的 CQ 码（[CQ:image,file=C:\secret.txt]），
 * 因为 v11 的 message 允许是 CQ 码文本而不是段数组。
 */
export function guardParams(params) {
  const hits = new Set();
  const walk = (v, key, depth) => {
    if (v == null || depth > 12) return;
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\[CQ:([a-z_]+),[^\]]*?\b(?:file|image|record|voice|video|url)=([^,\]]+)/gi)) {
        if (looksLocalFileRef(m[2])) hits.add(`CQ:${m[1]}`);
      }
      if (FILE_PARAM_KEYS.has(String(key).toLowerCase()) && looksLocalFileRef(v)) hits.add(String(key));
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, key, depth + 1); return; }
    if (typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1); }
  };
  walk(params, '', 0);
  return hits.size
    ? { block: true, reason: `10002 unsupported_action: 参数含本机文件引用（${[...hits].join(', ')}），已拒出网；媒体只接受 http(s) URL 或 base64 数据。` }
    : { block: false };
}

/**
 * 纯函数：动作名闸（2026-11-19 · 10-22 能力面收敛）。
 * 只放行 src/catalog.js 静态目录登记的动作；实现端扩展动作不再原样透传。
 * 模型因此不能在运行时发明 action 去触达实现端的文件读写能力面。
 */
export function guardActionName(name, entry) {
  if (entry) return { block: false };
  return {
    block: true,
    reason: `${name}: 10002 unsupported_action: 动作不在 v11 静态目录内，实现端扩展动作不再透传；如需启用请登记进 src/catalog.js。`,
  };
}
