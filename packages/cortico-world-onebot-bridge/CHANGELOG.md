# 更新日志 · cortico-world-onebot-bridge

每个版本一节 `## <版本号>`；扩展市场按节显示更新说明。

## 0.1.2

- 面板「桥状态」补客户端产物：`src/webui/client.js`，`cortico.webUiClient` 声明它。
- 描述改简体中文，并补 `cortico.locales.zh` / `.en` 两份。
- 服务端补 `webUi().panels` 与 `invoke('status','get')`，面板数据面与状态工具同源。

## 0.1.0

首个版本：Cortico 侧 OneBot v11 world 包骨架。只承诺 v11，不承诺 v12。

- 装载契约：`package.json` 的 `cortico` 块 `kind:"world"`、`api:6`（精确等于当前锚
  `EXTENSION_API_VERSIONS.world`，`repos/cortico/src/extensions/manifest.ts:24 @836238311`）、
  `describe:"describe.json"`。`main`/`exports` 指向 `src/definition.js`。
- 定义与实例：`isWorldDefinition` 四件 `id/label/defaults()/create()`；`create()` 纯，
  `defaults().enabled=false`。实例实现 World 的 `start / stop / envPromptVars / tools()`，
  无 `send/on/storage`，不实现 `outputTap()`。
- 事件投影：`onebot-bridge.message / notice / request / connection`。自发回声与
  `meta_event` 走 `deliver:false` 只归档；`meta_event/heartbeat` 缺省丢弃；每条保留
  `meta.raw`；缺 `raw_message/font` 的消息标 `meta.malformed`。
- 工具四件（名字均 ⊆ describe.tools）：`onebot_call`（act，门序固定：名字闸→身份闸→策略闸，
  写动作需本轮实证发起方 `anon=identified`，缺省需 `confirm=true`；`readOnly` 拦写；
  未知/扩展动作按写处理）、
  `onebot_actions`（read，目录/分类/覆盖）、`onebot_events`（read，查归档）、
  `onebot_status`（read，连接+账号+覆盖面+策略）。
- OneBot v11 覆盖面钉自运行产物：38 公开 action 中凭证三动作（`get_cookies`/`get_csrf_token`/
  `get_credentials`）按 `SECURITY-CBP.md:125` 不进目录、命中名字回 `10002 unsupported_action`；
  目录实发 35（读 16 / 写 19）、17 事件叶子、
  20 线上消息段（`r-nonebot-onebot.md:133,121-126,141 @2450b67a1`）。快照在
  `src/catalog.js`，实现端扩展动作由 `onebot_call` 按写处理、不进快照。
- 传输：正向双工 WebSocket，一条连接同时收事件、按 `echo` 关联 action 回执；
  退避 `1000ms×2` 封顶 `30000ms`；`start()` 永不 reject，连接等待封顶 `connectWaitMs`
  后放行、后台继续重连。`ws` 走延迟 dynamic import，import 本包与跑单测都无需装 `ws`。
- 产物与闸：`describe.json` 由 `npm run describe`（`node tools/selfcheck.mjs --write`）从
  `definition` 派生、幂等；`tools/selfcheck.mjs` 离线复刻 `check:extension` 的可判据
  （api 锚、上一版拒、describe 一致性、dryMount 形状、v11 覆盖面、未知段兜底）。
- 测试：`node --test`（`test/normalize / world / contract`）覆盖纯函数、事件投影、
  写门禁、驱动分类、装载契约与 v11 覆盖面计数。

骨架阶段未做（留待完整实现，需要实现端或宿主）：图片 `blobs` 下载与
`modelFacts.accepts` 投递前检查、WebUI 面板、按 `get_version_info` 识别实现并切目录、
真实 WS 往返与 `delete_msg` 回执语义、实现方言目录同步。行为对齐第三方先例
`cortico-world-onebot @2e91b7fb1`，不 fork、不重写。
