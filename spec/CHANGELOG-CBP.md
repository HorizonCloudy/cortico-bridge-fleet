# CHANGELOG-CBP · CBP-v1 帧表变更台账

本文件记 CBP（Cortico Bridge Protocol）v1 帧表的每一笔协议改动：改哪个帧、加哪个字段、
必填性与默认值、对应错误码、对端是旧版时的迁移代价，以及 conformance.json 要新增或
改正的向量。帧表单一来源是 `spec/CBP-v1.json`；字节期望单一来源是 `spec/conformance.json`；
安全口径的裁决来源是 `spec/SECURITY-CBP.md`（本台账第 1 节的 F1–F4、F9、F11–F15 行直接
照它的决定登记，其余行是本台账从帧表与代码逐行核对补上的旧债）。

## 0. 基线与证据边界

- 基线取证时（2026-11-16 00:34–00:54）本仓还不是 git checkout，`git rev-parse HEAD` 返回
  `fatal: not a git repository`，所以基线用 sha256 钉内容。2026-11-17 起本仓已是 git 仓
  （并行会话提交，HEAD 可引）；本节的哈希基线仍按内容比对读，不追改历史读数。
  `SECURITY-CBP.md:9` 的口径（fleet 内引用一律 `路径:行`）与本节一致。
- 基线哈希（2026-11-16 00:34–00:54 本机 `sha256sum`）：
  - `spec/CBP-v1.json` = `6e2638edfb579aaa13a30f0ef163206c9e51695d6c81440f95ae1df7260d89ea`
  - `spec/conformance.json` = `8d3ba0d63e0fc96f6a2fb9f18fe3adfbc78a7ecc3642451d9a885411ad51b95f`
  - `spec/SECURITY-CBP.md` = `b161f2dec3b6d6a05a4caf1ea9f067f43127e7d10fe0c8d47ea635db257080a1`
    （275 行、47670 字节，00:54 后内容稳定；写作期间它从 61 行长到 275 行，本台账按最终稿引行号）
  - `packages/cortico-bridge-core/src/frames.ts` = `a01ccbea74f5406cdfee18e9c7be2f8823d811ecc9664067ef5699ce7eda3ac2`
  - `packages/cortico-bridge-core/src/envelope.ts` = `f6497bf6afef855b8138801b22b79e40c4e9ed8c2cd0846d072f41742d73959e`
  - `packages/cortico-bridge-core/src/negotiate.ts` = `7c4a61546983ea84f095a3bfa2c9bdb70abcffe1ccb635da5f70ceffe8abd6a3`
  - `packages/cortico-world-astrbot-bridge/src/frames.ts` = `551cbb302dde8a234f1d6f305e20ade8b4b3c12b72a2ef16e8803f3a1f2cade9`
  - `packages/cortico-world-astrbot-bridge/src/driver.ts` = `6a80c7c4e083d9c70955272454646c5ddad2d80c1300eaac7c8ade404a2e22df`
- 上游锚点 sha9 逐字照抄 `spec/conformance.json:18-32`（neko `52e973ed2`、maibot `478f671e6`、
  onebot-11 `d4456ee70`、onebot(v12) `d533f0fca`、cortico `836238311`、astrbot `133dd9f86`、
  world-astrbot `4725feee6`、onebot prior art `2e91b7fb1` 等）。安装版本口径见
  `SECURITY-CBP.md:11`：`ws@8.23.0`（`packages/cortico-bridge-core/package.json:29` 钉
  `^8.18.0`，已核）。桥侧仓在 `C:/Users/54301/cortico-bridge-neko` 与
  `C:/Users/54301/cortico-bridge-maibot`，本台账抽查过其中三处引用行：
  `cortico-bridge-neko/cbp.py:25` 的 call 元组是 `("rid", "tool", "args")`（无 turn/actor），
  `cortico-bridge-neko/ingress.py:22-23` 写死 `PAYLOAD_MAX_BYTES = 524288` 与余量 `227`，
  `cortico-bridge-neko/pins.py:37-39` 要求 `pins["ports"]` 是对象。
- 校验器的真实位置：本仓没有 ajv，也没有任何在仓内跑向量的校验器。仓内对 spec 的闸只有
  文本包含断言（`tests/frames/frames-segments.test.mjs:89-126`，全部 `text.includes(...)`）。
  schema＋向量一致性目前只在仓外一次性取证环境成立：
  `C:/Users/54301/tmp/botfw-envs/spec-cbp/check.mjs`（`import Ajv2020 from 'ajv/dist/2020.js'`、
  `new Ajv2020({ strict: true, ... })`，check.mjs:2,13），ajv 实装 8.20.0。这不是门禁——
  `SECURITY-CBP.md:16,273`（§0 第 1 条、§6 第 12 条）对同一事实的判语与本段一致。

## 1. 帧表变更清单

共同前提：v1 从未发布（论证见第 3 节），场上没有按旧 v1 严格校验的已部署对端；唯一在场上
讲旧话的是 AstrBot 私有帧桥（`world-astrbot@4725feee6`、`astrbot-plugin-bridge@37c1e6ccd`），
它的兼容全部走 negotiate 兼容读与世界包分支，帧表不为它开洞。因此「迁移代价」一列衡量的是
本批必须同批同步的在架发帧方：内核 `helloFrame()/readyFrame()/callTool()`
（`packages/cortico-bridge-core/src/driver.ts:205-233`）、astrbot 世界包（`src/driver.ts:185-191、
255-267`）、两份 vendored `cbp.py` 副本（同步纪律 `cortico-bridge-neko/cbp.py:1-6`：先改 spec
再同步副本）。漏改任何一处的后果是它的出帧立刻被判坏帧，这是有意的fail-shut，不是回归。

| # | 帧/面 | 字段 | 动作 | 必填性 | 默认值 | 错误码 | 迁移代价 |
|---|-------|------|------|--------|--------|--------|----------|
| F1 | `hello` | `self` | 新增必填 | 必填 | 无默认，握手首帧必须带 | — | 三方同批改 |
| F2 | `ready` | `self` | 新增必填 | 必填 | 无默认，握手首帧必须带 | — | 三方同批改 |
| F3 | `call` | `turn`、`actor` | 新增必填 | 两者必填 | 无默认 | 60004 | 三方同批改 |
| F4 | 传输 | `Authorization` 头 | token 禁走 URL query，禁上帧面 | — | 无 token=环回限定（**F20 已废止**） | close 4401 | 配置迁移 |
| F5 | `hello` | `v_support` | schema 放宽 | 必填不变 | `[1]` | 60001 | 零 |
| F6 | `reply` | `error` | 解码器补 enforce | `ok:false` 时必填 | — | 吞帧计 `framesBad` | 近零 |
| F7 | `ack`/`call`/`reply`/`msg` | `rid`、`conv` | 解码器补长度上限 | 不变 | — | 吞帧计 `framesBad` | 零 |
| F8 | `notice` | `text` | 新增可选（世界包旧债，安全件未裁决） | 可选；`kind`、`raw` 保持必填 | 缺省=收件侧用 `kind` 渲染 | — | 零 |
| F9 | `notice` | `kind` 词表 | 收最小三值 | 类型不变（自由串） | — | 不认识的降级 | 零 |
| F10 | `event` | `data.reason` | 键名登记入词表 | `data` 仍 open | 缺 reason 走兜底投影 | 60008 仍闲置 | 零 |
| F11 | `ack` | 语义收窄 | description 改文案 | 不变 | — | — | 零 |
| F12 | 头 | `ts` | 降为展示键 | 必填不变 | — | 无（超差记降级） | 零 |
| F13 | `blob`/帧 | 字节上限 | 单一来源改 `pins.caps`；内核设 `maxPayload` | 不变 | `caps.cbp.frame_bytes=524288` | 60003；close 1009 | 字面量退场 |
| F14 | `listen` | 会话数 | 一连接一账号，二顶一 | — | 单会话 | close 沿用 4402 族 | 内核策略 |
| F15 | `listen` | 入站窗 | 定窗限流 | — | 60 帧/分/会话 | 丢帧计 `inboundDropped` | 内核新增 |
| F16 | `tick` | 完整头 | 不改表，改实现 | 头四件不变 | — | 无头 tick 被吞 | 包内改 |
| F17 | （无） | `t:'send'` 等 | 不入表，实现改道 call | — | — | 60005/60007 不变 | 包内改 |
| F18 | 根 | `description` | 改文案纠错 | — | — | — | 无 |
| F19 | `event`/`reply` | 文案字节 | 统一 mnemonic 前缀 | — | — | 60001、60007 | 零 |
| F20 | 传输（非帧表） | `Authorization` / `Origin` / `authToken` | 强制密钥 + 来源校验，废止「环回免鉴权」 | 密钥必填，无默认 | 缺密钥 = 拒绑定/拒建链 | close 4401 | **破坏性**：两端须配同名密钥 |

