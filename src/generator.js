'use strict';

const SECTION1_START =
  '// ==================== [CUSTOM MULTI-SUBSCRIPTION PROVIDERS] ====================';
const SECTION1_END = '// ' + '='.repeat(79);
const SECTION2_START =
  '// ==================== [CUSTOM PROXY GROUPS & LISTENERS] ====================';
const SECTION2_END = '// ' + '='.repeat(75);

const DEFAULT_PROVIDER_GROUP = '🔰 模式选择';
const DEFAULT_HEALTH_CHECK_URL = 'https://www.google.com/generate_204';

/**
 * 生成 Script.js 中的「多订阅 provider」段落。
 */
function buildProviderSection(subscriptions = {}) {
  const providers = {};

  for (const sub of Object.values(subscriptions)) {
    if (!sub || !sub.id || !sub.url) continue;

    const provider = {
      type: 'http',
      url: sub.url,
      interval: Number(sub.interval) || 86400,
      path: `./proxy_providers/${sub.id}.yaml`,
      proxy: DEFAULT_PROVIDER_GROUP,
    };

    if (sub.prefix) {
      provider.override = { 'additional-prefix': sub.prefix };
    }

    provider['health-check'] = {
      enable: true,
      url: DEFAULT_HEALTH_CHECK_URL,
      interval: 300,
    };

    providers[sub.id] = provider;
  }

  const json = JSON.stringify(providers, null, 2);

  return [SECTION1_START, `const proxyProviders = ${json};`, SECTION1_END].join('\n');
}

/**
 * 生成 Script.js main() 内部的「代理组与监听端口」段落。
 *
 * 该段落会在每次应用时整体替换，因此需要同时处理：
 * - 当前配置的组与监听器
 * - 上一次应用过、但本次已被删除的组与监听器（stale）
 */
function buildGroupsSection({
  groups = [],
  listeners = [],
  staleGroupNames = [],
  staleListenerNames = [],
} = {}) {
  const groupConfigs = groups.map((group) => ({
    name: group.name,
    type: group.type || 'select',
    use: Array.isArray(group.use) ? group.use : [],
    filter: group.filter || '',
    testUrl: group.testUrl || '',
    interval: Number.isInteger(Number(group.interval)) ? Number(group.interval) : 300,
    includeActiveProfile: Boolean(group.includeActiveProfile),
  }));

  const listenerConfigs = listeners.map((listener) => ({
    name: listener.name,
    type: listener.type || 'mixed',
    listen: listener.listen || '127.0.0.1',
    port: Number(listener.port),
    proxy: listener.proxy,
    udp: listener.udp !== false,
  }));

  const currentGroupNames = new Set(groupConfigs.map((group) => group.name));
  const staleGroups = Array.from(
    new Set(staleGroupNames.filter((name) => name && !currentGroupNames.has(name)))
  );

  const managedListenerNames = Array.from(
    new Set([...staleListenerNames, ...listenerConfigs.map((listener) => listener.name)])
  ).filter(Boolean);

  const lines = [
    SECTION2_START,
    `const panelGroupConfigs = ${JSON.stringify(groupConfigs, null, 2)};`,
    `const panelStaleGroupNames = ${JSON.stringify(staleGroups)};`,
    `const panelManagedListenerNames = ${JSON.stringify(managedListenerNames)};`,
    `const panelListeners = ${JSON.stringify(listenerConfigs, null, 2)};`,
    '',
    '// 将 Clash 风格的 (?i) 内联标记转换为 JS 正则 flags',
    'function panelFilterToRegExp(filter) {',
    '  let source = String(filter || "");',
    '  let flags = "";',
    '  const inline = source.match(/^\\(\\?([a-z]+)\\)/i);',
    '  if (inline) {',
    '    flags = inline[1];',
    '    source = source.slice(inline[0].length);',
    '  }',
    '  try {',
    '    return new RegExp(source, flags);',
    '  } catch (err) {',
    '    console.warn("信息：无法解析代理组过滤器:", filter, err.message);',
    '    return null;',
    '  }',
    '}',
    '',
    '// 移除上一次应用过、但已从面板删除的组',
    'if (panelStaleGroupNames.length > 0) {',
    '  for (let i = finalProxyGroups.length - 1; i >= 0; i--) {',
    '    if (panelStaleGroupNames.indexOf(finalProxyGroups[i].name) !== -1) {',
    '      finalProxyGroups.splice(i, 1);',
    '    }',
    '  }',
    '}',
    '',
    'panelGroupConfigs.forEach(cfg => {',
    '  let group = finalProxyGroups.find(item => item.name === cfg.name);',
    '  const created = !group;',
    '  if (!group) {',
    '    group = { name: cfg.name, type: cfg.type || "select" };',
    '    finalProxyGroups.push(group);',
    '  }',
    '  group.type = cfg.type || "select";',
    '  if (Array.isArray(cfg.use) && cfg.use.length > 0) {',
    '    group.use = [...cfg.use];',
    '  } else {',
    '    delete group.use;',
    '  }',
    '  if (cfg.filter) {',
    '    group.filter = cfg.filter;',
    '  } else {',
    '    delete group.filter;',
    '  }',
    '  if (cfg.testUrl) {',
    '    group.url = cfg.testUrl;',
    '  } else {',
    '    delete group.url;',
    '  }',
    '  if (cfg.interval !== undefined && cfg.interval !== null) {',
    '    group.interval = cfg.interval;',
    '  } else {',
    '    delete group.interval;',
    '  }',
    '  // includeActiveProfile：把当前活动配置中的节点合并进本组（按 filter 过滤）',
    '  if (cfg.includeActiveProfile) {',
    '    const matcher = cfg.filter ? panelFilterToRegExp(cfg.filter) : null;',
    '    group.proxies = Array.from(new Set((config.proxies || [])',
    '      .map(proxy => (proxy && proxy.name ? proxy.name : ""))',
    '      .filter(name => name && (!matcher || matcher.test(name)))));',
    '  } else if (created) {',
    '    delete group.proxies;',
    '  }',
    '});',
    '',
    '// 仅移除由面板管理的监听器，保留用户手动添加的其他监听器',
    'const panelManagedNames = new Set(panelManagedListenerNames);',
    'const existingListeners = Array.isArray(config.listeners) ? config.listeners : [];',
    'config.listeners = existingListeners.filter(listener => !panelManagedNames.has(listener.name));',
    'panelListeners.forEach(listener => {',
    '  config.listeners.push({',
    '    name: listener.name,',
    '    type: listener.type,',
    '    listen: listener.listen,',
    '    port: listener.port,',
    '    proxy: listener.proxy,',
    '    udp: listener.udp !== false',
    '  });',
    '});',
    SECTION2_END,
  ];

  return lines.join('\n');
}

module.exports = {
  SECTION1_START,
  SECTION1_END,
  SECTION2_START,
  SECTION2_END,
  buildProviderSection,
  buildGroupsSection,
};
