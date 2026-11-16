#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""neko_sdk_spec_check.py — N.E.K.O `[plugin.sdk]` 版本闸的离线本地复刻（D3.5-② 载体）。

工单：`_BUILD-PLAN.md` §2.1 行 `tools/neko_sdk_spec_check.py`；蓝图 §1.3-2、§7-D3.5、T1。
复刻对象（逐行对源）：
  - `plugin/core/registry.py:1084 _check_sdk_compatibility`（5 元组判定）
  - `plugin/core/dependency.py:31 _parse_specifier` / `:42 _version_matches`
  sha 口径：`upstream/neko @ 52e973ed2`（editable 装进 `${ENVD}/neko-py311`）。
反例基线：`reports/r-neko.md` §2 实测表十组 + T1 的 0.9.x 陷阱 + 无 packaging 回退分支。

数据源：`${ENVD}/neko-py311` 里已装的发行包（packaging==26.3、n-e-k.o editable 件）。
不联网；不启动宿主/框架主程序；形状存在性检查用 AST 读安装位文件，不 import 上游重模块
（蓝图 §5 前提纪律）。

用法：
  C:/Users/54301/tmp/botfw-envs/neko-py311/Scripts/python.exe -I tools/neko_sdk_spec_check.py --selftest
  ...--toml <path/plugin.toml>   退出码 0=可加载，1=会拒载（CI 闸）。