### F20 强制密钥与来源校验（2026-11-19，SECURITY-CBP.md §3 决定 7）

- **不改帧表**：本条只动 HTTP Upgrade 层与配置通道。`CBP-v1.json` 与
  `conformance.json` 均不变；hello 帧体原本就无 token 位（`SECURITY-CBP.md:118`），
  本次是把 astrbot 私有帧的兼容位一并移除，不是新增/删除 schema 字段。
- **废止 F4 的「无 token=环回限定」**：浏览器 WebSocket 不受同源策略/CORS 预检保护，
  本机任意网页都能拨 `ws://127.0.0.1:<port>`，环回监听不构成鉴权。依据索引仓
  10-22（commit `7dec0b00d`）与 11-13（commit `5b453aa0b`）两条判例。
- **落地**：`authToken` 类型层必填；`listen()` 无 token 拒绑定
  `door_closed: token required`，`dial()` 无 token 拒建链 `dial_refused: token required`；
  `Origin` 仅允无 Origin（native client）或环回 web origin，其余 close 4401；
  `token`/`access_token` query 见即拒；`Authorization: Bearer` 头逐字匹配。
- **凭据通道**：Cortico 侧 `ctx.secret('CORTICO_BRIDGE_TOKEN')`，框架侧同名环境变量。
  `worlds.astrbot.token` / `worlds.maibot.token` 配置串与面板项删除，hello 帧体不留
  token 位，URI 活闸拒凭据 query。
- **迁移代价**：旧部署未配密钥时两端 fail-shut，表现为桥静默断连。必须两端设逐字
  相同的值后重启，不是故障而是设计行为。
- **标签**：`cortico-world-onebot-bridge`、`cortico-world-koishi`（10-22 类），
  `cortico-world-maibot`、`cortico-world-neko`（11-13 类）按 `TAGS.md:42` 自声明
  `unsafe`；`cortico-world-qq-digest` 经核不适用；`cortico-world-astrbot-bridge`
  为 dial 侧，暂不声明（warning tag 不可撤回，留待仓主裁决）。
  **（本条标签口径已由 F21 取代：声明从未发布即撤回，改为收敛能力面。）**

### F21 能力面收敛与撤回未发布的 warning 声明（SECURITY-CBP.md §3 决定 8）

- 裁决出处：`SECURITY-CBP.md` §3 决定 8（2026-11-19 二次修订）。
- 撤回：4 个包的 `unsafe` 声明从未 commit / publish，按 `TAGS.md:40` 的适用边界撤回；
  不写 `safe`（词表外 tag 会被 `check:extension` 拒，`TAGS.md:31/:42`）。
- 10-22 类新增 `src/guard.js` 双闸：本机文件引用（盘符 / UNC / 绝对路径 / `..` /
  `file://` / CQ 码 / 深嵌套）与动作名静态目录白名单；排在身份、策略、连接判定之前，
  零出网。两包 `guard.js` 逐字相同，`test/guard.test.mjs` 断言 sha256 一致，新增 18 条用例。
- 11-13 类复核能力面：`egress` 默认关、未申报能力本地 60002、静态工具表；F20 的
  Bearer + Origin + fail-shut 已堵来源面，不重开帧表设计。
- 双端：Cortico world 包 + 框架 Python 桥均有改动与测试（框架侧为 F20 落地件）。
- 迁移代价：无新增；F20 的 `CORTICO_BRIDGE_TOKEN` 必填口径不变。

### F1/F2 `hello` 与 `ready` 各增必填 `self`（SECURITY-CBP.md §2）

- 裁决出处：`SECURITY-CBP.md:70-71`。定形 `self = {id, name, proven}`：
  `id: string(0..256)`、`name: string(0..256)`、`proven: boolean`，三键闭合
  （`additionalProperties:false`，`SECURITY-CBP.md:71`）。注意 `proven` 允许空串 id——
  实证失败也要诚实报 `proven:false`，不许用「没有 self」冒充「没有 self 需求」。
- 现状缺口：`hello` 必带键只有 `{v,t,id,ts,agent,v_support,caps,tools}`
  （`spec/CBP-v1.json:129`），`ready` 只有 `{v,t,id,ts,caps,tools}`（`spec/CBP-v1.json:144`），
  而回声抑制判定 `sender.id == self.id` 早已在册（`spec/CBP-v1.json:156`、
  `spec/conformance.json:106`、实现 `packages/cortico-bridge-core/src/envelope.ts:105`）。
  self 却靠部署者手填（`envelope.ts:83-84` `EnvelopeOptions.selfId` 是可选配置位）。
- 时序规则（`SECURITY-CBP.md:73-77`，全部进向量）：桥拨出在 `hello` 带、桥监听在 `ready` 带；
  `proven` 由假变真必须重推该握手帧（先例 `bridge.py:291-293`、`main.py:379-381`，
  `SECURITY-CBP.md:75`）；同连接内 `self.id` 变化是违规，丢帧 +
  `event{name:"degraded",data:{reason:"self-churn"}}`（`SECURITY-CBP.md:76`）；
  `self_echo` cap 只能与 `proven:true` 同现，矛盾则丢该 cap + `self-echo:caps-lie`
  （`SECURITY-CBP.md:77`）。
- 降级口径（`SECURITY-CBP.md:78-81`）：`proven:false` 时照常投递（不吞消息优先，同
  `envelope.ts:129-131`），同时发 `data:{reason:"self-unknown"}` 降级事件，`<w>.status`
  与 ENV_PROMPT 常驻 `self-echo:off`。两种静默都禁止：全量 archive-only（对用户失忆）与
  不声明的全量投递（回声环）。
- N.E.K.O 线永久 `proven:false`（`SECURITY-CBP.md:72,270`）：bus 面无 publish，唯一取值口是
  `role=="assistant"` 启发式，不算实证。
- 错误码：无新增码。必填性变化本身就是闸：缺 `self` 的 hello/ready 是结构坏帧，走
  parseFrame→null→`framesBad`（`frames.ts:222-227` 吞帧纪律、`driver.ts:343-347` 计数）。
- 迁移代价：内核 `helloFrame()/readyFrame()`（`driver.ts:217-233`）必须同时带 self；
  astrbot 世界包旧 ready 已有 `self` 位（`packages/cortico-world-astrbot-bridge/src/frames.ts:70`
  注释指 4725feee6/37c1e6ccd），改成填进 CBP self（`SECURITY-CBP.md:90`）；neko 桥 hello
  构造处填 `proven:false`（`SECURITY-CBP.md:91`，指 `cortico-bridge-neko/__init__.py:153-158`）；
  maibot 桥填 `internal_chat.identity` 结果（`SECURITY-CBP.md:91`）。三方与 spec 同批。

### F3 `call` 增必填 `turn` 与 `actor`（SECURITY-CBP.md §1）

- 裁决出处：`SECURITY-CBP.md:27-35`。定形
  `call = {v,t,id,ts,rid,tool,args,turn,actor}`，`actor = {platform, conv, member, anon}`。
