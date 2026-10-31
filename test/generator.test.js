'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SECTION1_START, SECTION1_END, SECTION2_START, SECTION2_END, buildProviderSection, buildGroupsSection } = require('../src/generator');
const { fixtureConfig } = require('../test-support/helpers');

test('生成 provider 段落包含订阅、前缀与健康检查', () => {
  const section = buildProviderSection(fixtureConfig().subscriptions);
  assert.ok(section.startsWith(SECTION1_START)); assert.ok(section.endsWith(SECTION1_END));
  assert.match(section, /const proxyProviders = \{/); assert.match(section, /"p2": \{/); assert.match(section, /"p3": \{/);
  assert.match(section, /Sakura \|/); assert.match(section, /Dasho \|/);
  assert.match(section, /"path": "\.\/proxy_providers\/p2\.yaml"/); assert.match(section, /"health-check"/);
});

test('无订阅时生成合法的空对象', () => assert.match(buildProviderSection({}), /const proxyProviders = \{\};/));

test('生成代理组与监听器段落', () => {
  const config = fixtureConfig();
  const section = buildGroupsSection({ groups: config.groups, listeners: config.listeners, staleGroupNames: ['Old Group'], staleListenerNames: ['old-listener'] });
  assert.ok(section.startsWith(SECTION2_START)); assert.ok(section.endsWith(SECTION2_END));
  assert.match(section, /const panelGroupConfigs = \[/); assert.match(section, /"name": "AGY Gemini"/);
  assert.match(section, /"p2"/); assert.match(section, /"p3"/); assert.match(section, /"includeActiveProfile": true/);
  assert.match(section, /panelFilterToRegExp/); assert.match(section, /"Old Group"/); assert.match(section, /"old-listener"/);
  assert.match(section, /"agy-gemini"/); assert.match(section, /"opencode-in"/); assert.match(section, /config\.listeners\.push/);
});

test('已被删除的组不会重复出现在 stale 列表中', () => {
  const config = fixtureConfig();
  const section = buildGroupsSection({ groups: config.groups, listeners: config.listeners, staleGroupNames: ['AGY Gemini'], staleListenerNames: [] });
  assert.match(section, /const panelStaleGroupNames = \[\];/);
});
