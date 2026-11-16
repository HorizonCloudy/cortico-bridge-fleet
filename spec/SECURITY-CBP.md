# SECURITY-CBP — 桥协议安全口径定稿

日期：2026-11-16。件主：`cortico-bridge-fleet/spec/SECURITY-CBP.md`。
作用域：Cortico Bridge Protocol v1（CBP v1）的十条帧型、四个 Cortico 侧 world 包、三个框架侧桥仓的安全裁决。
本件只定口径，不改代码。每条给四件：问题 / 决定 / 谁负责实现（文件） / 违反后怎么被测试抓到。

## 0. 证据口径与底账

- fleet 不是 git 仓，无 commit 面（`reports/_GATE-RUN.md:3` 判语）。fleet 内引用一律 `路径:行`，不带 sha。
- 上游/仓库件引用带 sha9，底账见 `spec/pins.json:15-156`（repos 段）与 `reports/00-ACQUISITION.md`。
- 发行包引用带安装版本：`n-e-k-o` editable `@52e973ed2`（宿主 0.9.1，`SDK_VERSION="0.1.0"`，Python 3.11.16）、`MaiBot==1.4.5 @478f671e6` + `maibot-plugin-sdk==2.23.0 @f9984673d`（3.12.14）、`astrbot==4.29.4 @133dd9f86`（3.12.14）、`nonebot2==2.5.0` + `nonebot-adapter-onebot==2.4.6 @8e0d1145a`（3.11.16）、`koishi 4.18.11 @97d5c3957`、`ws@8.23.0`（`packages/cortico-bridge-core/package.json:29` 钉 `^8.18.0`）、Cortico 本体 `repos/cortico@836238311`（0.2.15，world api 6）。
- 先例桥 `repos/astrbot-plugin-bridge@37c1e6ccd`（下文写作 `bridge.py` / `main.py`）是已上线的旧私有帧面。本件多处直接采用它的已验证形状，不新发明。

两条被推翻的旧说法，本件按现状写：

1. 「`CBP-v1.json` 由 ajv 2020-12 strict 加 `check.mjs` 校验」不成立。fleet 仓内没有 ajv，也没有任何跑向量的校验器。仓内现有的只是文本包含断言（`tests/frames/frames-segments.test.mjs:89-104`）。`ajv@8` + `check.mjs` 只存在于一次性取证环境 `C:/Users/54301/tmp/botfw-envs/spec-cbp/`，它不是门禁。见 §6 第 12 条与本件每节的「测试抓到」列。
2. `spec/CBP-v1.json:5` 的自述句「Every object in this schema closes with `additionalProperties:false`」按字面不成立。`seg.data` 是有意开的字符串映射（`CBP-v1.json:74-78`），`call.args` 是开的对象（`CBP-v1.json:211`），根 dispatcher 只有 `oneOf`、没有闭合（`CBP-v1.json:2-18`）。本件新增字段的闭合性逐条写明，句子里不得再用「全部闭合」。

---

## 1. `call` 帧的操作者身份（actor）

**问题。** `call` 现形为 `{v,t,id,ts,rid,tool,args}`（`spec/CBP-v1.json:203`、`_BUILD-PLAN.md:128`、`packages/cortico-bridge-core/src/frames.ts:112-120`、`C:/Users/54301/cortico-bridge-neko/cbp.py:26`）。帧里没有任何发起方位。四边的授权门都以发信人为准：AstrBot `PermissionType{ADMIN=1,MEMBER=2,GROUP_ADMIN=4,SHARED_GROUP_ADMIN=8}` 与 `register_permission_type`（`reports/r-astrbot.md:66,40`），先例已按发信人执法 `main.py:366-368`（`event.get_sender_id()` 比对 `admins_id`，`main.py:351-358`）。MaiBot 组件门是 `Tool(..., platforms=None, chat_scope='all', allowed_session=None)`（`reports/r-maibot.md:67`），未授权能力由宿主在加载期拒（`authorization.py:58`，`reports/_COMPAT-BLUEPRINT.md:84`）。v11 面有 8 个 permission 实例 `PRIVATE/PRIVATE_FRIEND/PRIVATE_GROUP/PRIVATE_OTHER/GROUP/GROUP_MEMBER/GROUP_ADMIN/GROUP_OWNER`（`reports/r-nonebot-onebot.md:147`）。N.E.K.O 的 consent 只拦首次加载，不拦桥转发的执行（`reports/_CRITIC-COMPAT.md:17`）。桥一律以插件自身身份执行，四边的 per-user 门禁形同虚设。onebot 线最直白：`onebot_call` 把全部 v11 动作摊给模型，写动作的门禁只看模型自报的 `confirm` 位（`packages/cortico-world-onebot-bridge/src/world.js:25-31,182-185`），`set_group_kick`/`set_group_ban` 就在那张表里（`src/catalog.js:41-42`）。

**决定。**

1. `call` 增两把必填位：`turn` 与 `actor`。定形
   `call = {v,t,id,ts,rid,tool,args,turn,actor}`，
   `actor = {platform, conv, member, anon}`。
2. 字段逐字定义：
   - `turn`：`$defs/frameId`（1..64，`CBP-v1.json:23-28`），值 = 触发本轮的那条入站 `msg` 帧的 `id`。先例已是同型做法：Cortico 侧把 `lastTurnMsgId` 随 call 发出，没有 turn 就拒（`packages/cortico-world-astrbot-bridge/src/world.ts:250-252`、`src/driver.ts:185-191`）。
   - `platform`：`string(1..64)`，宿主自报的平台名，逐字取宿主字段。AstrBot 取 UMO 首段（`platform:message_type:session_id`，`CBP-v1.json:35`、`reports/r-astrbot.md:134`），MaiBot 取 `MessageDict.platform`（`C:/Users/54301/cortico-bridge-maibot/mdict.py:17,58`），v11 线取 `message_type` 归一名，neko 线取 bus 记录 `source`（`C:/Users/54301/cortico-bridge-neko/watch.py:43,57`）。
   - `conv`：`$defs/conv`（`CBP-v1.json:34-39`）。
   - `member`：复用 `$defs/sender`（`{id,name}`，`CBP-v1.json:86-94`）。`id` 必须是宿主实证值：v11 `user_id`（`reports/r-nonebot-onebot.md:151`）、AstrBot `event.get_sender_id()`（`main.py:367`）、MaiBot `message_info.user_info.user_id`（`mdict.py:43-46`）、neko `metadata.user_id`（`watch.py:57`）。
   - `anon`：枚举四值 `["identified","anonymous","self","unknown"]`。判据：`member.id == self.id` → `self`。载荷带匿名位（v11 `anonymous` 字段/段，`reports/r-nonebot-onebot.md:151`）→ `anonymous`。宿主没给发信人 → `unknown`。其余 → `identified`。
3. 执法规则，按顺序：
   - 桥只用 `turn` 查自己的入站记录来定身份。线上 `actor` 只作对账用。两者不一致时以宿主记录为准，并回一条 `event{name:"degraded"}`，`data.reason = "actor-mismatch"`。
   - `turn` 查不到、或超出入站记录保留窗（窗长取 §5.1 的 rid 缓存口径，缺省对齐 `dedup.ts:14` 的 10 分钟），拒执行，回 `reply{ok:false,error:{code:60004,message:"unknown_session: turn 无对应入站记录"}}`。`60004` 是在册码（`packages/cortico-bridge-core/src/errors.ts:26`）。
   - 写动作的 `confirm` 只在 `anon=="identified"` 时生效。`anonymous`/`unknown` 的 turn 只允许只读动作。此条同时堵掉 `onebot_call` 自报 confirm 的洞。
   - 结构性缺字段（帧里根本没有 `actor`）在 `frames.ts` 的 `parseFrame` 判坏帧，走「吞帧 + `framesBad` 计数」老规则（`driver.ts:344-347`）。语义性缺身份（有字段、查不到）才走 `60004`。
