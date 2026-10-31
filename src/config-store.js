'use strict';

const fs = require('fs');
const path = require('path');

// 新安装不携带订阅、节点或任何凭据。旧项目 data/config.json 可由 Electron 首次启动迁移。
const DEFAULT_CONFIG = {
  subscriptions: {},
  groups: [],
  listeners: [],
  appliedGroupNames: [],
  appliedListenerNames: [],
  lastAppliedAt: null,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultConfig() {
  return clone(DEFAULT_CONFIG);
}

function normalizeConfig(input) {
  const cfg = { ...defaultConfig(), ...(input && typeof input === 'object' ? input : {}) };

  if (
    !cfg.subscriptions ||
    typeof cfg.subscriptions !== 'object' ||
    Array.isArray(cfg.subscriptions)
  ) {
    cfg.subscriptions = {};
  }

  for (const [key, sub] of Object.entries(cfg.subscriptions)) {
    if (!sub || typeof sub !== 'object') {
      delete cfg.subscriptions[key];
      continue;
    }
    if (!sub.id) sub.id = key;
  }

  if (!Array.isArray(cfg.groups)) cfg.groups = [];
  if (!Array.isArray(cfg.listeners)) cfg.listeners = [];
  if (!Array.isArray(cfg.appliedGroupNames)) {
    cfg.appliedGroupNames = cfg.groups.map((group) => group.name).filter(Boolean);
  }
  if (!Array.isArray(cfg.appliedListenerNames)) {
    cfg.appliedListenerNames = cfg.listeners.map((listener) => listener.name).filter(Boolean);
  }

  return cfg;
}

function saveConfig(configPath, config) {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.config.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, configPath);
  return config;
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    const cfg = defaultConfig();
    saveConfig(configPath, cfg);
    return cfg;
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const error = new Error(`配置文件解析失败 (${configPath}): ${err.message}`);
    error.status = 500;
    throw error;
  }

  return normalizeConfig(parsed);
}

function createConfigStore({ configPath }) {
  if (!configPath) throw new Error('createConfigStore 需要 configPath');

  return {
    configPath,
    read() {
      return loadConfig(configPath);
    },
    write(config) {
      saveConfig(configPath, config);
      return config;
    },
    update(mutator) {
      const cfg = loadConfig(configPath);
      const result = mutator(cfg);
      saveConfig(configPath, cfg);
      return result;
    },
  };
}

module.exports = {
  DEFAULT_CONFIG,
  defaultConfig,
  normalizeConfig,
  loadConfig,
  saveConfig,
  createConfigStore,
};
