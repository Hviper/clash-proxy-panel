'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createScriptManager } = require('../src/script-manager');
const { buildProviderSection, buildGroupsSection } = require('../src/generator');
const { makeTempProject, fixtureScript, fixtureConfig } = require('../test-support/helpers');

function buildSections(config = fixtureConfig()) {
  return {
    providerSection: buildProviderSection(config.subscriptions),
    groupsSection: buildGroupsSection({
      groups: config.groups,
      listeners: config.listeners,
      staleGroupNames: [],
      staleListenerNames: [],
    }),
  };
}

test('apply 会备份、校验语法并原子写回', () => {
  const project = makeTempProject();
  try {
    const manager = createScriptManager({ scriptPath: project.scriptPath });
    const result = manager.apply(buildSections());

    assert.match(path.basename(result.backupPath), /^Script\.js\.bak-panel-\d{8}-\d{6}$/);
    assert.ok(fs.existsSync(result.backupPath));

    const updated = fs.readFileSync(project.scriptPath, 'utf8');
    assert.match(updated, /\[CUSTOM MULTI-SUBSCRIPTION PROVIDERS\]/);
    assert.match(updated, /"p2": \{/);
    assert.match(updated, /AGY Gemini/);
    assert.match(updated, /agy-gemini/);
    assert.match(updated, /opencode-in/);
    assert.doesNotMatch(updated, /旧内容/);

    // 备份内容应当是替换前的原始文件
    assert.equal(fs.readFileSync(result.backupPath, 'utf8'), fixtureScript());

    const backups = manager.listBackups();
    assert.equal(backups.length, 1);
    assert.equal(backups[0].file, path.basename(result.backupPath));
  } finally {
    project.cleanup();
  }
});

test('语法错误会被 vm 拒绝且不写入、不创建备份', () => {
  const project = makeTempProject();
  try {
    const manager = createScriptManager({ scriptPath: project.scriptPath });
    assert.throws(() => manager.apply({ ...buildSections(), providerSection: 'const broken = ;' }), /语法校验失败/);
    assert.equal(fs.readFileSync(project.scriptPath, 'utf8'), fixtureScript());
    assert.equal(manager.listBackups().length, 0);
  } finally { project.cleanup(); }
});

test('restore 会先备份当前版本再回滚', () => {
  const project = makeTempProject();
  try {
    const manager = createScriptManager({ scriptPath: project.scriptPath });
    const applied = manager.apply(buildSections());

    fs.appendFileSync(project.scriptPath, '\n// 后续手动修改\n', 'utf8');

    const restored = manager.restore(path.basename(applied.backupPath));
    assert.equal(restored.restoredFrom, path.basename(applied.backupPath));
    assert.match(restored.backupOfCurrent, /^Script\.js\.bak-panel-/);

    const content = fs.readFileSync(project.scriptPath, 'utf8');
    assert.equal(content, fixtureScript());
    assert.equal(manager.listBackups().length, 2);
  } finally {
    project.cleanup();
  }
});

test('缺少标记时拒绝写入且不产生备份', () => {
  const project = makeTempProject();
  try {
    fs.writeFileSync(project.scriptPath, 'function main(config) { return config; }\n', 'utf8');
    const manager = createScriptManager({ scriptPath: project.scriptPath });

    assert.throws(() => manager.apply(buildSections()), /未找到段落标记/);
    assert.equal(manager.listBackups().length, 0);
    assert.equal(
      fs.readFileSync(project.scriptPath, 'utf8'),
      'function main(config) { return config; }\n'
    );
  } finally {
    project.cleanup();
  }
});

test('restore 拒绝非法文件名与不存在的备份', () => {
  const project = makeTempProject();
  try {
    const manager = createScriptManager({ scriptPath: project.scriptPath });

    assert.throws(() => manager.restore('../../etc/passwd'), /备份文件名不合法/);
    assert.throws(
      () => manager.restore('Script.js.bak-panel-20260101-000000'),
      /备份文件不存在/
    );
  } finally {
    project.cleanup();
  }
});