4. `actor` 是对象、内部四键全闭合（`additionalProperties:false`）。`args` 保持开映射不变（`CBP-v1.json:211`），凭据剥除按 §3 第 5 条在 `args` 上同样适用。
5. 不做的事：不在 CBP 上定义跨平台的用户等价（同人不同平台不对账），不把 `actor` 当授权结果的保证（桥只转交身份，门由宿主自己执），不在 v1 做「以某人身份代理执行」的委托链。

**谁负责实现。**

- `spec/CBP-v1.json`：`$defs/actor`、`$defs/anon`、`call.required` 加 `turn`,`actor`。
- `packages/cortico-bridge-core/src/frames.ts`：`CallFrame`（:112-120）加两键，`parseFrame` 的 `case 'call'` 校验；`negotiate.ts` 不动。
- `packages/cortico-bridge-core/src/driver.ts`：`callTool()`（:205-215）加 `turn` 入参，由调用方传入。
- `packages/cortico-world-astrbot-bridge/src/world.ts:244-258` 与 `src/driver.ts:185-191`：已有 turn 位，改成同时发 `actor`。
- `packages/cortico-world-onebot-bridge/src/world.js:25-31`（`gateAction`）与 `:182-185`：`anon` 判定进门禁。
- 框架侧：`C:/Users/54301/cortico-bridge-neko/__init__.py:95-121`（call 分发两条门）加 turn→入站记录查表；`C:/Users/54301/cortico-bridge-neko/cbp.py:26` 与 `C:/Users/54301/cortico-bridge-maibot/cbp.py` 两份 vendored 副本同步（纪律见 `cortico-bridge-neko/cbp.py:1-6`：先改 spec 再同步副本）。MaiBot 侧在 `client.py` 新增 call 处理腿（当前只有入站腿，`client.py:46-66`）。AstrBot 侧桥仓尚未建（`reports/_GATE-RUN.md:40-49`）。
- `tools/vocab_gate.py`（`build_specs`，:146-171）：加 `anon` 四值与 `actor` 键名断言。

**违反后怎么被测试抓到。**

- `spec/conformance.json` 的 `frame_negatives` 加三条负例：`call_missing_actor`、`call_missing_turn`、`actor_extra_key_closed`（验 `actor` 闭合而 `args` 仍开）。`frames` 正例加一条带 `turn`+`actor` 的完整 call，逐字节 `wire` 钉住。
- `tests/frames/frames-segments.test.mjs:17-30` 的 `FRAME_REQUIRED.call` 由 `['rid','tool','args']` 改为 `['rid','tool','args','turn','actor']`。这条是文本包含断言，spec 一改它就红，改不动就红着——它的强度只到这里，见 §6 第 12 条。
- `packages/cortico-bridge-core/tests/frames.test.ts` 加正/负例各一条；`tests/driver-loopback.test.ts` 加一条端到端：不带 turn 的 `callTool` 必得 `60004`。
- `tests/envelope`/`world.test.ts`：astrbot 包补一条「`anon=="anonymous"` 的写动作被拒」用例（先例红绿面在 `world.ts:250-252` 已有同类）。
- `cortico-bridge-neko/tests/test_ingress_v2.py` 与 `cortico-bridge-maibot/tests/test_cbp_codec.py`：两份副本各自跑同一向量表，副本漂移即红。

---

## 2. `self` 声明（自发回声的身份来源）

**问题。** 回声抑制判定是 `sender.id == self.id`（`spec/CBP-v1.json:156` 的 msg 支描述、`spec/conformance.json:106` 的 `self_echo_rule`、内核实现 `envelope.ts:105`）。但 CBP 十型里没有任何一帧带 self：`hello` 必带键为 `{v,t,id,ts,agent,v_support,caps,tools}`（`CBP-v1.json:129`），`ready` 为 `{v,t,id,ts,caps,tools}`（`CBP-v1.json:144`），两侧 TS 形状同（`frames.ts:67-84`）。缺口在册：`reports/b-spec-cbp.md:45` 明记「帧形不带 self 位、ready 无 self 字段」，之后无件承接（`reports/_CRITIC-COMPAT.md:26-32`）。`caps` 词表里有 `self_echo`（`CBP-v1.json:41`、`negotiate.ts:12-23`、`conformance.json:44`），但没有任何帧内证据能证明申报方真的知道 self。内核把 `selfId` 做成 world 的可选配置位（`envelope.ts:83-84`），等于把它交给部署者手填。onebot 线已在带外自取：`driver.js:166-168` 拨 `get_login_info`，`:168` 取 `login.user_id` 存 selfId，`world.js:39,52-54` 用它判 `deliver:false`。koishi 线实测缺 `self_id` 时拿到的是字面串 `undefined`，判定不可用（`conformance.json:526-528`）。先例桥已有一整套正确时序：`ready_frame()` 带 `self:{id,name}`（`bridge.py:272-283`），初值空串（`bridge.py:127`），首条事件后由 `event.get_self_id()` 补上并立刻重推 ready（`main.py:370-381`，握手期没有身份就在 2 秒后再推一次，`bridge.py:291-293`）。

**决定。**

1. `hello` 与 `ready` 各加一把必填位 `self`。定形
   `self = {id, name, proven}`，`id: string(0..256)`、`name: string(0..256)`、`proven: boolean`。三键闭合。
2. `proven` 只允许由宿主实证位置真：v11 线 `get_login_info` 的 `user_id`（`driver.js:166-168`）、AstrBot 线 `event.get_self_id()`（`main.py:373`）、MaiBot 线 `internal_chat.identity` 能力（`reports/r-maibot.md:99`、`spec/pins.json:605`）。任何来自配置、部署者手填、或对端自报的值都记 `proven:false`。N.E.K.O 线本轮定死为 `proven:false`：bus 面只有读与 watch、无 publish（U1，`reports/_COMPAT-BLUEPRINT.md:238`），没有可实证的 bot 主键，取值口只能是会话 `role=="assistant"`（`ConversationGetArgs.role ∈ user/assistant/instruction/unknown`，`reports/r-neko.md:128`），那是启发式不是实证。
3. 时序，四条：
   - 桥侧发出的第一个握手帧必须带 `self`。桥拨出（neko、maibot）在 `hello` 带，桥监听（astrbot 线）在 `ready` 带。
   - `proven` 由假变真时必须重推该握手帧，不得等下一次自然重连（先例即如此，`main.py:379-381`）。
   - 同一条连接内 `self.id` 变化是协议违规。内核丢帧并回 `event{name:"degraded",data:{reason:"self-churn"}}`。换账号必须重连，见 §5 第 2 条。
   - `self_echo` cap 只能与 `proven:true` 同时出现。二者矛盾（报了 cap、没报实证 self）按 §1 的降级路数处置：丢该 cap、`degraded` 报 `self-echo:caps-lie`。
