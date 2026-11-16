#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""补发布前置：CHANGELOG 段、版本号 0.1.2，并给发布闸加第四项「声明了面板就必须有产物」。"""
import io
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)


def read(p):
    with io.open(p, encoding="utf-8", newline="") as f:
        return f.read()


def write(p, s):
    with io.open(p, "w", encoding="utf-8", newline="") as f:
        f.write(s)


def crlf_of(p):
    return "\r\n" in read(p)


# ---------- 1. CHANGELOG 与版本号 ----------
ENTRIES = {
    "packages/cortico-bridge-core": [
        ("0.1.1", [
            "发布产物自带台账：`prepack`（`scripts/prepare_pins.mjs`）把 fleet 唯一来源 "
            "`spec/pins.json` 复制进包内 `spec/`，并校验 schema/generated/caps/vocab 四段，缺段拒绝打包。",
            "读数次序改为三级：`CORTICO_PINS_JSON` → 包内 `spec/pins.json` → 仓库根 `spec/pins.json`。",
            "为什么：装进 `node_modules` 以后 `<包>/../../spec/pins.json` 不存在，fail-shut 直接抛，"
            "依赖本内核的 world 包在宿主里报「导入失败」。仓内测试撞不到这一层。",
            "新增 `tests/pins-installed.test.ts`：在临时目录拼出安装态布局再加载内核。",
        ]),
    ],
    "packages/cortico-world-neko": [
        ("0.1.1", ["内核依赖从 `^0.1.0` 收紧到 `^0.1.1`，让坏掉的 0.1.0 不可能再被选中。"]),
    ],
    "packages/cortico-world-maibot": [
        ("0.1.1", ["内核依赖从 `^0.1.0` 收紧到 `^0.1.1`。"]),
    ],
}

PANEL_012 = [
    "面板「桥状态」补客户端产物：`src/webui/client.js`，`cortico.webUiClient` 声明它。",
    "描述改简体中文，并补 `cortico.locales.zh` / `.en` 两份。",
]
PANEL_012_SERVER = ["服务端补 `webUi().panels` 与 `invoke('status','get')`，面板数据面与状态工具同源。"]

for pkg, sections in ENTRIES.items():
    p = os.path.join(pkg, "CHANGELOG.md")
    body = read(p)
    for ver, lines in sections:
        sec = "## %s\n\n%s\n\n" % (ver, "\n".join("- " + x for x in lines))
        if ("## %s" % ver) in body:
            continue
        marker = "\n## "
        i = body.find(marker)
        body = (body[:i + 1] + sec + body[i + 1:]) if i >= 0 else (body.rstrip() + "\n\n" + sec)
    write(p, body)

for pkg in [d for d in os.listdir("packages") if d.startswith("cortico-")]:
    p = os.path.join("packages", pkg, "CHANGELOG.md")
    q = os.path.join("packages", pkg, "package.json")
    body = read(p)
    if "## 0.1.2" not in body:
        lines = list(PANEL_012)
        if pkg.startswith("cortico-world"):
            pj_data = json.loads(read(q).lstrip("﻿"))
            if pj_data.get("cortico"):
                lines = lines + (PANEL_012_SERVER if pkg in ("cortico-world-maibot", "cortico-world-onebot-bridge") else [])
        else:
            lines = ["发布闸新增第四项：`cortico.webUiClient` 声明了就必须有产物（`tests/_lib/release-gate.mjs`）。"]
        sec = "## 0.1.2\n\n%s\n\n" % "\n".join("- " + x for x in lines)
        i = body.find("\n## ")
        body = (body[:i + 1] + sec + body[i + 1:]) if i >= 0 else (body.rstrip() + "\n\n" + sec)
        write(p, body)
    d = json.loads(read(q).lstrip("﻿"))
    d["version"] = "0.1.2"
    sep = "\r\n" if crlf_of(q) else "\n"
    write(q, json.dumps(d, ensure_ascii=False, indent=2).replace("\n", sep) + sep)
print("CHANGELOG 与版本号 0.1.2 已补齐")

# ---------- 2. 发布闸第四项 ----------
g = "tests/_lib/release-gate.mjs"
t = read(g)
anchor = "  // 3. describe — only for Cortico extension packages (kind declared in the manifest)"
assert anchor in t, "发布闸里找不到 describe 段锚点"
new_check = """  // 4. 面板产物：声明了 cortico.webUiClient 就必须真有这个文件。
  //    框架侧规则：包内相对路径、.js / .mjs（src/extensions/manifest.ts:149-156 @836238311）。
  //    2026-11-16 的教训：world 声明了 panels 却没带客户端，宿主显示
  //    「面板「桥状态」加载失败：缺少面板构建产物」，而仓内测试全绿。
  {
    const client = pkg.cortico?.webUiClient;
    if (typeof client === 'string' && client) {
      if (!/\\.(m?js)$/.test(client)) {
        failures.push(`cortico.webUiClient 必须是 .js 或 .mjs：${client}`);
      } else if (client.startsWith('/') || client.includes('..')) {
        failures.push(`cortico.webUiClient 必须是包内相对路径：${client}`);
      } else if (!existsSync(join(pkgDir, client))) {
        failures.push(`面板产物缺失：${client}（发布前置四）`);
      } else {
        const srcTxt = readFileSync(join(pkgDir, client), 'utf8');
        if (!/panels\\s*:/.test(srcTxt) || !/mount\\s*:/.test(srcTxt)) {
          failures.push(`面板客户端必须默认导出 { panels: { <id>: { mount(ctx) } } }：${client}`);
        }
      }
    }
  }

"""
t = t.replace(anchor, new_check + anchor, 1)
write(g, t)
print("发布闸已加第四项")
