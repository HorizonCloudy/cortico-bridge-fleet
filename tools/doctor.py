#!/usr/bin/env python3
"""doctor — 装机自检（蓝图 L145，G1 件）：宿主 sha/版本、端口占用、能力位三查。

用法:
  python -I tools/doctor.py               # 真检：对 spec/pins.json 比 repos + ports + 四桶
  python -I tools/doctor.py --self-test   # 假 scan 注入，全离线（不碰 git、不开端口、不起环境）
  python -I tools/doctor.py --strict      # 把「查不到」升级为失败

判据（可执行；「缺证据默认 0、--strict 升 1」的档位是建议值，待 云玩家 签字后定稿，gate G-K4-2）：
  端口按 pins 的 owner 分向（分类只落此处，spec/pins.json 为禁改件，gate G-K4-1）：
  - owner 含 "listen" = 桥监听口：占用与 pins 正面矛盾 → exit 1（反证 A：39701 被占仍 FAIL）；空闲=桥未起，装机前正常态，不记。
  - 其余 = 宿主口：占用=宿主在线（期望态），降为信息项，不触发 exit 1；空闲=宿主未起 → WARN，--strict 升 1。
  - 仓 sha「漂移」、能力位「不可得」= 正面矛盾 → exit 1，装机必须先消解；
  - 「查不到」= 缺证据不是有矛盾（缺宿主是装机前正常态，缺仓的硬闸归 gen_pins.py --check）→ exit 0。
  --strict 供装完后的终验：把全部 WARN（查不到、宿主未起）也按 1 处理。
端口探测只用 bind 探针（本机实测 connect 探针连开放端口也超时，WFP 吞 SYN，证据见
work-phase2/K4-fleet-doctor/recon.md §2）；bind 只证明探测瞬间该端口可绑。
能力位探针只 import SDK 标记符号，不起宿主、不联网；词表全量闸在 vocab_gate.py。
"""
import argparse
import errno
import json
import re
import socket
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I 不前置脚本目录，显式补上
from vocab_gate import clean_env  # 凭证摘除口径与词表闸同源（SECURITY-CBP §3.5）

PINS_DEFAULT = Path(__file__).resolve().parent.parent / "spec" / "pins.json"
OK, BAD, MISS = "一致", "漂移", "查不到"

# 每桶一个能力位标记（module, attr）与要报版本的发行包；标记名取自 vocab_gate 已钉的正向名单。
BUCKET_MARKERS = {
    "neko_py311": ([("plugin.sdk.shared.core.types", "PushMessageResult")], ["n-e-k-o"]),
    "maibot_py312": ([("maibot_sdk.capabilities.render", "RenderCapability")], ["maibot", "maibot-plugin-sdk"]),
    "astrbot_py312": ([("astrbot.api.star", "Star")], ["astrbot"]),
    "nonebot_py311": ([("nonebot", "get_driver")], ["nonebot2", "nonebot-adapter-onebot"]),
}
DIST2REPO = {"n-e-k-o": "neko", "maibot": "maibot", "maibot-plugin-sdk": "maibot-sdk",
             "astrbot": "astrbot", "nonebot2": "nonebot2", "nonebot-adapter-onebot": "adapter-onebot"}
VER_RE = re.compile(r"^v?(\d+(?:\.\d+)*)")

BUCKET_TPL = r'''
import importlib.metadata as md, importlib.util, json, sys
mods, dists = json.loads(sys.argv[1])
out = {"markers": [], "versions": []}
for m, a in mods:
    if importlib.util.find_spec(m) is None:
        out["markers"].append([m + ":" + a, "missing"]); continue
    try:
        mod = __import__(m, fromlist=["x"]); st = "ok" if hasattr(mod, a) else "broken"
    except Exception:
        st = "broken"
    out["markers"].append([m + ":" + a, st])
for d in dists:
    try:
        out["versions"].append([d, md.version(d)])
    except Exception:
        out["versions"].append([d, None])
print("DOCTORBUCKET " + json.dumps(out, ensure_ascii=False))
'''


