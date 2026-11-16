# @horizoncloudy/cortico-world-neko

Cortico 侧的 N.E.K.O world 包。`cortico` 块 `kind:"world"`、`api:6`（当前锚
`EXTENSION_API_VERSIONS.world`，cortico `src/extensions/manifest.ts:23-27 @836238311`，
经 `cortico-bridge-core/src/pins.ts:46` 快照与 `spec/pins.json` 同源）。
帧编解码、WS 双角色驱动、去重、段渲染、错误码、能力协商**全部复用
`@horizoncloudy/cortico-bridge-core`**（本包零复制粘贴转换逻辑；`src/world.ts`/`src/normalize.ts`
的 import 就是复用点，测试 `world.test.ts` 有断言防回归）。

对端 = N.E.K.O 宿主原生插件 `cortico-bridge-neko`（独立仓，py3.11）。
本包 ↔ 桥之间的线协议 = CBP v1（`spec/CBP-v1.json`，十型帧，`_BUILD-PLAN.md` §3.1）。

## 1. 连接形态（双角色）

- 缺省 `role:'listen'`：本包在 `127.0.0.1:39701` 监听（`spec/pins.json` ports 行
  「@horizoncloudy/cortico-world-neko listen」，`_BUILD-PLAN.md` §4.4；R6：装机以 doctor 实扫为准），
  桥插件从 N.E.K.O 插件子进程外拨进来（蓝图 §2.2 L83：neko 插件子进程禁听任何 HTTP）。
- `role:'dial'`：本包拨 `url`（拓扑反过来时用；内核 `driver.ts` dial/listen 同一实现）。
- token：只走 HTTP Upgrade 头 `Authorization: Bearer`（F4，内核 `driver.ts authHeaderOf`）。
  URL query 里出现 `token`/`access_token` 的连接直接 `close 4401` 拒停（不比对，日志只记键名）；
  帧面不上 token。token 为空时非环回绑定被硬拒（`door_closed: loopback required`）。
- 握手：hello/ready caps 交集 + `v_support` 版本门禁（不相交 = 60001 断连，
  内核 `negotiate.ts`）。hello/ready 必带 `self:{id,name,proven}` 声明（F1/F2，见 §2）。
  `start()` 等待上限 12s 放行、永不 reject（硬规则）。
- 去重：入站 `msg` 帧按 `conv|message_id`（无 message_id 用帧 id）TTL 10 分钟、上限 200，
  在内核 `dedup.ts`/`driver.ts:359`，本包不再自设第二套。

## 2. 入站（N.E.K.O → Cortico）

| CBP 帧 | Cortico 事件 | 档位 |
|---|---|---|
| msg mention/direct | `neko.message` | `trigger:'flush'` |
| msg group/other | `neko.message` | 缺省 debounce（types.ts:633） |
| msg sender.id 命中**协商实证** self（proven:true） | `neko.message.self` | `deliver:false` 只归档 |
| notice（含 kind=`consent` 等待态） | `neko.notice` | `trigger:'piggyback'` |
| event connection / degraded | `neko.connection` / `neko.degraded` | flush、origin internal |
| catalog / ready | 更新进程内目录（status/envPrompt 用），不产事件 | — |
| call/reply/ack | tools() handler 的 in-flight 表（内核 correlate.ts，TTL 200） | — |

`meta` 恒带 `{conv, sender, kind, platformMsgId, raw}`（raw 恒留，硬规则 8）。
`conv` = neko `conversation_id`，同时作 senderKey（§3.2 映射表 neko 行）。
入站 image 段只把**内联 base64** 转 blob，投前查 `host.modelFacts.accepts(mime)`
（types.ts:602）；URL 句柄不过桥（U7）。未知段 `[<type>]` 兜底归内核
`segment.ts`（C1-16 唯一实现点），本包只记 `unknown-segment:<type>` 降级位。

### self 声明（F1/F2）

本包在 hello/ready 的 `self` 位申报 `{id: worlds.neko.selfId, name:
'@horizoncloudy/cortico-world-neko', proven: false}`。**N.E.K.O 线永久 `proven:false`**
（SECURITY-CBP §2.2、§6-9：bus 面只有读与 watch、无 publish，没有可实证的 bot 主键，
`role=="assistant"` 是启发式）。由此三条，全部有测试钉：

