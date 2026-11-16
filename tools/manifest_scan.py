#!/usr/bin/env python3
"""manifest_scan — AST 扫桥包 ctx.* 用法，生成 MaiBot capabilities 名单（G2/R5）。

用法:
  python -I tools/manifest_scan.py --scan <桥包目录>        # 打印名单（JSON）
  python -I tools/manifest_scan.py --check <桥包目录>       # 名单⊆universe 且与 _manifest.json 一致则 exit 0
  python -I tools/manifest_scan.py --self-test              # 离线自检，内存源样本，无文件写入

口径 = AST 全集 ∪ 白名单手抄（--whitelist FILE，JSON 数组），宁多报不漏报。
藏名（变量赋值再拼载荷，render.html2png 型）由「字符串常量命中 universe」捕获；
universe 取 spec/pins.json vocab.maibot.capabilities（103 名，钉 f9984673d 实测集）。
宿主执法点：authorization.py:58 @478f671e6 —— 名单缺项 = 加载期硬拒「未获授权能力」。
"""
import argparse
import ast
import json
import re
import sys
from pathlib import Path

PINS_DEFAULT = Path(__file__).resolve().parent.parent / "spec" / "pins.json"
CAPRE = re.compile(r"^[a-z_]+(?:\.[a-z_0-9]+)+$")


def universe(pins_path: Path) -> tuple[set[str], set[str]]:
    with open(pins_path, encoding="utf-8") as f:
        v = json.load(f)["vocab"]["maibot"]
    caps = set(v["capabilities"])
    extras = set(v.get("gateway_extra_caps", []))
    assert len(caps) == v["capabilities_len"], "pins.json capabilities 计数不符"
    return caps, extras


class _Caps(ast.NodeVisitor):
    """收三类：ctx 链（ctx/self.ctx/plugin.ctx 根）、call_capability·_call 字面参、命中 universe 的字符串常量。"""

    def __init__(self, caps, extras, whitelist):
        self.caps, self.extras, self.wl = caps, extras, whitelist
        self.found, self.outside = set(), set()

    def _add(self, name, lineno):
        if not CAPRE.match(name):
            return
        if name in self.caps or name in self.extras or name in self.wl:
            self.found.add(name)
        elif any(name.startswith(c.split(".")[0] + ".") for c in self.caps) or name.split(".")[0] in {c.split(".")[0] for c in self.caps}:
            self.outside.add(f"{name} (行 {lineno})")

    def visit_Attribute(self, node):
        chain = self._ctx_chain(node)
        if chain:
            self._add(".".join(chain), node.lineno)
        self.generic_visit(node)

    @staticmethod
    def _ctx_chain(node):
        parts = []
        cur = node
        while isinstance(cur, ast.Attribute):
            if cur.attr in ("ctx", "context") and isinstance(cur.value, ast.Name) and cur.value.id in ("self", "plugin"):
                return list(reversed(parts))
            parts.append(cur.attr)
            cur = cur.value
        if isinstance(cur, ast.Name) and cur.id == "ctx":
            return list(reversed(parts))
        return None

    def visit_Call(self, node):
        fn = node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id if isinstance(node.func, ast.Name) else None
        if fn in ("call_capability", "_call") and node.args and isinstance(node.args[0], ast.Constant):
            if isinstance(node.args[0].value, str):
                self._add(node.args[0].value, node.lineno)
        self.generic_visit(node)

    def visit_Constant(self, node):
        if isinstance(node.value, str) and node.value in (self.caps | self.extras):
            self.found.add(node.value)
        self.generic_visit(node)


def scan_source(src: str, filename: str, caps, extras, whitelist) -> _Caps:
    v = _Caps(caps, extras, whitelist)
    try:
        v.visit(ast.parse(src, filename=filename))
    except SyntaxError as e:
        v.outside.add(f"{filename}: 解析失败 {e}")
    return v


