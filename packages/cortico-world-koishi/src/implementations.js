/**
 * OneBot 实现识别 —— catalog 选择逻辑第一步。
 *
 * 样式移植自 cortico-world-onebot @2e91b7fb1 的 src/implementations.js:16
 * detectImplementation：靠 get_version_info 的 app_name 判断对端；认不出就保留
 * 自报名，让状态里能看出连的是谁。本包不跨仓 import 那个包，函数在此重写。
 */

const KNOWN = [
  { id: 'napcat', match: /napcat/i },
  { id: 'snowluma', match: /snowluma/i },
  { id: 'llonebot', match: /llonebot/i },
  { id: 'lagrange', match: /lagrange/i },
  { id: 'go-cqhttp', match: /go-?cqhttp/i },
];

export function detectImplementation(version) {
  const name = String(version?.app_name ?? '').trim();
  const known = KNOWN.find((entry) => entry.match.test(name));
  return {
    id: known?.id ?? '',
    label: known ? known.id : (name || 'v11-unknown'),
  };
}
