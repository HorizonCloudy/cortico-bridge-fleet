# 更新日志 · cortico-world-astrbot-bridge

每个版本一节 `## <版本号>`；扩展市场按节显示更新说明。

## 0.1.5

*2026-11-19 · 能力面收敛 / 声明撤回*

- 同步口径：本包仍**不声明** `unsafe`（dial 侧、不开监听口），上一版 README 的「待仓主裁决」改为「对端声明从未发布即撤回，链路能力面已收敛」。
- `TAGS.md:40` 规定 warning tag 不可撤回，故本包从未擅自声明；不写 `safe`（`TAGS.md:31/:42`）。
- README 安全声明改写为双端鉴权替换 + 能力面收敛证据；无新增代码改动。

## 0.1.4


> 注：本节未发布；其中「自声明 unsafe」一条已由下一版撤回，能力面收敛见下一节。
*2026-11-19 · 安全修复*

- **鉴权子协议替换（SECURITY-CBP.md:115-121、:132）**：删 `AstrbotBridgeConfig.token`、
  `DEFAULTS.token`、`normalizeConfig` token 读取、面板 `worlds.astrbot.token` 项；
  `definition.create` 改从 `ctx.secret('CORTICO_BRIDGE_TOKEN')` 注入 `authToken`。
- `driver.ts` 改用 Upgrade 头 `Authorization: Bearer` 建链、hello 帧体删除 token 位；
  缺密钥或 URL 带凭据 query 一律拒拨（fail-shut）；新增 `isCleanWsUrl()` 活闸。
- 新增 `tests/driver-auth.test.ts` 六条硬闸；`node --test "tests/*.test.ts"` 46/46 通过，
  `tsc --noEmit` 退 0。
- **未声明 `unsafe`**：本包是 dial 侧，自己不开监听口；监听面在 `cortico-bridge-astrbot`
  （Python 桥，非 Cortico 扩展）。是否需要对整条链路追加 warning tag 属开放裁决项，
  因 `TAGS.md:40` 规定 warning tag 不可撤回，故不擅自扩大声明面。

## 0.1.3

- `apps` 换成 `qq` + `im`：同 maibot 的理由（TAGS.md:28、:60）。
- 补 `experimental`：本包是骨架，存量包 @4725feee6 的功能面未完整替代。
- 发布闸新增第五项：`cortico.tags` 每一项必须在市场词表内（`tests/_lib/release-gate.mjs` 的 `MARKET_TAGS`，抓自 cortico-extensions index.json，2026-11-16）。

## 0.1.2

- 面板「桥状态」补客户端产物：`src/webui/client.js`，`cortico.webUiClient` 声明它。
- 描述改简体中文，并补 `cortico.locales.zh` / `.en` 两份。

## 0.1.0

首个版本：收编版骨架。基准 `cortico-world-astrbot @4725feee6`（v1.3.4 存量），
本包在其上只做「CBP 帧协商位 + 骨架」增量；帧与驱动自带
（`src/frames.ts`/`src/driver.ts`，不走 cortico-bridge-core，依赖只有 `ws`）。

- 装载契约：`cortico` 块 `kind:"world"`、`api:6`、`describe:"describe.json"`；
  `main` 指 `src/definition.ts`；`id` 沿用 `'astrbot'`（config.ts:14，配置段与事件
  命名空间跨版本连续；装本包须先卸旧包，同 id 并存被拒载）。
- 连接：缺省 `url:'ws://127.0.0.1:17999'` dial  AstrBot 侧桥插件的 WS 服务
  （config.ts:37）；hello/ready 申报 caps `msg-v2/notice/peer-tools/catalog`
  （world.ts:155）；v_support 不相交 = 60001。
- 事件投影：`astrbot.message / astrbot.message.self / astrbot.notice /
  astrbot.connection / astrbot.degraded`（describe.json events，与 world.ts
  `pushStatusEvent`（world.ts:412）的入站类型一致）。
- 工具四件（名字均 ⊆ describe.tools）：`astrbot_send_message`（write，门序
  egress→限流→身份，60005/60004/60007 文案出自内核 errors 家族）、
  `astrbot_status`（read）、`astrbot_history`（read，只查宿主事件库、不打对端）、
  `astrbot_peer_call`（write，catalog 闸 + 本轮桥消息身份闸）
  （world.ts:61,79,86,98；静态声明 TOOL_DECLS 与 describe.json 同源单份）。
- 测试：`node --test tests/`（call-actor/driver/frames/normalize/world 五条契约线）；
  框架闸 `tsx tests/drymount-gate.mts`（dryMountWorld + checkDescribe）。

骨架阶段未做（阶段二+）：AstrBot 存量 2146 行功能的完整移植（语音、图谱、插件面板）。
