# @horizoncloudy/cortico-bridge-core

CBP v1 桥内核。零框架知识（蓝图 §2.1 决策 2：新框架 = world 包加一张表，永远不动内核）。
运行时依赖只有 `ws`；Node ≥ 22.16.0（fleet 下限，package.json engines）。

本包不是 Cortico 扩展（`package.json` 无 `cortico` 块），发布前置只有 README 与
CHANGELOG 两件；describe 闸只作用 `kind:"world"` 包（tests/_lib/release-gate.mjs:53）。

## 模块图（src/index.ts:6-17 逐行）

| 子路径导出 | 模块 | 职责 |
|---|---|---|
| `.` | index | 全量面 |
| `./frames` | frames | CBP v1 十型帧 + 防御式 `parseFrame` |
| `./segment` | segment | v11 段词表、未知段兜底（单点） |
| `./envelope` | envelope | msg/notice → EventEnvelope + TriggerMode 档位，meta 恒留 raw |
| `./dedup` | dedup | TTL Map 去重：上限 200（dedup.ts:12）、TTL 10 分钟（dedup.ts:14） |
| `./driver` | driver | WS dial/listen 双角色（driver.ts:41），退避 1000ms×2 封顶（driver.ts:7），`start()` 永不 reject |
| `./negotiate` | negotiate | caps 交集、v 门禁 60001、tools[] risk/confirm_required |
| `./errors` | errors | v12 四位基座 + 桥段 60001..60008（errors.ts:5,23,30）+ 四家族翻译 |
| `./correlate` | correlate | rid/echo 在飞表 + tick 活性；TurnLedger 默认窗读同源 turn（工单二 F2，不再挂 dedup 600 秒） |
| `./pins` | pins | 版本钉快照；`spec/pins.json` 是 fleet 唯一来源（pins.ts:287-288 端口即例）；turn 段严读 + `effectiveTurnTtlSeconds()` env 覆盖（工单二 F2） |

另有 `idempotency`（rid→reply 缓存，§5.1）与 `redact`（凭证剥离，§3.4）经 `.` 面导出。
src 共 12 个模块 2424 行。

## 谁在用

- `@horizoncloudy/cortico-world-neko`：`src/world.ts:20-38` 整段 import（双角色驱动 + 帧 + 渲染 + 协商）。
- `@horizoncloudy/cortico-world-maibot`：`src/world.ts:38` 起 import（监听端）。
- `@horizoncloudy/cortico-world-astrbot-bridge` 不走本内核——收编版自带 `src/frames.ts` / `src/driver.ts`
  （baseline `@horizoncloudy/cortico-world-astrbot @4725feee6`），其 `package.json` 依赖只有 `ws`。

## 构建与测试

`npm run build`（tsc → dist）、`npm test`（先 build 再 `node --test dist/tests/`；
tests 12 个 .test.ts 与 src 模块一一对应加 driver-auth/driver-loopback 两条边界）。
离线闸由仓根 `node --test tests/` 统一跑。
