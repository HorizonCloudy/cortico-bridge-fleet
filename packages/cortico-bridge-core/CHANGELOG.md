# 更新日志 · cortico-bridge-core

每个版本一节 `## <版本号>`；本包不是 Cortico 扩展，版本号与 `package.json` version 同步。

## 0.1.3

*2026-11-19 · 安全修复*

- **安全（11-13 判例）**：`DriverOptions.authToken` 改必填，用类型系统强制所有调用点供密钥。
- `listen()` 无 token 一律拒绑定（`door_closed: token required`），`dial()` 无 token 一律拒建链
  （`dial_refused: token required`）；删掉旧的「环回免鉴权」降级路。
- `connection` 加 `Origin` 白名单（`isLoopbackOrigin`）：非环回 web origin close 4401；
  `token`/`access_token` query 见即拒；`Authorization` 头必须逐字匹配。
- 新增 5 条 hardening 测试；`node --test "dist/tests/*.test.js"` 90/90 通过。

## Unreleased（2026-11-17 · 工单二 F2）

- pins：`PINS.turn.ttlSeconds` 严读 `spec/pins.json` `turn.ttl_seconds`（缺段/坏值抛，F13 同款）。
  `effectiveTurnTtlSeconds()` 应用 env `CORTICO_TURN_TTL_SECONDS`（秒、正数）；坏值回落台账值并回
  degraded 原因 `turn-ttl-env-invalid`，不静默。单一源在 `spec/CBP-v1.json` `$defs/turnWindow`，
  经 `tools/gen_pins.py` 生成入 pins.json；缺省 300 秒（用户 2026-11-17 拍板，工单二决定 3）。
- correlate：`TurnLedger` 默认窗从 dedup 600 秒改挂同源窗；原文件里的 shortcut 注记随之清账。
- 包内台账：`scripts/prepare_pins.mjs` 重跑后包内 `spec/pins.json` 带 turn 段；缺段拒绝装机的
  仍是读侧严抛，不靠打包兜底。

## 0.1.2

- 发布闸新增第四项：`cortico.webUiClient` 声明了就必须有产物（`tests/_lib/release-gate.mjs`）。

## 0.1.1

- 发布产物自带台账：`prepack`（`scripts/prepare_pins.mjs`）把 fleet 唯一来源 `spec/pins.json` 复制进包内 `spec/`，并校验 schema/generated/caps/vocab 四段，缺段拒绝打包。
- 读数次序改为三级：`CORTICO_PINS_JSON` → 包内 `spec/pins.json` → 仓库根 `spec/pins.json`。
- 为什么：装进 `node_modules` 以后 `<包>/../../spec/pins.json` 不存在，fail-shut 直接抛，依赖本内核的 world 包在宿主里报「导入失败」。仓内测试撞不到这一层。
- 新增 `tests/pins-installed.test.ts`：在临时目录拼出安装态布局再加载内核。

## 0.1.0

首个版本：CBP v1 桥内核（`spec/CBP-v1.json` 十型帧的离线编解码与驱动面）。

- 零框架知识：v11 段词表进 `segment.ts`、各家错误码翻译进 `errors.ts` 一张表，
  新宿主框架 = world 包加表，内核不动（蓝图 §2.1 决策 2，src/index.ts:2-3）。
- 导出面：`.` 全量加 9 个子路径（package.json exports 表）；编译产物 `dist/src/*.js`。
- driver：dial/listen 双角色同一实现（driver.ts:41）；退避 1000ms×2 封顶（driver.ts:7）；
  `start()` 永不 reject；query 携带 token 的连接直接拒（§3.1 硬规则）。
- dedup：TTL Map，上限 200（dedup.ts:12）、TTL 10 分钟（dedup.ts:14），剪枝后逐最旧。
- errors：桥段 60001..60008（errors.ts:5）；koishi/maibot/neko/onebot 四家族入站翻译。
- pins：`spec/pins.json` 快照与校验（`python -I tools/gen_pins.py --check` 重生成），
  端口 neko 39701 / maibot 39702 即出自该文件（pins.ts:110-111,287-288）。
- 测试：`node --test dist/tests/`，12 个测试文件覆盖 frames/segment/envelope/dedup/
  driver（auth + loopback 边界）/negotiate/errors/correlate/idempotency/redact/pins。

骨架阶段未做（阶段二+）：跨机 TLS、帧压缩、断线补课协议位。
