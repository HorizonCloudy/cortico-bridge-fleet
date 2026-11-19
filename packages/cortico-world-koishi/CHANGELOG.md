# 更新日志 · cortico-world-koishi

每个版本一节 `## <版本号>`；扩展市场按节显示更新说明。

## 0.1.2

*2026-11-19 · 能力面收敛 / 声明撤回*

- 与 `cortico-world-onebot-bridge` 同批收敛：新增逐字相同的 `src/guard.js` 两闸（本机文件引用 + 静态目录白名单），`koishi_call` 不再透传目录外扩展动作。
- 撤回 `0.1.1` 节里**从未发布**的 `unsafe` 声明；不写 `safe`（`TAGS.md:31/:42`）。
- `describe.json` 按新工具声明重新生成；契约测试同步版本与 tags；`node --test "test/*.test.mjs"` 40/40。

## 0.1.1


> 注：本节未发布；其中「自声明 unsafe」一条已由下一版撤回，能力面收敛见下一节。
*2026-11-19 · 安全修复*

- **按 10-22 判例（commit `7dec0b00d`）自声明 `cortico.tags: ["unsafe", ...]`**。
  理由与 `cortico-world-onebot-bridge` 相同：本包复用 OneBot v11 正向 WS 与通用
  action 调度面，`koishi_call` 的开放 `params` 能把本机任意文件发进群聊或私聊。
- README 补安全声明章节。

## 0.1.0

首个版本（v1 薄壳，不发布）：Cortico 侧 Koishi 插件兼容入口，**不写 Koishi 协议码**，
用 OneBot v11 正向 WebSocket 拨 NapCat 类实现端，再叠 catalog 实现选择。只承诺 v11。

- 事件时刻取值加 `Number.isFinite` 守卫（`projectEvent`）：畸形 `time`（`'abc'`、`null`、
  `0`、负数、对象）回落当下时刻。缺守卫时 `new Date(NaN).toISOString()` 抛 RangeError，
  异常沿 `#handleEvent` 落进 `onEvent` catch，整条消息事件被吞。形状照先例
  `cortico-world-onebot-bridge/src/normalize.js:79-83 eventTs`。

- 装载契约：`cortico` 块 `kind:"world"`、`api:6`、`describe:"describe.json"`、
  `main`/`exports` 指 `src/definition.js`、全 `.js`；市场 tags 取词表五词
  `qq/im/external-setup/unofficial-api/experimental`（不声明 `onebot`/`onebot-v11`，
  两词在 29 词表外会市场静默隐身）；不声明 `webUiClient`。
- 驱动：`src/driver.js` 整文件复制自 `cortico-world-onebot-bridge @c85a87b24`
  （该包 exports 挡 subpath import，实跑 ERR_PACKAGE_PATH_NOT_EXPORTED）。复制件的病是
  各自演化（先例：四份 Python 桥各自手抄 CBP 帧表抄出分歧），所以配逐字节等闸
  `test/driver-parity.test.mjs`，并要求文件头写明来源件、钉住的 sha 与门禁编号。
  升级时机：v11 驱动进内核 `exports` 或单列 v11 profile 包后，删复制件与本闸。
- 工具四件 `koishi_*` 前缀（防撞名，`bot.ts:1146-1155 @836238311` 覆盖语义）：
  `koishi_call`（act，门序原样 copy：名字闸 10002 → 身份闸 60004 → 策略闸；未知/扩展动作按写）、
  `koishi_actions`（read，附实现识别与扩展白名单展示）、`koishi_events`（read）、
  `koishi_status`（read）。`describe.json` 与 `tools()` 由 `KOISHI_TOOL_DECLS` 同源派生。
- catalog 实现选择：连上后按 `get_version_info.app_name` 识别 napcat / snowluma /
  llonebot / lagrange / go-cqhttp（样式移植 `@2e91b7fb1`）；per-impl 扩展白名单
  起点值为空且标「猜」（未核验，recon.md §6-2），只展示不拦截。
- ID 空间：全程 v11 原生数字 `message_id`、`group_id/user_id` 原样，不做 Koishi
  字符串化；README 的对照表逐行核验自 `koishi-plugin-adapter-onebot @4109eb95c`。
- 测试：`node --test`（`test/contract / world / implementations`）覆盖门序、事件投影、
  契约同步、`onebot_*` 全文禁用扫描与实现识别；发布闸五项由 fleet 根
  `tests/release/release-gate.test.mjs` 枚举进闸。
