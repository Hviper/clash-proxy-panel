'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const vue = require('vue');

function renderer() {
  let state;
  let icons = 0;
  const requests = [];
  const sandbox = {
    Vue: {
      ...vue,
      onMounted() {},
      createApp(options) {
        state = options.setup();
        return { mount() {} };
      },
    },
    window: {
      desktop: {
        platform: 'darwin',
        request(url) {
          return new Promise((resolve, reject) => requests.push({ url, resolve, reject }));
        },
      },
      lucide: { createIcons() { icons += 1; } },
    },
    requestAnimationFrame(callback) { return setImmediate(() => callback(0)); },
    setTimeout() {},
    clearTimeout() {},
    console, FormData, URLSearchParams,
  };
  sandbox.window.requestAnimationFrame = sandbox.requestAnimationFrame;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), sandbox);
  return { state, requests, iconCount: () => icons };
}

async function reachRequest(app) {
  for (let i = 0; i < 12 && !app.requests.length; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(app.requests.length, 1);
}

test('组测速保留旧结果，以局部状态反馈且不重建全页图标', async () => {
  const app = renderer();
  app.state.groups.value = [{ name: 'demo', all: ['node-a'], type: 'select' }];
  app.state.groupDelays.value.demo = { 'node-a': 120 };
  const running = app.state.runGroupDelayTest('demo');
  assert.equal(app.state.groupTesting.value.demo, true);
  assert.equal(app.state.getNodeDelay('demo', 'node-a'), 120);
  assert.equal(app.state.toasts.value.length, 0);
  await reachRequest(app);
  app.requests[0].resolve({ ok: true, status: 200, data: { success: true, delays: { 'node-a': 95 } } });
  await running;
  await vue.nextTick();
  assert.equal(app.state.groupTesting.value.demo, false);
  assert.equal(app.state.getNodeDelay('demo', 'node-a'), 95);
  assert.equal(app.state.toasts.value.length, 0);
  assert.equal(app.iconCount(), 0);
});

test('重复点击同一组测速只发送一次请求', async () => {
  const app = renderer();
  app.state.groups.value = [{ name: 'demo', all: ['node-a'] }];
  const first = app.state.runGroupDelayTest('demo');
  const second = app.state.runGroupDelayTest('demo');
  await reachRequest(app);
  app.requests[0].resolve({ ok: true, status: 200, data: { success: true, delays: {} } });
  await Promise.all([first, second]);
  assert.equal(app.requests.length, 1);
});

test('测速失败后解除忙碌状态并保留旧延迟', async () => {
  const app = renderer();
  app.state.groups.value = [{ name: 'demo', all: ['node-a'] }];
  app.state.groupDelays.value.demo = { 'node-a': 120 };
  const running = app.state.runGroupDelayTest('demo');
  await reachRequest(app);
  app.requests[0].reject(new Error('test network failure'));
  await running;
  assert.equal(app.state.groupTesting.value.demo, false);
  assert.equal(app.state.getNodeDelay('demo', 'node-a'), 120);
  assert.equal(app.state.toasts.value.length, 1);
  assert.match(app.state.toasts.value[0].message, /test network failure/);
});

test('后台刷新失败保留已有数据，不把故障伪装成空列表', async () => {
  const app = renderer();
  app.state.groups.value = [{ name: 'existing-group', all: ['node-a'] }];
  app.state.listeners.value = [{ name: 'existing-port', port: 7891 }];
  app.state.nodes.value = [{ name: 'node-a', delay: 120 }];
  const running = app.state.loadAllData();
  for (let i = 0; i < 12 && app.requests.length < 6; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(app.requests.length, 6);
  for (const req of app.requests) req.reject(new Error('refresh unavailable'));
  await running;
  assert.equal(app.state.groups.value[0]?.name, 'existing-group');
  assert.equal(app.state.listeners.value[0]?.name, 'existing-port');
  assert.equal(app.state.nodes.value[0]?.name, 'node-a');
  assert.equal(app.state.loading.value, false);
});