4. 拿不到时的降级口径。`proven:false` 时，world 必须照常按普通入站投递（不吞消息优先，规则同 `envelope.ts:129-131`），同时：
   - 发一条 `event{name:"degraded", data:{reason:"self-unknown"}}`，走 `<w>.degraded` flush 档（`_BUILD-PLAN.md:170`）。
   - `<w>.status` 与 ENV_PROMPT 常驻一位 `self-echo:off`（变量位形同 `astrbot.self`，`packages/cortico-world-astrbot-bridge/src/ENV_PROMPT.md:6,28-31`、`world.ts:187`）。
   - 禁止两种静默：禁止把全部入站塞成 `archive-only`（等于对用户失忆），也禁止不加声明地全量投递（回声环，`reports/_CRITIC-COMPAT.md:31` 的碎法）。降级必须是显式的。
5. 不做的事：不承诺 self 一定可得，不做跨桥 self 对照表，不在 v1 用启发式（昵称匹配）冒充实证。

**谁负责实现。**

- `spec/CBP-v1.json`：新增 `$defs/self`，`hello`/`ready` 的 `required` 各加 `self`。
- `packages/cortico-bridge-core/src/frames.ts`：`HelloFrame`/`ReadyFrame`（:67-84）加 `self`，`parseFrame`（:236-244）校验三键。
- `packages/cortico-bridge-core/src/driver.ts`：`Peer` 存 self（:85-92），`helloFrame()`/`readyFrame()`（:217-233）从选项带出，`onHandshakeFrame`（:366-394）做 churn 与 caps-lie 判定。
- `packages/cortico-bridge-core/src/envelope.ts`：`EnvelopeOptions.selfId`（:84）改由协商结果供给，配置值退为兜底并在缺时发 `self-unknown`（:105、:124-128）。
- world 侧：`packages/cortico-world-onebot-bridge/src/world.js:39-54`（已有 selfId 腿，改为读协商 self）、`packages/cortico-world-astrbot-bridge/src/driver.ts:56,336`（`peer.self` 已在旧私有帧里，接进 CBP self）。
- 桥侧：`cortico-bridge-neko/__init__.py:153-158`（hello 构造处）填 `proven:false`，`watch.py:32-65` 的 sender 侧照 §1 对齐。`cortico-bridge-maibot/client.py:39-44` 填 `internal_chat.identity` 结果。`cortico-bridge-neko/cbp.py`、`cortico-bridge-maibot/cbp.py` 两份 vendored 副本同步。
- `tools/vocab_gate.py`：把 `self_echo` 与 `self` 三键列入断言。

**违反后怎么被测试抓到。**

- `spec/conformance.json`：`frames` 正例的 hello/ready 全部补 `self`。`frame_negatives` 加 `hello_missing_self`、`ready_self_extra_key`、`self_echo_cap_without_proven` 三条。
- `tests/frames/frames-segments.test.mjs:19-22`：`FRAME_REQUIRED.hello/ready` 各加 `self`。文本包含断言，红在改动的第一时间。
- `packages/cortico-bridge-core/tests/envelope.test.ts:24-34`：现有的 self 用例补一条反面：不传 self 时 `push.deliver` 必须为 `undefined`（照常投递），且 envelope 侧出现 `self-unknown` 降级。这条同时锁死「默认抑制失败」两种写法。
- `tests/driver-loopback.test.ts`：加「握手无 self → 第二条 msg 来自同一 id 仍 deliver」与「ready 重推带 proven:true → 之后同 id 走 archive-only」两例。
- `cortico-bridge-maibot/tests/test_cbp_codec.py`：hello 帧形用例（该文件已含 hello 帧形断言，`reports/b-side-neko-maibot.md:54`）补 `self` 键。

---

## 3. 凭据流向

**问题。** 四处叠在一起。

1. 传输鉴权走 URL query。内核注释自述「dial sends it as a `?token=` query, listen rejects a socket whose query token does not match (close 4401)」（`packages/cortico-bridge-core/src/driver.ts:68-72`），取 query 的实现是 `tokenOf()`（:94-100），执法在 `server.on('connection')`（:259-262）。URL 会进代理日志、进 `emitState(String(e))` 的错误串（:244、:255、:296）、进运维截图。query 形式在生态里是现实存在的：NoneBot v12 官方测试就覆盖 query `access_token`（`reports/r-nonebot-onebot.md:282`），NapCat 类实现常把 token 拼进 ws url（`reports/_CRITIC-COMPAT.md:21`）。
2. 明文落盘。world 配置里 `token: ''` 是一个普通配置串（`_BUILD-PLAN.md:147-149`），astrbot 包实际持久化它（`packages/cortico-world-astrbot-bridge/src/config.ts:20,38,55,82-87`、`world.ts:152`），onebot 包同形（`src/config.js:29`）。Cortico 的 `persist()` 深合并写回 `config.json` 的 `worlds.<id>` 段（`reports/d-cortico-side.md:90`，源 `src/world.ts:47`，实现 :569-579）。Cortico 本身另有密钥通道：`ctx.secret(name)` 读部署目录 `.env`（`src/world.ts:43`，`reports/d-cortico-side.md:88`），`ctx.storeSecret(name,value)` 写同名行并以 `writeSecretFile` 落 0600（`src/world.ts:44-45`，实现 :598-600，权限在 `src/config-file.ts:21`；`reports/d-cortico-side.md:89`）。桥没用它。
3. 监听面。`listen` 缺省绑环回（`driver.ts:236` host 默认 `127.0.0.1`），pins 表两行也写「127.0.0.1 建议缺省」（`spec/pins.json:285,293`），但没有硬规则拦住非环回绑定。先例只发警告：无 token 且非环回时打一行「任何能连到这个端口的人都能接管桥」（`bridge.py:151-154`）。N.E.K.O 宿主自己的 MONITOR 48913 默认绑 `0.0.0.0`（`reports/r-neko.md:143`，源 `config/network.py:163`；台账 C1-8），说明「宿主面全环回」是错的假设。
4. `meta.raw` 恒留。硬规则要求原样保留（`reports/_COMPAT-BLUEPRINT.md:72`），内核照做（`envelope.ts:114-121`、`:147-151`，`raw` 在 schema 里是无类型约束的任意 JSON，`CBP-v1.json:20-22,168`），桥侧也照做（`cortico-bridge-neko/watch.py:65`）。同一时间 `envPromptVars()` 把连接态注入模型提示词（`packages/cortico-world-astrbot-bridge/src/world.ts:179-193`、`ENV_PROMPT.md:4-13`），而 `onebot_call` 把三个返回凭据的动作当只读立即放行：`get_cookies`、`get_csrf_token`、`get_credentials` 在目录里 `readOnly:true`（`packages/cortico-world-onebot-bridge/src/catalog.js:26-28`），只读=不问 confirm 直接跑（`world.js:25-31,182-185`），动作名本身在册（`spec/pins.json:762-764`）。三条线合流的结果：凭据可以从 raw 或动作回执进事件库、进提示词、再随请求出到模型服务商（`reports/_CRITIC-COMPAT.md:19-24`）。

**决定。**

1. 禁止凭据过 URL query。CBP 的共享密钥只走 HTTP Upgrade 头 `Authorization: Bearer <token>`。
   - 执法：`listen` 侧读头。头缺失或不符 → `close 4401`（码沿用 `driver.ts:260`）。URL 里出现 `token` 或 `access_token` 查询参数 → 直接 `close 4401`，不做比对，并在 `log` 记一条 `query-token-refused`（只记键名，不记值）。
   - 先例两处已是头形式：Cortico 侧对 NapCat 类实现走 `Authorization: Bearer`（`packages/cortico-world-onebot-bridge/src/driver.js:132`），NoneBot v11 反向 WS 用 Bearer 校验 access_token（`reports/r-nonebot-onebot.md:189`，源 `v11/adapter.py:318-329`）。本条把 CBP 对齐到同一条路。
   - 旧 AstrBot 私有帧把 token 放在 hello 帧体里（`bridge.py:340,549`，close 4003；CBP 侧兼容读在 `packages/cortico-world-astrbot-bridge/src/driver.ts:253-264`）。裁决：该形态只作为旧方言的兼容读保留，CBP 协商一旦成立（`hello.v_support` 命中），帧体 token 位必须不再被读、也不再被发。`_BUILD-PLAN.md` 与 `CBP-v1.json` 的「CBP frames carry no token field」规则升为硬约束（现仅在 `driver.ts:69-70` 注释里）。
