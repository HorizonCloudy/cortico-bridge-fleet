# 更新日志 · cortico-world-maibot

每个版本一节 `## <版本号>`；扩展市场按节显示更新说明。

## 0.1.3

- `apps` 换成 `qq` + `im`：TAGS.md:28 规定别的 tag 成立时不用 `apps`；TAGS.md:60 又要求标了 `qq` 就同时标 `im`。
- 补 `experimental`：发信腿刚接线，真机派发路径未起宿主实测，只在单一宿主装态验过加载。
- 发信腿接线（工单 K1）：`maibot_send_message` 与 `maibot_streams` 两支固定工具回到 `TOOL_DECLS`、
  `describe.json`、`ENV_PROMPT.md`；`PEER_CAPABILITIES` 镜像改成桥 `hello.tools` 真申报的两支
  （`maibot_send`、`chat.get_all_streams`）。对面 = `cortico-bridge-maibot/sender.py`。
- 新增出站限流 `rateAllowed()`：60 秒滑动窗，参数校验排在限流之前，坏请求不吃额度。
- 发布闸新增第五项：`cortico.tags` 每一项必须在市场词表内（`tests/_lib/release-gate.mjs` 的 `MARKET_TAGS`，抓自 cortico-extensions index.json，2026-11-16）。

## 0.1.2

- 面板「桥状态」补客户端产物：`src/webui/client.js`，`cortico.webUiClient` 声明它。
- 描述改简体中文，并补 `cortico.locales.zh` / `.en` 两份。
- 服务端补 `webUi().panels` 与 `invoke('status','get')`，面板数据面与状态工具同源。

## 0.1.1

- 内核依赖从 `^0.1.0` 收紧到 `^0.1.1`。

## 0.1.0

首个版本：Cortico 侧 MaiBot world 包。CBP v1 帧 over WS **监听端**；帧编解码、
驱动、档位、段渲染、错误码、协商全部 import `cortico-bridge-core`
（`file:` 依赖，零复制粘贴）。

- 装载契约：`cortico` 块 `kind:"world"`、`api:6`、`describe:"describe.json"`；
  `main` 指 `src/definition.ts`；`id = 'maibot'`（config.ts:15）。
- 连接：缺省监听 `ws://127.0.0.1:39702`（config.ts:31；端口单源
  `spec/pins.json` ↔ 内核 pins.ts:111），桥仓 cortico-bridge-maibot 外拨进来；
  token 只走 `Authorization: Bearer` 头；`start()` 12s 上限放行、永不 reject。
- self 申报：`WORLD_SELF = { id:'', name:'Cortico', proven:false }`（world.ts:60）
  ——Cortico 无 IM 实证位，按 SECURITY-CBP 诚实报 proven:false；
  `self_echo` 不申报（caps-lie 守卫）。
- caps 面：`images / notices / tools`（world.ts:53）；能力名只对接
  MaiBot capabilities 层（`send.text`、`chat.get_all_streams`），不依赖
  compat/apis 的 48 个 silent 桩（README §1 表，r-maibot §6）。
- 工具五件（名字均 ⊆ describe.tools，且与 hello tools[] 目录同源单份
  `peerToolCatalog`，world.ts:553-561）：`maibot_send_message`（write，
  world.ts:87）、`maibot_status`（read，:106）、`maibot_history`（read，:113）、
  `maibot_peer_call`（write，:125）、`maibot_streams`（read，:141，转
  `chat.get_all_streams`，能力名逐字 maibot-plugin-sdk chat.py:57-59 @f9984673d）。
- 事件投影：`maibot.message / maibot.message.self / maibot.notice /
  maibot.connection / maibot.degraded`（describe.json events，与 world.ts:519
  `pushStatusEvent` 类型一致）；mention/direct→flush、其余 debounce、
  实证回声 `deliver:false` 只归档、`meta.raw` 恒留。
- 出站门：`egress:false` 缺省关（config.ts:4，关→60005 door_closed）；
  限流缺省 20/分（world.ts:540-544 滑窗）。
- 测试：`node --test tests/`（definition/normalize/world 三线，假驱动注入，
  不碰 WebSocket）；框架闸 `tsx tests/drymount-gate.mts`（checkDescribe 口径）。

骨架阶段未做（阶段二+）：图片 blobs 投递前检查、市场发布线、断线补课。
对面桥仓 hello 的 tools[] 申报与上表五件是否一致，由 M2 工单跟进
（reports/M2-maibot-hello-self.md）。
