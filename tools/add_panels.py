#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给四个桥包补面板：服务端 panels+invoke、浏览器客户端、webUiClient 声明、简体中文描述与 locales。

形状照先例与框架文档：
- 客户端默认导出 { panels: { <id>: { mount(ctx) } } }（docs/webui.md:91-93）。
- 面板方法只接受 POST，getMethods 点名的才接受 GET；本页用 GET 轮询读。
- 客户端只用 ctx.ui 与 ctx.invoke，不碰 document.body，不直连 /api/，不用裸定时器。
"""
import io
import json
import os

# 本脚本内所有相对路径都以 packages/ 为基准，从仓库根直接跑也成立。
os.chdir(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "packages"))

PKGS = {
    "cortico-world-neko": {
        "label": "N.E.K.O · 猫娘 (CBP)",
        "desc_zh": "经 CBP v1 帧协议连接 N.E.K.O 猫娘平台的桥：双角色 WebSocket、能力协商、出站门与身份登记。",
        "desc_en": "Bridge to the N.E.K.O pet platform over CBP v1 frames: dual-role WebSocket, capability negotiation, egress doors and turn identity.",
        "panel_desc": "连接、角色、协商能力、consent 态、对端工具目录与降级清单。",
    },
    "cortico-world-maibot": {
        "label": "MaiBot · QQ (CBP)",
        "desc_zh": "经 CBP v1 帧协议连接 MaiBot 的桥：监听 WebSocket、能力协商、出站门与对端工具清单。",
        "desc_en": "Bridge to MaiBot over CBP v1 frames: WS listen, capability negotiation, egress door and the peer tool catalog.",
        "panel_desc": "连接、协商能力、自回声态、账号、对端工具目录、出站门与降级清单。",
    },
    "cortico-world-astrbot-bridge": {
        "label": "AstrBot · QQ (CBP)",
        "desc_zh": "经 CBP 连接 AstrBot 的桥，收编旧私有帧协议并保留两阶段升级路径。",
        "desc_en": "Bridge to AstrBot over CBP, absorbing the legacy private-frame protocol with a two-phase upgrade path.",
        "panel_desc": "连接、CBP 协商结果、能力交集、对端工具目录与降级清单。",
    },
    "cortico-world-onebot-bridge": {
        "label": "OneBot Bridge",
        "desc_zh": "接任意 OneBot v11 实现的桥：正向 WebSocket、通用 action 调度与动作目录覆盖度。",
        "desc_en": "Bridge to any OneBot v11 implementation: forward WebSocket, a generic action dispatcher and catalog coverage.",
        "panel_desc": "连接、自身账号、地址、写策略、动作覆盖度与事件数。",
    },
}

CLIENT = """/**
 * 「桥状态」面板客户端。浏览器侧代码：只用 ctx.ui 与 ctx.invoke，
 * 不碰 document.body、不直连 /api/、不用裸定时器（docs/webui.md:91-99）。
 * 服务端方法见本包 world 的 invoke(panel='status', method='get')。
 */
const TXT = {
  zh: {
    title: '桥状态',
    refresh: '刷新',
    loading: '正在读取…',
    yes: '是',
    no: '否',
    emptyDegraded: '（无降级记录）',
    degraded: '降级清单',
    degradedDesc: '最近十条。每条都是显式降级说明，不是静默兜底。',
  },
  en: {
    title: 'Bridge status',
    refresh: 'Refresh',
    loading: 'loading…',
    yes: 'yes',
    no: 'no',
    emptyDegraded: '(no degradation notes)',
    degraded: 'Degradation notes',
    degradedDesc: 'Last ten entries. Each one is an explicit note, never a silent fallback.',
  },
};

const bool = (t, v) => (v ? t.yes : t.no);
const list = (v) => (Array.isArray(v) && v.length ? v.join('、') : '—');

function lines(data, t) {
  const s = [];
  if ('connected' in data) s.push(['连接', bool(t, data.connected)]);
  if (data.role) s.push(['连接角色', String(data.role)]);
  if (data.wsUrl) s.push(['地址', String(data.wsUrl)]);
  if (data.selfId) s.push(['自身标识', String(data.selfId)]);
  if (data.nickname) s.push(['昵称', String(data.nickname)]);
  if ('cbp' in data) s.push(['CBP 协商', bool(t, data.cbp)]);
  if (data.version !== undefined) s.push(['协议版本', String(data.version)]);
  if (data.caps !== undefined) s.push(['能力交集', list(data.caps)]);
  if (data.consent) s.push(['consent', String(data.consent)]);
  if (data.selfEcho) s.push(['自回声', String(data.selfEcho)]);
  if ('egress' in data) s.push(['出站门', bool(t, data.egress)]);
  if (data.writePolicy) s.push(['写策略', String(data.writePolicy)]);
  if ('readOnly' in data) s.push(['只读模式', bool(t, data.readOnly)]);
  if (data.accounts !== undefined) s.push(['账号', list(data.accounts)]);
  if (data.ownerIds !== undefined) s.push(['管理员', list(data.ownerIds)]);
  if (data.tts) s.push(['语音合成', data.tts.ready ? (data.tts.provider || '就绪') : '未就绪']);
  if (data.catalog !== undefined) s.push(['对端工具', list((data.catalog || []).map((x) => x.name || x))]);
  if (data.coverage) {
    s.push(['动作覆盖', `${data.coverage.implemented ?? '?'}/${data.coverage.total ?? '?'}`]);
    if (data.coverage.categories !== undefined) s.push(['分类数', String(data.coverage.categories)]);
  }
  if (data.knownEvents !== undefined) s.push(['已知事件', String(data.knownEvents)]);
  if (data.ratePerMin !== undefined) s.push(['每分钟上限', String(data.ratePerMin)]);
  return s;
}

