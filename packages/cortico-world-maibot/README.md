# @horizoncloudy/cortico-world-maibot

Cortico 侧 MaiBot world 包：CBP v1 帧 over WS **监听端**，入站桥消息进事件库，
出站只经工具回执。帧编解码/传输/档位/段渲染全部复用内核
`packages/cortico-bridge-core`（`file:` 依赖，零复制逻辑；任务硬要求「禁止复制粘贴一份
转换逻辑」按此落地）。

工单：`_BUILD-PLAN.md` §2.3 行「`packages/cortico-world-maibot/`」+ §3.2 模板；
蓝图 §2.2/§2.3。证据只来自 `C:/Users/54301/tmp/botfw-compat-20261115/` 的
upstream 钉住仓（maibot `478f671e6`、maibot-plugin-sdk `f9984673d`）、
r-maibot.md 运行产物与 fleet 现有代码。

## 1. 硬要求：对接 capabilities，不建在 compat 门面上

MaiBot 的插件面有两层，本包（以及它对面的桥仓 cortico-bridge-maibot）只站在
**capabilities** 那一层。差异边界逐条如下，运行时口径全部出自 r-maibot.md
（安装件 `maibot==1.4.5` + `maibot-plugin-sdk==2.23.0`，wheel ≡ 钉住仓件，r-maibot §0）：

| 面 | 实测事实 | 出处 | 桥/本包用法 |
|---|---|---|---|
| capabilities | ctx 代理 24 个、能力名 103（宿主注册表 104，SDK 无孤儿名） | r-maibot §3、§10-2 | 唯一依赖面。`send.text`（`maibot_sdk/capabilities/send.py:27`）、`chat.get_all_streams`（`chat.py:57-59`）、`gateway.route_message`（`gateway.py:26-33`，返回 `bool` = `result["accepted"]` 已拆）逐名对接 |
| compat/apis | 公开函数 87 = direct_forward 30 / via_delegate 3 / raises 6 / **silent 48** | r-maibot §6 | **一律不得依赖**：48 个 silent 桩实测恒空（`get_all_streams→[]`、`count_new_messages→0` 等，r-maibot §6 逐值表） |
| compat 路径常量 | pip 安装态 `PROJECT_ROOT` 指向 `<venv>/Lib`、`PLUGINS_DIR` 不存在 | r-maibot §9 | 桥部署指引写死 `MAIBOT_INSTANCE_DIR`（`third_party_plugin_root()` 无它即 `RuntimeError`，`SP/src/common/paths.py:20-21`） |
| 授权执法 | 缺能力名 = 加载期硬拒「插件 {plugin_id} 未获授权能力: {capability}」 | `src/plugin_runtime/host/authorization.py:57-58 @478f671e6` | 桥 `_manifest.json` capabilities 由 `tools/manifest_scan.py` 生成（别的工单），本包工具名与之解耦 |
| gateway 两套命名 | weixin 内置适配器 manifest 声明 `gateway.route_message/gateway.update_state`，不在 cap.call 注册表 104 名内；网关实际走原始方法 `host.route_message` | r-maibot §7 | 桥固定用 `ctx.gateway.route_message`；`receive_external_message`/`update_runtime_state` 是旧名别名（`gateway.py:101-134 @f9984673d`），**不进词表白名单**（C1-18） |
| 原始 RPC 白名单 | `{cap.call, host.route_message, host.update_message_gateway_state}`，越界 `PermissionError` | `maibot_sdk/context.py:137-143 @f9984673d` | 证明「Runner 子进程从模型上就没打算让插件开服务」——所以本包是 listen 端、桥外拨（§2） |

一句话版：**真转发的只有 30 个函数、都藏在 capabilities 代理后面；compat 门面
87 个名字里 48 个是死桩。本包的调用面按能力名钉，不按 compat 函数名钉。**

## 2. 方向与帧面

- 传输：内核 `BridgeDriver` role `listen`，缺省 `127.0.0.1:39702`
  （`_BUILD-PLAN` §4.4 端口表、内核 `pins.ts:73 maibotListen:39702`；env
  `CORTICO_BRIDGE_MAIBOT_PORT` 是桥侧对位覆盖，装机以 doctor 扫描为准 R6）。
- 握手：桥 `dial` 进来发 `hello`，内核回 `ready`；caps 交集、版本门禁 60001 全在内核
  （`negotiate.ts`）。token 走 `?token=` 查询串，不符 close 4401（内核 driver 规则）。
- 本端申报 caps：`images files notices self_echo tools`。不申报 `buttons`（MaiBot 无按钮段）、
  `history_backfill`（v1 无断线补课，断线丢消息是设计内行为，蓝图 §6.1）。
- 桥侧发起的 `call` 帧 v1 一律回 `10002 unsupported_action`，不让对端挂到超时。

## 3. 归一化表（`src/normalize.ts`，键名逐字来自实测）

