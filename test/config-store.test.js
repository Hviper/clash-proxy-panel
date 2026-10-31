'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig, saveConfig, defaultConfig, createConfigStore } = require('../src/config-store');

function tempConfigPath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clash-panel-config-'));
  return { root, configPath: path.join(root, 'data', 'config.json'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('配置文件不存在时创建不含凭据的空默认配置', () => {
  const temp = tempConfigPath();
  try {
    const config = loadConfig(temp.configPath);
    assert.ok(fs.existsSync(temp.configPath));
    assert.deepEqual(config.subscriptions, {});
    assert.deepEqual(config.groups, []);
    assert.deepEqual(config.listeners, []);
    assert.deepEqual(config.appliedGroupNames, []);
  } finally { temp.cleanup(); }
});

test('保存后可重新读取，且写入为原子替换', () => {
  const temp = tempConfigPath();
  try {
    const config = defaultConfig();
    config.listeners.push({ name: 'extra', port: 7999, proxy: 'DIRECT', type: 'mixed', listen: '127.0.0.1', udp: true });
    saveConfig(temp.configPath, config);
    const loaded = loadConfig(temp.configPath);
    assert.equal(loaded.listeners.length, 1);
    assert.equal(loaded.listeners[0].name, 'extra');
    assert.deepEqual(fs.readdirSync(path.dirname(temp.configPath)), ['config.json']);
  } finally { temp.cleanup(); }
});

test('store.update 会持久化修改', () => {
  const temp = tempConfigPath();
  try {
    const store = createConfigStore({ configPath: temp.configPath });
    store.update((config) => { config.subscriptions.p9 = { id: 'p9', name: 'Test', url: 'https://example.com/sub', prefix: '', interval: 3600 }; });
    assert.equal(store.read().subscriptions.p9.name, 'Test');
  } finally { temp.cleanup(); }
});

test('损坏的配置文件会抛出明确错误', () => {
  const temp = tempConfigPath();
  try {
    fs.mkdirSync(path.dirname(temp.configPath), { recursive: true });
    fs.writeFileSync(temp.configPath, '{ not json', 'utf8');
    assert.throws(() => loadConfig(temp.configPath), /配置文件解析失败/);
  } finally { temp.cleanup(); }
});