- 回声抑制只在 proven:true 上生效；proven:false 时同 id 入站**照常投递**，
  并显式记 `self-unknown` 降级 + `neko.self` 常驻 `self-echo:off`（§2.4，禁两种静默）。
- `self_echo` 不进本包 caps 申报（现报 `images/notices/tools`）：cap 只能与
  proven:true 同现，报了会被内核当 caps-lie 丢掉（§2.3）。
- 配置 `selfId` 只作 self 声明的 id 与协商 self 缺席时的兜底判定，不据它宣称实证。

## 3. 出站（Cortico → N.E.K.O）——身份、能力缺口，如实写

出站 `call` 必带 `turn`+`actor`（F3，`SECURITY-CBP §1`）。本包填法：`turn` = 触发
本轮的入站 msg 帧 id；`actor = {platform:'neko', conv, member, anon}` 从那条入站
记录的**实证侧**取（sender/conv 是桥从 N.E.K.O bus metadata 送进来的宿主值）。
args 里出现的任何身份键（`turn`/`actor`/`member`）不进帧；本轮没有桥消息 ⇒ 本地先拒
`60004 unknown_session`，一个 call 都不发（负例测试：自报 actor 被拒）。断线即清
本地轮次——桥侧 `TurnLedger` 随连接走，旧 turn 不跨连接复用。

N.E.K.O 宿主对插件只开**两道入站门**（蓝图 §2.2 L83，r-neko §5/§6 @52e973ed2）：

1. `ctx.push_message(*, visibility, ai_behavior, parts, ...)` v2 —— 桥的
   `ingress.py` 用它落地；两轴逐字 `("chat","hud")` × `("respond","read","blind")`
   （push_message_schema.py:63-64），v1 十关键词按已删处理（`:61` DEPRECATION_REMOVAL_VERSION
   = "v0.9" vs 宿主 0.9.1）。
2. `ctx.reply_tail.register(...)` 窄门 —— **不进第一切片**（蓝图 L92 保留名；
   C1-7：传输实为 HTTP `POST /api/tools/reply-tail/{op}` @48911，宿主 12 项 MAX_* 限额，
   等 reply_tail 真回调补证后再开）。

由此推导的硬缺口（写进提示词与工具描述，不是实现偷懒）：

- **外部 URL 图直接拒**：模型路只认宿主 `ctx.images.upload()` 句柄
  （push-message.md「Arbitrary external URLs are rejected」）；本包出站计划丢
  `image` 段的 `url` 形、记 `external-url-image`，JPEG 归一一位在宿主 upload
  （≤2048），Cortico 侧不重编码。
- **audio/video 无上传 API**（push-message.md「audio / video have no upload API yet」）：
  `record/audio/video/file` 段出站必拒，记 `no-upload-api`。
- **帧上限本地先拒**：上限 = `spec/pins.json` 顶层 `caps.neko.frame_bytes` 单源读数
  （宿主 settings.py:588 减 core/context.py:248 信封余量的折算值；本包代码零字节字面量，
  `normalize.test.ts` 有文本闸钉住），超限回 `60003 payload_too_large`，不动桥
  （双保险，桥侧还会再拒）。v1 不分片：超长的长文就是不送达（SECURITY-CBP §4.5/§6-10）。
- **按钮**：neko parts 没有按钮型（html_card/ui_action 是前端面），CBP `button`
  段过桥即降级 `[Button unavailable] <label>`（内核 segment.ts:163-165，aiocqhttp
  官方文案），报 `unknown-segment`/`degraded`。
- **无断线补课**：`history_backfill` 不申报（U 台账：v1 无断线补课是设计内行为）；
  断连期消息丢失属预期，`neko_history` 只读 Cortico 事件库。
- **convmap 宿主不可见**：桥的会话自建表在其 `self.store`，本包 `neko_history`
  不查对端（先例硬规则 §5-7）。
- **不实现 outputTap()**：`_BUILD-PLAN` §3.3 明令桥包一律不实现（C1-10）。

