/**
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
