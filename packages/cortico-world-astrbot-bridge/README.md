# @horizoncloudy/cortico-world-astrbot-bridge（骨架）

AstrBot 侧 Cortico world 包的收编版骨架：Cortico 主动外拨 AstrBot 桥插件的 WS 服务，
入站桥消息进事件库，出站经工具回执。收编基准 `@horizoncloudy/cortico-world-astrbot @4725feee6`
（v1.3.4，2146 行存量），本包只做「帧协商位 + 骨架」增量，不是存量功能的完整替代。

所有结论按 `C:/Users/54301/tmp/botfw-compat-20261115` 证据链：蓝图
`_COMPAT-BLUEPRINT.md`、工单 `_BUILD-PLAN.md` §2.3 行
`packages/cortico-world-astrbot/`、运行产物 `r-astrbot.md`（AstrBot @133dd9f86）。

## 1. 入口形状（只用装载器认的形状）

- `package.json`：`"type":"module"`、`main: "./src/definition.ts"`、
  `cortico:{kind:"world", api:6, describe:"describe.json"}`。
  装载器按 exports→module→main→index.js 解入口（extensions.ts:130-141 @836238311）；
  模板件 main 直接指 `.ts` 文件即合法（d-cortico-side §4.3，onebot 包入口是 `.js` 也合法）。
- 默认导出必须过 `isWorldDefinition` = `id/label/defaults()/create()`
  四件（extensions.ts:143-150 @836238311）。缺一件 = 拒载。
- `defaults().enabled` 必须 false（dry-mount.ts:141-143 warn 闸；缺省关是装载惯例）。
- `create()` 纯：不连接、不读密钥、不 await（硬规则 1；先例 world.ts:8-10 注释同断）。
- `id` 沿用先例 `'astrbot'`（4725feee6 definition.ts:10）：`worlds.astrbot` 配置段、
  事件命名空间、记忆检索键跨版本连续。装本包前必须先卸旧包 —— 同 id 两个扩展并存
  会被撞 id 拒载（extensions.ts:399-405/415-419 @836238311）。

## 2. 事件档位（只用已核实的 TriggerMode 取值）

档位表 = _BUILD-PLAN.md §3.2；取值域 = cortico types.ts:612-628 @836238311
（`preempt|interrupt|flush|debounce|piggyback`），缺省语义「外部事件 debounce、
内部事件 flush」（:633）。

| CBP 帧 | 事件 type | PushOptions |
|---|---|---|
| msg kind=mention/direct | astrbot.message | `{trigger:'flush'}` |
| msg kind=group/other | astrbot.message | `{}`（缺省 debounce） |
| msg 自发回声 | astrbot.message.self | `{deliver:false}` |
| notice | astrbot.notice | `{trigger:'piggyback'}` |
| event name=connection | astrbot.connection | `{trigger:'flush'}`，origin internal |
| event name=degraded | astrbot.degraded | `{trigger:'flush'}`，origin internal |
| call/reply/ack/catalog/tick | 不产事件（in-flight 表 / 目录位 / driver 层） | — |

「自发只归档」的实现入口只有一个：`PushOptions.deliver:false`。
`pushEvent` 的入参类型 Omit 掉了 `contextDelivery`（types.ts:692-694），
World 不得直传该字段；宿主落库时把 `deliver:false` 翻成 `contextDelivery:'archive-only'`
（core.ts:519 @836238311）。——这是对 _BUILD-PLAN §3.2 表原文
「`contextDelivery:'archive-only'` + PushOptions `{deliver:false}`」的字段级修正，
语义不变、写法必须按宿主签名。

## 3. 帧协商位（收编先例的增量核心）

- 出 hello：CBP 头（`v/v_support/caps/tools/agent/id/ts`，_BUILD-PLAN §3.1 帧形）
  ∪ 旧私有帧字段（`v:1/token/name/capabilities`，4725feee6 driver.ts:417-423）。
  旧桥只查首帧 `t==='hello'` 与 token（37c1e6ccd bridge.py:330-341；
  非 hello close 4002、token 不符 close 4003），多余字段无害。
- 读 ready：`readVersionSupport` 兼容三态 —— `v_support` 数组直接用；
  只有标量 `v:1`（bridge.py:282 现网实值）按 [1]；两者都无按 [1] 放行
  （_BUILD-PLAN §2.3「旧 hello 无 `v:[..]` 按 v:1 放行」）。
- 版本支持集不相交 → 断连 + 60001，文案带两侧包名/版本/sha（蓝图 §2.1 协商行）。
- caps：对端 ready 带 `caps` 数组才进 CBP 面；旧桥无 caps → 交集空、
  `cbp=false`，出站帧退回旧形（send 的 conv 是 dict `{kind,id}`+顶层 text，
  bridge.py:459-462 实读），入站旧 msg 帧由 `legacyMsgToCbp` 收敛成 CBP 形。