"""
from __future__ import annotations

import argparse
import ast
import importlib.metadata
import importlib.util
import json
import os
import sys

CITE = "registry.py:1084-1178 + dependency.py:31-49 @52e973ed2"
HERE = os.path.dirname(os.path.abspath(__file__))
PINS_PATH = os.path.join(HERE, os.pardir, "spec", "pins.json")
DEFAULT_ENVD = "C:/Users/54301/tmp/botfw-envs"

# -I（隔离模式）连 PYTHONUTF8 一起吃掉，Windows 控制台缺省 GBK 会在中文输出上炸。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def envd() -> str:
    return os.environ.get("ENVD", DEFAULT_ENVD).replace("\\", "/").rstrip("/")


# ---------------------------------------------------------------------------
# packaging 装载（镜像 registry.py:79-87 的 try/except ImportError 形状）
# ---------------------------------------------------------------------------

def load_packaging():
    try:
        from packaging.specifiers import InvalidSpecifier, SpecifierSet
        from packaging.version import InvalidVersion, Version
        return {
            "SpecifierSet": SpecifierSet,
            "InvalidSpecifier": InvalidSpecifier,
            "Version": Version,
            "InvalidVersion": InvalidVersion,
        }
    except ImportError:  # registry.py:82-86: 全部置 None，走字符串相等回退
        return None


# ---------------------------------------------------------------------------
# 复刻主体 —— 逐分支对照 registry.py:1084-1178 与 dependency.py:31-49
# ---------------------------------------------------------------------------

def _parse_specifier(spec, log, pk):
    """dependency.py:31-38：空串/无 packaging → None；InvalidSpecifier → 记 error 返 None。"""
    if not spec or pk is None:
        return None
    try:
        return pk["SpecifierSet"](spec)
    except pk["InvalidSpecifier"] as e:
        log.append(("error", f"Invalid sdk specifier '{spec}': {e}"))
        return None


def _version_matches(spec, version):
    """dependency.py:42-49：None 恒 False；任何异常按 False 吞掉。"""
    if spec is None:
        return False
    try:
        return version in spec
    except Exception:
        return False


def check_sdk_compatibility(pid, sdk_config, sdk_version, pk):
    """复刻 registry.py:1084 `_check_sdk_compatibility`。

    返回 ((compat, supported, recommended, untested, conflicts), [(级别, 文案)])。
    宿主里 logger 只出文案不进门禁；这里把文案收进第二个返回值供反例表对线。
    """
    log = []

    def reject():
        return (False, None, None, None, []), log

    supported = recommended = untested = None
    conflicts = []
    if isinstance(sdk_config, dict):  # registry.py:1104-1113
        recommended = sdk_config.get("recommended")
        supported = sdk_config.get("supported") or sdk_config.get("compatible")
        untested = sdk_config.get("untested")
        raw = sdk_config.get("conflicts") or []
        if isinstance(raw, list):
            conflicts = [str(c) for c in raw if c]
        elif isinstance(raw, str) and raw.strip():
            conflicts = [raw.strip()]
    elif sdk_config is not None:  # registry.py:1114-1118
        log.append(("error", f"Plugin {pid}: SDK configuration must be a dict "
                             f"(plugin.sdk block), got {type(sdk_config).__name__}; skipping load"))
        return reject()

    host_version_obj = None  # registry.py:1121-1130
    if pk:
        try:
            host_version_obj = pk["Version"](sdk_version)
        except pk["InvalidVersion"] as e:
            log.append(("error", f"Invalid host SDK_VERSION {sdk_version}: {e}"))
            host_version_obj = None

    if host_version_obj:  # registry.py:1132-1173
        supported_spec = _parse_specifier(supported, log, pk)
        recommended_spec = _parse_specifier(recommended, log, pk)
        untested_spec = _parse_specifier(untested, log, pk)
        conflict_specs = [_parse_specifier(c, log, pk) for c in conflicts]

        if supported and supported_spec is None:  # :1140-1142
            log.append(("error", f"Plugin {pid}: invalid supported SDK spec '{supported}'; skipping load"))
            return reject()
        if untested and untested_spec is None:  # :1143-1145
            log.append(("error", f"Plugin {pid}: invalid untested SDK spec '{untested}'; skipping load"))
            return reject()
        invalid_conflicts = [c for c, s in zip(conflicts, conflict_specs) if c and s is None]  # :1146-1150
        if invalid_conflicts:
            log.append(("error", f"Plugin {pid}: invalid conflict SDK spec(s) {invalid_conflicts}; skipping load"))
            return reject()
        if any(s and _version_matches(s, host_version_obj) for s in conflict_specs):  # :1151-1156
            log.append(("error", f"Plugin {pid}: conflicts with host SDK {sdk_version} "
                                 f"(conflict ranges: {conflicts}); skipping load"))
            return reject()

        in_supported = _version_matches(supported_spec, host_version_obj)  # :1158-1167
        in_untested = _version_matches(untested_spec, host_version_obj)
        if supported_spec and not (in_supported or in_untested):
            log.append(("error", f"Plugin {pid}: requires SDK in {supported} (or untested {untested}) "
                                 f"but host SDK is {sdk_version}; skipping load"))
            return reject()

        if recommended_spec and not _version_matches(recommended_spec, host_version_obj):  # :1169-1171
            log.append(("warn", f"Plugin {pid}: host SDK {sdk_version} is outside recommended range {recommended}"))
        if in_untested and not in_supported:  # :1172-1173
            log.append(("warn", f"Plugin {pid}: host SDK {sdk_version} is within untested range "
                                f"{untested}; proceed with caution"))
    else:  # registry.py:1174-1178 字符串相等回退：本闭包 packaging==26.3 在场、分支不可达（C1-9）
        if supported and supported != sdk_version:
            log.append(("error", f"Plugin {pid}: requires sdk_version {supported} "
                                 f"but host SDK is {sdk_version}; skipping load"))
            return reject()

    return (True, supported, recommended, untested, conflicts), log  # :1178


# ---------------------------------------------------------------------------
# r-neko §2 实测表（十组）+ T1 陷阱组 + 无 packaging 回退组
# ---------------------------------------------------------------------------

# (名称, sdk_config, 期望 5 元组, 期望日志子串[(级别, 子串)])
# 期望元组按 registry.py:1178 的成功返回形状回显原始字符串。
REJ = (False, None, None, None, [])
TABLE_10 = [
    ("无 sdk 块(None)", None, (True, None, None, None, []), []),
    ("非 dict", "0.1.0", REJ, [("error", "must be a dict")]),
    ('supported=">=0.1.0"', {"supported": ">=0.1.0"}, (True, ">=0.1.0", None, None, []), []),
    ('supported=">=0.2.0"', {"supported": ">=0.2.0"}, REJ,
     [("error", "requires SDK in >=0.2.0 (or untested None) but host SDK is 0.1.0")]),
    ('supported=">=0.2.0"+untested="<1.0"', {"supported": ">=0.2.0", "untested": "<1.0"},
     (True, ">=0.2.0", None, "<1.0", []), [("warn", "within untested range")]),
    ('conflicts=["0.1.*"]', {"conflicts": ["0.1.*"]}, REJ,
     [("error", "Invalid sdk specifier '0.1.*'"), ("error", "invalid conflict SDK spec")]),
    ('recommended=">=0.9.0"', {"recommended": ">=0.9.0"}, (True, None, ">=0.9.0", None, []),
     [("warn", "outside recommended range")]),
    ('supported="garbage!!"', {"supported": "garbage!!"}, REJ,
     [("error", "Invalid sdk specifier 'garbage!!'"), ("error", "invalid supported SDK spec")]),
    ('compatible="==0.1.0"(别名)', {"compatible": "==0.1.0"}, (True, "==0.1.0", None, None, []), []),
    ('supported="0.2.0"(裸版本)', {"supported": "0.2.0"}, REJ,
     [("error", "Invalid sdk specifier '0.2.0'"), ("error", "invalid supported SDK spec")]),
]
# T1（_BUILD-PLAN §5）：照宿主 APP_VERSION 空间写 supported → 必须做红。
TRAP_09X = ("supported=\">=0.9.0,<0.10.0\" (T1 陷阱)",
            {"supported": ">=0.9.0,<0.10.0"}, REJ, [("error", "requires SDK in")])
# 回退分支（registry.py:1176-1178）：packaging 缺席时字符串全等。本闭包 26.3 在场、
# 分支不可达（C1-9），这里用 pk=None 直接驱动它，防止复刻时把分支写丢。
FALLBACK_CASES = [
    ("回退: supported==SDK_VERSION", {"supported": "0.1.0"}, (True, "0.1.0", None, None, []), []),
    ("回退: supported!=SDK_VERSION", {"supported": ">=0.1.0"}, REJ,
     [("error", "requires sdk_version >=0.1.0 but host SDK is 0.1.0")]),
]


def selftest(pk) -> int:
    pins = json.load(open(PINS_PATH, encoding="utf-8"))
    sdk_version = pins["neko_sdk"]["sdk_version"]
    bad = 0

    def run(name, cfg, want_tuple, want_logs, use_pk):
        nonlocal bad
        got, log = check_sdk_compatibility("probe", cfg, sdk_version, use_pk)
        why = []
        if tuple(got) != tuple(want_tuple):
            why.append(f"5 元组={tuple(got)} 期望 {want_tuple}")
        for level, needle in want_logs:
            if not any(level == lv and needle in msg for lv, msg in log):
                why.append(f"缺 {level} 日志 «{needle}»")
        if len(log) != len(want_logs):
            why.append(f"日志条数 {len(log)} 期望 {len(want_logs)}: {log}")
        if why:
            bad += 1
            print(f"FAIL {name}: " + "；".join(why))
        else:
            print(f"ok   {name} -> {got}")

    print(f"# r-neko §2 十组（SDK_VERSION={sdk_version}, {CITE}）")
    for name, cfg, compat, logs in TABLE_10:
        run(name, cfg, compat, logs, pk)
    print("# T1 陷阱组")
    run(TRAP_09X[0], TRAP_09X[1], TRAP_09X[2], TRAP_09X[3], pk)
    print("# 无 packaging 回退分支（pk=None 驱动）")
    for name, cfg, compat, logs in FALLBACK_CASES:
        run(name, cfg, compat, logs, None)

    # 形状存在性 + 钉值复核（AST/元数据，不 import 上游件）
    print("# 已装发行包形状存在性")
    bad += shape_checks(sdk_version, pins)
    if pk is None:
        bad += 1
        print("FAIL packaging 不在场：本闸按 pins 应在 neko-py311 里（==26.3）")
    else:
        # pins syntax_rules 的三条行为断言，直接用安装位 packaging 驱动
        for spec, ok in ((">=0.1.0,<0.2.0", True), ("0.2.0", False), ("0.1.*", False)):
            try:
                pk["SpecifierSet"](spec)
                valid = True
            except pk["InvalidSpecifier"]:
                valid = False
            if valid is not ok:
                bad += 1
                print(f"FAIL SpecifierSet({spec!r}) valid={valid} 期望 {ok}")
            else:
                print(f"ok   SpecifierSet({spec!r}) valid={valid}")

    print(f"\n{'SELFTEST FAILED: ' + str(bad) if bad else 'SELFTEST PASS'} (neko_sdk_spec_check, {CITE})")
    return 1 if bad else 0


def shape_checks(sdk_version: str, pins: dict) -> int:
    bad = 0
    spec = importlib.util.find_spec("plugin")
    if spec is None or not spec.submodule_search_locations:
        print("FAIL importlib.util.find_spec('plugin') 不可解析：必须用 ${ENVD}/neko-py311 的解释器跑")
        return 1
    root = list(spec.submodule_search_locations)[0].replace("\\", "/")

    def module_ast(relpath: str):
        with open(os.path.join(root, relpath), encoding="utf-8") as f:
            return ast.parse(f.read(), filename=relpath)

    # SDK_VERSION 常量 == pins.neko_sdk.sdk_version（钉死在 0.1.x 空间，§1.3-2）
    consts = module_ast("sdk/shared/constants.py")
    found = [n for n in consts.body if isinstance(n, ast.Assign)
             and any(isinstance(t, ast.Name) and t.id == "SDK_VERSION" for t in n.targets)]
    got = found[0].value.value if found and isinstance(found[0].value, ast.Constant) else None
    if got == sdk_version:
        print(f"ok   SDK_VERSION={got!r} == pins（{root}/sdk/shared/constants.py）")
    else:
        bad += 1
        print(f"FAIL 安装位 SDK_VERSION={got!r} != pins {sdk_version!r}：宿主升级需复核 pins")

    # 闸函数存在且返回标注 5 元组
    reg = open(os.path.join(root, "core", "registry.py"), encoding="utf-8").read()
    if "def _check_sdk_compatibility(" in reg and "tuple[bool," in reg:
        print("ok   _check_sdk_compatibility 存在且标注 tuple[bool,...] 返回")
    else:
        bad += 1
        print("FAIL registry.py 里找不到 _check_sdk_compatibility 或 5 元组标注（上游改名了）")

    # PluginSdkSchema 四字段存在（r-neko §3；schema.py 在 plugin/config/ 下）
    schema_path = os.path.join(root, "config", "schema.py")
    with open(schema_path, encoding="utf-8") as f:
        tree = ast.parse(f.read(), filename="schema.py")
    fields = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.ClassDef) and n.name == "PluginSdkSchema":
            fields = {m.target.id for m in n.body if isinstance(m, ast.AnnAssign) and isinstance(m.target, ast.Name)}
    need = {"recommended", "supported", "untested", "conflicts"}
    if need <= fields:
        print(f"ok   PluginSdkSchema 字段 ⊇ {sorted(need)}")
    else:
        bad += 1
        print(f"FAIL PluginSdkSchema 缺字段 {sorted(need - fields)}（实得 {sorted(fields)}）")

    want_pk = pins["python_buckets"]["neko_py311"]["packages"]["packaging"].lstrip("= ")
    got_pk = importlib.metadata.version("packaging")
    if got_pk == want_pk:
        print(f"ok   packaging=={got_pk} == pins")
    else:
        bad += 1
        print(f"FAIL packaging {got_pk} != pins {want_pk}")

    if not os.path.normcase(sys.executable).startswith(os.path.normcase(envd())):
        print(f"note 当前解释器 {sys.executable} 不在 {envd()} 下（用 PY311 跑）")
    return bad


def check_toml(path: str, pk) -> int:
    import tomllib
    with open(path, "rb") as f:
        data = tomllib.load(f)
    plugin_block = data.get("plugin", {})
    sdk_cfg = plugin_block.get("sdk")
    pins = json.load(open(PINS_PATH, encoding="utf-8"))
    got, log = check_sdk_compatibility(str(plugin_block.get("id", "?")), sdk_cfg,
                                       pins["neko_sdk"]["sdk_version"], pk)
    for level, msg in log:
        print(f"{level}: {msg}")
    print(f"compat={got[0]} tuple={got}")
    if not got[0]:
        print(f"结论：{path} 会被宿主拒载（{CITE}）")
        return 1
    declared = got[1]
    want = pins["neko_sdk"].get("declare_supported")
    if declared != want:
        print(f"note supported={declared!r} 与 pins declare_supported={want!r} 不一致（§3.4-1 钉法）")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="N.E.K.O [plugin.sdk] 版本闸离线复刻（离线、不启动宿主）")
    ap.add_argument("--selftest", action="store_true", help="跑 r-neko §2 十组反例 + 形状存在性检查")
    ap.add_argument("--toml", metavar="PATH", help="校验一个 plugin.toml 的 [plugin.sdk] 块")
    args = ap.parse_args()
    pk = load_packaging()
    if args.toml:
        return check_toml(args.toml, pk)
    return selftest(pk)


if __name__ == "__main__":
    sys.exit(main())