- 字段定义逐字（`SECURITY-CBP.md:31-35`）：
  - `turn`: `$defs/frameId`（1..64，`spec/CBP-v1.json:23-28`），值 = 触发本轮的入站 `msg`
    帧 id。先例同型：world 已随 call 发 `lastTurnMsgId`、没有就拒
    （`packages/cortico-world-astrbot-bridge/src/world.ts:250-252`、`src/driver.ts:185-191`）。
  - `platform`: `string(1..64)`，宿主自报平台名逐字（AstrBot 取 UMO 首段，MaiBot 取
    `MessageDict.platform`，v11 取 `message_type` 归一名，neko 取 bus 记录 `source`，
    `SECURITY-CBP.md:32`）。
  - `conv`: 复用 `$defs/conv`（`spec/CBP-v1.json:34-39`）。
  - `member`: 复用 `$defs/sender`（`{id,name}`，`spec/CBP-v1.json:86-94`），`id` 必须宿主
    实证值（`SECURITY-CBP.md:34` 列的四口）。
  - `anon`: 枚举四值 `["identified","anonymous","self","unknown"]`（`SECURITY-CBP.md:35`）。
- `actor` 对象内部四键全闭合；`args` 保持开映射不变（`SECURITY-CBP.md:41`，开面现状
  `spec/CBP-v1.json:211`）。这条闭合性是本批唯一的「新对象闭合、旧开放不动」组合，
  与本台账 F18 对 description 假话的纠正配套。
- 执法规则（`SECURITY-CBP.md:36-40`）：桥只用 `turn` 查入站记录定身份，线上 `actor` 只作
  对账，不一致以宿主记录为准 + `degraded data.reason="actor-mismatch"`；`turn` 查不到或
  超窗，拒执行回 `reply{ok:false,error:{code:60004,message:"unknown_session: ..."}}`
  （60004 在册，`packages/cortico-bridge-core/src/errors.ts:26`）；写动作的 `confirm` 只在
  `anon=="identified"` 生效，堵掉 `onebot_call` 自报 confirm 的洞
  （`packages/cortico-world-onebot-bridge/src/world.js:25-31,182-185`，写动作含
  `set_group_kick`/`set_group_ban`，`src/catalog.js:41-42`，`SECURITY-CBP.md:23`）；
  结构性缺字段 = 坏帧吞掉，语义性缺身份才 60004。
- 不做的事照抄 `SECURITY-CBP.md:42`：不做跨平台同人等价、`actor` 不保证授权结果、v1 无
  身份委托链。
- 必填性：`turn`、`actor` 必填。默认值：无。错误码：60004（语义缺）、`framesBad`
  （结构缺）。
- 迁移代价：`spec/CBP-v1.json:203` 的 `call.required` 追加两键；内核 `CallFrame`
  （`frames.ts:112-120`）与 `callTool()`（`driver.ts:205-215`）加 `turn` 入参；两份
  vendored 副本的 call 元组（已核 `cortico-bridge-neko/cbp.py:25` 现值 `("rid","tool","args")`）
  同步；MaiBot 桥要先长出 call 处理腿（现只有入站腿，`SECURITY-CBP.md:51` 指
  `cortico-bridge-maibot/client.py:46-66`）。

### F4 凭据承载位（SECURITY-CBP.md §3）——帧表维持不开 token 洞

- 裁决出处：`SECURITY-CBP.md:115-118`。CBP 共享密钥只走 HTTP Upgrade 头
  `Authorization: Bearer <token>`；`listen` 侧头缺失或不符 → `close 4401`（码沿用现
  `driver.ts:260`）；URL 出现 `token`/`access_token` query → 直接 `close 4401` 不比对，
  log 记 `query-token-refused`（只记键名不记值，`SECURITY-CBP.md:116`）。
- 帧面 token 的旧形态（`bridge.py:340,549`，close 4003）只作为旧方言兼容读保留；CBP 协商
  一旦成立（`hello.v_support` 命中），帧体 token 位不再被读也不再被发
  （`SECURITY-CBP.md:118`）。本台账此前记的 union hello 矛盾（世界包在发
  `{...token,name,capabilities}`，`packages/cortico-world-astrbot-bridge/src/driver.ts:255-267`，
  schema hello 却闭合，`spec/CBP-v1.json:127-141`）就此结账：hello 帧表不动、保持闭合，
  世界包按协商态分叉。
- 配套三条本地纪律（`SECURITY-CBP.md:120-122`，非帧面但属协议改动账）：非环回 bind 必须配
  非空 token 否则拒 bind；Cortico 侧凭据走 `ctx.storeSecret()/ctx.secret()`（0600），
  `worlds.<w>.token` 配置串删除（现持久化点 `packages/cortico-world-astrbot-bridge/src/config.ts:20,38,55,82-87`）；
  token 值与带 query 的 URL 不进 `log()`/`onState.lastError`/`doctor`，
  `emitState(String(e))` 三处（`driver.ts:244,255,296`）先过 redact。
- `meta.raw` 的剥除规则（`SECURITY-CBP.md:124`）：`raw`（`spec/CBP-v1.json:168`，
  `$defs/any` 开放 :20-22）、`call.args`、`reply.text` 进模型前按键名表删敏感键、按两串
  规则替换 userinfo 与 `?token=` 尾巴。「恒留原始载荷」硬规则的实现口径改为「恒留剥除后的
  原始载荷」。凭证型动作 `get_cookies`/`get_csrf_token`/`get_credentials` 从目录摘除，命中
  名字回 `reply{ok:false,error:{code:10002,message:"unsupported_action: 凭证动作不进桥"}}`
  （`SECURITY-CBP.md:125`；10002 在册 `errors.ts:11`；现 `readOnly:true` 点在
  `packages/cortico-world-onebot-bridge/src/catalog.js:26-28`）。
- 错误码：10002、4401（传输层 close），帧表无新增。
- 迁移代价：配置位迁移（token 从 config 进 secret/env `CORTICO_BRIDGE_TOKEN`）；对端旧版
  桥（37c1e6ccd）继续吃它的帧体 token 兼容读，直到协商翻转。

### F5 `hello.v_support` 放宽为整数集（本台账自记）

- 现状矛盾：schema 钉 `items:{"const":1}, maxItems:1`（`spec/CBP-v1.json:136`），只许 `[1]`；
  解码器收任意有限数字数组（`frames.ts:240`）；门禁只做交集（`negotiate.ts:26,50`）；世界包
  协商取 `Math.max(...shared)`（`cortico-world-astrbot-bridge/src/frames.ts:166`）。四方三种
  口径。
- 改动：`items` 放宽为 `{"type":"integer","minimum":1}`，`minItems:1` 不变，`maxItems:8`
  （防无界数组；8 是本台账定的上限，非上游锚）。
- 必填性/默认值：`hello` 仍必填（`spec/CBP-v1.json:129`）；内核仍发 `[1]`
  （`driver.ts:224`）。错误码：60001 不变（`negotiate.ts:51-55` + `errors.ts:23`）。
- 迁移代价：零。放宽只让 schema 追上已宽容的解码器；不放宽，将来 v2 端诚实报 `[1,2]` 反而
  违 v1 schema。F4 的「协商成立」判定也依赖这个支持集语义。

### F6 `reply` 的 `ok:false ⇒ error` 解码器补 enforce（本台账自记）

- 现状：schema 的 `if/then` 已在（`spec/CBP-v1.json:234-241`），反向向量已在
  （`spec/conformance.json:193`），解码器没管（`frames.ts:273-285` 只查 `rid`、`ok`）。
- 改动：`parseFrame` reply 分支加 `ok===false && error===undefined` → null。
- 错误码/迁移：坏帧吞掉计 `framesBad`（`driver.ts:343-347`）；发坏 reply 的旧桥分支走世界包
  自己的宽松解码（`cortico-world-astrbot-bridge/src/frames.ts:113-122`），不经内核，近零。

### F7 `rid`、`conv` 解码器补长度上限（本台账自记）

- 现状：schema 已定 `rid`=frameId 1..64（`spec/CBP-v1.json:196,209,224`）、`conv` ≤256
  （`spec/CBP-v1.json:34-39`）；解码器只查 `isStr`（`frames.ts:266,270,274`）、conv 无上限
  （`frames.ts:253`）。两者都拼进无界内存键：dedup `${conv}|${message_id}`
  （`dedup.ts:83-90`）、in-flight 按 rid（`correlate.ts:36-61`）。F3 的 actor 让 conv 变成
  授权输入，长度闸从卫生问题升级为门禁配套。
