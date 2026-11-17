#!/usr/bin/env python3
"""Python 帧表唯一生成器：spec/CBP-v1.json → 两仓 cbp_table.py。

纪律：仓内不许手抄第二份帧表。先改 spec，再重跑本文件覆盖两份副本
（SECURITY-CBP.md:60「副本各跑同一向量表，漂移即红」；CHANGELOG-CBP.md:471,479）。
两仓 tests/test_table_parity.py 断言盘上 cbp_table.py 与 render() 逐字节一致。
输出确定性：唯一变化源是 spec 内容（头部写其 sha256），同一 spec 重跑逐字节相同。

用法：python tools/gen_table.py [--base C:/Users/54301] [--check] [--repos 名,...]
  --base 五仓的父目录；反向验证（negctl）时指向副本根，别指真仓。
  --check 只比不改：盘上副本与 render() 不一致 exit 1（帧表一致性闸）。
  --repos 逗号分隔仓名过滤。边界：只重生成你有权写的仓；名单外桥仓的副本
        漂移走台账，由该仓工序自己重跑本文件。

工单二 F2：本文件还把 $defs/turnWindow.const 落进 cbp_table.py 的
TURN_TTL_SECONDS（turn 保留窗单源；不是帧字段，不进 any 帧）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
DEFAULT_BASE = HERE.parent.parent  # .../cortico-bridge-fleet/tools/../.. = 五仓父目录
REPOS = ("cortico-bridge-neko", "cortico-bridge-maibot")
HEADER_FIELDS = ("v", "t", "id", "ts")  # 公共头，tick 无体字段 → tick.required ≡ 公共头（table() 自检）


def spec_path(base: Path) -> Path:
    return base / "cortico-bridge-fleet" / "spec" / "CBP-v1.json"


def table(base: Path = DEFAULT_BASE) -> dict[str, Any]:
    schema = json.loads(spec_path(base).read_text(encoding="utf-8"))
    defs = schema["$defs"]
    assert tuple(defs["tick"]["required"]) == HEADER_FIELDS, "公共头漂移：tick.required != {v,t,id,ts}"
    types = [ref["$ref"].rsplit("/", 1)[-1] for ref in schema["oneOf"]]
    assert len(types) == 10, f"十型漂移（F17 禁 mint 第 11 型）：{types}"
    required: dict[str, tuple[str, ...]] = {}
    optional: dict[str, tuple[str, ...]] = {}
    for name in types:
        node = defs[name]
        assert node["properties"]["t"]["const"] == name, f"{name}: t const 与 $defs 键名不一致"
        required[name] = tuple(k for k in node["required"] if k not in HEADER_FIELDS)
        opt = tuple(k for k in node["properties"] if k not in node["required"])
        if opt:
            optional[name] = opt
    turn_ttl = defs["turnWindow"]["const"]
    assert (
        isinstance(turn_ttl, int) and not isinstance(turn_ttl, bool) and turn_ttl > 0
    ), f"turnWindow.const 必须为正整数秒: {turn_ttl!r}（工单二 F2 单源）"
    return {
        "CBP_VERSION": defs["hello"]["properties"]["v"]["const"],  # properties.v.const
        "_REQUIRED": required,                                     # 逐型 required 去公共头，oneOf 顺序
        "_OPTIONAL": optional,                                     # 逐型 properties 去 required
        "MSG_KINDS": tuple(defs["msg"]["properties"]["kind"]["enum"]),
        "TOOL_RISKS": tuple(defs["toolAnn"]["properties"]["risk"]["enum"]),  # ToolTag 六值
        "ANON_VALUES": tuple(defs["anon"]["enum"]),                          # $defs/anon 四值
        "_SELF_KEYS": tuple(defs["self"]["required"]),                       # 三键闭合
        "_ACTOR_KEYS": tuple(defs["actor"]["required"]),                     # 四键闭合
        "_MEMBER_KEYS": tuple(defs["sender"]["required"]),                   # 两键闭合
        "_ID_MAX": defs["frameId"]["maxLength"],                             # 1..64
        "_STR_MAX": defs["sender"]["properties"]["id"]["maxLength"],         # conv·sender·self ≤256
        "TURN_TTL_SECONDS": turn_ttl,  # 工单二 F2：turn 保留窗单源（非帧字段）
    }


def render(base: Path = DEFAULT_BASE) -> str:
    digest = hashlib.sha256(spec_path(base).read_bytes()).hexdigest()
    t = table(base)
    lines = [
        '"""CBP v1 帧表 —— GENERATED 文件，别手改、别手抄第二份。\n'
        f'source: cortico-bridge-fleet/spec/CBP-v1.json sha256={digest}\n'
        'cmd:    python cortico-bridge-fleet/tools/gen_table.py\n'
        '\n'
        '改动纪律：先改 spec 再重跑生成器，两份副本同批覆盖（SECURITY-CBP.md:60）。\n'
        '两仓 tests/test_table_parity.py 把本文件钉住生成器输出。\n'
        '"""\n'
        '\n',
    ]
    for key, value in t.items():
        if isinstance(value, dict):
            body = "".join(f"    {k!r}: {v!r},\n" for k, v in value.items())
            lines.append(f"{key}: dict[str, tuple[str, ...]] = {{\n{body}}}\n\n")
        else:
            lines.append(f"{key} = {value!r}\n\n")
    return "".join(lines)


def targets(raw: str) -> list[str]:
    names = [x.strip() for x in raw.split(",") if x.strip()]
    unknown = [x for x in names if x not in REPOS]
    assert not unknown, f"--repos 含未知仓名 {unknown}（在表名单：{list(REPOS)}）"
    return names if names else list(REPOS)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", type=Path, default=DEFAULT_BASE, help="五仓的父目录（negctl 副本用）")
    ap.add_argument("--check", action="store_true", help="只比不改：盘上副本与 render() 不一致 exit 1")
    ap.add_argument("--repos", default="", help="逗号分隔仓名过滤；只动你有权写的仓")
    args = ap.parse_args()
    text = render(args.base)
    data = text.encode("utf-8")
    repos = targets(args.repos)
    if args.check:
        bad: list[str] = []
        for repo in repos:
            out = args.base / repo / "cbp_table.py"
            got = out.read_bytes() if out.exists() else None
            if got != data:
                bad.append(f"{repo}: 盘上 cbp_table.py 缺失或与生成器输出不一致（重跑本生成器）")
        if bad:
            print("\n".join(bad))
            return 1
        print(f"--check OK: {repos} 的 cbp_table.py 与生成器输出逐字节一致（含 TURN_TTL_SECONDS）")
        return 0
    for repo in repos:
        out = args.base / repo / "cbp_table.py"
        out.write_bytes(data)  # write_bytes：不被平台换行符改写，两仓字节必然一致
        print(f"wrote {out} ({len(data)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
