"""doctor.py 单测：假 scan 注入，离线。不联网、不开真端口、不起宿主、不跑 git。

跑法（桥仓规矩：pytest 必须带路径）:
  <nb桶python> -I -m pytest tests/doctor -q
"""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("doctor", ROOT / "tools" / "doctor.py")
doctor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(doctor)

OK, BAD, MISS = doctor.OK, doctor.BAD, doctor.MISS

FAKE = {
    "root": "FAKEROOT",
    "repos": {
        "neko": {"dir": "upstream/neko", "sha9": "52e973ed2", "version": "0.9.1"},
        "maibot": {"dir": "upstream/maibot", "sha9": "478f671e6", "version": "1.4.5"},
        "cortico": {"dir": "repos/cortico", "sha9": "836238311", "version": "0.2.15"},
        "maibot-sdk": {"dir": "upstream/maibot-plugin-sdk", "sha9": "f9984673d", "version": "2.23.0"},
        "astrbot": {"dir": "repos/astrbot", "sha9": "133dd9f86", "version": "4.29.4"},
        "nonebot2": {"dir": "repos/nonebot2", "sha9": "2450b67a1", "version": "2.5.0"},
        "adapter-onebot": {"dir": "repos/adapter-onebot", "sha9": "8e0d1145a", "version": "2.4.6"},
    },
    # owner 带 "listen" 者是桥监听口，其余是宿主口——方向分类只落 doctor，pins 禁改（gate G-K4-1）
    "ports": [
        {"port": 39701, "proto": "tcp", "owner": "cortico-world-neko listen"},
        {"port": 48911, "proto": "tcp", "owner": "neko main HTTP（reply_tail 宿主端）"},
        {"port": 39539, "proto": "udp", "owner": "neko VMC (OSC)"},
        {"port": None, "proto": "tcp", "owner": "koishi 自报"},
    ],
}


def heads(rel):
    d = str(rel).replace("\\", "/")
    return {"FAKEROOT/upstream/neko": "52e973ed2", "FAKEROOT/upstream/maibot": "fffffffff"}.get(d)


def test_repos_three_states():
    rows = {r["key"]: r["status"] for r in doctor.check_repos(FAKE, heads)}
    assert {k: rows[k] for k in ("neko", "maibot", "cortico")} == {"neko": OK, "maibot": BAD, "cortico": MISS}


def test_ports_states_and_null_skip():
    rows = doctor.check_ports(FAKE, lambda p, k: {39701: "占用"}.get(p, "空闲"))
    assert [(r["port"], r["status"]) for r in rows] == [
        (39701, "占用"), (48911, "空闲"), (39539, "空闲"), (None, "跳过")]


def test_bucket_missing_interpreter_is_miss():
    pins = dict(FAKE, python_buckets={k: {"interpreter": "Q:/nope/python.exe", "env": {}}
                                      for k in doctor.BUCKET_MARKERS})
    rows = doctor.check_buckets(pins, lambda *a: None)
    assert rows and all(r["status"] == MISS and "缺解释器" in r["note"] for r in rows)


def bucket_probe_ok(interp, spec_, cwd, env):
    mods, dists = spec_
    return {"markers": [[f"{m}:{a}", "ok"] for m, a in mods],
            "versions": [[d, doctor.expected_version(FAKE["repos"], d)] for d in dists]}


def test_buckets_ok_and_broken_states():
    pins = dict(FAKE, python_buckets={k: {"interpreter": str(Path(__file__)), "env": {}}
                                      for k in doctor.BUCKET_MARKERS})
    rows = doctor.check_buckets(pins, bucket_probe_ok)
    assert len(rows) == 4 + 6 and all(r["status"] in (OK, "可得") for r in rows)
    broken = lambda i, s, c, e: {"markers": [["x:y", "broken"]], "versions": [["maibot", "9.9.9"]]}
    rows2 = doctor.check_buckets(pins, broken)
    assert {r["status"] for r in rows2} == {"不可得", BAD}, rows2
    dead = lambda i, s, c, e: None
    rows3 = doctor.check_buckets(pins, dead)
    # 探针跑不起来=缺证据（查不到，exit 0 档），不是正面矛盾。只有探针回报 broken 标记
    # 才算「不可得」→ hard。上面 rows2 那一支就是它。
    assert all(r["status"] == MISS for r in rows3), rows3
    assert all("探测进程失败" in r["note"] for r in rows3), rows3
    assert doctor.verdict([dict(r, status=OK) for r in doctor.check_repos(FAKE, heads)],
                          [], rows3, False)[0] == 0, "缺证据档不许升 exit 1"


def _clean():
    # 团队常态机基线：宿主口占用=宿主在线、桥监听口空闲=桥未起。doctor 必须在此态绿（gate G-K4-1）。
    repos = [dict(r, status=OK, got=r["want"]) for r in doctor.check_repos(FAKE, heads)]
    ports = doctor.check_ports(FAKE, lambda p, k: "空闲" if p == 39701 else "占用")
    return repos, ports


def test_verdict_listen_port_occupied_fails():
    # 39701 反证 A 的牙保留：桥监听口占用仍是唯一「占用即 hard」的方向。
    repos, ports = _clean()
    ports[0]["status"] = "占用"
    code, hard, warn = doctor.verdict(repos, ports, [], False)
    assert code == 1 and len(hard) == 1


def test_verdict_host_occupied_listen_free_exits_zero():
    # gate 必补的一例：宿主口 48911 占用 + 监听口 39701 空闲 → 默认 exit 0，strict 也不升（期望态非缺证）。
    repos, ports = _clean()
    code, hard, warn = doctor.verdict(repos, ports, [], False)
    assert code == 0 and not hard and not warn, (code, hard, warn)
    assert doctor.verdict(repos, ports, [], True)[0] == 0


def test_verdict_host_port_free_warns_not_fails():
    # 宿主口空闲=宿主未起=WARN：默认 0，--strict 升 1；监听口空闲不进榜。
    repos, ports = _clean()
    for p in ports:
        p["status"] = "跳过" if p["port"] is None else "空闲"
    code, hard, warn = doctor.verdict(repos, ports, [], False)
    assert code == 0 and not hard and len(warn) == 2, (code, hard, warn)
    assert doctor.verdict(repos, ports, [], True)[0] == 1


def test_verdict_missing_host_warns_but_exits_zero():
    # 「查不到→exit 0」为建议档（gate G-K4-2），待 云玩家 签字；政策变更只动此处判据与文档措辞。
    repos, ports = _clean()
    repos[2]["status"], repos[2]["got"] = MISS, None
    code, hard, warn = doctor.verdict(repos, ports, [], False)
    assert code == 0 and not hard and len(warn) == 1
    code_strict, _, _ = doctor.verdict(repos, ports, [], True)
    assert code_strict == 1


def test_real_pin_shape_ports_have_one_null_row():
    pins = doctor.load_pins(ROOT / "spec" / "pins.json")
    rows = doctor.check_ports(pins, lambda p, k: "空闲")
    assert sum(1 for r in rows if r["port"] is None) == 1
    assert sum(1 for r in rows if r["port"] is not None) == len(pins["ports"]) - 1
