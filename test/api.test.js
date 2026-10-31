'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { createApp } = require('../src/app');
const {
  makeTempProject,
  startServer,
  fakeMihomo,
  fixtureScript,
} = require('../test-support/helpers');

test('桌面模式 API 拒绝缺失 token 并接受匹配 token', async () => {
  const project = makeTempProject();
  const app = createApp({ configPath: project.configPath, scriptPath: project.scriptPath, profilesPath: project.profilesPath, mihomo: fakeMihomo(), apiToken: 'test-desktop-token' });
  const server = await startServer(app);
  try {
    const denied = await fetch(`${server.baseUrl}/api/status`);
    assert.equal(denied.status, 401);
    const accepted = await fetch(`${server.baseUrl}/api/status`, { headers: { 'X-Panel-Token': 'test-desktop-token' } });
    assert.equal(accepted.status, 200);
  } finally {
    await server.close();
    project.cleanup();
  }
});

test('REST API 全流程', async (t) => {
  const project = makeTempProject();
  const mihomo = fakeMihomo();
  const ports = { 7890: true, 7891: false, 7893: false };

  const app = createApp({
    configPath: project.configPath,
    scriptPath: project.scriptPath,
    profilesPath: project.profilesPath,
    mihomo,
    checkPorts: async () => ports,
    checkPort: async () => true,
  });
  const server = await startServer(app);

  t.after(async () => {
    await server.close();
    project.cleanup();
  });

  async function api(method, apiPath, body) {
    const response = await fetch(`${server.baseUrl}${apiPath}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    return { status: response.status, data };
  }

  await t.test('GET /api/status', async () => {
    const { status, data } = await api('GET', '/api/status');
    assert.equal(status, 200);
    assert.equal(data.mihomoRunning, true);
    assert.equal(data.coreVersion, '1.19.32');
    assert.equal(data.coreVersionRaw, 'v1.19.32');
    assert.equal(data.activeProfile, '测试机场');
    assert.deepEqual(data.ports, ports);
  });

  await t.test('GET /api/subscriptions 合并 Mihomo 数据', async () => {
    const { status, data } = await api('GET', '/api/subscriptions');
    assert.equal(status, 200);
    assert.equal(Object.keys(data).length, 2);

    const p2 = data.p2;
    assert.equal(p2.name, 'SakuraCat');
    assert.equal(p2.nodeCount, 2);
    assert.equal(p2.aliveCount, 1);
    assert.equal(p2.providerExists, true);
    assert.match(p2.updatedAt, /^2026-10-31/);
  });

  await t.test('POST /api/subscriptions 新增与更新', async () => {
    const created = await api('POST', '/api/subscriptions', {
      name: '新订阅',
      url: 'https://example.com/sub.yaml',
      prefix: 'New |',
      interval: 3600,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.subscription.id, 'p4');

    const updated = await api('POST', '/api/subscriptions', {
      id: 'p4',
      name: '新订阅改名',
      url: 'https://example.com/sub.yaml',
      prefix: 'New |',
      interval: 7200,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.subscription.name, '新订阅改名');
    assert.equal(updated.data.subscription.interval, 7200);

    const invalid = await api('POST', '/api/subscriptions', {
      name: '坏订阅',
      url: 'not-a-url',
    });
    assert.equal(invalid.status, 400);
  });

  await t.test('POST /api/subscriptions/:id/refresh', async () => {
    const { status, data } = await api('POST', '/api/subscriptions/p2/refresh');
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.ok(mihomo.calls.updateProvider.includes('p2'));

    const missing = await api('POST', '/api/subscriptions/nope/refresh');
    assert.equal(missing.status, 404);
  });

  await t.test('GET /api/nodes 返回扁平节点列表', async () => {
    const { status, data } = await api('GET', '/api/nodes');
    assert.equal(status, 200);
    assert.equal(data.length, 3);

    const first = data.find((node) => node.name === 'Sakura | US 1');
    assert.deepEqual(first, {
      name: 'Sakura | US 1',
      type: 'Tuic',
      delay: 120,
      alive: true,
      provider: 'p2',
      providerName: 'p2',
    });

    const p3Node = data.find((node) => node.provider === 'p3');
    assert.equal(p3Node.delay, 95);
  });

  await t.test('GET /api/test-port 检测端口', async () => {
    const { status, data } = await api('GET', '/api/test-port?port=7890');
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.port, 7890);
    assert.equal(typeof data.latency, 'number');

    const invalid = await api('GET', '/api/test-port?port=70000');
    assert.equal(invalid.status, 400);
  });

  await t.test('DELETE /api/subscriptions/:id', async () => {
    const { status, data } = await api('DELETE', '/api/subscriptions/p4');
    assert.equal(status, 200);
    assert.equal(data.deleted, 'p4');

    const list = await api('GET', '/api/subscriptions');
    assert.equal(Object.keys(list.data).length, 2);

    const missing = await api('DELETE', '/api/subscriptions/p4');
    assert.equal(missing.status, 404);
  });

  await t.test('代理组 CRUD', async () => {
    const created = await api('POST', '/api/groups', {
      name: 'Test Group',
      type: 'select',
      use: ['p2'],
      filter: '(?i)US',
      testUrl: 'https://www.google.com/generate_204',
      interval: 180,
      includeActiveProfile: false,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.group.name, 'Test Group');

    const updated = await api('POST', '/api/groups', {
      name: 'Test Group',
      type: 'url-test',
      use: ['p2', 'p3'],
      filter: '(?i)US|JP',
      interval: 240,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.group.type, 'url-test');
    assert.deepEqual(updated.data.group.use, ['p2', 'p3']);

    const list = await api('GET', '/api/groups');
    assert.equal(list.data.length, 2);

    const testGroup = list.data.find((group) => group.name === 'Test Group');
    assert.equal(testGroup.now, null);
    assert.deepEqual(testGroup.all, []);

    const deleted = await api('DELETE', '/api/groups/Test%20Group');
    assert.equal(deleted.status, 200);
    assert.equal(deleted.data.deleted, 'Test Group');
    assert.deepEqual(deleted.data.removedListeners, []);
  });

  await t.test('GET /api/groups 返回活跃节点与全部节点列表', async () => {
    const { status, data } = await api('GET', '/api/groups');
    assert.equal(status, 200);

    const agy = data.find((group) => group.name === 'AGY Gemini');
    assert.equal(agy.now, 'Sakura | US 1');
    assert.deepEqual(agy.all, ['Sakura | US 1', 'Sakura | US 2']);
  });

  await t.test('POST /api/groups/:name/delay 使用自定义 URL 测速', async () => {
    const defaults = await api('POST', '/api/groups/AGY%20Gemini/delay');
    assert.equal(defaults.status, 200);
    assert.deepEqual(defaults.data, {
      success: true,
      group: 'AGY Gemini',
      url: 'https://generativelanguage.googleapis.com',
      delays: { 'Sakura | US 1': 120, 'Sakura | US 2': -1 },
    });

    const firstCall = mihomo.calls.groupDelay.at(-1);
    assert.equal(firstCall.group, 'AGY Gemini');
    assert.equal(firstCall.url, 'https://generativelanguage.googleapis.com');
    assert.equal(firstCall.timeout, 5000);

    const viaQuery = await api(
      'POST',
      '/api/groups/AGY%20Gemini/delay?url=https%3A%2F%2Fexample.com%2Fgenerate_204&timeout=1200'
    );
    assert.equal(viaQuery.status, 200);
    assert.equal(viaQuery.data.url, 'https://example.com/generate_204');
    assert.deepEqual(mihomo.calls.groupDelay.at(-1), {
      group: 'AGY Gemini',
      url: 'https://example.com/generate_204',
      timeout: 1200,
    });

    const viaBody = await api('POST', '/api/groups/AGY%20Gemini/delay', {
      url: 'https://example.com/body',
      timeout: 900,
    });
    assert.equal(viaBody.status, 200);
    assert.deepEqual(mihomo.calls.groupDelay.at(-1), {
      group: 'AGY Gemini',
      url: 'https://example.com/body',
      timeout: 900,
    });

    const bodyWins = await api(
      'POST',
      '/api/groups/AGY%20Gemini/delay?url=https%3A%2F%2Fexample.com%2Fquery',
      { url: 'https://example.com/from-body' }
    );
    assert.equal(bodyWins.data.url, 'https://example.com/from-body');

    const badUrl = await api('POST', '/api/groups/AGY%20Gemini/delay?url=not-a-url');
    assert.equal(badUrl.status, 400);
    assert.match(badUrl.data.message, /URL/);

    const badTimeout = await api('POST', '/api/groups/AGY%20Gemini/delay?timeout=0');
    assert.equal(badTimeout.status, 400);

    const nonNumericTimeout = await api('POST', '/api/groups/AGY%20Gemini/delay?timeout=abc');
    assert.equal(nonNumericTimeout.status, 400);
  });

  await t.test('POST /api/proxies/:name/delay 单节点测速', async () => {
    const node = encodeURIComponent('Sakura | US 1');

    const defaults = await api('POST', `/api/proxies/${node}/delay`);
    assert.equal(defaults.status, 200);
    assert.deepEqual(defaults.data, {
      success: true,
      proxy: 'Sakura | US 1',
      url: 'https://generativelanguage.googleapis.com',
      delay: 88,
    });

    const call = mihomo.calls.proxyDelay.at(-1);
    assert.equal(call.proxy, 'Sakura | US 1');
    assert.equal(call.timeout, 5000);

    const custom = await api('POST', `/api/proxies/${node}/delay`, {
      url: 'https://example.com/ping',
      timeout: 2500,
    });
    assert.equal(custom.status, 200);
    assert.equal(custom.data.url, 'https://example.com/ping');
    assert.equal(custom.data.delay, 88);
    assert.deepEqual(mihomo.calls.proxyDelay.at(-1), {
      proxy: 'Sakura | US 1',
      url: 'https://example.com/ping',
      timeout: 2500,
    });

    const badUrl = await api('POST', `/api/proxies/${node}/delay?url=ftp%3A%2F%2Fexample.com`);
    assert.equal(badUrl.status, 400);
  });

  await t.test('POST /api/groups/:name/select 切换活跃节点', async () => {
    const { status, data } = await api('POST', '/api/groups/AGY%20Gemini/select', {
      proxy: 'Sakura | US 1',
    });
    assert.equal(status, 200);
    assert.deepEqual(data, {
      success: true,
      group: 'AGY Gemini',
      proxy: 'Sakura | US 1',
    });
    assert.deepEqual(mihomo.calls.selectProxy.at(-1), {
      group: 'AGY Gemini',
      proxy: 'Sakura | US 1',
    });

    const missing = await api('POST', '/api/groups/AGY%20Gemini/select', {});
    assert.equal(missing.status, 400);
    assert.match(missing.data.message, /proxy/);

    const blank = await api('POST', '/api/groups/AGY%20Gemini/select', { proxy: '   ' });
    assert.equal(blank.status, 400);
  });

  await t.test('监听器 CRUD 与端口冲突', async () => {
    const created = await api('POST', '/api/listeners', {
      name: 'test-listener',
      port: 7999,
      proxy: 'AGY Gemini',
      type: 'mixed',
      listen: '127.0.0.1',
      udp: true,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.listener.port, 7999);

    const conflict = await api('POST', '/api/listeners', {
      name: 'another-listener',
      port: 7999,
      proxy: 'AGY Gemini',
    });
    assert.equal(conflict.status, 409);

    const invalid = await api('POST', '/api/listeners', {
      name: 'bad-port',
      port: 70000,
      proxy: 'AGY Gemini',
    });
    assert.equal(invalid.status, 400);

    const deleted = await api('DELETE', '/api/listeners/test-listener');
    assert.equal(deleted.status, 200);

    const missing = await api('DELETE', '/api/listeners/test-listener');
    assert.equal(missing.status, 404);
  });

  let appliedBackup = null;

  await t.test('POST /api/apply 写入 Script.js 并刷新 provider', async () => {
    const { status, data } = await api('POST', '/api/apply');
    assert.equal(status, 200);
    assert.equal(data.success, true);
    assert.equal(data.ok, true);
    assert.match(data.message, /Script\.js/);
    assert.match(data.backup, /^Script\.js\.bak-panel-\d{8}-\d{6}$/);
    assert.ok(data.logs.some((line) => line.includes('语法校验通过')));
    assert.deepEqual(data.ports, ports);

    assert.deepEqual(
      data.providers.map((provider) => provider.id).sort(),
      ['p2', 'p3']
    );
    assert.ok(data.providers.every((provider) => provider.ok));

    const script = fs.readFileSync(project.scriptPath, 'utf8');
    assert.match(script, /"p2": \{/);
    assert.match(script, /AGY Gemini/);
    assert.match(script, /"port": 7891/);

    appliedBackup = data.backup;
  });

  await t.test('GET /api/backups 与 POST /api/backups/restore', async () => {
    const list = await api('GET', '/api/backups');
    assert.equal(list.status, 200);
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].file, appliedBackup);
    assert.match(list.data[0].time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const restored = await api('POST', '/api/backups/restore', {
      file: appliedBackup,
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.data.success, true);
    assert.equal(restored.data.restoredFrom, appliedBackup);
    assert.equal(fs.readFileSync(project.scriptPath, 'utf8'), fixtureScript());

    const after = await api('GET', '/api/backups');
    assert.equal(after.data.length, 2);

    const bad = await api('POST', '/api/backups/restore', {
      file: '../evil.js',
    });
    assert.equal(bad.status, 400);
  });

  await t.test('拒绝非本机 Origin 的跨站请求', async () => {
    const response = await fetch(`${server.baseUrl}/api/apply`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(response.status, 403);
    const data = await response.json();
    assert.equal(data.success, false);
    assert.match(data.message, /跨站/);
  });

  await t.test('未知接口返回 JSON 404', async () => {
    const { status, data } = await api('GET', '/api/does-not-exist');
    assert.equal(status, 404);
    assert.equal(data.success, false);
    assert.match(data.error, /接口不存在/);
    assert.match(data.message, /接口不存在/);
  });
});
