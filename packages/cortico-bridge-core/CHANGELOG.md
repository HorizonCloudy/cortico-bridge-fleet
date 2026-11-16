# 更新日志 · cortico-bridge-core

每个版本一节 `## <版本号>`；本包不是 Cortico 扩展，版本号与 `package.json` version 同步。

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