- 改动：`ack/call/reply.rid` 复用头部的 1..64 检查；`msg.conv`、`notice.conv` ≤256。
  `caps` 重复不补查（交集用 Set 无害，`negotiate.ts:35-38`）。
- 错误码：无新增；超限吞帧。迁移代价零（合法帧本就不许超限）。

### F8 `notice.text` 可选（本台账旧债，安全件未裁决）

- 现状：旧桥 notice 带人读正文，世界包消费（`packages/cortico-world-astrbot-bridge/src/
  frames.ts:88-90`、`world.ts:330`）；schema notice 闭合无 `text`（`spec/CBP-v1.json:172-186`）。
- 改动：properties 加 `"text": {"type":"string","maxLength":1024}`（对齐 `error.message`
  的 1024，`spec/CBP-v1.json:123`）。`kind`、`raw` 保持必填（`spec/CBP-v1.json:175`）。
- 默认值：缺省=收件侧按 F9 词表与 envelope 规则用 `kind` 渲染。错误码：无。
- 迁移代价：零（旧版解码透传未知键，`frames.ts:259-264`）。

### F9 `notice.kind` 收最小词表（SECURITY-CBP.md §5.3）

- 裁决出处：`SECURITY-CBP.md:237`。`kind` 从纯自由串（`spec/CBP-v1.json:182`）收三值词表：
  `group_recall`、`friend_recall`（宿主在册叶名）+ 新词 `message-edited`。类型面不变
  （词表外的宿主叶名仍合法——kind 本来就是「宿主事件判别叶子」，`spec/CBP-v1.json:173`），
  收紧的是：撤回/编辑帧必须带被作用消息的 `platformMsgId`（现成键
  `packages/cortico-bridge-core/src/envelope.ts:118`），world 落 `contextDelivery:'archive-only'`
  墓碑事件、piggyback 档（`SECURITY-CBP.md:237`）。
- 错误码：无新增；kind 不在词表且不是宿主叶名 → degraded（`SECURITY-CBP.md:240`）。
  撤回不删改已入库事件（Cortico 事件面只读加 append，`SECURITY-CBP.md:263`）。
- 迁移代价：零（纯投影与词表闸；`tools/vocab_gate.py` 钉三值，`SECURITY-CBP.md:240`）。

### F10 `event.data.reason` 键名入册（SECURITY-CBP.md 各节汇总）

- 新登记的 reason 值：`actor-mismatch`（`SECURITY-CBP.md:37`）、`self-churn`（:76）、
  `self-echo:caps-lie`（:77）、`self-unknown`（:79）、`frame-over-limit`（:189）、
  `inbound-rate`（:244）、`clock-skew:<±Ns>`（:251）、`media-over-cap:<线>` /
  `media-dropped:<mime>`（:193）。
- 表不变：`data` 仍是 `$defs/any` 开放（`spec/CBP-v1.json:21-22,253`），不闭合——本台账
  F18 的真实口径。登记的是词表闸与投影兜底：认得的 reason 走 `<w>.degraded` flush 档
  （`envelope.ts:162-168` 现状需按第 2 节改正），不认识的原样 JSON 展示，绝不抛。
- 错误码：60008 `DEGRADED`（`errors.ts:30`）仍无发射点，保持在册不用；原因：降级面已全部
  走 `event{name:'degraded'}` 帧，给同一事实发两份账反而违反单一来源。此判断记入第 5 节。
- 迁移代价：零。

### F11 `ack` 语义收窄（SECURITY-CBP.md §5.1）

- 裁决出处：`SECURITY-CBP.md:223`。`ack` 定义收窄为「入站接收回执」：桥收到 `msg`/`notice`
  并本地落定后发一次；不代表任何出站投递成功。出站幂等键就是 `call.rid`，框架侧落
  rid→回执缓存（TTL 300 秒、上限 200，先例 `bridge.py:65-66,425-458`，`SECURITY-CBP.md:222`）；
  同 rid 重投只回缓存不再发。不做跨重启幂等、不做 exactly-once（`SECURITY-CBP.md:224,264`）。
- 表动作：`ack` 的 `description` 改写（现文 `spec/CBP-v1.json:188` "Receipt that a msg/notice
  frame was taken by the peer" 本已接近，补「不代表出站」一句）；必填性/字段不变。
- 错误码：无。迁移代价：零（描述性收窄；实现侧见第 4 节 correlate/driver 行）。

### F12 头 `ts` 降为展示键（SECURITY-CBP.md §5.5）

- 裁决出处：`SECURITY-CBP.md:251`。排序键 = Cortico 落库 cursor，`ts` 只做展示；内核加钟差
  探测 `|frame.ts*1000 - now| > 120000` 记 `clock-skew:<±Ns>` 降级，帧照收。
- 表动作：`ts` 的 description 补「展示用，非排序键」（`spec/CBP-v1.json:29-33`）；类型、
  必填性不变。去重窗与限流窗不用 `ts`（`SECURITY-CBP.md:252`；现状 `dedup.ts:14,33` 用的
  就是本地墙钟，不动）。
- 迁移代价：零。

### F13 媒体与帧字节上限：单一来源 `spec/pins.json` 新 `caps` 段（SECURITY-CBP.md §4）

- 裁决出处：`SECURITY-CBP.md:168-187`。六个互不折算的数字（宿主 524288、本地先拒 524061、
  宿主图 8 MiB、ZMQ 4784128、schema 的 b64 无上限、ws 缺省 100 MiB）收进一个顶层 `caps`
  段，形状照 `SECURITY-CBP.md:171-187` 逐字：`cbp.frame_bytes=524288`、
  `neko.frame_bytes=524061`、`maibot` 全 null `action:"host-ask"`、
  `astrbot.media_bytes=6291456`、`onebot.text_bytes=4000` `action:"degrade"`。
  代码里不写媒体字节字面量（`SECURITY-CBP.md:168`；已核现状违例：
  `cortico-bridge-neko/ingress.py:22-23`、`spec/CBP-v1.json:226` 的 text 524288、
  `packages/cortico-world-onebot-bridge/src/config.js:36` 的 4000）。
- 单位口径定死：`media_bytes` 说解码字节；发送方自算 `b64len = 4 * ceil(rawlen/3)` 后按
  `frame_bytes` 判（`SECURITY-CBP.md:188`）。
- 内核必设 `maxPayload: caps.cbp.frame_bytes` 两处（`SECURITY-CBP.md:189`；已核现状：
  `packages/cortico-bridge-core/src/driver.ts:241` `new WebSocketServer({...})`、
  `:276` `new WebSocket(url)` 均无 maxPayload，全仓 src grep 零命中，吃 `ws@8.23.0`
  缺省 100 MiB）。超限 `ws` close 1009，内核记 `framesBad` + `degraded
  data.reason:"frame-over-limit"`。1009 是传输层事实，不是 CBP 码。
- `blob.b64` 不新增 maxLength（现 `minLength:1` 无上限，`spec/CBP-v1.json:113`）——上限的
  单一来源是 caps 段 + 发送方折算 + 传输 maxPayload，schema 里再抄一份字面量正是本条要消灭
  的「五处数字」第六处。`reply.text` 的 `maxLength:524288`（`spec/CBP-v1.json:226`）保留为
  结构护栏，description 注记与 `caps.cbp.text_bytes` 同源。
- 超限行为三档（`SECURITY-CBP.md:191-193`）：出站且目的地已知 → 本地预拒不发，回
  `60003 payload_too_large: N > M`（60003 在册 `errors.ts:25`；现成向量形态
  `spec/conformance.json:413`）；目的地只有宿主知道（MaiBot）→ 允许尝试一次，宿主拒转
  60003，不得重试第二次；入站表达不了 → 降级不拒收，附件换 `[image]` 类占位。
- v1 不分片（`SECURITY-CBP.md:194`），并把「超 524288 的长文不送达」写进做不到清单
  （`SECURITY-CBP.md:271`）。
