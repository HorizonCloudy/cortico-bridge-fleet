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
- 凭据（工单一 F3 + 工单二 F1）：token 值从部署 `.env` 的 `CORTICO_BRIDGE_TOKEN` 读
  （`ctx.secret`，`SECURITY-CBP.md` §3 规则 2）。`worlds.neko.token` 配置串与面板项已删除，
  本包不再**写**这个键。已经落盘的旧值由升级装载时的一次性清理删除（工单二 F1：只删
  `worlds.neko.token` 这一个键，其余段逐字节不动；先读后删，读不到不写；第二次装载零写；
  日志只记键名；旧值非空按凭据已泄露处理并记迁移提示——本包不清 `.env`、不写 `secret`）。
  把新值放进 `.env` 仍要人工做，然后重启本 World。桥侧读同名环境变量
  （`cortico-bridge-neko/pins.py`）。token 上线路径不变：只走
  HTTP Upgrade 头 `Authorization: Bearer`（F4，内核 `driver.ts authHeaderOf`）。
  URL query 里出现 `token`/`access_token` 的连接直接 `close 4401` 拒停（不比对，
  日志只记键名）；帧面不上 token。token 为空时非环回绑定被硬拒
  （`door_closed: loopback required`）。
- 握手：hello/ready caps 交集 + `v_support` 版本门禁（不相交 = 60001 断连，
  内核 `negotiate.ts`）。hello/ready 必带 `self:{id,name,proven}` 声明（F1/F2，见 §2）。
  `start()` 等待上限 12s 放行、永不 reject（硬规则）。
- 去重：入站 `msg` 帧按 `conv|message_id`（无 message_id 用帧 id）TTL 10 分钟、上限 200，
  在内核 `dedup.ts`/`driver.ts:359`，本包不再自设第二套。
- turn 保留窗（工单二 F2）：入站记录的保留窗两端同源。单一源在 `spec/CBP-v1.json`
  `$defs/turnWindow`（正整数 const，缺省 300 秒）；`tools/gen_table.py` 落两桥 `cbp_table.py`、
  `tools/gen_pins.py` 落 `spec/pins.json`，内核 `PINS.turn.ttlSeconds` 与本包读同一生成值。
  部署覆盖用环境变量 `CORTICO_TURN_TTL_SECONDS`（两端同名）；坏值回落台账值并记
  degraded（`turn-ttl-env-invalid`），不静默。本包 `lastTurn` 除断线清外，超过这个窗也清，
  超窗出站回 `60004`。它与去重 TTL（10 分钟）和内核 rid 缓存（300 秒/200 条，§5.1）
  分属三件事。
- 申报面（工单一 F2）：本包 hello/ready 的 `tools[]` 是空集。被调面第一切片不开；申报而
  不服务会让对端每次误调空等 30 秒拿 60007。入站 `call` 帧立即回 60002
  `capability_unavailable`。阶段二开被调面时经 `peerToolCatalog` 恢复申报。
- 下发扬闸（工单二 F3，`SECURITY-CBP.md` §7 规则 3 的后半边）：链路已立而对端没申报
  `neko_send` 时，`neko_send_message` 本地回 60002 且一帧 call 都不发；未连接时不判
  （申报面本就空，网络故障归内核 60006）。桥侧申报面含 `neko_send` 已核实
  （`cortico-bridge-neko/__init__.py` `_BRIDGE_TOOLS`），这道闸不挡正常路径。

## 2. 入站（N.E.K.O → Cortico）