| 表 | 内容 | 出处 |
|---|---|---|
| 宿主 MessageDict | 17 键（`message_id…processed_plain_text`） | `src/plugin_runtime/host/message_utils.py:45-62 @478f671e6`（仓内路径；安装件同内容） |
| SDK MaiMessages | 15 字段（pydantic） | `maibot_sdk/messages.py:22-60 @f9984673d`；r-maibot §4 运行时枚举 |
| 宿主段型 | `text image emoji voice file at reply forward dict` 九支 | `message_utils.py:97-168 @478f671e6` |

映射规则（有单测逐条对表）：

- `text` 段的 `data` 是**裸字符串**（`:97-98`），不是 v11 的 `{text}`；`hostSegToCbp` 包形。
- `voice`→v11 `record`；`image/emoji` 的 `hash/binary_data_base64` 收进 `data.hash/base64`；
  base64 + 可判 MIME 才转 BlobInput，`modelFacts.accepts` 不过记 `model-rejects:<mime>`。
- `at`：`target_user_id→qq`、`cardname‖nickname→name`（`at` 参数名照 v11 用 `qq`，
  `segment.md:167 @d4456ee70`）；`target_user_id==='all'` → `{qq:'all'}`，宿主无 `atall` 键。
- `reply`：`target_message_id→id`。`forward`：宿主 data 是节点数组 → `{count,nodes(json)}`。
- 未知/非白名单型名照常出帧并记 `unknown-segment:<type>`；`[<type>]` 渲染兜底的
  唯一实现点在内核 `segment.ts`（C1-16），本包不重复造。
- **`raw_message` 同名不同义**：宿主侧 = 段列表（`:53`），SDK `MaiMessages.raw_message`
  = 原始对象（`Any|None`，`messages.py:45 @f9984673d`；compat 旧类是 `str|None`，r-maibot §4）。
  CBP `msg.raw` 恒留宿主 dict 原样，语义不许互相 cast（`_BUILD-PLAN` §3.2 maibot 行 + 硬规则 8）。
- 自发回声判据：`msg.sender.id === raw.account_id`（MessageDict `account_id` 即接收号）；
  命中 → 事件 `maibot.message.self` + `PushOptions{deliver:false}`。`pushEvent` 入参
  Omit 掉了 `contextDelivery`（`cortico src/core/types.ts:692-695 @836238311`），
  `deliver:false` 是唯一合法入口——这是对 §3.2 表原文「contextDelivery + deliver:false」
  双写的字段级修正，与 astrbot 先例 README §2 同断。

事件档位（内核 `envelope.ts` 落地）：`mention/direct→flush`；`group/other→缺省 debounce`
（`types.ts:633`）；`notice→piggyback`；`connection/degraded→flush + origin:'internal'`。

## 4. 工具面（describe.json 由框架 `exportDescribe` 生成，代码单源）

| 工具 | tags | 行为 |
|---|---|---|
| `maibot_send_message` | write, barrierAfter | egress 关→`60005 door_closed`；限流 ratePerMin（缺省 20/分）；开→ CBP call `maibot_send`，30s 无回执→`60007 send_uncertain` |
| `maibot_status` | read | 连接态 + caps 交集 + 对端 catalog + 降级清单 |
| `maibot_history` | read | 只查 `host.store`（source=maibot），不查对端 |
| `maibot_peer_call` | write, barrierAfter | 先本轮身份闸（无桥消息轮拒），再 catalog 闸；args 附带 `__turn`=本轮 msg 帧 id（CBP `call.args` 是无约束映射 §3.1，桥用它对位 `route_metadata`/`external_message_id`） |
| `maibot_streams` | read | 转 call `chat.get_all_streams`（能力名逐字；桥须在 catalog 报名并在 manifest capabilities 申报，否则加载期硬拒见 §1 表） |

## 5. 装载闸与自检（本机实测输出见 f-world-maibot.md）

```
npx tsc --noEmit                      # 全部 src+tests 类型闸
node --test tests/                    # 46 条（normalize 表 22 / world 壳 18 / 入口形状 6）
npx tsx tests/drymount-gate.mts       # 框架真闸 dryMountWorld + checkDescribe
npx tsx tests/drymount-gate.mts --regen  # 重导 describe.json（等价 pnpm describe:extension）
```

npm 通道：`--registry=https://registry.npmmirror.com --ignore-scripts`（本机 npmjs TLS 已知问题）。
依赖：运行时 `ws ^8.18.0` + `@horizoncloudy/cortico-bridge-core file:`；开发件 `cortico 0.2.15`（精确钉，
禁 latest）/typescript/tsx/@types。类型 import 全部 `import type`，运行期零框架 import。

## 6. v1 不承诺（与蓝图 §6.1 一致）

断线补课（无）、按钮/表情面板段（无对应型）、`send.image/emoji/...` 富出站
（桥 sender.py 属 ✗ 切片，第二周后）、`reply_tail` 类窄门（neko 专属，本包无）、
MaiBot 内部 `llm/maisaka/knowledge` 等其余 21 个 ctx 代理（本包只钉 §1 表里的名字，
新增引用先过 fleet 词表闸）。