def scan_dir(root: Path, caps, extras, whitelist) -> _Caps:
    agg = _Caps(caps, extras, whitelist)
    for p in sorted(root.rglob("*.py")):
        if any(x in p.parts for x in ("tests", "__pycache__", ".git")):
            continue
        v = scan_source(p.read_text(encoding="utf-8"), str(p), caps, extras, whitelist)
        agg.found |= v.found
        agg.outside |= v.outside
    if whitelist:
        agg.found |= whitelist & caps  # 手抄白名单只保留 universe 内的
    return agg


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pins", type=Path, default=PINS_DEFAULT)
    ap.add_argument("--scan", type=Path, help="桥包目录")
    ap.add_argument("--check", type=Path, help="桥包目录，并对照其 _manifest.json")
    ap.add_argument("--whitelist", type=Path, help="手抄补充名单 JSON 数组（R5 宁多报）")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args(argv)

    if a.self_test:
        caps, extras = universe(a.pins)
        src = '''
async def f(ctx, plugin, self):
    await ctx.send.text("hi", sid)                       # 链
    await ctx.chat.get_stream_by_group_id(1)
    await ctx.gateway.route_message("g", m)              # extras 放行
    await ctx.call_capability("render.html2png", html)   # 字面参（藏名形态）
    await ctx.send.nonexistent("x")                      # 域内坏名，应报 outside
    hidden = "web.search"                                # 常量命中 universe
    await self.ctx.web.fetch(url)
    from maibot_sdk import MaiMessages  # noqa
'''
        v = scan_source(src, "t.py", caps, extras, set())
        want = {"send.text", "chat.get_stream_by_group_id", "gateway.route_message", "render.html2png", "web.search", "web.fetch"}
        assert v.found == want, f"found={sorted(v.found)} want={sorted(want)}"
        assert any("send.nonexistent" in o for o in v.outside), v.outside
        # 白名单并集：AST 扫不到的假想名经手抄进入
        wl = {"maisaka.context.resolve_image"}
        v2 = _Caps(caps, extras, wl)
        v2.found |= wl & caps
        assert "maisaka.context.resolve_image" in v2.found
        # 链根覆盖 self.ctx 与 ctx；plugin.ctx 按 _ctx_chain 第二形态
        assert scan_source("async def f(self):\n    await self.ctx.llm.generate('x')\n", "t2.py", caps, extras, set()).found == {"llm.generate"}
        print(f"SELF-TEST OK: universe {len(caps)} 名、样本命中 {sorted(want)}、坏名被拦、白名单并集在")
        return 0

    caps, extras = universe(a.pins)
    wl = set(json.loads(a.whitelist.read_text(encoding="utf-8"))) if a.whitelist else set()
    target = a.check or a.scan
    if target is None:
        ap.error("需要 --scan / --check / --self-test 之一")
    if not target.is_dir():
        print(f"缺输入：目录不存在 {target}（桥包仓 cortico-bridge-maibot 尚未建仓时即为此态——不算通过）")
        return 2
    agg = scan_dir(target, caps, extras, wl)
    lst = sorted(agg.found)
    if agg.outside:
        print("越 universe 名（须先过词表闸/改码，勿直接进 manifest）:\n  " + "\n  ".join(sorted(agg.outside)), file=sys.stderr)
    if a.scan:
        print(json.dumps(lst, ensure_ascii=False, indent=1))
        return 0
    mf = target / "_manifest.json"
    if not mf.exists():
        print(f"--check FAIL: 缺 {mf}（capabilities 应由本工具生成写回）")
        return 1
    declared = set(json.loads(mf.read_text(encoding="utf-8")).get("capabilities", []))
    if declared != set(lst):
        print(f"--check FAIL: 名单漂移\n  多报: {sorted(declared - set(lst))}\n  漏报: {sorted(set(lst) - declared)}")
        return 1
    if agg.outside:
        return 1
    print(f"--check OK: {len(lst)} 名 ⊆ universe({len(caps)})+extras，且与 _manifest.json 一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
