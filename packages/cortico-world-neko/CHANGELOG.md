# 更新日志 · cortico-world-neko

每个版本一节 `## <版本号>`；扩展市场按节显示更新说明。发版前批次记在 `## Unreleased`。

## 0.1.5

*2026-11-19 · 能力面收敛 / 声明撤回*

- 撤回 `0.1.4` 节里**从未发布**的 `unsafe` 声明；`cortico.tags` 不再含 warning tag。
- 同 maibot 复核 11-13 能力面：鉴权三闸 + `egress` 默认关 + 60002 申报闸 + 静态工具表；不重开 CBP v1 帧表设计。
- README 安全声明改写；不写 `safe`，最终状态留待索引仓维护者审查。

## 0.1.4


> 注：本节未发布；其中「自声明 unsafe」一条已由下一版撤回，能力面收敛见下一节。
*2026-11-19 · 安全修复*

- **按 11-13 判例（commit `5b453aa0b`）自声明 `cortico.tags: ["unsafe", ...]`**。
  理由与 maibot 相同：本机 CBP WS 监听口 + 无鉴权时本机任意网页可拨入。
- `world.ts` 真实 driver 改传 `authToken`；`definition.ts` 明确「缺 secret 返回空串
  会让内核 listen()/dial() fail-shut」，不再读作「留空不校验」。
- 依赖内核钉到 `^0.1.3`（含强制密钥 + Origin 校验）。
- `node --test "tests/*.test.ts"` 复跑通过。

## Unreleased（2026-11-17 · 工单二 F1–F6 批次，未发版）

- F1 残键一次性清理（用户决定 2）：升级装载（`definition.create()`）删除
  config.json 里 `worlds.neko.token` 旧残键并同步活配置对象。只删那一个键，其余段
  逐字节不动；先读后删，读不到不写；第二次装载零写；日志只记键名；旧值非空记
  「按已泄露处理」迁移提示。本包不清 `.env`、不写 `secret`。上一节的手工删键迁移步
  随本条作废（值搬进 `.env` 仍要人工做）。
- F2 turn 保留窗同源可调（用户决定 3，缺省 300 秒）：源在 `spec/CBP-v1.json`
  `$defs/turnWindow`，经 `gen_table.py`/`gen_pins.py` 落两份产物；`lastTurn` 补按窗过期，
  超窗回 `60004` 并记 `turn-expired`；提示词新增 `neko.window` 状态位；env 覆盖用
  `CORTICO_TURN_TTL_SECONDS`（两端同名，坏值回落并记 `turn-ttl-env-invalid`）。与
  `dedup.ts` 的 600 秒无关，那条腿没动。
- F3 下发扬闸（`SECURITY-CBP.md` §7 后半边）：链路已立而对端没申报 `neko_send` 时，
  `neko_send_message` 本地判 `60002 capability_unavailable`，不发 call 帧；未连接时不判
  （60006 归内核）。桥侧申报面含 `neko_send` 已按只读取证核实。
- F4 文档口径：README 错误码枚举补 `60002`/`60004`，新增 §9 F 编号图例。
- F6 禁写清单：README 写死条数行与「config.json 不再落这个键」的现在时态断言改掉；
  `describe.json` 经 drymount-gate `--regen` 重新生成；`ENV_PROMPT.md` 的 caps 行改为
  「申报上限不等于交集」。
- 回归：`tests/world.test.ts` 新增工单二 F1–F6 断言；跨仓等值闸见 fleet
  `tests/pins/turn-window-gate.test.mjs` 与 core 的 turn 用例；仓外负例副本回退对应
  修复后断言转红（ROUND3/negctl-fleet-F）。另有一笔仓级工单二 F5（`tools/doctor.py`
  与 `tests/doctor/test_doctor.py` 的名字卫生），不属本包，记在仓内注释。

## Unreleased（2026-11-17 · 工单一 F2/F3 批次，未发版）

- F2 申报面与回帧：`peerToolCatalog` 退为空集；hello/ready 的 `tools[]` 不再带
  `neko_send_message`、`neko_status`、`neko_history`、`neko_peer_call` 四支。入站
  `call` 帧不再静默：立即回 `60002 capability_unavailable`，对端不必空等内核 30s
  超时拿 60007。被调面本体仍属阶段二。口径对齐 `spec/SECURITY-CBP.md` §7 对
  maibot 同类缺陷的交集推导裁决。
- F3 凭据通道：删除 `worlds.neko.token` 的字段、缺省、归一化与面板项；`create()`
  改读 `ctx.secret('CORTICO_BRIDGE_TOKEN')`（`spec/SECURITY-CBP.md` §3 规则 2）。
  非环回绑定缺 token 的硬拒不变。迁移：旧面板填过 token 的部署，把值写进部署
  `.env` 同名键后重启本 World。
- 回归：`tests/world.test.ts` 新增四件断言（catalog 空集；真 socket 握手验
  `ready.tools` 为空且入站 call 秒级回 60002；`create()` 走 secret 通道；
  secret 值注入驱动构造）。仓外负例副本回退本批 src 改动后，四件转红。

## 0.1.3

- `apps` 保留：N.E.K.O 是另一个应用程序，词表里没有更贴的平台 tag（TAGS.md:28）。
- 补 `experimental`：本包只在单一宿主装态验过加载与面板，猫娘侧实端联调未做。
- 发布闸新增第五项：`cortico.tags` 每一项必须在市场词表内（`tests/_lib/release-gate.mjs` 的 `MARKET_TAGS`，抓自 cortico-extensions index.json，2026-11-16）。

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
