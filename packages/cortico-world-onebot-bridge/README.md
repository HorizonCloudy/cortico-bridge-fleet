# cortico-world-onebot-bridge

Cortico 侧的 **OneBot v11 world 包骨架**。它是一条正向 WebSocket 客户端，连到任意
OneBot v11 实现（NapCat、SnowLuma、LLOneBot、Lagrange 等），把对端消息与事件投进
Cortico 事件库，并暴露一个通用 action dispatcher 让模型回话。

这是骨架：结构、契约与覆盖面齐全，出站只到 action 层，图片下载 / WebUI / 实现方言
目录同步留待完整实现。它**只承诺 v11，不承诺 v12**。

## 覆盖面（钉自本次运行产物）

| 面 | 数量 | 证据 |
|---|---|---|
| 公开 action | reality 38，目录实发 35（读 16 / 写 19；凭证三动作按 SECURITY-CBP §3.5 摘除） | `r-nonebot-onebot.md:133`，nonebot-adapter-onebot 2.4.6 @`2450b67a1` |
| 事件叶子 | 17（message 2 / notice 11 / request 2 / meta 2） | `r-nonebot-onebot.md:121-126` |
| 线上消息段 | 20 | `r-nonebot-onebot.md:141` |

目录在 `src/catalog.js`，是 v11 标准面快照（凭证动作除外，见下）。实现对端多出的扩展 action（如 NapCat 的
`send_private_forward_msg`）不在快照里，`onebot_call` 按写动作处理（仍过身份闸与 `writePolicy`）。
`get_cookies` / `get_csrf_token` / `get_credentials` 不进目录也不透传：名字闸直接回
`10002 unsupported_action`（`SECURITY-CBP.md:125`）。v12 草案（31 动作、
无 request 细分、无合并转发与群管控）不实现，见蓝图 §2.2 R12。

## 装载契约

`package.json` 的 `cortico` 块：

```json
{ "kind": "world", "api": 6, "displayName": "OneBot Bridge",
  "tags": ["qq", "onebot", "onebot-v11"], "describe": "describe.json" }
```

`api` 必须精确等于当前锚 `6`（`repos/cortico/src/extensions/manifest.ts:24 @836238311`），
写上一版 `5` 会被装载过渡层接受但被 `check:extension` 直接判失败。定义体满足
`isWorldDefinition` 四件：`id / label / defaults() / create()`（`src/extensions.ts:143-150 @836238311`）。
`create()` 保持纯：不连 WS、不发请求、不读密钥。

## 安装

需要 `ws`（`engines.node >=22.16.0`）。本包依赖：

```
ws ^8.18.0
```

装完重启才改变 `loaded`。Cortico 侧扩展装在独立 pnpm 树里，桥包必须自己声明 `ws`，
不能从框架借用（`d-cortico-side §5.3`）。

## 配置（config.js DEFAULTS）

| 键 | 缺省 | 说明 |
|---|---|---|
| `enabled` | `false` | 缺省禁用，框架控制启停 |
| `wsUrl` | `ws://127.0.0.1:3001` | 实现端正向 WS；5700/6700 是 v11 规范缺省段 |
| `token` | `''` | 也可用环境变量 `ONEBOT_TOKEN`（优先），仅用于出站 `Authorization` |
| `writePolicy` | `confirm` | 写动作策略：`confirm` / `allow` / `deny` |
| `readOnly` | `false` | 只允许目录里 `readOnly` 的 action |
| `dropEventKinds` | `meta_event/heartbeat` | 完全不收的事件 kind |
| `maxEventChars` | `4000` | 非消息事件正文上限；原始 JSON 仍在 `meta.raw` |

## 工具（tools）

实例 `tools()` 的名字必须都在 `describe.json` 声明里，四个：

- `onebot_call`（act）：调 v11 action。门序固定（`SECURITY-CBP.md:36-40,125`）：名字闸（凭证名 10002）→
  写动作身份闸（无入站记录 60004、缺发起方/缺 self/anon≠identified 拒）→ `readOnly`/`writePolicy`（缺省要 `confirm=true`）。身份只认世界自己的入站记录与 `get_login_info` 实证 self，args 自报不进闸。
- `onebot_actions`（read）：查目录、分类与覆盖数；给 `name` 返回单条。
- `onebot_events`（read）：按 kind / 时间查归档事件，`kind` 支持 `*`。
- `onebot_status`（read）：连接、账号、v11 覆盖面、写策略。

## 事件（pushEvent 映射）

| v11 post_type | Cortico 事件 | 投递 |
|---|---|---|
| `message` | `onebot-bridge.message` | debounce；自发回声 `deliver:false` 只归档 |
| `notice` | `onebot-bridge.notice` | debounce |
| `request` | `onebot-bridge.request` | debounce |
| `meta_event` | `onebot-bridge.notice` | `deliver:false`；heartbeat 缺省丢弃 |
| 连接上 / 断 | `onebot-bridge.connection` | debounce |

每条都保留 `meta.raw`（原始 v11 事件）；缺 `raw_message` / `font` 的消息标
`meta.malformed`（实测会退化通用 Event，见 `r-nonebot-onebot.md:152`）。未知段渲染成
`[<type>]` 占位、绝不吞整条消息。出站不实现 `outputTap()`（蓝图 §3.3）。

## 自检与测试

```
npm run selfcheck   # 离线复刻 check:extension 的可判据，全绿 exit 0
npm test            # node --test：纯函数 / 事件投影 / 门禁 / 契约
```

未覆盖（需实现端或宿主，本骨架按边界不跑）：真实 WS 往返、`delete_msg` 撤回回执语义、
图片 blob 下载。

## 来源

行为对齐先例 `cortico-world-onebot @2e91b7fb1`（第三方，不 fork、不重写）与本次
`repos/cortico @836238311`、`nonebot-adapter-onebot @2450b67a1` 运行产物。见
`reports/_BUILD-PLAN.md` §2.3 与 `_REALITY-LEDGER.md` R11/R12。
