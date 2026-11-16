# 更新日志 · cortico-world-neko

每个版本一节 `## <版本号>`；扩展市场按节显示更新说明。

## 0.1.2

- 面板「桥状态」补客户端产物：`src/webui/client.js`，`cortico.webUiClient` 声明它。
- 描述改简体中文，并补 `cortico.locales.zh` / `.en` 两份。

## 0.1.1

- 内核依赖从 `^0.1.0` 收紧到 `^0.1.1`，让坏掉的 0.1.0 不可能再被选中。

## 0.1.0

首个版本：Cortico 侧 N.E.K.O world 包。CBP v1 面复用 `cortico-bridge-core`
（帧编解码、双角色 WS 驱动、去重、段渲染、错误码、协商一律 import，零复制粘贴）。

- 装载契约：`package.json` 的 `cortico` 块 `kind:"world"`、`api:6`
  （manifest.ts:23-27 @836238311，经内核 pins.ts:46 快照同源 `spec/pins.json`）、
  `describe:"describe.json"`（框架 `exportDescribe` 生成件，tests/drymount-gate.mts
  `--regen`，非手抄）。`main` 指 `src/definition.ts`。
- 定义与实例：`isWorldDefinition` 四件 `id/label/defaults()/create()`（extensions.ts:143-150）；
  `create()` 纯、`defaults().enabled=false`；实例实现 `start/stop/envPromptVars/tools()/webUi()`，
  不实现 `outputTap()`（_BUILD-PLAN §3.3）。
- 双角色：缺省 listen `127.0.0.1:39701`（§4.4 端口表；dial 角色同驱动实现）；
  共享密钥只走 `Authorization: Bearer` 头（F4；URL query 携带即 4401 拒停，空 token
  非环回绑定硬拒）；`start()` 12s 上限放行、永不 reject；hello/ready `v_support`
  不相交 = 60001 断连。
- 帧表对接（F1/F2/F3/F13，`spec/SECURITY-CBP.md` §1/§2/§4）：hello/ready 带
  `self:{id,name,proven:false}`——N.E.K.O 线永久无实证 self（§6-9），回声抑制只在
  proven:true 生效，proven:false 照常投递 + `self-unknown` 显式降级 + `self-echo:off`
  常驻；`self_echo` 不申报（caps-lie 守卫），caps 面 `images/notices/tools`。出站
  call 必带 `turn`+`actor`：只从本轮入站 msg 的实证记录填（args 自报身份不进帧，
  冷轮次本地先拒 `60004 unknown_session`，断线清轮次）。字节上限单一来源
  `spec/pins.json` `caps.neko.frame_bytes`（代码零字面量，测试文本闸钉住）。
- 事件投影：`neko.message / neko.message.self / neko.notice / neko.connection /
  neko.degraded`，名字全显式常量（不从 worldId 派生，d-bridge-priorart §8.7）；
  mention/direct→flush、group/other→缺省 debounce、实证回声→`deliver:false` 只归档、
  notice→piggyback；`meta.raw` 恒留（剥除后进内核 envelope）。
- 工具四件：`neko_send_message`（write；egress 缺省关→60005；无本轮桥消息→60004；
  限流 20/分；超 caps.neko 本地先拒→60003；30s 无回执→60007）、`neko_status`（read）、
  `neko_history`（read，只查 host.store，桥侧 convmap 宿主不可见）、
  `neko_peer_call`（write，catalog 闸 + 本轮桥消息身份闸）。
- N.E.K.O 面（README §3 缺口账）：宿主只有 push_message v2 与 reply_tail 两道入站门，
  reply_tail 不进第一切片；外部 URL 图拒、audio/video/file 段拒、按钮段内核兜底降级；
  consent 等待态按 notice 面上报（正常态非故障）。
- 测试：`node --test`（normalize 11 条 + world 22 条，含 F3 自报 actor 被拒两条负例、
  F13 caps 单源边界与字面量文本闸）纯函数与契约面，假驱动注入，
  不碰 WebSocket、不启动宿主；框架闸 `tsx tests/drymount-gate.mts`
  dryMountWorld+checkDescribe exit 0（残留 warn：webUiClient 浏览器 bundle 属后续件）。

骨架阶段未做（阶段二+）：`reply_tail` 窄门、断线补课、市场发布线、入站 call 被调面。
self 声明已上线（hello/ready self 位）；实证 self 在本线做不到（SECURITY-CBP §6-9，
永久 proven:false），不是待办。
