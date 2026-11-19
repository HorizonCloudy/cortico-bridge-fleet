/**
 * 2026-11-19 鉴权子协议回归（SECURITY-CBP.md:115-121；10-22 / 11-13 索引仓判例）。
 * 契约：共享密钥只走 HTTP Upgrade 头、缺密钥 fail-shut、帧体与配置段都不留 token 位。
 * 只连 127.0.0.1 随机端口，不碰宿主与 IM（driver.test.ts 同口径）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { Logger } from 'cortico/core/types.ts';
import { BridgeDriver, isCleanWsUrl, type DriverHandlers, type DriverOptions } from '../src/driver.ts';
import { CONFIG_GROUP, DEFAULTS, WORLD_ID } from '../src/config.ts';

const log: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, emit() {}, child() { return log; } };
const SECRET = 's3cr3t-do-not-leak';

const idle: DriverHandlers = {
  onReady() {}, onMsg() {}, onNotice() {}, onEvent() {}, onCatalog() {}, onState() {},
};

function opts(url: string, authToken: string): DriverOptions {
  return {
    url,
    authToken,
    agent: { name: 'w', version: '1', sha: 's' },
    caps: [],
    tools: [],
    reconnectBaseMs: 200,
    reconnectMaxMs: 1000,
    log,
  };
}

function sourceOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8');
}

test('Upgrade 头带 Bearer，hello 帧体不带 token 位', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  let authHeader: string | undefined;
  let hello: Record<string, unknown> | null = null;
  server.on('connection', (ws, req) => {
    const raw = req.headers.authorization;
    authHeader = Array.isArray(raw) ? raw[0] : raw;
    ws.on('message', (data) => { hello = JSON.parse(String(data)) as Record<string, unknown>; });
  });
  const d = new BridgeDriver(opts(`ws://127.0.0.1:${port}`, SECRET), idle);
  try {
    await d.start();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(authHeader, `Bearer ${SECRET}`, '凭据必须走 Upgrade 头');
    assert.ok(hello, 'hello 必须发出');
    assert.equal((hello as Record<string, unknown>).t, 'hello');
    assert.equal('token' in (hello as Record<string, unknown>), false, '帧体不得再带 token 位');
    assert.equal('auth' in (hello as Record<string, unknown>), false);
  } finally {
    d.stop();
    for (const c of server.clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('缺共享密钥 → 拒绝拨号（fail-shut），环回也不例外', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  let connections = 0;
  server.on('connection', () => { connections++; });
  const d = new BridgeDriver(opts(`ws://127.0.0.1:${port}`, ''), idle);
  try {
    await d.start();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(connections, 0, '空 token 不再等于免鉴权，一次连接都不许建');
  } finally {
    d.stop();
    for (const c of server.clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('URL 带凭据 query → 拒绝拨号', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  let connections = 0;
  server.on('connection', () => { connections++; });
  const d = new BridgeDriver(opts(`ws://127.0.0.1:${port}/?token=${SECRET}`, SECRET), idle);
  try {
    await d.start();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(connections, 0, '凭据禁过 URL，做过比对之前就该挡下');
  } finally {
    d.stop();
    for (const c of server.clients) c.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('isCleanWsUrl：干净 URI 放行，query/fragment/凭据键判脏', () => {
  assert.equal(isCleanWsUrl('ws://127.0.0.1:17999'), true);
  assert.equal(isCleanWsUrl('ws://192.0.2.10:17999/path'), true);
  assert.equal(isCleanWsUrl('ws://127.0.0.1:17999?token=x'), false);
  assert.equal(isCleanWsUrl('ws://127.0.0.1:17999?access_token=x'), false);
  assert.equal(isCleanWsUrl('ws://127.0.0.1:17999#token=x'), false);
  assert.equal(isCleanWsUrl('ws://127.0.0.1:17999/x_token=y'), false);
});

test('配置段与面板都不再暴露 token 项', () => {
  assert.equal('token' in DEFAULTS, false, '默认配置不得有 token 字段');
  const keys = Object.keys(CONFIG_GROUP.schema.properties ?? {});
  assert.equal(keys.includes(`worlds.${WORLD_ID}.token`), false, '面板不得有 token 输入项');
  assert.equal(keys.some((k) => k.toLowerCase().includes('token')), false);
  assert.equal(sourceOf('config.ts').includes('.token'), false, 'config.ts 源码不得再拼 token 配置键');
});

test('definition 从 ctx.secret 注入密钥，world 只把它交给 driver', () => {
  const definition = sourceOf('definition.ts');
  const world = sourceOf('world.ts');
  assert.match(definition, /ctx\.secret\?\.\('CORTICO_BRIDGE_TOKEN'\)/);
  assert.match(world, /authToken:\s*this\.opts\.authToken/);
  assert.equal(world.includes('this.cfg.token'), false, '不得再从配置段读密钥');
});