- 错误码：60003（既有）；close 1009（传输事实）。
- 迁移代价：`spec/pins.json` 现无 caps 段（本机已核其顶层键集：`schema`、`generated`、
  `root`、`evidence`、`refresh`、`repos`、`node`、`python_buckets`、`npm_pins`、`neko_sdk`、
  `ports`、`vocab`，无 `caps`）；三个读取方形状须一次对齐（`SECURITY-CBP.md:195` 裁 caps 用线名为键的对象，
  并要求 `tools/gen_pins.py` 的 `validate()`（`tools/gen_pins.py:50-71`）同批校验 ports
  三读取方期望——现三方形状冲突：数组 vs 内核对象视图（`packages/cortico-bridge-core/src/
  pins.ts:35-40,70-75`）vs Python 桥的对象硬要求（已核 `cortico-bridge-neko/pins.py:37-39`））。

### F14 一连接一账号（SECURITY-CBP.md §5.2）

- 裁决出处：`SECURITY-CBP.md:230`。一条 CBP 会话 = 一个账号；listen 侧最多保留一个 ready
  会话，第二条连接顶掉旧的并清 rid 缓存（先例 `bridge.py:344-360`）；world 侧对 `actor.conv`
  校验「本会话见过的 conv」集（现成结构 `packages/cortico-world-astrbot-bridge/src/
  world.ts:131` `seenConvs`），没见过回 60004。
- 现状缺口：内核 listen 来者不拒（`driver.ts:258-264`），`send()` 广播所有 ready 对端
  （`driver.ts:187-202`），`conv` 是自由串无账号维（`spec/CBP-v1.json:34-39`）。
- 表动作：无新字段；`self` 的 description 补账号语义（`SECURITY-CBP.md:232`）。
- 错误码：60004。迁移代价：内核策略改动，对端无感。

### F15 入站定窗限流（SECURITY-CBP.md §5.4）

- 裁决出处：`SECURITY-CBP.md:244`。内核加入站定窗，缺省 60 帧/分/会话（写法镜像世界包现成
  `rateAllowed`，`packages/cortico-world-astrbot-bridge/src/world.ts:408-413`），超限丢帧并
  `counters.inboundDropped++`（计数器现无此字段，`driver.ts:45-53`），每窗聚合一条
  `degraded data.reason:"inbound-rate"`；egress 收 60006/backpressure 即暂停出站 30 秒
  （窗长复用 `CALL_TIMEOUT_MS = 30000`，`driver.ts:34`）。
- 表动作：无。错误码：无新增（丢帧不报错，报错的是聚合降级）。
- 迁移代价：内核新增件；旧对端无感。

### F16 `tick`：CBP 分支必须带头四件（本台账旧债）

- 现状：世界包 CBP 分支仍发裸 `{t:'tick'}`（`packages/cortico-world-astrbot-bridge/src/
  driver.ts:277`），内核解码对缺头帧判坏（`frames.ts:212-214`），会把它计进 `framesBad`；
  内核自己发的 tick 是完整的（`driver.ts:420`）。
- 改动：CBP 分支改发完整头 tick；旧桥分支保留裸形。表不变（`spec/CBP-v1.json:260`）。
- 迁移代价：零（缺头 tick 只计坏帧不断线；连接活性靠 WS ping/pong，`driver.ts:312-316`）。

### F17 出站发送不入表：`t:'send'`、`t:'tool'`、`t:'tool-ack'`、`t:'tools'` 是旧私有帧

- 现状：十型闭集（`spec/CBP-v1.json:7-18`；`frames.ts:52-63`）无 `send`；世界包 CBP 分支却在
  发 `{v,t:'send',id,ts,rid,conv,segments}`（`packages/cortico-world-astrbot-bridge/src/
  driver.ts:163-173`），入站面认 `tool-ack`/`tools`（:363-381，4725feee6 旧形）。
- 决策：不 mint 第 11 型。出站=对 ready/catalog 已报名工具发 `call`（F3 的 turn/actor 正是
  这条路的身份配套），回执=`reply`；出站门语义本就是工具结果 `"60005 door_closed: 出站门未开"`
  （`spec/conformance.json:381` 与 `world.ts:202` 逐字一致）；关联表一张管 call→reply
  （`correlate.ts:63-71`）。
- 错误码：60005、60007 不变。迁移代价：CBP 分支 send 改道 `callTool`；旧桥分支保留私有形。

### F18 schema `description` 第 5 行的假话要改

- 现状：`spec/CBP-v1.json:5` 写 "Every object in this schema closes with
  additionalProperties:false"。不实且开处是有意设计：`$defs/any`（`spec/CBP-v1.json:20-22`）、
  `seg.data` 开放字符串映射（`spec/CBP-v1.json:74-78`）、`call.args` 开放对象
  （`spec/CBP-v1.json:211`）、根 dispatcher 只有 `oneOf`（`spec/CBP-v1.json:6-18`）。
  `SECURITY-CBP.md:17` 判语与本段一致，并加了一条纪律：本台账与后续文件不得再用「全部闭合」
  句式，新增字段的闭合性逐条写（F3 的 actor 闭合、args 仍开，即按此写）。
- 改动：description 改为「十个帧形各自闭合；`seg.data`、`call.args`、`raw`/`data` 是有意
  开放的透传位」。无字节变更。

### F19 错误文案字节统一（60001、60007）

- 现状三方不一致：`rules.message_format`＝「mnemonic + ": " + 原生细节逐字」
  （`spec/conformance.json:67`）；向量期望 `"version_mismatch: ... vs peer v=2 not in [1]"`
  （`spec/conformance.json:363`）；内核实发 `"CBP version mismatch: local ..."`
  （`negotiate.ts:40-55`），前缀与 agent 格式都不符。且向量文案缺对端 name/version/sha，
  违 `spec/CBP-v1.json:96` 的硬规则（60001 断连文案必须带两侧三件套）。60007 同族：
  期望（`spec/conformance.json:375`）vs 实发（`correlate.ts:88-90`）。
- 改动：内核按 `message_format` 发；x_version_gate 向量重写为双侧三件套。
- 错误码不变。迁移代价：零（诊断文本，无解析依赖）。

## 2. 与 conformance.json 的对应

现有向量集：正向帧 10（`spec/conformance.json:118-172`）、反向 20（:173-197）、段 11
（:198-277）、envelope 7（:278-354）、错误 20（:355-473）、降级 4（:474-481）。

### 2.1 改正既有向量（6 组）

| 向量 | 位置 | 改什么 | 断言什么 |
|------|------|--------|----------|
| `hello_full`、`ready_minimal_caps_empty_tools` | `spec/conformance.json:123,128` | 各补必填 `self`，`call_send`（:147）补 `turn`+`actor` | 握手与调用的新必填位逐字节进 wire 期望（`canonical.frame_key_order` 规则 :37：`v,t,id,ts` 后按 schema properties 顺序，故 hello 的 `self` 插在 `agent` 与 `v_support` 之间——以改后 schema 的 properties 顺序为准） |
| envelope 4 条 `mention_flush`/`direct_flush`/`group_debounce_rendered`/`self_echo_archive_only` | `spec/conformance.json:283-322` | `senderKey` 从 `sender.id` 改为 `frame.conv` | senderKey＝会话键。内核（`envelope.ts:113`，测试钉 `envelope.test.ts:62`）与世界包（`normalize.ts:47-49`、`driver.ts:153` 注释）两处实现一致，向量是唯一少数派。宿主内面不过线，零迁移代价 |
| `self_echo_archive_only` | `spec/conformance.json:313-322` | 期望不动，欠的是 core：`EVENT_SUFFIXES` 无 `.self`（`envelope.ts:60-65`）、self 分支无 `trigger:"debounce"`（:124-128） | `.self` 事件名 + debounce/deliver:false 两面；`check.mjs:49-52`（仓外那份）也按 `.self` 后缀识别回声 |
| `notice_piggyback` | `spec/conformance.json:323-332` | 期望不动；core 实发 `[notice kind]`（`envelope.ts:145`），世界包实发 kind（`world.ts:330`） | text＝`kind` 逐字（规则 `:109`）；改 core 不改向量 |
| `connection_internal_flush`、`degraded_internal_flush` | `spec/conformance.json:333-352` | 期望不动；core 只 `JSON.stringify(data)` 且无 meta（`envelope.ts:157-170`） | text=`connection/<state>`/`degraded/<cause>`，meta 带 `kind`（规则 :110-111）。F10 的 reason 词表把这条从「两型」扩成「多 cause」 |
| `x_version_gate` | `spec/conformance.json:363` | error_wire 重写为双侧三件套 | 60001 文案含两侧 name/version/sha（`spec/CBP-v1.json:96`；F19）。现向量只有本地三件套＋对端版本集，自相矛盾 |