## 4. 工具四件（名字 ⊆ describe.tools，describe-export.ts:134-136）

| 工具 | tags | 语义 |
|---|---|---|
| `neko_send_message` | write, barrierAfter | egress 关→`60005 door_closed` 不动桥；本轮没有桥消息→`60004 unknown_session` 不动桥（F3 身份闸）；限流缺省 20/分；call 工具名 `neko_send`（§3.2 `call('<w>_send', args)`）；30s 无回执→`60007 send_uncertain` |
| `neko_status` | read | 连接态/角色/listenPort/caps 交集/consent/catalog/降级清单 |
| `neko_history` | read | 只查 `host.store.range`，不查对端 |
| `neko_peer_call` | write | 只接受 catalog 已报名；无本轮桥消息身份直接拒（turn 绑定照 §3.2，先例 4725feee6 world.ts:167-174） |

错误码文案 = 内核 `errors.ts` RET 表：60001 version_mismatch、60003 payload_too_large、
60005 door_closed、60006 peer_unreachable、60007 send_uncertain、60008 degraded。

## 5. 配置（`worlds.neko` 段）

`enabled`(false)、`role`('listen'|'dial')、`host`('127.0.0.1')、`port`(39701)、
`url`('ws://127.0.0.1:39701')、`token`、`selfId`、`egress`(false)、`ratePerMin`(20)、
`visibility`('chat')、`aiBehavior`('respond')、`reconnectBaseMs`(1000)、`reconnectMaxMs`(30000)。
x-hot 标注见 `src/config.ts` CONFIG_GROUP；role/host/port/url/token 改完需重启本 World。

## 6. consent 等待态

首启 consent 闸当正常态上报（蓝图 L83）。桥在 consent 状态变化时发 CBP
`notice kind:'consent'`（raw = decision/status，形状参照 `consent_policy.py:12-44`
@52e973ed2；蓝图引的 `:19` 属另一 sha 3985eea0b，本地按钉住 sha 读），
本包记入 `neko.consent` 提示词位与 `neko_status`；放行前出站失败由桥侧上报。

## 7. 验收与跑法

```bash
npm install --registry=https://registry.npmmirror.com --ignore-scripts
./node_modules/.bin/tsc --noEmit
node --test tests/                       # 33 pass / 0 fail
./node_modules/.bin/tsx tests/drymount-gate.mts          # 框架 dryMountWorld+checkDescribe，exit 0
./node_modules/.bin/tsx tests/drymount-gate.mts --regen  # describe.json 由框架 exportDescribe 生成
```

残留 WARN：`webUi() declares panels (1) but the manifest has no cortico.webUiClient`
——面板浏览器 bundle 属后续件，先例 astrbot/onebot 同 warn 级，不影响装载判定。

## 8. 本包没做的（诚实账）

- caps 词表（images/notices/tools）是本件起草的申报面（INFERENCE，
  `src/world.ts` NEKO_CAPS 注释）；桥端工单 `cortico-bridge-neko` 引用即升 FACT。
  self_echo 已从申报面摘掉（§2.3 caps-lie：neko 线 proven:false 永久，报了会被内核丢）。
- self 声明上线了（hello/ready 的 self 位），但 `proven` 永久 false：没有可实证的
  bot 主键（§6-9）。`selfId` 只作申报 id 与协商缺席时的兜底判定；ready 扩面补实证 id
  归桥端工单。
- 入站 `call`（桥调 Cortico 侧工具）第一切片不开：只记日志不产事件。
- `reply_tail` 门、按钮通道、断线补课、市场发布线：全在阶段二以后（蓝图 §7）。
- 真机未验（任务禁启动宿主/框架）：CBP 环回、60001 断连、consent 真实行为
  属蓝图 §5.3 人工冒烟卡。

版本钉：N.E.K.O 宿主 `0.9.1 @52e973ed2`；桥清单 `[plugin.sdk] supported =
">=0.1.0,<0.2.0"`（SDK_VERSION 空间 `constants.py:9`，非 APP_VERSION——蓝图
§1.3-2 亲验的加载期硬闸；写错这个空间插件永远加载不上且 CI 看不见）。