2. 三则本地纪律，逐条钉死：
   - 环回：`listen` 的非环回绑定必须与一个非空 token 同时成立。token 为空且 host 不是 `127.0.0.1`/`::1`/`localhost` 时，拒绝 bind，`counters.listenErrors++`，`onState.lastError = "door_closed: loopback required"`。先例的警告升为硬拒。
   - 0600：Cortico 侧凭据一律走 `ctx.storeSecret()` / `ctx.secret()`（`src/world.ts:43-45 @836238311`，写盘 0600 在 `src/config-file.ts:21`）。`worlds.<w>.token` 这个配置串删除，配置面板项一并删。框架侧 Python 桥只从环境变量读（键名钉 `CORTICO_BRIDGE_TOKEN`），不落插件配置文件。确需落盘的（convmap 那类自建 KV，`cortico-bridge-neko/convmap.py`）文件权限必须 0600，且该文件不得在宿主可见目录树内。
   - 不落日志：`log()`、`onState.lastError`、`doctor` 输出、`framesBad` 记录里不得出现 token 值或带 query 的 URL。`emitState(String(e))` 三处（`driver.ts:244,255,296`）与 `attach`/`dial` 的 catch 必须先过 redact。
3. 提示词侧最小面。`envPromptVars()` 只允许输出状态串（连接、caps 交集、降级、self），不得输出 url、token、`raw` 的任何子串。现有变量表逐个过一遍（`packages/cortico-world-astrbot-bridge/src/world.ts:180-192`、`ENV_PROMPT.md` 全文）。
4. `meta.raw` 进模型前的剥除规则（`spec/CBP-v1.json:168` 的 `raw` 位与 `notice.raw` 同规则）。递归遍历对象与数组，命中即删键：键名大小写不敏感匹配 `token`、`access_token`、`secret`、`password`、`passwd`、`api_key`、`apikey`、`authorization`、`cookie`、`set-cookie`、`csrf_token`、`x-signature`、`signature`、`credentials`。对字符串值再做两件事：`[?&](access_)?token=` 之后的内容替换为 `<redacted>`，`scheme://user:pass@` 形态的 userinfo 替换为 `<redacted>`。剥除后仍保留原始事件的结构与非敏感字段（「恒留」规则的实现口径改为「恒留剥除后的原始载荷」）。同一规则对 `call.args`（`CBP-v1.json:211`，开映射）与 `reply.text` 生效。
5. 凭证型动作不进目录。`get_cookies`、`get_csrf_token`、`get_credentials` 从 `catalog.js` 摘除，`onebot_call` 命中这三个名字直接 `reply{ok:false,error:{code:10002,message:"unsupported_action: 凭证动作不进桥"}}`。`10002` 是在册码（`errors.ts:11`）。`get_status`/`get_version_info` 这类不含凭据的动作保留。
6. 不做的事：不做凭据轮换协议（v1 只支持重启生效，与先例 README 的 `x-hot:false` 口径一致，`config.ts:8`），不做多凭据/多密钥体系，不承诺剥除表能覆盖未知厂商键名（见 §6 第 7 条），不在 CBP 帧里搬「密钥迁移」（U3 明文口径不动，`reports/_COMPAT-BLUEPRINT.md:238`）。

**谁负责实现。**

- `packages/cortico-bridge-core/src/driver.ts`：删 `tokenOf()`（:94-100）换成 `authHeaderOf(req)`，:259-262 改读头并加 query 拒停；`dial()`（:272-303）传 `headers`；新增 `src/redact.ts`（键表 + 两串规则），`emitState` 出口接上。
- `packages/cortico-bridge-core/src/envelope.ts`：`msgToEnvelope`/`noticeToEnvelope` 的 `meta.raw` 赋值处（:114-121、:147-151）调 `redact()`。一处实现，四桥共用。
- `packages/cortico-world-astrbot-bridge/src/config.ts`：删 `token` 字段（:20,38,55,82-87），`world.ts:152` 改读 `ctx.secret('CORTICO_BRIDGE_TOKEN')`。onebot 包同改（`src/config.js:29`、`src/world.js:143`——那里的 `ONEBOT_TOKEN` 环境变量优先级保留，那是对的形态）。
- `packages/cortico-world-onebot-bridge/src/catalog.js:26-28` 删三行，`src/world.js` dispatcher 加名字闸。
- `spec/CBP-v1.json`：`blob`/`raw`/`args` 的 description 写明剥除口径，`conformance.json` 的 `rules` 段加 `raw_redaction` 与 `credential_actions_forbidden`。
- 桥侧：`cortico-bridge-neko/__init__.py:133-134,159`（`bridge_ws_uri` 不带凭据，`pins.py:46-48` 现拼法 `ws://127.0.0.1:port` 本就干净，锁住别加）+ token 改环境读取；`cortico-bridge-maibot/client.py:35-36` 同。两份 `pins.py` 与 `cbp.py` 副本同步。
- `tools/gen_pins.py` 的 `validate()`（:50-71）加两条：`ports` 表里 CBP 自家用口的 `bind` 必须是环回，`caps` 段（§4）与剥除键表一致。

**违反后怎么被测试抓到。**

- `packages/cortico-bridge-core/tests/envelope.test.ts` 加 raw 用例：`raw = {message_id:1, access_token:"abc", url:"ws://h?access_token=abc", nested:{Cookie:"x"}}` → 断言 `meta.raw` 里这三个键/串都不存在，非敏感键原样在。
- `tests/driver-loopback.test.ts` 加三条：带 `?token=` 的连接被 `close 4401`；带正确 `Authorization` 头的连接通过；`onState.lastError` 与 log 回调收到的串里不含 token 子串（用随机 token 值断言 `!includes`）。
- `conformance.json` 加负例向量 `hello_with_query_token_url`（帧体带 token）与 `raw_access_token_stripped`。注意：仓内当前没有能执行 schema 校验的器（§0 第 1 条），这两条要向 `tests/spec/` 里新增的向量校验器才真正咬得住。落地前，唯一真咬人的是上面两条 `node --test` 用例。
- `packages/cortico-world-onebot-bridge/test/world.test.mjs`：`onebot_call('get_credentials')` 必得 `reply.error.code == 10002`，且 `catalog` 列表长度断言同步（该文件现有 catalog 覆盖断言会因删三行而红，逼实现者显式改账）。
- `cortico-bridge-neko/tests/test_pins.py` 与 `cortico-bridge-maibot/tests/test_pins.py` 的端口字面量活闸（`reports/b-side-neko-maibot.md:72`）扩一条「URI 串不含 `token` 子串」。
- `tools/vocab_gate.py` 加禁名断言：三个凭证动作名进 forbidden 名单，与 `spec/pins.json:762-764` 对照。

---

## 4. 媒体与字节上限（单一来源）

**问题。** 同一个「这条消息能不能发出去」的问题，批评件数出五处互不折算的数字（`reports/_CRITIC-COMPAT.md:35`），加上内核吃缺省的 ws 帧上限是第六处，而且没有一处是唯一权威。

