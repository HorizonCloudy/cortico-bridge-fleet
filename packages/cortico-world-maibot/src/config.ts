/**
 * config.ts —— `worlds.maibot` 配置段。
 * 形状钉自 _BUILD-PLAN.md §3.2 definition 模板行：
 * `{ enabled:false, url:'ws://127.0.0.1:3970X', egress:false, ratePerMin:20 }`，
 * maibot 的 X = 39702（§4.4 端口表「Cortico 侧 neko/maibot world listen」行；
 * 内核 pins 同值 cortico-bridge-core/src/pins.ts:73 `maibotListen: 39702`）。
 * 方向与 astrbot 包相反：MaiBot 插件跑在 Runner 子进程、只有三个原始 RPC
 * （upstream/maibot-plugin-sdk maibot_sdk/context.py:137-143 @f9984673d，蓝图 §2.2），
 * 「从模型上就没打算让插件开服务」——所以本包是 listen 端，桥外拨进来。
 * ConfigGroup 路径必须全在 `worlds.maibot.` 段内，否则 dry-mount 判 fail
 * （cortico src/extensions/dry-mount.ts:47-63,217 @836238311）。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';

export const WORLD_ID = 'maibot';

export interface MaibotConfig {
  enabled: boolean;
  /** 本包监听地址；桥（cortico-bridge-maibot）外拨到这里。改完重启本 World 生效。 */
  url: string;
  // 2026-11-19：共享密钥不进配置段。只从部署 .env 的 CORTICO_BRIDGE_TOKEN
  // 经 definition.ts 的 ctx.secret() 注入；留空即拒监听（11-13 判例）。
  /** 出站门；缺省关。发信腿接线后由它决定是否放行；桥 hello.tools 空期本腿不下发。 */
  egress: boolean;
  /** 每分钟出站上限，0 不限；缺省 20（§3.2 模板 ratePerMin）。 */
  ratePerMin: number;
}

export const DEFAULTS: MaibotConfig = {
  enabled: false,
  url: 'ws://127.0.0.1:39702',
  egress: false,
  ratePerMin: 20,
};

export function normalizeConfig(raw: Partial<MaibotConfig> | undefined): MaibotConfig {
  const c = raw ?? {};
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    enabled: c.enabled === true,
    url: typeof c.url === 'string' && c.url !== '' ? c.url : DEFAULTS.url,
    egress: c.egress === true,
    ratePerMin: Math.max(0, Math.floor(num(c.ratePerMin, DEFAULTS.ratePerMin))),
  };
}

/** 面板配置组：owner 必须是 `world:<id>`（EXTENSION_PAGE_KIND，extensions.ts:47-51 @836238311）。 */
export const CONFIG_GROUP: ConfigGroup = {
  id: `world:${WORLD_ID}`,
  owner: `world:${WORLD_ID}`,
  schema: {
    type: 'object',
    title: 'MaiBot 桥（CBP）',
    description: 'Cortico 侧监听、出站门与限流。共享密钥不在本面板，设在部署 .env 的 CORTICO_BRIDGE_TOKEN。',
    properties: {
      [`worlds.${WORLD_ID}.url`]: {
        type: 'string',
        title: '监听地址',
        'x-hot': false,
        description: '形如 ws://127.0.0.1:39702。桥外拨到这里；改完重启本 World 生效。',
      },
      [`worlds.${WORLD_ID}.egress`]: {
        type: 'boolean',
        title: '出站门',
        'x-hot': true,
        'x-warning': true,
        description: '出站到 IM 的开关。发信腿接线后生效；桥当前 hello.tools 未申报，本腿不出站。',
      },
      [`worlds.${WORLD_ID}.ratePerMin`]: {
        type: 'integer',
        title: '每分钟发送上限',
        minimum: 0,
        maximum: 600,
        'x-hot': true,
        description: '0 表示不限。缺省 20。',
      },
    },
  },
};

/** `ws://host:port` → 内核 listen 参数；解析不出来回落 DEFAULTS.url。 */
export function parseListenUrl(url: string): { host: string; port: number } {
  try {
    const u = new URL(url);
    const port = u.port ? Number(u.port) : u.protocol === 'wss:' ? 443 : 80;
    if (!u.hostname || !Number.isFinite(port) || port <= 0 || port > 65535) {
      const d = new URL(DEFAULTS.url);
      return { host: d.hostname, port: Number(d.port) };
    }
    return { host: u.hostname, port };
  } catch {
    const d = new URL(DEFAULTS.url);
    return { host: d.hostname, port: Number(d.port) };
  }
}
