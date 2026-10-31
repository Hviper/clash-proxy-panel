'use strict';

const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const CLASH_VERGE_DIR =
  process.env.CLASH_VERGE_DIR ||
  path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'io.github.clash-verge-rev.clash-verge-rev'
  );

module.exports = {
  PROJECT_ROOT,
  PUBLIC_DIR: path.join(PROJECT_ROOT, 'public'),
  DATA_DIR: path.join(PROJECT_ROOT, 'data'),
  CONFIG_PATH: path.join(PROJECT_ROOT, 'data', 'config.json'),

  CLASH_VERGE_DIR,
  CLASH_VERGE_CONFIG: path.join(CLASH_VERGE_DIR, 'clash-verge.yaml'),
  PROFILES_YAML: path.join(CLASH_VERGE_DIR, 'profiles.yaml'),
  SCRIPT_PATH:
    process.env.CLASH_SCRIPT_PATH ||
    path.join(CLASH_VERGE_DIR, 'profiles', 'Script.js'),

  MIHOMO_API: process.env.MIHOMO_API || 'http://127.0.0.1:9097',
  // Mihomo 未设置 secret 时使用空授权；绝不在发行包中内置凭据。
  FALLBACK_SECRET: process.env.MIHOMO_SECRET || '',

  HOST: '127.0.0.1',
  PORT: Number(process.env.PANEL_PORT || 3690),
};