| CBP 帧 | Cortico 事件 | 档位 |
|---|---|---|
| msg mention/direct | `neko.message` | `trigger:'flush'` |
| msg group/other | `neko.message` | 缺省 debounce（types.ts:633） |
| msg sender.id 命中**协商实证** self（proven:true） | `neko.message.self` | `deliver:false` 只归档 |
| notice（含 kind=`consent` 等待态） | `neko.notice` | `trigger:'piggyback'` |
| event connection / degraded | `neko.connection` / `neko.degraded` | flush、origin internal |
| catalog / ready | 更新进程内目录（status/envPrompt 用），不产事件 | — |
| reply/ack | tools() handler 的 in-flight 表（内核 correlate.ts，TTL 200） | — |
| call（被调面未开，F2） | 立即回 60002 capability_unavailable，不产事件 | — |

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
本地轮次——桥侧 `TurnLedger` 随连接走，旧 turn 不跨连接复用。轮次还随时钟过期：
超过 §1 的同源保留窗（缺省 300 秒）同样回 `60004`，并记 `turn-expired` 降级位。

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
| `neko_send_message` | write, barrierAfter | egress 关→`60005 door_closed` 不动桥；本轮没有桥消息或超出 turn 保留窗→`60004 unknown_session` 不动桥（工单一 F3 身份闸 + 工单二 F2 过期）；对端没申报 `neko_send`→`60002 capability_unavailable` 不发帧（工单二 F3）；限流缺省 20/分；call 工具名 `neko_send`（§3.2 `call('<w>_send', args)`）；30s 无回执→`60007 send_uncertain` |
| `neko_status` | read | 连接态/角色/listenPort/caps 交集/consent/catalog/降级清单 |
| `neko_history` | read | 只查 `host.store.range`，不查对端 |
| `neko_peer_call` | write | 只接受 catalog 已报名；无本轮桥消息身份直接拒（turn 绑定照 §3.2，先例 4725feee6 world.ts:167-174） |

错误码文案 = 内核 `errors.ts` RET 表（工单二 F4 补齐枚举）：60001 version_mismatch、
60002 capability_unavailable、60003 payload_too_large、60004 unknown_session、60005 door_closed、
60006 peer_unreachable、60007 send_uncertain、60008 degraded。

## 5. 配置（`worlds.neko` 段）

`enabled`(false)、`role`('listen'|'dial')、`host`('127.0.0.1')、`port`(39701)、
`url`('ws://127.0.0.1:39701')、`selfId`、`egress`(false)、`ratePerMin`(20)、
`visibility`('chat')、`aiBehavior`('respond')、`reconnectBaseMs`(1000)、`reconnectMaxMs`(30000)。
token 不在此段（工单一 F3）：共享密钥走部署 `.env` 的 `CORTICO_BRIDGE_TOKEN`（`ctx.secret`）。
turn 窗口也不在此段：单一源在 `spec/CBP-v1.json`，覆盖走 `CORTICO_TURN_TTL_SECONDS`
（工单二 F2，见 §1）。
x-hot 标注见 `src/config.ts` CONFIG_GROUP；role/host/port/url 改完需重启本 World。

## 6. consent 等待态

首启 consent 闸当正常态上报（蓝图 L83）。桥在 consent 状态变化时发 CBP
`notice kind:'consent'`（raw = decision/status，形状参照 `consent_policy.py:12-44`
@52e973ed2；蓝图引的 `:19` 属另一 sha 3985eea0b，本地按钉住 sha 读），
本包记入 `neko.consent` 提示词位与 `neko_status`；放行前出站失败由桥侧上报。

## 7. 验收与跑法