- at_all 特判在 normalize.ts 一处：`{type:'at',data:{qq:'all'}}`。
  AstrBot `ComponentTypes` 25 键无 `atall`（components.py:1060-1086 @133dd9f86，
  台账 C1-5），任何一侧都不许发 `atall` 段型。

## 4. 两阶段升级说明

阶段一（本包，向后兼容读旧帧）：
1. Cortico 侧装本包（先卸 4725feee6 旧包，同 id 撞闸），桥端**不升级**。
2. 现网行为 = 旧私有帧语义 + hello 多带的协商字段被旧桥忽略；
   `astrbot_status` 报 `cbp:false`，功能位全关。旧桥 ack/tool-ack 照常关联。
3. 升级顺序固定：先 Cortico 侧、后桥端（_BUILD-PLAN §2.3「升级顺序先 Cortico 侧
   后对端」）。混跑窗每一帧都是回归面（蓝图 R3 / §5.3-3 真机卡，需单独授权）。

阶段二（桥端 cortico-bridge-astrbot 升级后）：
1. 桥 ready 开始带 `caps` 数组与（可选）`v_support`；本包自动进 CBP 面。
2. catalog 帧 / `tools` 帧双形兼容读已就位（driver.ts `tools` 分支）。
3. 旧私有帧端下线归阶段二收口（蓝图 §7 阶段二第 3 条）。

回滚：本包与旧包同 id、同配置段，卸本包、装回旧包即回到 1.3.4 线；
`worlds.astrbot` 段里本包新增的 `egress` 键旧包不读，无需清理。

## 5. 与 r-astrbot 导出面的对接点（对端 Python 插件按这些名字接）

全部逐字来自 `r-astrbot.md`（安装件≡仓库件，585 文件哈希零差；sha 底账 133dd9f86）：

| 对接点 | 锚 | 用/不用 |
|---|---|---|
| `from astrbot.api.event import filter`（显式子模块 import，属性直取 AttributeError） | r-astrbot §3 | 桥端装饰器入口 |
| `register_llm_tool` | star_handler.py:613 @133dd9f86 | 桥端暴露 `cortico_call` |
| llm_tool 函数参数缺任一类型注释 → 宿主 `raise ValueError(...缺少类型注释...)` | register/star_handler.py:665-668 | 桥端硬约束（本包无码可绕） |
| `register_button_action` | :278 | 阶段二补线（蓝图切片外） |
| metadata.yaml 必填 `("name","desc","version","author")`，`description` 兜底 desc | updater.py:28-30；star_manager.py:523-524 | 桥端清单 |
| `astrbot_version` PEP440 加载期校验 | star_manager.py:674 `_validate_astrbot_version_specifier` | 版本闸（下节） |
| senderKey = UMO `platform:message_type:session_id` | message_session.py:18-20 | normalize.ts |
| `ComponentTypes` 25 键、无 `atall`；`AtAll` 类无枚举成员 | components.py:1060-1086 | 段词表特判 |
| `MessageChain` 容器（无 IM 侧 `Message/MessageSegment` 类） | r-astrbot §4 | 桥端造链，本包不 import astrbot |

## 6. SDK 版本闸（两道，各管一头）

- Cortico 侧扩展 API：`cortico.api = 6`。装载硬闸 `api < expected` 拒
  （manifest.ts:23-27,143 @836238311）；过渡层 `PREVIOUS_CONTRACT_VERSIONS.world = 5`
  （previous-contract.ts:28-32）只保装载、不保 check —— `api === 5` 时
  check:extension 直接 fail 并要求升 6（extension-check 语义，d-cortico-side §6.2-3）。
  Node `>=22.16.0`（_BUILD-PLAN §4.3，qq-promax 顶高的 fleet 交集）。
- AstrBot 侧框架版本：桥插件 `metadata.yaml` 必须钉 `astrbot_version: ">=4.29.4,<5"`
  （_BUILD-PLAN §2.4 行；先例 37c1e6ccd 原文 `">=4.25.3"` 是旧窗，收编时改钉）。
  执法在加载期（star_manager.py:674），越界 = PluginVersionUnsupportedError、
  不加载。运行时基线 = 4.29.4 @133dd9f86 + py3.12 桶（r-astrbot §0）。
- 帧版本闸（60001）与上面两道是不同层：它只断 WS 连接、不动安装清单。

## 7. 面板与路由（只用核实存在的）

