#!/usr/bin/env python3
"""gen_pins — 刷新 spec/pins.json 各仓 sha9（对钉住克隆跑 git rev-parse HEAD）。

用法:
  python -I tools/gen_pins.py --check   # 只比不改；全部一致 exit 0
  python -I tools/gen_pins.py           # 把漂移的 sha9 写回 pins.json
  python -I tools/gen_pins.py --self-test  # 离线自检（不碰 git），隔离环境外可跑

F13（SECURITY-CBP §4）：`validate` 同时闸 caps 段与 vocab.cbp.caps——缺段、缺线、
action 非三值、非 null 值缺「文件:行」来源、词表与 spec/CBP-v1.json 不一致，都非零退出；
写模式把 vocab.cbp.caps 从 CBP-v1.json $defs.caps 生成回 pins.json（caps 六数只能带证件手钉）。

只读边界：仅调用 `git rev-parse HEAD`；不 fetch、不改远端。
"""
import argparse
import copy
import json
import re
import subprocess
import sys
from pathlib import Path

SHA9 = re.compile(r"^[0-9a-f]{9}$")
PINS_DEFAULT = Path(__file__).resolve().parent.parent / "spec" / "pins.json"
CAP_LINES = ("cbp", "neko", "maibot", "astrbot", "onebot")
CAP_KEYS = ("frame_bytes", "text_bytes", "media_bytes", "action")
CAP_ACTIONS = {"reject", "host-ask", "degrade"}
CITE_RE = re.compile(r"[A-Za-z0-9_./\\-]+:\d+")  # 来源必须长成 文件:行（可带范围）


