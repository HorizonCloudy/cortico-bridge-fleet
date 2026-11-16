# cortico-bridge-fleet

Cortico 侧的 CBP（Cortico Bridge Protocol）桥族。一个协议，四个框架，每边一对包。

- `spec/CBP-v1.json` —— 帧表 JSON Schema（十型含 `catalog`，共享头 `v/t/id/ts`）。
- `spec/pins.json` —— 版本钉与硬数上限的单一来源（上游 sha、Python 桶、Node 下限、端口表、caps 字节段）。
- `spec/conformance.json` —— 黄金向量。正向必须过，反向必须被指名关键字拒。
- `spec/SECURITY-CBP.md`、`spec/CHANGELOG-CBP.md` —— 安全口径与帧表演账。
- `packages/cortico-bridge-core` —— 帧编解码、段词表、去重、双角色 WS 驱动、能力协商、错误码、turn/actor 关联。
- `packages/cortico-world-{neko,maibot,astrbot-bridge,onebot-bridge}` —— Cortico 侧 world 包。
- `tools/` —— `validate_cbp.mjs`（ajv 跑向量，带台账元闸）、`gen_pins.py`、`gen_table.py`、`manifest_scan.py`、`vocab_gate.py`。
- `tests/` —— 改名账、帧与段词表一致性、pins 自洽、发布前置闸。

对端插件在隔壁仓库：`cortico-bridge-neko`、`cortico-bridge-maibot`、`cortico-bridge-astrbot`。
`cortico-bridge-koishi` 是 v1 口径文档仓（零对端码）。

## 检查

```
cd packages/cortico-bridge-core && npm test
cd packages/cortico-world-neko && npm test
cd packages/cortico-world-maibot && npm test
cd packages/cortico-world-astrbot-bridge && npm test
cd packages/cortico-world-onebot-bridge && npm test
node --test tests/
cd tools && node validate_cbp.mjs
```

依赖只装进隔离目录，不碰全局。npm 在这台机器上要走 `registry.npmmirror.com` 并加 `--ignore-scripts`。

## 已经验到的程度

协议自洽与假驱动层为绿：向量 39/39，五包与根仓测试全绿，帧表由 `tools/gen_table.py` 单源生成并有跨仓等值闸。
真宿主冒烟未做：不启动宿主、不连 IM、不发消息。那一档的授权清单在调研记录里。

许可 MIT，含第三方归属声明，见 `LICENSE`。
