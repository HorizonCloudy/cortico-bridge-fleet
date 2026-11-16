# @horizoncloudy/cortico-world-koishi

Cortico 侧的 **Koishi 插件兼容入口薄壳**（v1）。口径一句话：**本包不写 Koishi 协议码**，
它用 OneBot v11 正向 WebSocket 拨 NapCat 类实现端，再叠一层 catalog 实现选择逻辑；
对 Cortico 提供 koishi_* 工具面，为后续 Koishi 插件兼容做桥。

它和 `cortico-world-onebot-bridge` 是姊妹包：驱动整文件复制自该包 @c85a87b24
（gate C-2，该包 exports 挡 subpath import），行为同 v11 profile，差异在工具名前缀
（`koishi_*`，避免两包同装撞名——宿主按工具名建 Map，后装静默覆盖前装且全程不报错，
`repos/cortico src/bot.ts:1146-1155 @836238311`）、世界 ID（`koishi-bridge`）与 catalog
实现选择展示。**只承诺 v11，不承诺 v12**；不接 CBP 桥帧，不声明 `*_send_message`。

## 装载契约

`package.json` 的 `cortico` 块：`kind:"world"`、`api:6`（精确等于当前锚，
`repos/cortico src/extensions/manifest.ts:24 @836238311`）、`describe:"describe.json"`、
`tags:["qq","im","external-setup","unofficial-api","experimental"]`（29 词市场词表内，
`tests/_lib/release-gate.mjs` 的 `MARKET_TAGS`）。不声明 `webUiClient`（v1 无面板）。
定义体满足装载器四件 `id / label / defaults() / create()`（`extensions.ts:146-149 @836238311`
只查这四件）；`defaults().enabled=false` 与 `create()` 纯是先例约定。

## 安装

需要 `ws`（`engines.node >=22.16.0`）。本包依赖：

```
ws ^8.18.0
```

装完重启才改变 `loaded`。Cortico 侧扩展装在独立 pnpm 树里，桥包必须自己声明 `ws`，
不能从框架借用（`d-cortico-side §5.3`）。

## 配置（src/config.js DEFAULTS）

| 键 | 缺省 | 说明 |
|---|---|---|
| `enabled` | `false` | 缺省禁用，框架控制启停 |
| `wsUrl` | `ws://127.0.0.1:3001` | 实现端正向 WS；NapCat 转发通道常用 3001 |
| `token` | `''` | 也可用环境变量 `KOISHI_TOKEN`（优先），仅用于出站 `Authorization` |
| `writePolicy` | `confirm` | 写动作策略：`confirm` / `allow` / `deny` |
| `readOnly` | `false` | 只允许目录里 `readOnly` 的 action |
| `dropEventKinds` | `meta_event/heartbeat` | 完全不收的事件 kind |
| `maxEventChars` | `4000` | 非消息事件正文上限；原始 JSON 仍在 `meta.raw` |

## 工具（tools，四件均 `koishi_*` 前缀）

- `koishi_call`（act）：调 v11 action。门序固定（`SECURITY-CBP.md:36-40,125`）：名字闸
  （凭证名 10002）→ 写动作身份闸（无入站记录 60004、缺发起方/缺 self/anon≠identified 拒）→
  `readOnly`/`writePolicy`（缺省要 `confirm=true`）。身份只认世界自己的入站记录与
  `get_login_info` 实证 self，args 自报不进闸。未知/扩展动作按写处理。
- `koishi_actions`（read）：查目录、分类与覆盖数；无参时附实现识别结果与扩展白名单；
  给 `name` 返回单条。
- `koishi_events`（read）：按 kind / 时间查归档事件，`kind` 支持 `*`。
- `koishi_status`（read）：连接、账号、识别出的实现、v11 覆盖面、写策略。

事件投递 `koishi-bridge.message / notice / request / connection`；自发回声与 `meta_event`
`deliver:false` 只归档；每条保留 `meta.raw`；未知段渲染 `[<type>]` 占位不吞消息。