| # | 数字 | 口径 | 出处 |
|---|---|---|---|
| 1 | 524288 | N.E.K.O 宿主 message_plane 单条 payload | `MESSAGE_PLANE_PAYLOAD_MAX_BYTES`，`plugin/server/settings.py:588 @52e973ed2`，运行实测 `reports/r-neko.md:106` |
| 2 | 524061 | 上一条减去宿主信封余量 227 | `_HOST_ENVELOPE_HEADROOM_BYTES=227`，`plugin/core/context.py:247-252 @52e973ed2`，`reports/r-neko.md:106`。本地先拒已落码：`C:/Users/54301/cortico-bridge-neko/ingress.py:22-23,78-80`，向量已钉 `spec/conformance.json:112,413` |
| 3 | 8388608 | N.E.K.O 图片字节上限 `_IMAGE_MAX_BYTES=8 MiB` | `reports/r-neko.md:106` |
| 4 | 4784128 | N.E.K.O ZMQ 控制上链 `PLUGIN_ZMQ_CONTROL_UPLINK_MAX_BYTES` | `reports/r-neko.md:106` |
| 5 | 无 | CBP 线上 `reply.blobs[].b64` 只有 `minLength:1`，没有 `maxLength` | `spec/CBP-v1.json:113`（`reply.text` 反倒有 `maxLength:524288`，`CBP-v1.json:226`） |
| 6 | 104857600 | 内核两侧都没设 `maxPayload`，吃 `ws` 缺省。批评件说的「百 MiB 量级」经安装件复核成立 | `driver.ts:241`（`new WebSocketServer({host,port,path})`）、`:276`（`new WebSocket(url)`）；缺省值实测 `ws@8.23.0` 的 `node_modules/ws/lib/websocket-server.js:76` 与 `node_modules/ws/lib/websocket.js:699` 均为 `100 * 1024 * 1024`，判长处 `receiver.js:63,441,558`；原句 `reports/_CRITIC-COMPAT.md:35` |

三个次级口径同样没人折算：N.E.K.O `reply_tail` 的宿主硬限 `MAX_PAYLOAD_BYTES = 2 MiB`（`reports/r-neko.md:117`）、MaiBot 的上传上限根本不是常量而是每次由宿主回包声明（`SP/maibot_sdk/capabilities/files.py:74-75 @f9984673d`：`if size > info["max_bytes"]: raise ValueError("File exceeds the host limit")`；SDK 全树 grep `MAX_*_BYTES` 零命中）、onebot 线 Cortico 侧两处自定裁剪 `maxEventChars = 4000`（`packages/cortico-world-onebot-bridge/src/config.js:36`）与动作回执 20000 字符（同包 `src/world.js:196` 的 `capText(..., 20000)`）。先例桥另有 `MAX_IMAGE_B64 = 8 * 1024 * 1024`，判的是 base64 **字符串长度**（`repos/astrbot-plugin-bridge@37c1e6ccd bridge.py:50,79-80`），等于解码后 6 MiB，与第 3 行的 8 MiB 同名不同义。AstrBot 侧只量到图片**边长**默认值 `IMAGE_COMPRESS_DEFAULT_MAX_SIZE = 1280`（`core/utils/media_utils.py:41 @133dd9f86`，配置默认 `core/config/default.py:206`），字节上限本轮未测，且禁连 IM 后也测不到平台侧。蓝图 §5.3-5 的「512 KiB 分段、JPEG 归一 2048」仍是真机待办（`reports/_COMPAT-BLUEPRINT.md:227`）。base64 膨胀系数 4/3 无人折算，所以 neko 线的有效媒体上限实际约 391 KB 而不是 512 KB，还随 JSON 邻居键大小漂移（`reports/_CRITIC-COMPAT.md:33-38`）。

`spec/pins.json` 现在没有 caps 段（全文 842 行，只有 `repos`/`node`/`python_buckets`/`npm_pins`/`neko_sdk`/`ports`/`vocab`，`vocab.cbp` 只装 `tool_tags` 与 `frame_types`，`spec/pins.json:818-840`）。

**决定。**

1. 单一来源定为 `spec/pins.json` 新增顶层 `caps` 段。内核、四个 world 包、三个桥仓、`doctor.py`、词表闸一律从此取数，代码里不写媒体字节字面量（neko 桥现有的端口零字面量纪律同型，`cortico-bridge-neko/pins.py:1-13`）。
2. 形状，每条线四键，全为可空整数或字符串状态：

   ```json
   "caps": {
     "cbp":    { "frame_bytes": 524288, "text_bytes": 524288, "media_bytes": 8388608, "action": "reject" },
     "neko":   { "frame_bytes": 524061, "text_bytes": null,   "media_bytes": 8388608, "action": "reject" },
     "maibot": { "frame_bytes": null,   "text_bytes": null,   "media_bytes": null,   "action": "host-ask" },
     "astrbot":{ "frame_bytes": null,   "text_bytes": null,   "media_bytes": 6291456,"action": "reject" },
     "onebot": { "frame_bytes": null,   "text_bytes": 4000,   "media_bytes": null,   "action": "degrade" },
     "notes": {
       "neko_frame_bytes": "524288 - 227 = 524061（settings.py:588 / core/context.py:247-252 @52e973ed2）",
       "maibot_media_bytes": "宿主每次在 files.upload 回包里声明 max_bytes，SDK 无常量（capabilities/files.py:74-75 @f9984673d），禁写死",
       "astrbot_media_bytes": "沿用先例 MAX_IMAGE_B64=8MiB 的 base64 串长口径，折算解码 6MiB（bridge.py:50,79-80 @37c1e6ccd）；AstrBot 本体字节上限本轮未测",
       "onebot_media_bytes": "平台侧上限未测且禁连 IM，本轮记 null",
       "unit": "所有 media_bytes 均以解码后的原始字节计；发送方自己按 4*ceil(n/3) 折算 base64 长度并检查 frame_bytes",
       "unverified": "maibot/astrbot/onebot 的 frame_bytes 全为 null，属未测，不许当作无限"
     }
   }
   ```
3. 单位口径定死：`media_bytes` 说解码字节。线上比的是帧字节。发送方先算 `b64len = 4 * ceil(rawlen/3)`，再判 `b64len + 帧内其余键长度 <= caps.<线>.frame_bytes`。这条把第 2 节里那个「391 KB 还是 512 KB」的歧义一次消掉。
4. 内核必须显式设帧上限。`WebSocketServer` 与 `WebSocket` 两处补 `maxPayload: caps.cbp.frame_bytes`（现在吃 100 MiB 缺省，见问题表第 6 行）。超限时 `ws` 自己以 close 1009 断链（`node_modules/ws/lib/receiver.js:420,446,563` 实测三处），内核在 close 处理里记 `framesBad`，并回 `event{name:"degraded",data:{reason:"frame-over-limit"}}`。1009 不是 CBP 码，它是传输层事实。
5. 超限行为，三档，按方向定：
   - 出站且目的地已知：本地预拒，不发。回执 `reply{ok:false,error:{code:60003,message:"payload_too_large: N > M"}}`，`N`/`M` 必须是实测 caps 值。`60003` 在册（`errors.ts:25`）。形态沿用 neko 线已跑的向量（`conformance.json:413`）。
   - 出站且目的地只有宿主知道（MaiBot）：允许尝试一次，宿主拒即转 `60003`。MaiBot 的 `ValueError("File exceeds the host limit")`（`capabilities/files.py:75`）与 N.E.K.O 的 `payload_too_large` reason（`reports/r-neko.md:105`，互译 `errors.ts:53-54`）都落到同一码。不得重试第二次。
   - 入站且目的地表达不了（未知段、模型不吃该 MIME、线不支持该段型）：降级不拒收，正文保留、附件换成 `[image]` 类占位，并记降级位。词表三值：`media-over-cap:<线>`、`media-dropped:<mime>`、既有 `model-rejects:<mime>`（`packages/cortico-world-astrbot-bridge/src/ENV_PROMPT.md:30-31`）。
   - 分片：v1 不做。`reports/_CRITIC-COMPAT.md:35` 点名「长文本超单帧要不要分段根本没在任何工单里出现」，本件的裁决是不做，并把「超 524288 的长文不送达」写进 §6。