export default {
  panels: {
    status: {
      mount: async (ctx) => {
        const { ui, root } = ctx;
        const t = String(ctx.language ?? '').startsWith('en') ? TXT.en : TXT.zh;

        const card = ui.sheet({ title: t.title });
        const facts = ui.h('div');
        const message = ui.msgline();
        const button = ui.button(t.refresh, { onClick: () => { void load(); } });
        const bar = ui.rowbar();
        bar.append(button);
        const degSection = ui.section(t.degraded, t.degradedDesc);
        const degFacts = ui.h('div');
        degSection.append(degFacts);

        card.body.append(facts, bar, message, degSection);
        root.append(card.el);

        function render(data) {
          if (data && data.error) {
            message.textContent = String(data.error);
            message.classList.add('bad');
            return;
          }
          facts.replaceChildren(ui.kv(lines(data ?? {}, t).map(([k, v]) => ({ k, v }))));
          const deg = Array.isArray(data && data.degraded) ? data.degraded : [];
          degFacts.replaceChildren(
            ui.kv((deg.length ? deg : [t.emptyDegraded]).map((item, i) => ({ k: deg.length ? String(i + 1) : '—', v: String(item) }))),
          );
          message.classList.remove('bad');
          message.textContent = '';
        }

        async function load() {
          message.textContent = t.loading;
          try {
            render(await ctx.invoke('get'));
          } catch (error) {
            message.textContent = String(error);
            message.classList.add('bad');
          }
        }

        // 15 秒轮询走 ctx.interval：登记过的资源在卸载时自动释放。
        ctx.interval(() => { void load(); }, 15000);
        await load();
      },
    },
  },
};
"""

MAIBOT_PANELS = """      panels: [
        {
          id: 'status',
          title: '桥状态',
          description: '{DESC}',
          getMethods: ['get'],
        },
      ],
      invoke: async (panel, method) => {
        if (panel === 'status' && method === 'get') {
          return {
            connected: this.connected,
            caps: this.driver?.effectiveCaps() ?? [],
            selfEcho: this.selfEchoState(),
            accounts: [...this.accounts],
            catalog: this.announcedTools(),
            degraded: this.degradedList.slice(-10),
            egress: this.cfg.egress,
            ratePerMin: this.cfg.ratePerMin,
          };
        }
        return { error: `unknown panel/method: ${panel}/${method}` };
      },
"""

ONEBOT_UI = """  /**
   * 面板「桥状态」：只读展示连接、自身账号、地址、写策略与动作覆盖度。
   * 面板方法只接受 POST，getMethods 点名的方法才接受 GET（docs/webui.md:83）。
   */
  webUi() {
    return {
      panels: [
        {
          id: 'status',
          title: '桥状态',
          description: '{DESC}',
          getMethods: ['get'],
        },
      ],
      invoke: async (panel, method) => {
        if (panel === 'status' && method === 'get') {
          const raw = this.#statusTool().text;
          return JSON.parse(raw);
        }
        return { error: `unknown panel/method: ${panel}/${method}` };
      },
    };
  }

"""


def read(p):
    with io.open(p, encoding="utf-8", newline="") as f:
        return f.read()


def write(p, s):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with io.open(p, "w", encoding="utf-8", newline="") as f:
        f.write(s)


def nl_join(text, lines_to_add, anchor, before=True):
    """在 anchor 前后插入块，保持原文件换行风格。"""
    crlf = "\r\n" in text
    block = lines_to_add.replace("\n", "\r\n") if crlf else lines_to_add
    if anchor not in text:
        raise SystemExit("锚点未找到：%r" % anchor[:60])
    return text.replace(anchor, (block + anchor) if before else (anchor + block), 1)


# 1) 服务端面板：maibot 与 onebot
p = "cortico-world-maibot/src/world.ts"
t = read(p)
t = nl_join(t, MAIBOT_PANELS.replace("{DESC}", PKGS["cortico-world-maibot"]["panel_desc"]),
            "      config: [CONFIG_GROUP],\n      promptDocs: [")
write(p, t)
print("maibot：服务端 panels+invoke 已加")

p = "cortico-world-onebot-bridge/src/world.js"
t = read(p)
t = nl_join(t, ONEBOT_UI.replace("{DESC}", PKGS["cortico-world-onebot-bridge"]["panel_desc"]),
            "  #actionsTool(args) {")
write(p, t)
print("onebot：webUi() 已加")

# 2) 客户端与包声明
for name, meta in PKGS.items():
    client_path = f"{name}/src/webui/client.js"
    crlf = os.path.exists(f"{name}/package.json") and "\r\n" in read(f"{name}/package.json")
    body = CLIENT.replace("\n", "\r\n") if crlf else CLIENT
    write(client_path, body)
    q = f"{name}/package.json"
    d = json.loads(read(q).lstrip("﻿"))
    d["description"] = meta["desc_zh"]
    c = d.setdefault("cortico", {})
    c["displayName"] = meta["label"]
    c["webUiClient"] = "src/webui/client.js"
    c["locales"] = {"zh": {"displayName": meta["label"], "description": meta["desc_zh"]},
                    "en": {"displayName": meta["label"], "description": meta["desc_en"]}}
    files = d.get("files") or []
    for need in ("src", "describe.json", "README.md", "CHANGELOG.md"):
        if need not in files:
            files.append(need)
    d["files"] = files
    sep = "\r\n" if crlf else "\n"
    write(q, json.dumps(d, ensure_ascii=False, indent=2).replace("\n", sep) + sep)
    print(f"{name}：客户端已写，webUiClient/locales/描述已声明")