## catalog 实现选择

连接建立后驱动已带回 `get_version_info`（`src/driver.js:167` 复制件行），
`src/implementations.js` 按 `app_name` 分流：napcat / snowluma / llonebot / lagrange /
go-cqhttp（样式移植自 `cortico-world-onebot src/implementations.js:16 @2e91b7fb1`）。
识别只改展示与 `koishi_actions` 无参输出，**不动工具集、不改门序**。未识别实现按
空扩展名单处理，标准 35 面照常透传。

### per-impl 扩展 action 白名单（起点值＝猜，未核验）

**下表名单未经权威表核验**（recon.md §6-2：NapCat / Lagrange 各家扩展无权威清单，
只有适配器侧注释证据）。v1 起点值：全部为空——只展示、不拦截；未知动作在
`gateAction` 一律按写处理。升级条件：某实现扩展动作在真实对端复现参数或语义分歧后再填。

| 实现 | 扩展白名单起点 |
|---|---|
| napcat / snowluma / llonebot / lagrange | `[]`（猜） |

## Koishi 侧 ID 空间差异（本包全程 v11 原生 ID）

本包对 JSON 透传 v11 线：`message_id` 是**数字**，`group_id` / `user_id` 原样传，
**不做 Koishi 侧字符串化**。若对端换成 Koishi + 官方适配器（`koishi-plugin-adapter-onebot
@4109eb95c`，下表行锚逐行重读核实），同一条消息的 ID 会变成：

| 差异点 | 行锚（该仓 src/ 内） | 该行实证 |
|---|---|---|
| v11 原生 message_id 是数字 | `types.ts:14` | `message_id: number` |
| Koishi 侧统一字符串化 | `utils.ts:48` | `message.id = message.messageId = data.message_id.toString()` |
| 出站回迁数字 | `types.ts:599-610` | `prepareArg`：方法名不含 guild 且键以 `_id` 结尾、`Math.abs(value) < 4294967296` 才 `+value`；`guild_id/channel_id` 保持字符串 |
| selfId 两套体系 | `utils.ts:180` | `session.selfId = data.self_tiny_id ? data.self_tiny_id : '' + data.self_id` |
| 用户 id | `utils.ts:9-13` | decodeUser `id = user.tiny_id \|\| user.user_id.toString()` |
| guild/channel 同值与私聊前缀 | `utils.ts:121-129` | decodeGuildChannelId：有 `guild_id` 用 (guild_id,channel_id)；仅 `group_id` 时 guild 与 channel **同值**；否则 `'private:' + sender.user_id` |
| 前缀常量 | `bot/message.ts:18` | `export const PRIVATE_PFX = 'private:'` |
| 秒→毫秒 | `utils.ts:115` | `payload.timestamp = data.time * 1000` |
| 无回执路径 | `bot/message.ts:133-135` | 「相关 API 没有返回 message_id」⇒ `session.messageId = ''` |

口径：跨 Koishi 插件对账 ID 时，先按上表换算再比。Koishi 反向 WS 的
`x-client-role: Universal` 硬闸在 Koishi 当服务端的适配器侧，与本包无关——本包是
正向 WS 客户端。

## 测试

```
npm test                  # node --test：门序 / 事件投影 / 契约 / 实现识别
node --test tests/release/ # fleet 根目录跑发布闸（本目录一建即进闸）
```

## 来源

`src/driver.js` 整文件复制自 `@horizoncloudy/cortico-world-onebot-bridge/src/driver.js
@c85a87b24`（文件头注明）。行为对齐第三方 `cortico-world-onebot @2e91b7fb1`（不 fork、
不 import）。门禁与取证：`work-phase2/K5-koishi-world/gate.md`、`recon.md`。
v1 薄壳不发布；图片 blob、WebUI、真实 WS 往返留待完整实现。