6. caps 段的形状必须与既有读取方对齐，否则「单一来源」是假的。现在同一个 `ports` 已有三种形状：`spec/pins.json:280` 是 23 元素的数组，内核视图是对象并靠 `owner` 正则回捞（`packages/cortico-bridge-core/src/pins.ts:35-40,70-75,96-106`），两个 Python 桥要求 `pins["ports"]` 是以口名为键的对象、拿到数组就 `RuntimeError`（`cortico-bridge-neko/pins.py:37-39`、`cortico-bridge-maibot/pins.py:38-39`；它们的测试用对象夹具自洽，`cortico-bridge-neko/tests/support.py:20`）。裁决：`caps` 用**以线名为键的对象**，且这次改 `ports` 形状问题时 `gen_pins.py` 的 `validate()`（`tools/gen_pins.py:50-71`）必须同时校验三种读取方的期望，缺一条即 exit 非零。

**谁负责实现。**

- `spec/pins.json`：新增 `caps` 段（形状见上）。
- `tools/gen_pins.py`：`validate()` 加 caps 分支（键集完整、`null` 必须配 `notes` 说明、`action` 限定三值），`--self-test` 加一组坏 caps 反例（现有自检在 :113）。
- `packages/cortico-bridge-core/src/pins.ts`：`Pins` 接口加 `caps`，`loadPins()` 映射；`PINS` 快照同步。
- `packages/cortico-bridge-core/src/driver.ts`：`listen()`（:241）与 `dial()`（:276）设 `maxPayload`。
- `packages/cortico-bridge-core/src/segment.ts`：出站编码处按 caps 预检并产出 `media-over-cap` 降级项。
- 桥侧：`cortico-bridge-neko/ingress.py:22-23,78-80` 的字面量改读 caps；`cortico-bridge-neko/pins.py` 与 `cortico-bridge-maibot/pins.py` 各加 `cap_of()`；MaiBot 出站腿按 `action:"host-ask"` 实现一次尝试；`packages/cortico-world-onebot-bridge/src/config.js:36` 的 `maxEventChars` 收编进 caps 读数。
- `tools/manifest_scan.py` 的端口/常量扫描纪律（`reports/b-side-neko-maibot.md:72`）扩到媒体字节字面量。

**违反后怎么被测试抓到。**

- `spec/conformance.json` 的 `errors`/`degrade` 组加向量：b64 恰界通过、超 1 字节拒、text 超长拒且不分片、未知 MIME 走降级。逐字节 `error_wire` 钉死。
- `packages/cortico-bridge-core/tests/driver-loopback.test.ts` 加一条：投一条超 `maxPayload` 的帧，断言连接被断且 `counters.framesBad` 增长，而不是静默吞下。
- `packages/cortico-bridge-core/tests/pins.test.ts`（现有 5 组用例，见 :6-32）加 caps 完整性用例，并把 `loadPins` 对真实 `spec/pins.json` 的映射断言扩到 caps。
- `tests/pins/pins-selftest.test.mjs` 加一条：`caps` 的键集与 `vocab.cbp.frame_types` 一样是封闭表，多键少键都红。
- `PY312M -I tools/gen_pins.py --check` 与 `PY312A -I tools/vocab_gate.py --self-test` 在 caps 漂移时非零退出（命令实跑记录见 `reports/_GATE-RUN.md:100-103`）。
- 两个 Python 桥的 `tests/test_pins.py` 各加一条媒体字面量 AST 扫描（端口扫描的现成写法直接复用），任何 `524288` 类裸数出现即红。
- 未测的三条线（maibot/astrbot/onebot 的 `frame_bytes`）不许用测试掩盖：向量只跑 `caps.*.action` 声明的行为，实测数字仍记 `UNVERIFIED`，装机窗口补（`reports/_COMPAT-BLUEPRINT.md:227` §5.3-5）。

---

## 5. 五项快判（每项一句决定、一句不做）

**5.1 出站幂等与 ack 责任。**
问题：去重是进程内 TTL 表，上限 200、无持久化（`packages/cortico-bridge-core/src/dedup.ts:12-14`，`reports/_CRITIC-COMPAT.md:42` 记 grep 无 persist），只防平台重投不防自己重启。`call→reply` 30 秒超时翻 `60007`（`correlate.ts:88-90`、`errors.ts:29`），而 `closeAll` 的注释直接把重试责任甩给调用方（`correlate.ts:82-84`）。`ack` 帧在册无契约（`CBP-v1.json:187-199`；`_BUILD-PLAN.md:171` 只说它「走 tools in-flight 表，不产事件」）。先例已有可抄的实现：rid 命中缓存直接回上次结果、TTL 300 秒、上限 200（`bridge.py:65-66,425-449`，`_handle_send` 的缓存分支 `:451-458`）。
决定：出站幂等键就是 `call.rid`，框架侧照先例落 rid→回执缓存（TTL 300 秒、上限 200），同 rid 重投只回缓存不再发；`ack` 定义收窄为「入站接收回执」，桥收到 `msg`/`notice` 并在本地落定后发一次，不代表任何出站投递成功。
不做：不做跨进程重启的幂等账本（重启后窗内重投可能双发，`ENV_PROMPT.md:20` 那句「60007 先确认再重试」是唯一的兜底），不做 exactly-once。
实现件：`correlate.ts`（加缓存语义或新 `src/idempotency.ts`）、`cortico-bridge-neko/__init__.py:95-127`、`cortico-bridge-maibot/client.py`、`driver.ts` 的 `handleRaw`（:355-358 现在是「未匹配的 ack 也交给消费者」）。
测试：`conformance.json` 加「同 rid 两次 call → 只产一次副作用」向量；`driver-loopback.test.ts` 加断开-重连-重放同键用例；`cortico-bridge-neko/tests/test_entry_contract.py` 加双发反例。

