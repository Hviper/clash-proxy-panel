'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { saveConfig, defaultConfig } = require('../src/config-store');
const {
  SECTION1_START,
  SECTION1_END,
  SECTION2_START,
  SECTION2_END,
} = require('../src/generator');

function fixtureConfig() {
  return {
    subscriptions: {
      p2: { id: 'p2', name: 'SakuraCat', url: 'https://example.com/p2', prefix: 'Sakura |', interval: 86400 },
      p3: { id: 'p3', name: '赔钱机场', url: 'https://example.com/p3', prefix: 'Dasho |', interval: 86400 },
    },
    groups: [{ name: 'AGY Gemini', type: 'select', use: ['p2', 'p3'], includeActiveProfile: true, filter: '(?i)(US)', testUrl: 'https://www.google.com/generate_204', interval: 300 }],
    listeners: [
      { name: 'agy-gemini', port: 7891, proxy: 'AGY Gemini', type: 'mixed', listen: '127.0.0.1', udp: true },
      { name: 'opencode-in', port: 7893, proxy: 'AGY Gemini', type: 'mixed', listen: '127.0.0.1', udp: true },
    ],
    appliedGroupNames: ['AGY Gemini'],
    appliedListenerNames: ['agy-gemini', 'opencode-in'],
    lastAppliedAt: null,
  };
}

function fixtureScript() {
  return [
    '// 测试用 Script.js',
    SECTION1_START,
    'const proxyProviders = {};',
    SECTION1_END,
    '',
    'function main(config) {',
    '  const finalProxyGroups = [];',
    '  config.proxies = config && config.proxies ? config.proxies : [];',
    '',
    '  ' + SECTION2_START,
    '  // 旧内容',
    '  ' + SECTION2_END,
    '',
    '  return config;',
    '}',
    '',
  ].join('\n');
}

function fixtureProfilesYaml() {
  return [
    '# Profiles Config for Clash Verge',
    '',
    'current: TESTUID',
    'items:',
    '- uid: TESTUID',
    '  type: remote',
    '  name: 测试机场',
    '  file: TESTUID.yaml',
    '',
  ].join('\n');
}

function makeTempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clash-panel-project-'));
  const dataDir = path.join(root, 'data');
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profilesDir, { recursive: true });

  const configPath = path.join(dataDir, 'config.json');
  const scriptPath = path.join(profilesDir, 'Script.js');
  const profilesPath = path.join(profilesDir, 'profiles.yaml');

  saveConfig(configPath, fixtureConfig());
  fs.writeFileSync(scriptPath, fixtureScript(), 'utf8');
  fs.writeFileSync(profilesPath, fixtureProfilesYaml(), 'utf8');

  return {
    root,
    configPath,
    scriptPath,
    profilesPath,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close() {
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}

function fakeMihomo() {
  const calls = {
    updateProvider: [],
    selectProxy: [],
    groupDelay: [],
    proxyDelay: [],
    providerProxyDelay: [],
  };

  // 订阅 provider 的节点不在 /proxies 顶层，fake 用这份表模拟 provider 作用域查找。
  const providerProxies = {
    p2: ['Sakura |🇺🇸|美国-IEPL 01'],
    p3: ['Dasho |🇺🇸美国06-0.1倍 | 电信联通移动推荐'],
  };

  return {
    calls,
    async getVersion() {
      return { meta: true, version: 'v1.19.32' };
    },
    async getProviders() {
      return {
        providers: {
          p2: {
            name: 'p2',
            vehicleType: 'HTTP',
            updatedAt: '2026-10-31T17:52:15.399661+08:00',
            proxies: [
              {
                name: 'Sakura | US 1',
                type: 'Tuic',
                alive: true,
                history: [{ delay: 120 }],
              },
              {
                name: 'Sakura | US 2',
                type: 'Vmess',
                alive: false,
                history: [],
              },
            ],
          },
          p3: {
            name: 'p3',
            vehicleType: 'HTTP',
            updatedAt: '2026-10-31T17:52:17.919458+08:00',
            proxies: [
              {
                name: 'Dasho | US 1',
                type: 'Trojan',
                alive: true,
                history: [{ delay: 80 }, { delay: 95 }],
              },
            ],
          },
          'AGY Gemini': {
            name: 'AGY Gemini',
            vehicleType: 'Compatible',
            updatedAt: '0001-01-01T00:00:00Z',
            proxies: [],
          },
        },
      };
    },
    async updateProvider(id) {
      calls.updateProvider.push(id);
      return null;
    },
    async getProxies() {
      return {
        proxies: {
          'AGY Gemini': {
            type: 'Selector',
            now: 'Sakura | US 1',
            all: ['Sakura | US 1', 'Sakura | US 2'],
          },
        },
      };
    },
    async selectProxy(group, proxy) {
      calls.selectProxy.push({ group, proxy });
      return null;
    },
    async testGroupDelay(group, url, timeout) {
      calls.groupDelay.push({ group, url, timeout });
      return { 'Sakura | US 1': 120, 'Sakura | US 2': -1 };
    },
    async testProxyDelay(proxy, url, timeout) {
      calls.proxyDelay.push({ proxy, url, timeout });
      return { delay: 88 };
    },
    async testProviderProxyDelay(provider, proxy, url, timeout) {
      calls.providerProxyDelay.push({ provider, proxy, url, timeout });
      const known = providerProxies[provider] || [];
      if (!known.includes(proxy)) {
        const error = new Error(`Mihomo GET /providers/proxies/${provider}/${proxy}/healthcheck 失败: HTTP 404 - Resource not found`);
        error.status = 404;
        throw error;
      }
      return { delay: 165 };
    },
  };
}

module.exports = {
  fixtureConfig,
  fixtureScript,
  fixtureProfilesYaml,
  makeTempProject,
  startServer,
  fakeMihomo,
};
