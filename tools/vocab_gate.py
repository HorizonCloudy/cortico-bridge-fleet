#!/usr/bin/env python3
"""vocab_gate — 词表存在性闸（G3）：对隔离环境里的发行包安装件，断言 pins.json 引用的 API 名与枚举值仍在。

用法:
  python -I tools/vocab_gate.py --self-test   # 离线自检：只验 pins.json 词表与判定引擎，不碰任何环境
  python -I tools/vocab_gate.py --all         # 四套 Python 桶 + Koishi Node 面（只 import，不 start、不安装、不联网）
  python -I tools/vocab_gate.py --only neko,koishi

反向断言（台账 §2）：ComponentTypes.atall、顶层 MaiMessages、core.PluginContext.finish、
Session.prototype.send、ctx.off、rc 顶层 z/Schema —— 必须不存在，复现即红。
盲区（如实）：查的是发布产物，HEAD 已合未发的改名看不见——与 gen_pins.py 的 sha 快照并联使用。
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

PINS_DEFAULT = Path(__file__).resolve().parent.parent / "spec" / "pins.json"
CRED_ENV = ["NEKO_TOKEN", "ASTRBOT_TOKEN", "ONEBOT_ACCESS_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
            "DEEPSEEK_API_KEY", "ZHIPU_API_KEY", "TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN",
            "MAIN_SERVER_PORT", "MEMORY_SERVER_PORT", "MONITOR_SERVER_PORT", "COMMENTER_SERVER_PORT",
            "TOOL_SERVER_PORT", "USER_PLUGIN_SERVER_PORT", "NEKO_USER_PLUGIN_SERVER_PORT",
            "NEKO_ZMQ_SESSION_PUB_PORT", "NEKO_ZMQ_AGENT_PUSH_PORT", "NEKO_ZMQ_ANALYZE_PUSH_PORT",
            "NEKO_MESSAGE_PLANE_RPC_ENDPOINT", "NEKO_MESSAGE_PLANE_PUB_ENDPOINT", "NEKO_MESSAGE_PLANE_INGEST_ENDPOINT",
            "MAIBOT_INSTANCE_DIR", "CORTICO_EXTENSIONS_DIR", "MONITOR_HOST"]

PY_TPL = r'''
import importlib, json, sys, typing
from pathlib import Path
spec = json.loads(sys.argv[1])
out = []
def chain(mod, dotted):
    cur = mod
    for p in dotted.split("."):
        cur = getattr(cur, p)
    return cur
def resolve(mod, attr):
    """attr 支持 a.b.c、xxx_len（对链尾取 len）、get_args:Xxx（typing 展开）。"""
    if attr.endswith("|len"):
        return len(chain(mod, attr[:-4]))
    if attr.startswith("get_args:"):
        return sorted(typing.get_args(chain(mod, attr[9:])))
    return chain(mod, attr)
for t in spec.get("present", []):
    try:
        if t["attr"]:
            resolve(importlib.import_module(t["module"]), t["attr"])
        else:
            importlib.import_module(t["module"])
        ok = True
    except Exception:
        ok = False
    out.append({"kind": "present", "target": t["module"] + (":" + t["attr"] if t["attr"] else ""), "ok": ok})
for t in spec.get("absent", []):
    try:
        resolve(importlib.import_module(t["module"]), t["attr"])
        ok = True
    except Exception:
        ok = False
    out.append({"kind": "absent", "target": t["module"] + ":" + t["attr"], "ok": ok})
for t in spec.get("value", []):
    try:
        got = resolve(importlib.import_module(t["module"]), t["attr"])
    except Exception as e:
        got = "<err %s>" % type(e).__name__
    if isinstance(got, (list, tuple, set, frozenset)):
        norm, want = sorted(got), sorted(t["want"])
    else:
        norm, want = got, t["want"]
    out.append({"kind": "value", "target": t["module"] + ":" + t["attr"], "ok": norm == want,
                "got": str(got)[:60], "want": t["want"]})
for t in spec.get("pyi", []):
    try:
        p = Path(importlib.import_module(t["module"]).__file__).with_suffix(".pyi")
        text = p.read_text(encoding="utf-8")
        for n in t["names"]:
            out.append({"kind": "present", "target": p.name + ":def " + n, "ok": ("def %s(" % n) in text or ("def %s (" % n) in text})
    except Exception as e:
        out.append({"kind": "present", "target": t["module"] + " .pyi 读取", "ok": False})
print("VOCABRESULT " + json.dumps(out, ensure_ascii=False))
'''

NODE_TPL = r'''
const spec = JSON.parse(process.argv[1]);
const out = [];
const get = (root, dotted) => dotted.split(".").reduce((o, p) => (o == null ? undefined : o[p]), root);
const emit = (kind, target, ok, got, want) => out.push({kind, target, ok, got: got === undefined ? "undefined" : String(got).slice(0, 60), want});
for (const t of spec.modules || []) {
  let m;
  try { m = require(t.name); } catch (e) { emit("present", t.name + " import", false, String(e).slice(0, 80)); continue; }
  for (const n of t.present || []) emit("present", t.name + "." + n, get(m, n) !== undefined);
  for (const a of t.absent || []) emit("absent", t.name + "." + a, get(m, a) !== undefined);
  for (const v of t.value || []) {
    let got; try { got = get(m, v.attr); } catch (e) { got = "<err>"; }
    if (v.len !== undefined) emit("value", t.name + ":" + v.attr, got && Object.keys(got).length === v.len, got && Object.keys(got).length, v.len);
    else if (v.eq !== undefined) emit("value", t.name + ":" + v.attr, JSON.stringify(got) === JSON.stringify(v.eq), got, v.eq);
  }
}
for (const c of spec.ctor || []) {
  const [mn, cn] = c.new.split(":");
  let inst, err = null;
  try { inst = new (get(require(mn), cn))(c.arg ?? {}); } catch (e) { err = String(e).slice(0, 80); }
  (c.then || []).forEach((p, i) => {
    const t = err ? "<ctor " + err + ">" : (get(inst, p) === undefined ? "undefined" : typeof get(inst, p));
    emit("value", c.new + "." + p, t === c.want[i], t, c.want[i]);
  });
}
console.log("VOCABRESULT " + JSON.stringify(out));
'''


def load_pins(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def clean_env(overrides: dict | None = None) -> dict:
    env = dict(os.environ)
    for k in CRED_ENV:
        env.pop(k, None)
    env.update(overrides or {})
    return env


def judge(results: list[dict]) -> tuple[bool, list[str]]:
    bad = []
    for item in results:
        if item["kind"] == "present" and not item["ok"]:
            bad.append(f"缺名 {item['target']}")
        elif item["kind"] == "value" and not item["ok"]:
            bad.append(f"值漂移 {item['target']}: 实得 {item.get('got')!r} ≠ 钉 {item.get('want')!r}")
        elif item["kind"] == "absent" and item["ok"]:
            bad.append(f"禁用名复现 {item['target']}")
    return (not bad, bad)


def parse_probe(stdout: str) -> list[dict]:
    for line in stdout.splitlines():
        if line.startswith("VOCABRESULT "):
            return json.loads(line[len("VOCABRESULT "):])
    raise ValueError("探测输出无 VOCABRESULT 行（宿主启动噪声之外的失败）")


def build_specs(p: dict) -> dict[str, dict]:
    neko, mab, ast_, nb, ko = (p["vocab"][k] for k in ("neko", "maibot", "astrbot", "nonebot", "koishi"))
    return {
        "neko": {
            "present": [{"module": "plugin.sdk.plugin", "attr": n} for n in neko["sdk_names"]] + [
                {"module": "plugin.sdk.plugin", "attr": "__all__"},
                {"module": "plugin.sdk.shared.core.push_message_schema", "attr": "translate_push_message"},
                {"module": "plugin.config.schema", "attr": "PluginConfigSchema"},
                {"module": "plugin.config.schema", "attr": "PluginRuntimeSchema"},
                {"module": "plugin.core.registry", "attr": "_check_sdk_compatibility"},
                {"module": "plugin.sdk.shared.core.types", "attr": "PushMessageResult"},
            ],
            "absent": neko["absent"],
            "value": [
                {"module": "plugin.sdk.plugin", "attr": "__all__|len", "want": neko["sdk_all_len"]},
                {"module": "plugin.sdk.shared.constants", "attr": "SDK_VERSION", "want": neko["constants"]["SDK_VERSION"]},
                {"module": "config.application", "attr": "APP_VERSION", "want": neko["constants"]["APP_VERSION"]},
                {"module": "plugin.sdk.shared.core.push_message_schema", "attr": "SCHEMA_VERSION", "want": neko["constants"]["SCHEMA_VERSION"]},
                {"module": "plugin.sdk.shared.core.push_message_schema", "attr": "VISIBILITY_VALUES", "want": neko["visibility"]},
                {"module": "plugin.sdk.shared.core.push_message_schema", "attr": "AI_BEHAVIOR_VALUES", "want": neko["ai_behavior"]},
                {"module": "plugin.sdk.shared.core.push_message_schema", "attr": "DEPRECATION_REMOVAL_VERSION", "want": neko["constants"]["DEPRECATION_REMOVAL_VERSION"]},
                {"module": "plugin.message_plane.protocol", "attr": "PROTOCOL_VERSION", "want": neko["constants"]["PROTOCOL_VERSION"]},
                {"module": "plugin.message_plane.protocol", "attr": "get_args:RpcOp", "want": neko["rpc_ops"]},
                {"module": "plugin.sdk.shared.core.types", "attr": "get_args:PushMessageFailureReason", "want": neko["push_failure_reasons"]},
            ],
        },
        "maibot": {
            "present": [{"module": "maibot_sdk", "attr": n} for n in mab["sdk_names"]] + [
                {"module": "maibot_sdk.messages", "attr": "MaiMessages"},
                {"module": "maibot_sdk.messages", "attr": "MessageSegment"},
                {"module": "maibot_sdk.compat.apis", "attr": None},
                {"module": "maibot_sdk.types", "attr": "EventType.ON_MESSAGE"},
                {"module": "maibot_sdk.types", "attr": "MessageGatewayRouteType.DUPLEX"},
                {"module": "maibot_sdk.capabilities.render", "attr": "RenderCapability.html2png"},
                {"module": "maibot_sdk.capabilities.gateway", "attr": "GatewayCapability.route_message"},
                {"module": "maibot_sdk.capabilities.gateway", "attr": "GatewayCapability.receive_external_message"},
                {"module": "src.plugin_runtime.runner.manifest_validator", "attr": "ManifestValidator"},
                {"module": "src.common.paths", "attr": "third_party_plugin_root"},
            ],
            "absent": mab["absent"],
            "value": [
                {"module": "maibot_sdk", "attr": "__all__|len", "want": mab["sdk_all_len"]},
                {"module": "maibot_sdk.compat._import_hook", "attr": "_MODULE_MAP|len", "want": 35},
                {"module": "maibot_sdk.context", "attr": "_ALLOWED_RAW_HOST_METHODS", "want": mab["raw_host_methods"]},
                {"module": "maibot_sdk.context", "attr": "_CAPABILITY_RESULT_KEYS|len", "want": mab["result_keys_len"]},
                {"module": "src.plugin_runtime.runner.manifest_validator", "attr": "ManifestValidator.SUPPORTED_MANIFEST_VERSIONS", "want": [2]},
            ],
        },
        "astrbot": {
            "present": [{"module": "astrbot.api.star", "attr": n} for n in ast_["names"][:4]] + [
                {"module": "astrbot.api.event", "attr": None},
                {"module": "astrbot.core.message.components", "attr": "ComponentTypes"},
                {"module": "astrbot.core.star.register", "attr": "register_llm_tool"},
                {"module": "astrbot.core.star.register", "attr": "register_button_action"},
                {"module": "astrbot.core.platform.astrbot_message", "attr": "AstrBotMessage"},
            ],
            "absent": ast_["absent"],
            "value": [
                {"module": "astrbot.core.star.register", "attr": "__all__|len", "want": ast_["register_all_len"]},
                {"module": "astrbot.api.event.filter", "attr": "__all__|len", "want": ast_["filter_all_len"]},
                {"module": "astrbot.core.message.components", "attr": "ComponentTypes|len", "want": ast_["component_types_keys_len"]},
                {"module": "astrbot.core.message.components", "attr": "ComponentType|len", "want": ast_["component_type_len"]},
                {"module": "astrbot.core.star.star_handler", "attr": "EventType|len", "want": ast_["event_type_len"]},
            ],
        },
        "nonebot": {
            "present": [{"module": "nonebot.adapters.onebot.v11.event", "attr": n} for n in nb["v11_event_leaves"]] + [
                {"module": "nonebot", "attr": "get_driver"},
                {"module": "nonebot.adapters.onebot.v11", "attr": "Bot"},
                {"module": "nonebot.adapters.onebot.v11", "attr": "Event"},
            ],
            "absent": [],
            "value": [],
            "pyi": [{"module": "nonebot.adapters.onebot.v11.bot", "names": nb["v11_actions"]}],
        },
        "koishi": None,  # 走 node，见 build_node_specs
    }


def build_node_specs(p: dict) -> list[tuple[str, Path, dict]]:
    nb = p["vocab"]["nonebot"]
    ko = p["vocab"]["koishi"]
    env = Path(p["root"]).parent / "botfw-envs" / "koishi-node"
    v3 = {
        "modules": [
            {"name": "cordis", "present": ["Context", "Service", "z", "Schema", "ScopeStatus", "ForkScope"]},
            {"name": "@satorijs/core", "present": ["Session", "Bot", "Context"],
             "absent": ["Session.prototype.send"], "note": "C1-4 反向断言"},
            {"name": "@satorijs/protocol", "value": [{"attr": "Methods", "len": ko["satori_methods_len"]}]},
            {"name": "koishi", "present": ["Context"]},
            {"name": "koishi-plugin-adapter-onebot", "present": ["OneBot.adaptSession"]},
        ],
        "ctor": [{"new": "cordis:Context", "then": ["on", "off", "plugin", "use"],
                  "want": ["function", "undefined", "function", "undefined"],
                  "note": "off 两线皆无（forbidden）；v3 无 ctx.use（C1-14）"}],
    }
    rc = {
        "modules": [{"name": "cordis", "present": ["Context"], "absent": ["z", "Schema", "ScopeStatus", "ForkScope", "MainScope"],
                     "note": "rc 顶层断链清单 = vocab.koishi.forbidden.cordis_rc"}],
        "ctor": [{"new": "cordis:Context", "then": ["use", "off"], "want": ["function", "undefined"]}],
    }
    return [("koishi-v3", env, v3), ("cordis-rc", env / "cordis-v4", rc)]


def run_env(name: str, interp: str, spec: dict, cwd: Path | None, overrides: dict | None = None) -> tuple[bool, list[str]]:
    r = subprocess.run([interp, "-I", "-c", PY_TPL, json.dumps(spec, ensure_ascii=False)],
                       capture_output=True, text=True, timeout=300, cwd=str(cwd) if cwd else None, env=clean_env(overrides))
    if r.returncode != 0:
        return (False, [f"探测进程 exit {r.returncode}: {r.stderr.strip()[-300:]}"])
    try:
        return judge(parse_probe(r.stdout))
    except ValueError as e:
        return (False, [str(e)])


def run_node(env_dir: Path, spec: dict) -> tuple[bool, list[str]]:
    r = subprocess.run(["node", "-e", NODE_TPL, "--", json.dumps(spec, ensure_ascii=False)],
                       capture_output=True, text=True, timeout=120, cwd=str(env_dir), env=clean_env())
    if r.returncode != 0:
        return (False, [f"探测进程 exit {r.returncode}: {r.stderr.strip()[-200:]}"])
    try:
        return judge(parse_probe(r.stdout))
    except ValueError as e:
        return (False, [str(e)])


def selftest(pins: dict) -> int:
    # 1) 判定引擎：present 缺 / value 漂 / absent 复现 都要红，合成全绿要绿。
    ok, bad = judge([{"kind": "present", "target": "x", "ok": True}, {"kind": "value", "target": "y", "ok": True}])
    assert ok and not bad
    ok, bad = judge([{"kind": "present", "target": "a.b", "ok": False},
                     {"kind": "value", "target": "c", "ok": False, "got": "0.9.9", "want": "0.1.0"},
                     {"kind": "absent", "target": "ComponentTypes.atall", "ok": True}])
    assert not ok and len(bad) == 3, bad
    assert "VOCABRESULT" in PY_TPL and "VOCABRESULT" in NODE_TPL
    # 2) pins 词表自洽。
    v = pins["vocab"]
    assert len(v["maibot"]["capabilities"]) == 103 == v["maibot"]["capabilities_len"]
    assert "render.html2png" in v["maibot"]["capabilities"], "藏名单必须在 universe 里"
    assert len(v["nonebot"]["v11_actions"]) == 38 and len(v["nonebot"]["v11_event_leaves"]) == 17
    assert len(v["neko"]["rpc_ops"]) == 8 and len(v["neko"]["push_failure_reasons"]) == 4
    ns = {c.split(".")[0] for c in v["maibot"]["capabilities"]}
    assert set(v["maibot"]["capability_proxies"]) <= ns | {"db", "gateway"}, "代理名应能对上能力命名空间"
    assert "0.9" not in pins["neko_sdk"]["declare_supported"], "supported 只许钉 SDK 0.1.x 空间（T1）"
    forb = {m["attr"] for sec in ("neko", "maibot", "astrbot") for m in v[sec]["absent"]}
    assert {"PluginContext.finish", "MaiMessages", "ComponentTypes.atall", "MessageSegment", "Message"} <= forb
    for pkg, e in pins["npm_pins"].items():
        assert e["version"] not in ("latest", "next"), f"{pkg} 钉了 latest（C1-13 禁）"
    assert pins["node"]["min"] == "22.16.0"
    specs = build_specs(pins)
    assert sum(len(s["value"]) + len(s["present"]) for s in specs.values() if s) >= 60, "名单太薄，闸无牙"
    print(f"SELF-TEST OK: 引擎 2 组、pins 断言 12 组；正向 {sum(len(s['present']) for s in specs.values() if s)} 名 + 值/枚举断言在案，禁名 {len(forb)} 类在册")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--pins", type=Path, default=PINS_DEFAULT)
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--only", default="")
    a = ap.parse_args(argv)
    pins = load_pins(a.pins)
    if a.self_test:
        return selftest(pins)
    sel = {s.strip() for s in a.only.split(",") if s.strip()} or ({"neko", "maibot", "astrbot", "nonebot", "koishi"} if a.all else set())
    if not sel:
        ap.error("用 --all / --only <名单> / --self-test")
    specs = build_specs(pins)
    results: dict[str, tuple[bool, list[str]]] = {}
    for name in sel:
        if name == "koishi":
            for nm, edir, spec in build_node_specs(pins):
                if not (edir / "node_modules" / "cordis").exists() and not (edir / "node_modules").exists():
                    results[nm] = (False, [f"SKIP: 缺 {edir}/node_modules（缺：按 npm_pins 精确版本 install --registry=npmmirror --ignore-scripts）"])
                else:
                    results[nm] = run_node(edir, spec)
            continue
        envkey = {"neko": "neko_py311", "maibot": "maibot_py312", "astrbot": "astrbot_py312", "nonebot": "nonebot_py311"}[name]
        interp = Path(pins["python_buckets"][envkey]["interpreter"])
        if not interp.exists():
            results[name] = (False, [f"SKIP: 隔离环境缺失 {interp}（缺：uv venv + uv pip install 按 python_buckets 精确钉）"])
            continue
        results[name] = run_env(name, str(interp), specs[name], Path(pins["root"]), pins["python_buckets"][envkey].get("env"))
    code = 0
    for name, (ok, bad) in sorted(results.items()):
        print(f"{'PASS' if ok else 'FAIL'} vocab[{name}]" + (("\n  " + "\n  ".join(bad)) if bad else ""))
        if not ok:
            code = 1
    return code


if __name__ == "__main__":
    sys.exit(main())