### 2.2 新增正向向量（7 条）

1. `call_full_actor_bound`：带 `turn`+`actor{platform,conv,member,anon:"identified"}` 的完整
   call，逐字节 wire 钉（`SECURITY-CBP.md:56`）。断言 F3 定形与 `actor` 闭合、`args` 仍开。
2. `hello_proven_false`：`self.proven:false` 且不带 `self_echo` cap 的 hello。断言合法
   （`SECURITY-CBP.md:72,77` 的诚实申报路径）。
3. `ready_repush_proven_true`：同连接第二条 ready，`proven` 翻转 true。断言允许重推
   （`SECURITY-CBP.md:75`）。
4. `recall_tombstone_reference`：`notice{kind:"group_recall"}` → 墓碑 envelope 正例
   （`SECURITY-CBP.md:240`）。断言 F9：archive-only、piggyback、引用原 `platformMsgId`。
5. `same_rid_double_call_single_effect`：同 rid 两次 call 只产一次副作用（`SECURITY-CBP.md:226`）。
   断言 F11/§5.1 幂等缓存语义。
6. `arrival_order_over_wallclock`：两条 ts 倒挂的 msg，断言到达序≠ts 序、排序按 cursor
   （`SECURITY-CBP.md:253-254`）。断言 F12。
7. `b64_at_limit_pass` / `frame_over_limit_reject`：b64 恰界通过、超 1 字节拒且不分片、未知
   MIME 走降级占位（`SECURITY-CBP.md:209`）。断言 F13 三档行为的字节面（逐字节 `error_wire`）。

（本台账自补的两条保留：`hello_v_support_set`（`v_support:[1,2]` 过 schema、过
`checkVersion`，F5）与 `notice_with_text`（F8）。）

### 2.3 新增反向向量（11 条）

1. `call_missing_actor`、2. `call_missing_turn`：结构缺位判坏帧
   （`SECURITY-CBP.md:40,56`）。
3. `actor_extra_key_closed`：`actor` 内多一键 invalid，同批断言 `args` 内多一键仍 valid——
   一条向量锁死「闭合的是新位、开的是旧透传位」（`SECURITY-CBP.md:56`，配套 F18）。
4. `hello_missing_self`、5. `ready_self_extra_key`、6. `self_echo_cap_without_proven`：
   握手面三条（`SECURITY-CBP.md:96`）。第 6 条锁 F1/F2 的 caps-lie 前提。
7. `hello_with_query_token_url`：帧体带 `token` 的混血 hello invalid——与既有
   `legacy_private_hello`（`spec/conformance.json:195`，纯旧形，只许 negotiate 兼容读）分列，
   两条都红才封死 token 上帧的两条路（`SECURITY-CBP.md:118,142`）。
8. `rid_over_64`（reply rid 65 字符）：F7，解码 null + schema invalid。
9. `conv_over_256`（msg conv 257 字符）：F7。
10. `send_frame_not_in_table`：完整头的 `{t:'send'}`——十型闭集的字节化（F17）。
11. `tick_headless`：`{t:'tick'}` 缺头（F16）；另加一条词表负例「kind 不在词表且不是宿主
    叶名 → degraded」（`SECURITY-CBP.md:240`，记为 11b）。

### 2.4 校验器落位（向量能不能跑起来的前提）

`SECURITY-CBP.md:142,273` 自认：仓内没有能执行 schema 判帧的器，上表凡是「schema invalid」
类断言要等 `tests/spec/` 校验器落地才真正咬得住；在那之前能咬人的只有 `node --test` 的文本
包含与行为断言（`tests/frames/frames-segments.test.mjs:89-126`）。该仓外校验器对本次基线
（第 0 节哈希）实跑一遍，输出 `ALL CHECKS PASS`（2026-11-16 00:56，
`cd C:/Users/54301/tmp/botfw-envs/spec-cbp && node check.mjs`）——它证明的是现有 spec 自洽，
不证明任何第 1 节改动已被执行。本台账的结账动作是把
仓外校验器等价物搬进仓（第 4 节第 29 行）：把 `C:/Users/54301/tmp/botfw-envs/spec-cbp/
check.mjs` 移植为 `tools/check_conformance.mjs` 并钉 ajv 8.20.0（npmmirror 源，
`--ignore-scripts`）。不搬，则第 1、2 节全部字节断言在仓内无人执行，等于没改。

## 3. 版本号策略：一个决定

**决定：原地改 v1。不升 v1.1。`v` 的 `const 1` 不动，`$id` 的 `CBP-v1.json` 不动，
`V_SUPPORT` 保持 `[1]`。**

理由，按硬到软排：

1. v1.1 在线上无法表达。`v` 是整数 `const 1`（`spec/CBP-v1.json:131`，十型同此），版本门禁
   只认整数交集（`negotiate.ts:26,50`）。要写「1.1」得先改 `v` 的类型——那是比加字段大一个
   量级的破坏，为未发布协议制造自己的第一个不兼容，纯亏。
2. 没有任何已发布对端需要兼容。本仓不是 git checkout（无 commit、无 tag、无 remote，
   `git rev-parse HEAD` fatal；`SECURITY-CBP.md:9` 同判）；两个世界包都停在 `0.1.0`
   （`packages/cortico-world-onebot-bridge/CHANGELOG.md:5`）；内核 pins 写 `cbpVersion: 1`
   （`packages/cortico-bridge-core/src/pins.ts:45`）。在野的只有旧私有帧桥，它的兼容走
   negotiate 兼容读与世界包分支（`spec/conformance.json:369`、
   `packages/cortico-world-astrbot-bridge/src/frames.ts:124-131`），与 CBP 版本号无关。
3. 升 v1.1 的全部收益（旧端识别新端）已由 `agent.sha` + `v_support` 交集承担
   （`spec/CBP-v1.json:95-105,136`）。F5 的放宽就是给这条路留的：将来真出 v2，握手在整数
   集合上自然分流，不需要 minor 号。
4. 安全件的裁决方式与「原地改」互证：`SECURITY-CBP.md:42`（不在 v1 做委托链）、
   `:126`（不做凭据轮换协议）、`:194`（分片 v1 不做）、`:224,264`（不做 exactly-once）全部
   以 v1 为主语收缩范围，从头到尾没有引入第二个协议版本号。
5. 改动历史不靠版本号承载：本文件按批次记账；v1 定稿冻结时把 `CBP-v1.json` 与
   `conformance.json` 的 sha256 记进发布说明，那就是字节意义上的「v1 首发」。协议此后
   再变才配 v2，并必须走 `v_support` 交集门禁。

两头话排除：不采用「原地改但文档里叫它 v1.1」。版本名永远只有 v1。

## 4. 需要改的实现文件清单（按依赖顺序）

安全件各节的「谁负责实现」列（`SECURITY-CBP.md:44-52,84-92,128-136,197-205,225,232,239,
246,253`）已全部并入下表；标 ◈ 的是我抽查过现文行号的桥侧文件，其余路径行号以安全件原文
为准。