- 面板 RPC：`GET/POST /api/webui/providers/<pageId>/panels/<panel>/<method>`
  （server.ts:2342-2343 @836238311）；`pageId = world:astrbot`
  （EXTENSION_PAGE_KIND world→'world'，extensions.ts:47-51）。GET 只放行面板
  `getMethods` 白名单里的方法（types.ts:786-787）。本包只声明面板 `status`
  （id 合 `^[a-z0-9-]+$`，dry-mount.ts:66/204-207 闸）。
- WS 旁路 `/ws/providers/<pageId>/panels/<panelId>`（webui-protocol.ts:451-454）存在，
  本包未实现 `stream()` —— 没有需求，不留空壳。
- 不存在事件注入 webhook：`/api/events` 只 GET 读事件库（server.ts:1720）。
  所以桥消息入站的唯一门是本包 driver 主动外拨；面板 invoke 不是入站口，别指望它。
- 配置写回一律 `ctx.persist()` 深合并 `worlds.astrbot` 段（world.ts:47；
  ConfigGroup 键路径出段 = dry-mount fail，dry-mount.ts:47-63/217）。

## 8. 未做 / 不可验（诚实账）

- 存量先例的功能位未搬全：截图授权链（world.ts:36-39/741-747 先例段）、
  渠道防串台三件套（_BUILD-PLAN §8-2 明令单渠道别整套搬）、TTS/voice、
  image_errors 回显、会话清单上限、`astrbot_call_tool` 旧名兼容（旧名进环境提示词
  的历史引用靠 UPGRADE 文档，不造兼容壳）。
- 真机项全部未验：AstrBot 宿主没启动、桥插件没跑、QQ 没连（任务边界）。
  hello/ready 混跑、`astrbot_call_tool` turn 绑定、限流真实手感都在 §5.3-3 卡里。
- 内核 `@horizoncloudy/cortico-bridge-core` 未落仓：本包的 frames/negotiate/driver/segment 兜底
  是包内替身（文件头 `shortcut:` 已标），落仓后逐个改指内核。
- `spec/CBP-v1.json`、`spec/pins.json`、`tools/check_ext.ts` 属别的工单；
  本包验收命令 `npx tsx tools/check_ext.ts <本包>` 暂不可跑（工具件不存在）。
- 本包 caps 词表（`msg-v2/notice/peer-tools/catalog`）是本件起草：桥端对账前
  它是 INFERENCE，桥端工单引用它即升 FACT。

---

## 安全声明（2026-11-19 · 鉴权子协议已替换）

本包 **不声明任何 warning tag**，`cortico.tags` 里没有 `unsafe`；本包是 dial 侧、
自己不开监听口，监听面在框架侧 `cortico-bridge-astrbot`（Python 插件，非 Cortico 扩展）。

### 为什么可以撤回，以及为什么不能写 `safe`

`TAGS.md:40` 的「warning tag 一旦任一版本声明即保留」约束的是**已发布版本**。
上一轮给本包加的 `unsafe` 从未 git commit、从未 npm publish，没有任何版本带过红标，
撤回合法。`TAGS.md:42` 同时写明平台**没有 `safe` 标签**，标签缺席只代表
「未声明且未审查」；`TAGS.md:31` 规定词表外 tag 会被 `check:extension` 拒。
因此本包既不写 `"safe"`，也不自称已获 safe 认证——那是索引仓维护者审查后的状态。
本声明只交付**能力面收敛的可验证证据**。

### 双端怎么改的

| 项 | 旧 | 新 |
|---|---|---|
| 密钥来源 | `worlds.astrbot.token` 配置串 + 面板 | `ctx.secret('CORTICO_BRIDGE_TOKEN')` |
| 凭据通道 | hello 帧体 `token` 字段 | Upgrade 头 `Authorization: Bearer` |
| 缺密钥 | 空串照拨 | `start()` 直接拒拨（fail-shut） |
| URL 凭据 | 未校验 | `isCleanWsUrl()` 判脏即拒 |
| 框架侧监听 | 无 Origin 校验、默认免密钥 | 无密钥拒绑定、非环回 Origin close 4401、query 凭据拒 |

**破坏性迁移**：两端 `CORTICO_BRIDGE_TOKEN` 必须逐字相同；旧配置里的 `token` 项已删除，
升级后需在部署环境重新设值，否则服务拒绝监听 / 拒绝拨号。

### 验证证据

- `node --test "tests/*.test.ts"` 全绿（含新增鉴权硬闸）；`tsc --noEmit` 退 0。
- 框架侧 `pytest tests/ -q` 全量通过；平台 `check:extension` 通过。

- 这是作者侧的能力面收敛证据，**不等于**维护者已审查通过。
- 最终 `safe` 状态由索引仓维护者审查裁定（`TAGS.md:42`）。
