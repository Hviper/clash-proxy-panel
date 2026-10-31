'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const {
  createMihomoClient,
  DEFAULT_DELAY_URL,
  DEFAULT_DELAY_TIMEOUT,
} = require('../src/mihomo');

function makeSecretFile(secret) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clash-panel-delay-'));
  const file = path.join(dir, 'clash-verge.yaml');
  fs.writeFileSync(file, `secret: ${secret}\n`, 'utf8');
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 启动一个假 Mihomo API，记录收到的请求并返回固定 JSON。
 */
function startFakeApi(payload) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        requests,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('testGroupDelay 按 Mihomo 格式构造测速请求', async (t) => {
  const secret = makeSecretFile('delay-secret');
  const api = await startFakeApi({ 'US 1': 120, 'JP 1': -1 });
  const client = createMihomoClient({
    baseUrl: api.baseUrl,
    secretPath: secret.file,
    fallbackSecret: 'fallback',
  });

  t.after(async () => {
    await api.close();
    secret.cleanup();
  });

  const delays = await client.testGroupDelay(
    'AGY Gemini',
    'https://generativelanguage.googleapis.com/generate_204?x=1',
    3000
  );

  assert.deepEqual(delays, { 'US 1': 120, 'JP 1': -1 });
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].method, 'GET');
  assert.equal(
    api.requests[0].url,
    '/group/AGY%20Gemini/delay?url=https%3A%2F%2Fgenerativelanguage.googleapis.com%2Fgenerate_204%3Fx%3D1&timeout=3000'
  );
  assert.equal(api.requests[0].authorization, 'Bearer delay-secret');
});

test('testProxyDelay 使用默认测速地址与超时', async (t) => {
  const secret = makeSecretFile('delay-secret');
  const api = await startFakeApi({ delay: 88 });
  const client = createMihomoClient({
    baseUrl: api.baseUrl,
    secretPath: secret.file,
    fallbackSecret: 'fallback',
  });

  t.after(async () => {
    await api.close();
    secret.cleanup();
  });

  const result = await client.testProxyDelay('Sakura | US 1');

  assert.deepEqual(result, { delay: 88 });
  assert.equal(
    api.requests[0].url,
    `/proxies/Sakura%20%7C%20US%201/delay?url=${encodeURIComponent(
      DEFAULT_DELAY_URL
    )}&timeout=${DEFAULT_DELAY_TIMEOUT}`
  );
});

test('测速接口透传 Mihomo 的 HTTP 错误状态', async (t) => {
  const secret = makeSecretFile('delay-secret');
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'group not found' }));
  });
  const baseUrl = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

  const client = createMihomoClient({
    baseUrl,
    secretPath: secret.file,
    fallbackSecret: 'fallback',
  });

  t.after(async () => {
    await new Promise((done) => server.close(done));
    secret.cleanup();
  });

  await assert.rejects(
    () => client.testGroupDelay('missing-group'),
    (err) => {
      assert.equal(err.status, 404);
      assert.match(err.message, /group not found/);
      return true;
    }
  );
});