| 序 | 文件 | 一句职责 | 本批要它做什么 |
|----|------|----------|----------------|
| 1 | `spec/CBP-v1.json` | 帧 schema 单一来源 | `hello`/`ready` 必填 `self`（新增 `$defs/self`）；`call` 必填 `turn`,`actor`（新增 `$defs/actor`,`$defs/anon`）；`notice` 加可选 `text`、kind 词表注记；`v_support` 放宽；`ack`/`ts` description 改写；修 :5 假话（F1–F5、F8–F12、F18） |
| 2 | `spec/pins.json` | 版本与常量单一来源 | 新增顶层 `caps` 段，形状逐字照 `SECURITY-CBP.md:171-187`；`ports` 形状三方对齐同批处理（F13） |
| 3 | `spec/conformance.json` | 黄金向量单一来源 | 2.1 改 6 组、2.2 增 7+2 条、2.3 增 11+1 条；`rules` 段加 `raw_redaction` 与 `credential_actions_forbidden`（`SECURITY-CBP.md:134`） |
| 4 | `packages/cortico-bridge-core/src/errors.ts` | retcode 表与文案构造 | `mnemonic + ": " + detail` 构造器供 60001/60003/60004/60007/10002 复用；无新码（F19） |
| 5 | `packages/cortico-bridge-core/src/pins.ts` | pins 内核视图 | `Pins` 接口加 `caps`，`loadPins()` 映射，`PINS` 快照同步（`SECURITY-CBP.md:201`） |
| 6 | `packages/cortico-bridge-core/src/frames.ts` | 十型接口面 + 防御解码 | `HelloFrame`/`ReadyFrame` 加 `self`、`CallFrame` 加 `turn`,`actor`（:67-84,:112-120）；`parseFrame` 校验新必填与三键/四键闭合（:236-244,:269-272）；reply `ok:false⇒error`（F6）；`rid`/`conv` 长度上限（F7） |
| 7 | `packages/cortico-bridge-core/src/negotiate.ts` | 版本门禁与 caps 协商 | 60001 文案改双侧三件套（:51-55）；legacy hello 兼容读落点 + 协商成立后帧体 token 不再读不再发（F4、F19；`SECURITY-CBP.md:118`） |
| 8 | `packages/cortico-bridge-core/src/redact.ts`（新增） | 凭据剥除一处实现四桥共用 | 键名表 + 两串规则逐字照 `SECURITY-CBP.md:124`；供 envelope/driver/emitState 出口（`SECURITY-CBP.md:130`） |
| 9 | `packages/cortico-bridge-core/src/envelope.ts` | 帧→宿主事件投影 | selfId 改由协商供给、缺时 `self-unknown` 降级且照常投递（:83-84,:105,:124-128）；`EVENT_SUFFIXES` 补 `.self`（:60-65）；notice text=kind、F9 墓碑（:134-153）；connection/degraded `kind/slash` 投影 + reason 词表（:157-170）；`meta.raw` 过 `redact()`（:114-121,:147-151）；ts skew 判定（F12） |
| 10 | `packages/cortico-bridge-core/src/driver.ts` | WS 双角色传输 | `tokenOf()`（:94-100）换 `authHeaderOf(req)`，query token 直接 4401 + `query-token-refused` 日志（F4）；`listen()/dial()` 设 `maxPayload: caps.cbp.frame_bytes`（:241,:276；F13）；单会话顶替 + 清 rid（F14）；入站定窗 + `inboundDropped` 计数器（:45-53；F15）；`helloFrame()/readyFrame()`（:217-233）带 `self`；`callTool()`（:205-215）加 turn 入参；`onHandshakeFrame`（:366-394）做 churn 与 caps-lie；`emitState` 出口过 redact（:244,:255,:296）；非环回无 token 拒 bind（`SECURITY-CBP.md:120`） |
| 11 | `packages/cortico-bridge-core/src/segment.ts` | 段词表与渲染单点 | 出站按 caps 预检并产出 `media-over-cap:<线>` 降级项（`SECURITY-CBP.md:203`；F13） |
| 12 | `packages/cortico-bridge-core/src/correlate.ts` | rid/echo 关联表 | 60007 超时文案改向量原文（:88-90；F19）；加 rid→回执缓存语义（TTL 300、上限 200）或新 `src/idempotency.ts`（F11；`SECURITY-CBP.md:225`） |
| 13 | `packages/cortico-bridge-core/tests/`（frames、negotiate、envelope、correlate、pins、driver-loopback 六件） | 内核行为钉 | 新必填位正反例；60001 新格式（现 `negotiate.test.ts:36-38` 断旧格式）；self 两面（现 `envelope.test.ts:24-34`，`SECURITY-CBP.md:98`）；超 maxPayload 断连非静默、1k 帧突发断聚合 degraded、同 rid 双发、ts 倒挂到达序（`SECURITY-CBP.md:210,247,254`）；caps 完整性用例（`SECURITY-CBP.md:211`） |
| 14 | `packages/cortico-world-astrbot-bridge/src/frames.ts` | 内核包内替身 | 按该文件自注终态删除、import 改指内核（其 :12-13 shortcut 原文） |
| 15 | `packages/cortico-world-astrbot-bridge/src/driver.ts` | AstrBot 侧拨号驱动 | CBP 分支：`send` 改道 call（:163-173；F17）；`turn`+`actor` 随 call（:190；F3）；协商成立后停发 union hello 的 token/name/capabilities（:255-267；F4）；裸 tick 改完整头（:277；F16）；`peer.self` 接进 CBP self（`SECURITY-CBP.md:90`） |
| 16 | `packages/cortico-world-astrbot-bridge/src/config.ts` | 包配置面 | 删 `token` 字段与面板项（:20,38,55,82-87），改读 `ctx.secret('CORTICO_BRIDGE_TOKEN')`（F4；`SECURITY-CBP.md:132`） |
| 17 | `packages/cortico-world-astrbot-bridge/src/world.ts` | World 装载面与出站门 | `actor` 组装（发信侧实证值入 `member`，`SECURITY-CBP.md:49`）；`seenConvs` 校验 `actor.conv` 回 60004（:131；F14）；envPromptVars 只输状态串、剥 url/token/raw 子串（:179-193；`SECURITY-CBP.md:123`）；rate 窗件下沉内核（:408-413；F15）；notice text 分支按 F8/F9 |
| 18 | `packages/cortico-world-onebot-bridge/src/world.js` | OneBot v11 world | `gateAction` 加 `anon` 判定（:25-31,182-185；F3）；三个凭证动作名字闸回 10002（F4）；selfId 腿改读协商 self（:39-54；F1/F2）；`capText` 20000 收编进 caps 读数（:196；F13） |
| 19 | `packages/cortico-world-onebot-bridge/src/catalog.js` | v11 动作目录快照 | 删 `get_cookies`/`get_csrf_token`/`get_credentials` 三行（:26-28；F4；`SECURITY-CBP.md:133`） |
| 20 | `packages/cortico-world-onebot-bridge/src/config.js` | 包配置面 | `maxEventChars=4000` 改读 caps（:36；F13）；token env 优先形态保留（`SECURITY-CBP.md:132`） |
| 21 | `packages/cortico-world-astrbot-bridge/tests/`（frames、driver、world 三件） | 包级断言 | 随 14–17 更新；`anonymous` 写动作被拒用例（`SECURITY-CBP.md:59`）；world.test.mjs 的 catalog 长度断言随 19 显式改账（`SECURITY-CBP.md:143`） |
| 22 | ◈ `C:/Users/54301/cortico-bridge-neko/cbp.py` + ◈ `C:/Users/54301/cortico-bridge-maibot/cbp.py` | 两份 vendored 编解码副本 | call 元组加 `turn`,`actor`、hello/ready 加 `self`（现值 `cbp.py:25` 已核）；纪律先 spec 后副本（`cbp.py:1-6`） |
| 23 | ◈ `C:/Users/54301/cortico-bridge-neko/__init__.py`、`watch.py`；◈ `C:/Users/54301/cortico-bridge-maibot/client.py`、`plugin.py`、`mdict.py` | 两桥收发热路径 | neko hello 填 `proven:false`、call 分发加 turn→入站记录查表（`SECURITY-CBP.md:51,91`）；maibot 长 call 腿（现只有入站腿，`client.py:46-66`）+ `internal_chat.identity` 填 self（`SECURITY-CBP.md:72,91`）；两桥的 `actor.conv` 会话登记（F14） |
| 24 | ◈ `C:/Users/54301/cortico-bridge-neko/ingress.py`、`pins.py`；`C:/Users/54301/cortico-bridge-maibot/pins.py` | 本地闸与 pins 读数 | `PAYLOAD_MAX_BYTES`/余量字面量改读 caps（现值 `ingress.py:22-23` 已核；`SECURITY-CBP.md:156,204`）；`pins.py` 加 `cap_of()`；URI 串不含 token 子串的活闸扩一条（`SECURITY-CBP.md:144`） |
| 25 | `tests/frames/frames-segments.test.mjs` | 仓级文本包含闸 | `FRAME_REQUIRED.hello/ready` 各加 `self`、`FRAME_REQUIRED.call` 改 `['rid','tool','args','turn','actor']`（现值 :17-28；`SECURITY-CBP.md:57,97`）；:89-98 的 schema 断言补新键名。它仍只是文本闸，强度口径见 `SECURITY-CBP.md:57` 自注 |
| 26 | `tools/gen_pins.py` | pins 生成与自检 | `validate()`（:50-71）加 caps 分支（键集完整、null 配 notes、action 三值限定）+ ports 三读取方同校验 + CBP 自家端口环回断言（`SECURITY-CBP.md:136,195,200`） |
| 27 | `tools/vocab_gate.py` | 词表存在性闸（G3） | 加 `anon` 四值、`actor` 键名、`self` 三键与 `self_echo` 断言（`SECURITY-CBP.md:52,92`）；三个凭证动作名进 forbidden 名单对照 `spec/pins.json`（`SECURITY-CBP.md:145`） |
| 28 | `tools/manifest_scan.py` | 常量扫描纪律 | 端口字面量扫描扩到媒体字节字面量（`SECURITY-CBP.md:205`） |
| 29 | `tools/check_conformance.mjs`（新增）+ 根 `package.json` | 把仓外向量校验器变成仓内闸 | 移植 `botfw-envs/spec-cbp/check.mjs`（ajv 8.20.0 strict，2020-12），npmmirror 源 + `--ignore-scripts`；2.2/2.3 的 schema 断言从此真咬（`SECURITY-CBP.md:142,273`；本台账 2.4） |
| 30 | `C:/Users/54301/cortico-bridge-neko/tests/test_ingress_v2.py`、`test_entry_contract.py`、`test_pins.py` 与 `C:/Users/54301/cortico-bridge-maibot/tests/test_cbp_codec.py`、`test_pins.py` | 桥侧副本行为钉 | 副本各跑同一向量表，漂移即红（`SECURITY-CBP.md:60`）；双发反例（`SECURITY-CBP.md:226`）；hello 帧形用例补 `self`（`SECURITY-CBP.md:100`）；媒体字面量 AST 扫描（`SECURITY-CBP.md:214`） |