def load_pins(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def schema_caps_vocab(cbp_file: Path):
    """词表生成源：spec/CBP-v1.json $defs.caps description 的 Vocabulary 行（c1 §5.5）。"""
    try:
        j = json.loads(cbp_file.read_text(encoding="utf-8"))
        m = re.search(r"Vocabulary = ([a-z_,]+)", j["$defs"]["caps"]["description"])
        return m.group(1).split(",") if m else None
    except (OSError, KeyError, TypeError, ValueError):
        return None


def validate_caps(pins: dict, spec_dir: Path) -> list[str]:
    """F13 闸：顶层 caps 段 + vocab.cbp.caps，缺段或来源缺失都算错（非零退出）。"""
    errs = []
    caps = pins.get("caps")
    if not isinstance(caps, dict):
        errs.append("缺顶层 caps 段（F13，SECURITY-CBP.md §4.2）")
        caps = {}
    notes = caps.get("notes")
    if not isinstance(notes, dict):
        errs.append("caps.notes 缺（null 必须配说明）")
        notes = {}
    for k in ("unit", "unverified"):
        if not (isinstance(notes.get(k), str) and notes[k].strip()):
            errs.append(f"caps.notes.{k} 缺（口径与未核验台账，SECURITY-CBP.md:178-185）")
    for line in CAP_LINES:
        e = caps.get(line)
        if not isinstance(e, dict):
            errs.append(f"caps.{line} 缺线（五条线一个不能少）")
            continue
        if set(e) != set(CAP_KEYS):
            errs.append(f"caps.{line} 键集必须恰为 {list(CAP_KEYS)}，实为 {sorted(e)}")
            continue
        if e["action"] not in CAP_ACTIONS:
            errs.append(f"caps.{line}.action 非法: {e['action']!r}（三值限定）")
        for f in ("frame_bytes", "text_bytes", "media_bytes"):
            v = e[f]
            note = notes.get(f"{line}_{f}")
            if v is None:
                if not (isinstance(note, str) and note.strip()):
                    errs.append(f"caps.{line}.{f}=null 缺 notes.{line}_{f} 未测理由（[未核验]）")
                continue
            if isinstance(v, bool) or not isinstance(v, int) or v <= 0:
                errs.append(f"caps.{line}.{f} 非正整数: {v!r}")
            elif not (isinstance(note, str) and CITE_RE.search(note)):
                errs.append(f"caps.{line}.{f}={v} 缺来源（notes.{line}_{f} 必须带 文件:行）")
        if line == "cbp" and e.get("frame_bytes") is None:
            errs.append("caps.cbp.frame_bytes 不许 null（内核 maxPayload 唯一数）")
    names = pins.get("vocab", {}).get("cbp", {}).get("caps")
    if (not isinstance(names, list) or not names
            or not all(isinstance(s, str) and s for s in names)
            or len(names) != len(set(names))):
        errs.append("vocab.cbp.caps 缺失或非「非空不重复字符串数组」")
        names = None
    schema = schema_caps_vocab(spec_dir / "CBP-v1.json")
    if schema is None:
        errs.append(f"词表生成源缺失：读不到 {spec_dir / 'CBP-v1.json'} 的 $defs.caps Vocabulary 行")
    elif names is not None and names != schema:
        errs.append(f"vocab.cbp.caps 与 CBP-v1.json 词表不一致: {names} != {schema}")
    return errs


def git_head9(clone_dir: Path) -> str:
    out = subprocess.run(
        ["git", "-C", str(clone_dir), "rev-parse", "HEAD"],
        capture_output=True, text=True, timeout=30,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or f"not a git repo: {clone_dir}")
    return out.stdout.strip()[:9]


def compare(pins: dict, read_head) -> tuple[list[str], dict[str, str]]:
    """read_head(dir_rel) -> sha9 或 None（缺仓/缺 git）。返回 (问题行, 新值表)。"""
    problems, fresh = [], {}
    for key, entry in pins["repos"].items():
        sha = read_head(entry["dir"])
        if sha is None:
            problems.append(f"{key}: 无法读取 {entry['dir']}（缺仓或无 git）")
        elif sha != entry["sha9"]:
            problems.append(f"{key}: pins={entry['sha9']} live={sha}（dir={entry['dir']}）")
            fresh[key] = sha
    return problems, fresh


def validate(pins: dict, spec_dir: Path = PINS_DEFAULT.parent) -> list[str]:
    """结构自检：pins.json 自身格式与一致性，不依赖 git。"""
    errs = []
    if pins.get("schema") != "cortico-bridge-fleet/pins/1":
        errs.append("schema 字段不符")
    errs += validate_caps(pins, spec_dir)
    for key, e in pins["repos"].items():
        if not SHA9.match(e.get("sha9", "")):
            errs.append(f"repos.{key}.sha9 非 9 位十六进制: {e.get('sha9')!r}")
        for req in ("dir", "remote", "branch"):
            if not e.get(req):
                errs.append(f"repos.{key} 缺 {req}")
    dirs = [e.get("dir", "") for e in pins["repos"].values()]
    if len(dirs) != len(set(dirs)):
        errs.append("repos 有重复 dir")
    ports = [p["port"] for p in pins["ports"] if p.get("port") is not None]
    if len(ports) != len(set((p["port"], p.get("proto", "tcp")) for p in pins["ports"] if p.get("port") is not None)):
        errs.append("ports 有重复 (port,proto)")
    for p in pins["ports"]:
        if p.get("port") is not None and not (0 < p["port"] < 65536):
            errs.append(f"ports 非法端口 {p['port']}")
        if "bind" not in p:
            errs.append(f"ports[{p.get('port')}] 缺绑定面列（C1-8）")
    v = pins["vocab"]
    n = len(v["maibot"]["capabilities"])
    if n != v["maibot"]["capabilities_len"]:
        errs.append(f"vocab.maibot capabilities {n} != 声称 {v['maibot']['capabilities_len']}")
    if len(v["nonebot"]["v11_actions"]) != v["nonebot"]["v11_actions_len"]:
        errs.append("vocab.nonebot v11_actions 数与声称不符")
    if "atall" in v["maibot"]["capabilities"] or "atall" in v["nonebot"]["v11_actions"]:
        errs.append("禁用名混进了正向名单")
    sup = pins["neko_sdk"]["declare_supported"]
    if not re.fullmatch(r"(>=|<=|==|~=|>|<)\d+(\.\d+)+(\s*,\s*(>=|<=|==|~=|>|<)\d+(\.\d+)+)*", sup):
        errs.append(f"neko_sdk.declare_supported 非比较符+版本语法: {sup!r}")
    for pkg, e in pins["npm_pins"].items():
        if e["version"] in ("latest", "next") or "^" in e["version"] or "~" in e["version"]:
            errs.append(f"npm_pins.{pkg} 非精确版本（禁 latest，C1-13）: {e['version']}")
    return errs


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pins", type=Path, default=PINS_DEFAULT)
    ap.add_argument("--check", action="store_true", help="只比不改")
    ap.add_argument("--self-test", action="store_true", help="离线自检，不跑 git")
    a = ap.parse_args(argv)

    pins = load_pins(a.pins)
    # 写模式生成侧（F13）：vocab.cbp.caps 从 spec/CBP-v1.json $defs.caps 重新生成；
    # caps 六数不自动生成——那是证件逐条钉的取值（notes 文件:行），生成侧无机器可推来源。
    vocab_drift = False
    if not (a.check or a.self_test):
        schema = schema_caps_vocab(a.pins.parent / "CBP-v1.json")
        if schema is not None:
            cbp_vocab = pins.setdefault("vocab", {}).setdefault("cbp", {})
            if cbp_vocab.get("caps") != schema:
                cbp_vocab["caps"] = schema
                vocab_drift = True
    errs = validate(pins, a.pins.parent)
    if errs and not a.self_test:
        print("pins.json 结构错误:\n  " + "\n  ".join(errs))
        return 1

    if a.self_test:
        # 用合成 pins 验证 compare 能抓漂移、缺仓、一致三种态，不依赖真实 git。
        fake = {"repos": {"x": {"dir": "d1", "sha9": "aaaaaaaaa"}, "y": {"dir": "d2", "sha9": "bbbbbbbbb"}}}
        heads = {"d1": "aaaaaaaaa", "d2": "ccccccccc"}
        probs, fresh = compare(fake, lambda d: heads.get(d))
        assert len(probs) == 1 and fresh == {"y": "ccccccccc"}, probs
        probs, fresh = compare(fake, lambda d: None)
        assert len(probs) == 2 and not fresh, probs
        probs, fresh = compare(fake, lambda d: {"d1": "aaaaaaaaa", "d2": "bbbbbbbbb"}[d])
        assert not probs and not fresh
        assert validate(pins) == [], f"真 pins.json 结构自检失败: {validate(pins)}"
        assert validate({"repos": {"k": {"sha9": "ZZZZ"}}, "ports": [], "vocab": {"maibot": {"capabilities": [], "capabilities_len": 0}, "nonebot": {"v11_actions": [], "v11_actions_len": 0}}, "neko_sdk": {"declare_supported": "0.1.0"}, "npm_pins": {}}), "validate 未抓坏输入"
        # caps/vocab 反例组（F13）：每条都必须被 validate_caps 抓到
        bad_cases = {
            "缺 caps 段": lambda p: p.pop("caps"),
            "cbp.frame_bytes null": lambda p: p["caps"]["cbp"].__setitem__("frame_bytes", None),
            "action 非法值": lambda p: p["caps"]["neko"].__setitem__("action", "explode"),
            "字节数写字符串": lambda p: p["caps"]["astrbot"].__setitem__("media_bytes", "6291456"),
            "缺一条线": lambda p: p["caps"].pop("onebot"),
            "多一键": lambda p: p["caps"]["cbp"].__setitem__("blob_bytes", 1),
            "非 null 值缺文件:行来源": lambda p: p["caps"]["notes"].__setitem__("onebot_text_bytes", "平台没实测"),
            "null 值缺未测理由": lambda p: p["caps"]["notes"].pop("maibot_frame_bytes"),
            "词表整段缺失": lambda p: p["vocab"]["cbp"].pop("caps"),
            "词表与 schema 漂移": lambda p: p["vocab"]["cbp"].__setitem__("caps", ["images"]),
        }
        for what, mutate in bad_cases.items():
            q = copy.deepcopy(pins)
            mutate(q)
            errs = validate_caps(q, PINS_DEFAULT.parent)
            assert errs, f"caps 反例未被抓到: {what}"
        assert schema_caps_vocab(PINS_DEFAULT.parent / "CBP-v1.json") == pins["vocab"]["cbp"]["caps"]
        print(f"SELF-TEST OK: {len(pins['repos'])} 仓、{len(pins['ports'])} 端口、{pins['vocab']['maibot']['capabilities_len']} 能力名、caps 反例 {len(bad_cases)} 组、自检断言 5 组")
        return 0

    root = Path(pins["root"])
    def read_head(rel: str):
        d = root / rel
        if not (d / ".git").exists() and not d.is_dir():
            return None
        try:
            return git_head9(d)
        except Exception:
            return None

    problems, fresh = compare(pins, read_head)
    if a.check:
        if problems:
            print("sha9 漂移/缺仓:\n  " + "\n  ".join(problems))
            return 1
        print(f"--check OK: {len(pins['repos'])} 仓 sha9 一致；caps {len([k for k in pins['caps'] if k != 'notes'])} 线 + vocab.cbp.caps {len(pins['vocab']['cbp']['caps'])} 名（闸在 validate，缺段/缺源到不了这里）")
        return 0
    if not fresh and not vocab_drift:
        print("无漂移，pins.json 未改动。" + (f"（另有 {len(problems)} 条不可读）" if problems else ""))
        return 0 if not problems else 1
    for k, s in fresh.items():
        pins["repos"][k]["sha9"] = s
    with open(a.pins, "w", encoding="utf-8") as f:
        json.dump(pins, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("已刷新 " + ", ".join(f"{k}->{s}" for k, s in fresh.items())
          + ("；vocab.cbp.caps 已按 CBP-v1.json 重新生成" if vocab_drift else "")
          + "。行号引用需按新 sha 复核后方可写码。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