```bash
npm install --registry=https://registry.npmmirror.com --ignore-scripts
./node_modules/.bin/tsc --noEmit
node --test tests/                       # 全绿；条数以现输出为准，文档不写死（X3 §2.5）
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
- 入站 `call`（桥调 Cortico 侧工具）第一切片不开：回 60002 且不申报（F2，
  hello/ready `tools[]` 空集）；被调面本体属阶段二。
- `reply_tail` 门、按钮通道、断线补课、市场发布线：全在阶段二以后（蓝图 §7）。
- 真机未验（任务禁启动宿主/框架）：CBP 环回、60001 断连、consent 真实行为
  属蓝图 §5.3 人工冒烟卡。
- 工单二 F3 的核实口径：对端申报面含 `neko_send` 取自桥仓源码现值（只读），生产装机上
  的桥版本是否同样含这一行未逐台核验；闸的失败方向保守（判 60002 不发帧），不会双发。

## 9. F 编号图例（裸 `F2` 有歧义，这里钉死）

文档里的 F 号来自三套台账，含义互不相通。新写引用一律带工单名（如「工单二 F2」），
别只写裸 `F2`（X3 台账 §3 的口径）。历史行没带前缀的按此表归位：

| 前缀 | 出处 | 与本文档相关的意思 |
|---|---|---|
| 工单一 F1–F4 | `FIXORDER.md`（2026-11-17） | F2=被调面申报退空+秒回 60002；F3=token 改走 ctx.secret（neko 仓 F1/F4 不在本文档） |
| 工单二 F1–F6 | `FIXORDER2.md`（2026-11-17） | F1=残键一次性清理；F2=turn 窗口同源可调（缺省 300）；F3=下发扬闸；F4=文档口径；F5=名字卫生（tools/tests）；F6=禁写口径 |
| F 帧表审计号 | `CHANGELOG-CBP.md` §1 | F13=caps 单源、F17=十型冻结、F18=开放映射等协议台账编号，与前两个 F 系列无关 |
| N / ADV / U / X 系列 | 取证目录 `cbp-neko-e2e-20261116` | 审查与工序编号，只作出处引用 |

版本钉：N.E.K.O 宿主 `0.9.1 @52e973ed2`；桥清单 `[plugin.sdk] supported =
">=0.1.0,<0.2.0"`（SDK_VERSION 空间 `constants.py:9`，非 APP_VERSION——蓝图
§1.3-2 亲验的加载期硬闸；写错这个空间插件永远加载不上且 CI 看不见）。

---

## 安全声明（2026-11-19 · 能力面已收敛）

本包 **不声明任何 warning tag**，`cortico.tags` 里没有 `unsafe`。

### 为什么可以撤回，以及为什么不能写 `safe`

`TAGS.md:40` 的「warning tag 一旦任一版本声明即保留」约束的是**已发布版本**。
上一轮给本包加的 `unsafe` 从未 git commit、从未 npm publish，没有任何版本带过红标，
撤回合法。`TAGS.md:42` 同时写明平台**没有 `safe` 标签**，标签缺席只代表
「未声明且未审查」；`TAGS.md:31` 规定词表外 tag 会被 `check:extension` 拒。
因此本包既不写 `"safe"`，也不自称已获 safe 认证——那是索引仓维护者审查后的状态。
本声明只交付**能力面收敛的可验证证据**。

### 11-13 判例的能力面怎么被收敛

判例理由是「本地转发服务不校验来源，本机任意网页都能以控制台身份与 Coo 对话、
改写宪法文件」。浏览器 WebSocket 不受同源策略 / CORS 预检保护，**环回监听本身
不构成鉴权**。本链路两端都改了：

| 门禁 | Cortico 侧（本包 + kernel） | 框架侧插件 |
|---|---|---|
| 强制密钥 | `authToken` 类型层必填；`ctx.secret('CORTICO_BRIDGE_TOKEN')` | 同名环境变量；`auth_headers()` 缺值抛错 |
| fail-shut | listen 无 token 拒绑定、dial 无 token 拒建链 | 建链前取不到密钥直接退出，不静默重连 |
| 凭据通道 | Upgrade 头 `Authorization: Bearer`；query 凭据见即拒 | 同；URI 判脏即拒 |
| 来源校验 | 非环回 web `Origin` close 4401 | 同 |
| 能力面 | `egress` 默认关；未申报能力本地判 60002 不下发；工具集是静态表 | 同；工具目录静态，未报名判 60002 |

能力面只剩消息收发与静态工具目录，模型无法借这条链路读写本机任意文件，
不落入 `TAGS.md:92` 的 `unsafe` 判据。CBP v1 帧表设计未重开、未新增协议字段。

### 验证证据

- core `node --test "dist/tests/*.test.js"` 全绿；本包 `node --test "tests/*.test.ts"` 全绿。
- Python 桥三仓 `pytest tests/ -q` 全量通过；平台 `check:extension` 通过。

### 边界

- **破坏性迁移**：`CORTICO_BRIDGE_TOKEN` 必填，两端值必须逐字相同；未配时桥静默断连
  是 fail-shut 设计行为，不是故障。

- 这是作者侧的能力面收敛证据，**不等于**维护者已审查通过。
- 最终 `safe` 状态由索引仓维护者审查裁定（`TAGS.md:42`）。