## 5. 开放项（记在明处，不当已决）

1. `caps` 段的内部张力：`cbp.frame_bytes=524288` 且 v1 不分片（`SECURITY-CBP.md:173,194`），
   而 `cbp.media_bytes=8388608`（解码字节）。折算 base64 后超过约 393 KB 的媒体永远塞不进
   一帧，8 MiB 那条在 CBP 线上是「宿主能力声明」而非「可送达承诺」。`SECURITY-CBP.md:188`
   的发送方折算会把矛盾显式化成 60003，但装机文档必须写明这一有效上限，否则六处数字消灭了、
   误读还剩一处。不改动裁决，只记账。
2. F3 的 turn 查表窗长：`SECURITY-CBP.md:38` 写「超出入站窗（§5 第 4 条的窗）」，而 §5.4
   定的是 60 帧/分的限流窗；量级上更像 rid 缓存的 300 秒（§5.1，`SECURITY-CBP.md:222`）。
   定哪个窗，影响 60004 的触发面与 `arrival` 向量，向量落地前必须先钉一句。
   —— 2026-11-17 已钉（工单二 F2，用户拍板：同源可调、缺省 300）：单一源
   `CBP-v1.json $defs/turnWindow`，两端经生成器读同一值，覆盖用 env
   `CORTICO_TURN_TTL_SECONDS`；rid 缓存 300/200 与 dedup 10 分钟各自不动。
   见文末「工单二 F2 · turn 保留窗同源」节。本条历史文本按台账纪律不改写，收口以本行为准。
3. 60008 `DEGRADED`（`packages/cortico-bridge-core/src/errors.ts:30`）在全部裁决之后仍无
   发射点：降级面全部走 `event{name:'degraded'}` 帧（F10）。维持「在册不用」，除非有人给它
   帧外场景。
4. `world.ts:204` 的 `rate_limited:` 文案没有 retcode 也没有 mnemonic（`errors.ts:8-31`、
   `spec/conformance.json:46-65` 均查无）；F15 的内核窗聚合走 degraded 而非该文案，两账要
   在向量改写时并轨。
5. `spec/conformance.json:564-569` 自带的 4 条 open_items（NapCat 重投递、koishi 端口、
   consent_policy sha、reply_tail 回调）本批未触碰；`SECURITY-CBP.md` §6 的 14 条做不到
   （:262-275）是能力边界，按该节自己的纪律「写成待办即违规」，此处只指路不展开。
6. `SECURITY-CBP.md` 引用的 `reports/*` 行号（如 `:156` 指 `reports/r-neko.md:106`）在
   本台账的证据边界之外，未逐条复验；凡本台账独立断言处，均已改用仓内文件或已抽查的桥侧
   行号（0 节末段列了抽查点）。

## N3 工具申报权威（2026-11-16）

- 帧表：未改。`hello.tools`/`ready.tools`/`catalog.tools[]`/`call.tool` 形状不动（`CBP-v1.json:108,499,671`）。
- 协商口径：固定下发型工具的可申报/可调用集 = `intersection(fleet 镜像, 对端已申报目录)`，与
  §5.5 caps 的 `intersectCaps` 同构。裁决正文见 `SECURITY-CBP.md` §7。
- fleet 行为变更：`packages/cortico-world-maibot` 在桥 `tools=[]` 期把 `maibot_send_message`、
  `maibot_streams` 从 `TOOL_DECLS`/`describe.json`/`ENV_PROMPT.md`/`peerToolCatalog` 移除；`runCall`
  对未申报能力本地判 60002，不发 call 帧。无 wire 变更、无迁移代价（这两支本就 60002）。
- conformance：未加向量（schema 校验器仍未落地，`SECURITY-CBP.md` §6-12）。跨仓咬合改由
  `packages/cortico-world-maibot/tests/hello-authority.test.ts` 直读桥 `client.py` 与 fleet 镜像，
  断言两侧申报名集合相等。
- 对端旧版兼容：旧桥仍发空 tools 时，新版 fleet 只是不再 advertise 未接线工具，不新增断连路径。

## 工单二 F2 · turn 保留窗同源（2026-11-17）

- 帧表：`$defs` 加 `turnWindow`（integer const 300，minimum 1）。它不是第 11 型帧，不进
  oneOf、不进任何帧；协议常量注记，F17「禁 mint 第 11 型」不受影响。
- 产物链（两份产物经两个现有生成器落，不许手抄）：`tools/gen_table.py` → 两桥
  `cbp_table.py` 的 `TURN_TTL_SECONDS`；`tools/gen_pins.py` → `spec/pins.json` 的
  `turn.ttl_seconds` → `cortico-bridge-core/src/pins.ts` 的 `PINS.turn.ttlSeconds`。
- 覆盖：环境变量 `CORTICO_TURN_TTL_SECONDS`（两端同名，秒，正数）。坏值回落台账值并记
  degraded（`turn-ttl-env-invalid`），不静默。上限 200 条沿用 §5.1 rid 缓存口径，不并入本窗。
- fleet 行为变更：`correlate.ts` 的 `TurnLedger` 默认窗从 dedup 600 秒改挂同源值
  （该文件原 shortcut 注记随之清账）；`cortico-world-neko` 的 `lastTurn` 补按窗过期（工单二 F2）。
- conformance：未加向量（无 wire 变更，帧形不变）。
- 闸：`tests/pins/turn-window-gate.test.mjs`（源=pins.json=gen_table 渲染输出=内核读数，
  一端改源不重生成即红）+ 两桥 `tests/test_table_parity.py`（盘上 `cbp_table.py` 与
  `render()` 逐字节）。桥侧两份盘上副本本批未重生成：neko 由 N8 工序跑
  `python -I tools/gen_table.py --repos cortico-bridge-neko`，maibot 走台账由该仓工序自跑
  （工单二边界：禁改名单）。重生成前 `--check` 会红，属设计内漂移信号。
- 对端旧版兼容：无 wire 变更。旧 `worlds.neko.token` 残键由装载一次性清理删除
  （工单二 F1），不涉及协议帧。