**5.2 多账号命名空间。**
问题：`conv` 是自由串、无账号维（`CBP-v1.json:34-39`），配置面只有一个 `url` 加一个 `token`（`_BUILD-PLAN.md:147-149`），而 listen 侧来者不拒、`send()` 广播给所有 ready 对端（`driver.ts:258-264`、`:187-202`）。框架侧本来是分账的：NoneBot 重复 `X-Self-ID` 直接 `close 1008`（`reports/r-nonebot-onebot.md:192`，向量 `conformance.json:506`），Koishi 适配器按 self_id 分 Bot，MaiBot 的 `MessageGateway` 带 `account_id` 位（`reports/r-maibot.md:67`，桥侧现为空串，`cortico-bridge-maibot/plugin.py`）。先例已有单会话替换策略：新连接顶掉旧连接并清 rid 缓存（`bridge.py:344-360`）。
决定：一条 CBP 会话 = 一个账号。listen 角色（neko/maibot 线在内核 world 侧、astrbot 线在桥侧）最多保留一个 ready 会话，第二条连接顶掉旧的并清 rid 缓存（照 `bridge.py:344-360` 的做法写进 spec，并沿用 §2 的 `self.id` 作为该会话的账号标识），world 侧对 `actor.conv` 校验「本会话见过的 conv」集（现成结构 `packages/cortico-world-astrbot-bridge/src/world.ts:131` 的 `seenConvs`），没见过就 `60004`。
不做：不在同一会话里做账号路由，不共享两账号的历史（`conv` 与 `senderKey` 的字符串形状不改，`config.ts:12-13` 的部署连续性优先），不校验跨账号的 `message_id` 引用。
实现件：`driver.ts`（连接数策略 + close 码）、`spec/CBP-v1.json` 的 `self` 描述、`cortico-bridge-{neko,maibot}/` 的会话登记、`cortico-world-onebot-bridge/src/config.js` 的 `wsUrl` 单值口径说明。
测试：`driver-loopback.test.ts` 加第二条连接顶掉第一条的断言；`world.test.ts` 加「未见过 conv 的 actor 被拒」；`conformance.json` 加 `duplicate_self_id` 的 close 向量（v11 面已有，`:506`，CBP 面对齐一条）。

**5.3 撤回与编辑映射。**
问题：`notice.kind` 是无词表自由串（`CBP-v1.json:182`）。onebot 线把 recall 当 notice 顺带上报（`packages/cortico-world-onebot-bridge/src/world.js:106`），`delete_msg` 的回执自己注明「ok 只代表撤回包已发出」（`world.js:193-194`）。neko 与 maibot 两条线连「有没有撤回概念」都没取证（`reports/_CRITIC-COMPAT.md:56`）。Cortico 侧无从失效：`store` 是只读面（`reports/d-cortico-side.md:28`，源 `types.ts:712`、`EventStoreReader` 170-177），落库只有 append（`repos/cortico@836238311 src/core/event-store.ts:203-204`）。
决定：`notice.kind` 收最小词表三值——沿用宿主在册叶名 `group_recall`、`friend_recall`（`reports/r-nonebot-onebot.md:123`、`spec/pins.json:783-784`）加一个新词 `message-edited`。撤回与编辑帧必须带被作用消息的 `platformMsgId`（`envelope.ts:118` 的现成键），world 落一条 `contextDelivery:'archive-only'` 的墓碑事件，引用原 `platformMsgId`，唤醒档走 piggyback。
不做：不删也不改已入库事件，不承诺模型不再复读撤回前内容，不承诺平台真的撤成功。
实现件：`spec/CBP-v1.json` 的 `notice.kind`、`conformance.json` 词表、`envelope.ts` 的 notice 支（:134-153）、四个 world 的 notice 映射表、`cortico-bridge-neko/watch.py` 与 `cortico-bridge-maibot/observer.py` 的入站腿。
测试：`conformance.json` 加「recall 后对原消息的引用」正例与「kind 不在词表且不是宿主叶名 → degraded」负例；`envelope.test.ts:35-36`（现有 `kind:'recall'` 用例）扩成墓碑断言；`tools/vocab_gate.py` 钉词表三值。

**5.4 入站限流与退避。**
问题：限流只写在世界层 `<w>_send_message` 的缺省 20/分（`_COMPAT-BLUEPRINT.md:92`），实测只有 astrbot 包落了实现（`world.ts:135,204,408-413`，配置 `config.ts:23-24,40,95-102`），内核与 onebot-bridge 无对等物。入站方向零防护：`pushEvent` 无界灌（`driver.ts:363` 直达 `onFrame`）。N.E.K.O 的 `backpressure` reason 翻成 `60006` 之后没人降速（`errors.ts:49-52`），退避表只治重连不治消息速率。
决定：内核加入站定窗（写法直接镜像 `rateAllowed`，缺省 60 帧/分/会话），超限丢帧并 `counters.inboundDropped++`，每窗聚合一条 `event{name:"degraded",data:{reason:"inbound-rate"}}`。退避方向闭环：egress 收到 `60006` 或 `neko backpressure` 即暂停出站 30 秒再试（窗长取现成的 `CALL_TIMEOUT_MS = 30000`，`driver.ts:34`）。
不做：不做逐会话公平排队，不做模型 token 预算联动，不感知平台侧频控（NapCat 静默丢仍只归 `60007`/`20002`）。
实现件：`driver.ts` 的 `DriverCounters`（:45-53）与 `handleRaw`、`packages/cortico-world-astrbot-bridge/src/world.ts:408-413` 的窗口件下沉到内核、`cortico-bridge-neko/ingress.py:97`。
测试：`driver-loopback.test.ts` 加 1k 帧突发用例（断言丢帧计数与一条聚合 degraded，而不是 1k 条）；`world.test.mjs`/`world.test.ts` 加 `60006` 后暂停窗口断言；`conformance.json` 加 `inbound-rate` 降级向量。

**5.5 乱序与时钟。**
问题：`ts` 是发送方墙钟 float64 秒（`CBP-v1.json:29-33`、`_BUILD-PLAN.md:117`），进 Cortico 只翻 ISO 展示（`envelope.ts:76-79`）。AstrBot 线的桥在对端公网上，两机墙钟差分钟级是常态（`reports/_CRITIC-COMPAT.md:89-94`，先例自述「服务器有公网地址、本机没有」`repos/world-astrbot@4725feee6 src/driver.ts:1-9`）。`<w>_history` 按什么排没人定（现件只查库、`limit` 上限 100，`world.ts:233-242`）。去重窗吃本地钟（`dedup.ts:14,33`）。
决定：排序键就是 Cortico 落库游标（现状已是：`event-store.ts:203-204` 的 `cursor: this.next++`，分片按 cursor 排、`:140-141` 的注释明说墙钟 run id 不是序，`scanRange` 按 cursor 升序返回 `:296-299`），`ts` 降为纯展示字段，内核加钟差探测：`|frame.ts*1000 - now| > 120000`（沿用 `IDLE_TIMEOUT_MS`，`driver.ts:33`）即记 `degraded` 位 `clock-skew:<±Ns>`，帧照收不丢。
不做：不做 NTP 校时、不做跨桥全序、不重排已入库事件、不用 `ts` 当去重或限流的窗。
实现件：`envelope.ts`（ts 转换处加 skew 判定）、`driver.ts`（degraded 上报）、`spec/CBP-v1.json` 的 `ts` 描述补一句「展示用，非排序键」、`spec/conformance.json` 加「ts 倒挂入站仍按到达序入库」向量。
测试：`envelope.test.ts` 加两条：`ts` 倒挂的两帧不改变到达序断言、超 120 秒 skew 触发 degraded；`conformance.json` 的 envelope 组扩「到达序 ≠ ts 序」正例。

---

## 6. 本协议做不到

以下是能力边界，不是待办。写成待办即违规。

