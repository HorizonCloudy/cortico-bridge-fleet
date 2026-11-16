# CBP 校验闸报告 — 2026-11-16（工单：把假绿变成真闸）

## 结论
- 真闸已落地：`tools/validate_cbp.mjs`（sha256 f84bc4df2fbcba8d…）用 ajv 8.20.0（安装版本，装于 `C:/Users/54301/cortico-bridge-fleet/tools/node_modules`，npmmirror + --ignore-scripts）以 draft 2020-12 strict 模式编译 `spec/CBP-v1.json`（sha256 6e2638edfb579aaa…），逐条跑 `spec/conformance.json`（sha256 8d3ba0d63e0fc96f…）的 `frames.vectors` 10 条正向 + `frame_negatives.vectors` 20 条反向；反向除被拒外还要求拒绝关键字命中向量预期。任一不符 exit 1 并打印向量 id。
- `npm test`（tools/package.json sha256 7659e77cf2bfea59… 的 test 脚本 = `node --test ../tests/frames/`）现已包含该闸：`tests/frames/cbp-schema-gate.test.mjs`（sha256 4ff8ddc0af523b32…）execFileSync 跑校验器并要求全 pass。9/9 绿。
- 关键事实：当前 schema 对 30 条向量本来就全过（见下「改前」）。工单预期的三类失败没有以向量失败形式出现，它们是 schema 自述文字与开放范围的偏差，用探针复现如下。未动任何向量、未放宽任何断言。
- 未做（越界）：schema description 那句「Every object … closes with additionalProperties:false」的改写。`spec/` 不在本工单可写路径内，建议文字见 §改后-建议，由 spec 工单落盘。

## 改前：当前 schema 的真实失败清单
命令：`cd tools && node validate_cbp.mjs`（exit 0）

    CBP vectors: 30/30 pass (10 positive, 20 negative, schema C:\Users\54301\cortico-bridge-fleet\spec\CBP-v1.json)

即：向量层面 0 失败。工单预期的三类问题按「自述 vs 实际」探针列出（同一 strict 编译产物上执行，node -e，未落盘）：

    A seg.data extra key => valid: true
    B call.args any shape => valid: true
    C out-of-band code 999999 => valid: true
    D extra top key x => valid: false rootKeywords: [...branch errors...,oneOf]

- A/B：`CBP-v1.json:74-78`（`$defs.seg.data` 是 propertyNames+string 值的开放映射）、`CBP-v1.json:211`（`call.args` 仅 `"type":"object"`）。两处有意开放，与 `CBP-v1.json:5` description 的「每个对象都闭合」矛盾 —— 这是描述假绿，不是向量假绿。
- D：根 dispatcher（`CBP-v1.json:6-18`）没有自己的 additionalProperties；额外键被拒是靠 oneOf 分支闭合，归因关键字是分支错误 + oneOf。description 的「every object」同样不准。
- C：`$defs.error.code` 范围 0..4294967295（`CBP-v1.json:122`），十型语境下的 18 个成文码（conformance `rules.error_codes`：0,10001-10007,20001,20002,60001-60008）之外的码照样过。JSON Schema 表达不了「或文档化 passthrough」，这是校验器（kernel）活，ajv 闸管不到，如实记录。

## 改后：全绿
命令 1：`cd tools && node validate_cbp.mjs`

    CBP vectors: 30/30 pass (10 positive, 20 negative, schema C:\Users\54301\cortico-bridge-fleet\spec\CBP-v1.json)

命令 2：`cd tools && npm test`

    ✔ ajv gate: tools/validate_cbp.mjs passes every spec/conformance.json frame vector (239.7693ms)
    ✔ frame table: exactly ten unique types, each with a head and required list (1.7704ms)
    ✔ frame table: msg carries segments, ToolTag risk set is the six verbatim values (0.1075ms)
    ✔ segment table: 24 factories = 20 wire + 4 sugar, sugars map into wire (0.7066ms)
    ✔ segment table: no `atall` token anywhere; at_all renders as at{qq:"all"} (0.1566ms)
    ✔ segment table matches r-nonebot-onebot.md §2.3 verbatim (0.5793ms)
    ✔ cross-check spec/CBP-v1.json (skips until the spec work order lands) (0.5775ms)
    ✔ cross-check conformance.json vectors (skips until it lands) (0.4956ms)
    ✔ cross-check core src/frames.ts + src/segment.ts (skips until they land) (1.1426ms)
    ℹ tests 9 / pass 9 / fail 0

## 破坏实验（副本，控制文件在 botfw-compat，不进仓）
把 `$defs.tick.required` 里的 `"ts"` 去掉：
`C:/Users/54301/tmp/botfw-compat-20261115/work/cbp-sabotage-20261116/CBP-v1.broken.json`

命令：`cd tools && CBP_SCHEMA=C:/Users/54301/tmp/botfw-compat-20261115/work/cbp-sabotage-20261116/CBP-v1.broken.json node validate_cbp.mjs`（exit 1）

    removed ts from tick required -> ['v', 't', 'id']
    FAIL frame_negatives.missing_ts: expected rejection, schema accepted it (reason field: header ts required)

    CBP vectors: 1/30 FAILED (schema C:/Users/54301/tmp/botfw-compat-20261115/work/cbp-sabotage-20261116/CBP-v1.broken.json)

## 建议给 spec 工单的 description 替换文字（spec/CBP-v1.json:5，本工单无权落盘）
把「Every object in this schema closes with additionalProperties:false; …」改为点名两处有意开放映射与根闭合方式：

> Frame objects close with additionalProperties:false at each oneOf branch; the root dispatcher itself is not closed and rejects unknown keys through its ten branches. Two maps are deliberately open: $defs.seg.data (propertyNames string 1..128, values must be strings, onebot-11 array.md:23 @d4456ee70) and $defs.call.args (type object only, tool-defined). Unknown keys make a frame invalid and the kernel must swallow bad frames without throwing (_BUILD-PLAN.md 2.2 frames.ts, blueprint 2.1).

## 覆盖范围与局限（如实）
- 闸只跑 CBP-v1.json 能裁决的两节：`frames.vectors` + `frame_negatives.vectors`（30 条）。`segments/envelope/errors/degrade/v11_line/neko_ipc` 各节面向渲染/映射/RpcEnvelope 等其他校验器，不是本 schema 的向量，未纳入（neko_ipc.rpc_envelope_vectors 是另一 schema）。`expect.wire` 逐字节比对属于 kernel 序列化检查，也不在本闸内。
- 反向断言是「拒绝 + 预期关键字 ∈ 扁平化 oneOf 错误集」的 membership 判定，不校验关键字的精确 instancePath（ajv allErrors 把十个分支错误全部摊平，无法定位到意图分支；shortcut: 关键字命中即可，若日后要精确归因，改为按 t 直编对应 $defs 分支再断言）。
- `node --test tests/pins|release|rename` 不在本闸脚本内；闸只接 frames（工单指定路径）。
- frames-segments.test.mjs:96 的文本包含断言仍在（它没坏），但它不再是唯一防线。