def load_pins(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def expected_version(repos: dict, dist: str):
    m = VER_RE.match(str(repos.get(DIST2REPO.get(dist, ""), {}).get("version", "")))
    return m.group(1) if m else None


def check_repos(pins: dict, read_head) -> list[dict]:
    root = Path(pins["root"])
    rows = []
    for key, e in pins["repos"].items():
        sha = read_head(root / e["dir"])
        st = MISS if sha is None else (OK if sha == e["sha9"] else BAD)
        rows.append({"key": key, "dir": e["dir"], "want": e["sha9"], "got": sha, "status": st})
    return rows


def probe_port(port: int, proto: str) -> str:
    kind = socket.SOCK_STREAM if proto == "tcp" else socket.SOCK_DGRAM
    s = socket.socket(socket.AF_INET, kind)
    try:
        s.bind(("127.0.0.1", port))
        return "空闲"
    except OSError as e:
        w = getattr(e, "winerror", None)
        if w in (10048, 10049) or e.errno in (errno.EADDRINUSE, errno.EADDRNOTAVAIL):
            return "占用"  # bind 到 0.0.0.0 的监听者会挡住具体地址绑定，实测见 recon §2
        return "查不到"
    finally:
        s.close()


def check_ports(pins: dict, probe) -> list[dict]:
    rows = []
    for p in pins["ports"]:
        if p.get("port") is None:
            rows.append({"port": None, "proto": p.get("proto", "tcp"), "owner": p["owner"], "status": "跳过"})
            continue
        rows.append({"port": p["port"], "proto": p.get("proto", "tcp"), "owner": p["owner"],
                     "status": probe(p["port"], p.get("proto", "tcp"))})
    return rows


def probe_bucket_real(interp: str, spec: list, cwd: Path, env: dict | None):
    r = subprocess.run([interp, "-I", "-c", BUCKET_TPL, json.dumps(spec, ensure_ascii=False)],
                       capture_output=True, text=True, timeout=300, cwd=str(cwd), env=clean_env(env))
    if r.returncode != 0:
        return None
    for line in r.stdout.splitlines():
        if line.startswith("DOCTORBUCKET "):
            return json.loads(line[len("DOCTORBUCKET "):])
    return None


def check_buckets(pins: dict, probe_bucket) -> list[dict]:
    root = Path(pins["root"])
    rows = []
    for bname, (markers, dists) in BUCKET_MARKERS.items():
        b = pins["python_buckets"][bname]
        interp = Path(b["interpreter"])
        if not interp.exists():
            rows.append({"bucket": bname, "kind": "caps", "target": "*", "status": MISS,
                         "note": f"缺解释器 {interp}"})
            continue
        got = probe_bucket(str(interp), [markers, dists], root, b.get("env"))
        if got is None:
            # 探针进程失败/无输出 = 缺证据，不是矛盾（与「缺解释器」同档，docstring 判据第 4 条）。
            # 「不可得」只留给探针真跑起来并回报 broken 标记的场合——那才是正面矛盾。
            rows.append({"bucket": bname, "kind": "caps", "target": "*", "status": MISS,
                         "note": "探测进程失败或无 DOCTORBUCKET 行（缺证据）"})
            continue
        for tgt, st in got["markers"]:
            rows.append({"bucket": bname, "kind": "caps", "target": tgt,
                         "status": {"ok": "可得", "broken": "不可得", "missing": MISS}[st]})
        for dist, ver in got["versions"]:
            want = expected_version(pins["repos"], dist)
            if ver is None or want is None:
                rows.append({"bucket": bname, "kind": "ver", "target": dist, "status": MISS,
                             "want": want, "got": ver})
            else:
                rows.append({"bucket": bname, "kind": "ver", "target": dist,
                             "status": OK if ver == want else BAD, "want": want, "got": ver})
    return rows


def verdict(repos, ports, buckets, strict: bool):
    hard, warn = [], []
    for r in repos:
        line = f"sha[{r['key']}] {r['status']} pins={r['want']} live={r['got']} dir={r['dir']}"
        if r["status"] == BAD:
            hard.append(line)
        elif r["status"] == MISS:
            warn.append(line)
    for p in ports:
        if p["status"] == "跳过":
            continue  # pins 里 port=null 的自报项（Koishi），不是探测结果，不进两榜
        listen = "listen" in p["owner"]  # 方向取自 owner 文本；pins 禁改，分类不落数据（gate G-K4-1）。shortcut: 依赖 pins owner 措辞含 "listen", pins 表结构定稿时改读显式方向字段
        if p["status"] == "占用" and listen:
            hard.append(f"port[{p['port']}/{p['proto']}] 占用 owner={p['owner']}")
        elif p["status"] == "查不到":
            warn.append(f"port[{p['port']}/{p['proto']}] 查不到 owner={p['owner']}")
        elif p["status"] == "空闲" and not listen:
            warn.append(f"port[{p['port']}/{p['proto']}] 空闲=宿主未起 owner={p['owner']}")
        # 宿主口占用=期望态（信息项，main 已逐行打印）；监听口空闲=桥未起，装机前正常态，不记
    for b in buckets:
        label = f"{b['kind']}[{b['bucket']}:{b['target']}]"
        detail = f" pins={b.get('want')} live={b.get('got')}" if b["kind"] == "ver" else f" {b.get('note', '')}"
        if b["status"] in (BAD, "不可得"):
            hard.append(label + b["status"] + detail)
        elif b["status"] == MISS:
            warn.append(label + b["status"] + detail)
    code = 1 if hard or (strict and warn) else 0
    return code, hard, warn


def selftest(pins: dict) -> int:
    heads = {"d1": "aaaaaaaaa", "d2": "ccccccccc"}
    fake = {"root": "/nonexistent", "repos": {"x": {"dir": "d1", "sha9": "aaaaaaaaa"},
                                              "y": {"dir": "d2", "sha9": "bbbbbbbbb"},
                                              "z": {"dir": "d3", "sha9": "ddddddddd"}},
            "ports": [{"port": 1, "proto": "tcp", "owner": "cortico-world-x listen"},
                      {"port": 2, "proto": "udp", "owner": "neko VMC (OSC)"},
                      {"port": 3, "proto": "tcp", "owner": "MaiBot WebUI"},
                      {"port": None, "proto": "tcp", "owner": "koishi 自报"}]}
    repos = check_repos(fake, lambda d: heads.get(Path(str(d)).name))
    assert [r["status"] for r in repos] == [OK, BAD, MISS], repos
    probe = {1: "空闲", 2: "占用", 3: "空闲"}.get
    ports = check_ports(fake, probe)
    assert [p["status"] for p in ports] == ["空闲", "占用", "空闲", "跳过"], ports
    bprobe = lambda i, s, c, e: {"markers": [[f"{m}:{a}", "ok"] for m, a in s[0]],
                                 "versions": [[d, "9.9.9"] for d in s[1]]}
    f3 = {"root": "/nonexistent",
          "repos": {v: {"dir": "d", "sha9": "aaaaaaaaa", "version": "9.9.9"} for v in DIST2REPO.values()},
          "python_buckets": {k: {"interpreter": str(PINS_DEFAULT), "env": {}} for k in BUCKET_MARKERS}}
    buckets = check_buckets(f3, bprobe)
    assert buckets and all(b["status"] in (OK, "可得") for b in buckets), buckets
    code, hard, warn = verdict(repos, ports, buckets, strict=False)
    assert code == 1 and len(hard) == 1 and len(warn) == 2, (code, hard, warn)  # 监听口空闲不记、宿主口占用不记、宿主口空闲=WARN
    clean_r = [dict(r, status=OK, got=r["want"]) for r in repos]
    assert verdict(clean_r, ports, buckets, False)[0] == 0
    assert verdict(clean_r, ports, buckets, True)[0] == 1  # 宿主未起仅 strict 升
    host_up = [ports[0], ports[1], dict(ports[2], status="占用"), ports[3]]
    assert verdict(clean_r, host_up, buckets, True)[0] == 0  # gate G-K4-1：宿主口占用 strict 也不升
    assert verdict(repos, ports, buckets, True)[0] == 1
    assert verdict([], [{"port": 9, "proto": "tcp", "owner": "x", "status": "查不到"}], [], True)[0] == 1
    assert verdict([], [], [], False)[0] == 0
    assert check_ports(pins, lambda p, k: "空闲") and all(
        p["status"] == "跳过" for p in check_ports(pins, lambda x, y: "空闲") if p["port"] is None)
    print(f"SELF-TEST OK: repos 三态、ports 三态+null 跳过、buckets 一致态、判据 7 组（含端口分向与 strict）")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="doctor — 装机自检：sha/版本、端口、能力位")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")  # 控制台编码不含中文字符时降级为 ?，不崩
    ap.add_argument("--pins", type=Path, default=PINS_DEFAULT)
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--strict", action="store_true", help="缺宿主/缺仓等「查不到」也按失败")
    a = ap.parse_args(argv)
    pins = load_pins(a.pins)
    if a.self_test:
        return selftest(pins)
    root = Path(pins["root"])

    def read_head(d: Path):
        try:
            r = subprocess.run(["git", "-C", str(d), "rev-parse", "HEAD"],
                               capture_output=True, text=True, timeout=30)
            return r.stdout.strip()[:9] if r.returncode == 0 else None
        except (OSError, subprocess.TimeoutExpired):
            return None

    def bucket_probe(interp, spec, cwd, env):
        try:
            return probe_bucket_real(interp, spec, cwd, env)
        except (OSError, subprocess.TimeoutExpired, ValueError):
            return None

    repos = check_repos(pins, read_head)
    ports = check_ports(pins, probe_port)
    buckets = check_buckets(pins, bucket_probe)
    for r in repos + buckets:
        print(f"{r['status']:<3} " + (f"sha[{r.get('key')}]" if "key" in r else f"{r['kind']}[{r['bucket']}:{r['target']}]"))
    for p in ports:
        print(f"{p['status']:<3} port[{p['port'] or '-'}:{p['proto']}] owner={p['owner']}")
    code, hard, warn = verdict(repos, ports, buckets, a.strict)
    print(f"合计: 仓 {len(repos)} 端口 {len(ports)} 桶项 {len(buckets)}；正面矛盾 {len(hard)}，缺证据 {len(warn)}")
    for line in hard:
        print("FAIL " + line)
    for line in warn:
        print("WARN " + line)
    print("VERDICT " + ("PASS" if code == 0 else "FAIL") + ("（--strict）" if a.strict and warn else ""))
    return code


if __name__ == "__main__":
    sys.exit(main())