1. 做不到让框架按「谁在说」执法。桥只能把 §1 的 `actor` 交给宿主的门。门本身是否在运行期执法由宿主决定：N.E.K.O 的 consent 只拦首次加载（`reports/_CRITIC-COMPAT.md:17`），MaiBot 的 capabilities 白名单在加载期执法（`authorization.py:58`，`reports/_COMPAT-BLUEPRINT.md:84`），AstrBot 的门在装饰器上（`reports/r-astrbot.md:40`）。宿主没门，桥补不出来。
2. 做不到撤回已投递给模型的内容。Cortico 的事件面是只读加 append（`types.ts:712` 与 `event-store.ts:203-204 @836238311`）。撤回只能留墓碑。
3. 做不到 exactly-once。`60007 send_uncertain` 的语义就是「不确定」（`errors.ts:29`、`correlate.ts:88-90`），幂等靠 §5.1 的进程内 rid 缓存，重启即失效。
4. 做不到跨框架的同人对账。`member.id` 是各平台自有的不透明主键：v11 `user_id`（`reports/r-nonebot-onebot.md:151`）、MaiBot `person.get_id`（`spec/pins.json:625`）、neko `metadata.user_id`（`cortico-bridge-neko/watch.py:57`）。三者之间没有 CBP 层的等价关系（关系目录不跨框架，U2，`reports/_COMPAT-BLUEPRINT.md:238`）。
5. 做不到带 URL 或句柄过桥。媒体只有 base64 一条路（`CBP-v1.json:106-115`，U7 句柄不过桥），N.E.K.O 的外部 URL 图在宿主侧直接拒（`reports/_COMPAT-BLUEPRINT.md:83`）。
6. 做不到断线补课。`history_backfill` 恒 false（`reports/_CRITIC-COMPAT.md:82`，蓝图 §6.1），重连后离线窗内的消息不追。
7. 做不到凭据剥除的完备性。§3 的表是键名匹配。未知厂商的键名、图片隐写、把 token 抄进正文的自发行为，剥不掉也不负责剥。
8. 做不到 Windows 上的 0600。POSIX 权限位在本机不成立，`.env` 的 0600 依赖宿主实现（`src/config-file.ts:21 @836238311`）。本件只能承诺写入走 `storeSecret`，权限强度按宿主实现为准。
9. 做不到 neko 线的实证 self。bus 面只有读与 watch、无 publish（U1），取值口只有会话 `role=="assistant"` 这类启发式（`reports/r-neko.md:128`）。该线永久 `proven:false`。
10. 做不到长文本分片与富媒体重编码。超帧的长文按 §4 第 5 条直接拒。512 KiB 分段与 JPEG 归一 2048 仍是真机待办，不在协议承诺内（`reports/_COMPAT-BLUEPRINT.md:227`）。
11. 做不到平台侧限流感知与回执。NapCat 类实现的静默丢、双投、方言重发都落在 `60007`/`20002` 之后（`reports/_CRITIC-COMPAT.md:77-80`，`reports/_REALITY-LEDGER.md` §2 缺列：真 NapCat 方言与 `message_id` 双投因禁连 IM 未取证）。
12. 做不到「协议违规一定会被 CI 抓到」。仓内没有 schema 校验器，向量文件在 `spec/conformance.json` 里躺着而没有执行件（§0 第 1 条）。本件每节的「测试」列里凡是依赖 schema 判帧的条目，都要等一个 `tests/spec/` 校验器落地才真正咬得住；在那之前，能咬人的只有 `node --test` 的文本包含与行为断言（`reports/_GATE-RUN.md:69-75` 的 128 绿即为此现状的账）。
13. 做不到未起宿主的执法验证。加载期硬闸（neko `SDK_VERSION` 闸、MaiBot capabilities 拒载、reply_tail 真回调、`route_key` 并发）在 CI 全盲（R4，`reports/_COMPAT-BLUEPRINT.md:247`；「锁不住的」全集口径见同件 §5.4，`reports/_COMPAT-BLUEPRINT.md:232`）。本件对这些只定口径，不定「已验证」。
14. 做不到 MaiBot、AstrBot、OneBot 三条线的媒体字节实测值。`caps` 段里它们就是 `null`（§4 第 2 条），原因是本轮禁连宿主与 IM，且 SDK 无常量可取。写任何数字进这三格都算造假。

---

## 7. 工具申报的协商权威（N3）

**问题。** `cortico-bridge-maibot/client.py:56` 的 `hello()` 申报 `tools=[]`（发信腿属阶段二工单，零可达工具零申报），但 `packages/cortico-world-maibot/src/world.ts` 仍把 `maibot_send_message`（:86）与 `maibot_streams`（:140）写进能力目录与提示词，并在处理器里无条件 `runCall('maibot_send')`（:279）、`runCall('chat.get_all_streams')`（:327）。两侧各说各话：Cortico 替桥答应了桥没实现的能力。这正是 §2.3-4 `self-echo:caps-lie` 的反面同类——申报与兑现不一致。

**决定。**

1. 协商权威只有一侧：对端 `hello.tools` 与 `catalog` 帧申报的能力目录是真值来源（`CBP-v1.json:499` 已规定「call.tool 必须在 ready/catalog tools[] 申报，否则 60002」）。Cortico 不得另立一份「我以为对端有」的名单。
2. 固定下发型工具（其唯一作用是替对端跑一个 CBP 能力）的可申报与可调用集合 = `intersection(fleet 镜像 PEER_CAPABILITIES, 对端已申报目录)`。交集外的工具既不进能力目录（`tools()` / `describe.json` / `peerToolCatalog`），也不进提示词，更不允许下发。这与 §5.5 caps 的 `intersectCaps(ours, theirs)`（`negotiate.ts:32-35`，koishi `do-not-copy.md:12` 钉的唯一实现点）同构：协商取交集，缺一即整支关闭，不留到调用时逐试。
3. 下发口收一道闸：`runCall` 对未申报能力名本地判 `60002 capability_unavailable`，绝不发出 call 帧。删掉「桥没申报却仍然下发」这条通路。`peer_call` 也走同一条闸——它本就是动态名单的逃生口，只放行对端当场申报过的能力。
4. 桥 `tools=[]` 期，`maibot_send_message`/`maibot_streams` 两支从 fleet 能力目录与提示词中移除。桥一旦在 `hello.tools` 申报某能力，先改桥、再把对应固定工具加回 `world.ts TOOL_DECLS`、`describe.json`、`ENV_PROMPT.md` 并同步 `PEER_CAPABILITIES` 镜像；两侧不同步即被闸拦。

**不选「fleet 为准、桥补实现」的理由。** 事实来源在桥侧的 SDK 能力面，不在手写名单（纪律 2）。桥 `client.py:88` 收到未实现的 call 一律回 60002，已自证它不提供这些能力。若反过来要桥补发信腿，那是阶段二工单（`client.py:54` 注明 `sender.py`），禁起宿主/连 IM 的纪律下无法取证，等于让 fleet 的猜测去驱动桥的实现。协商权威必须落在唯一可核验的一侧=桥的实际申报。

**实现件。** `packages/cortico-world-maibot/src/world.ts`：`PEER_CAPABILITIES`（桥申报镜像，随 `client.py` 同步）、`PEER_CAPABILITY_OF`（固定工具→能力名映射）、`fixedCallable`/`isAnnounced`（交集闸）、`runCall` 的 60002 本地闸、`peerToolCatalog`/`tools()`/`TOOL_DECLS` 由交集派生；`describe.json`、`src/ENV_PROMPT.md` 删两支未接线工具。桥侧 `client.py`、内核 `driver.ts`/`negotiate.ts` 不动（`driver.ts` 被 koishi `docs.test.mjs` 按内容哈希钉死，且发信腿不在本轮工单）。

**违反后怎么被测试抓到。** `packages/cortico-world-maibot/tests/hello-authority.test.ts` 同时读桥 `client.py` 的 `hello()` `tools=` 与 fleet `PEER_CAPABILITIES`，断言两侧集合相等（桥空则 fleet 必须空）。`world.test.ts` 加「未接线两支不进目录/清单/提示词」「未申报下发判 60002 不发帧」「catalog 申报后 peer_call 才放行」三条。
