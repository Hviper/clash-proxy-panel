'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const {
  SECTION1_START,
  SECTION2_START,
} = require('./generator');

const BACKUP_PATTERN = /^Script\.js\.bak-panel-\d{8}-\d{6}(?:-\d+)?$/;

function pad(value) {
  return String(value).padStart(2, '0');
}

function timestamp(date = new Date()) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function formatDateTime(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function indentBlock(block, indent) {
  if (!indent) return block;
  return block
    .split('\n')
    .map((line) => (line.length > 0 ? indent + line : line))
    .join('\n');
}

function findSection(lines, startMarker) {
  const start = lines.findIndex((line) => line.trim() === startMarker);
  if (start === -1) {
    const error = new Error(`Script.js 中未找到段落标记: ${startMarker}`);
    error.status = 422;
    throw error;
  }

  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\/\/\s*=+\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }

  if (end === -1) {
    const error = new Error(`Script.js 中段落缺少结束标记（起始行 ${start + 1}）`);
    error.status = 422;
    throw error;
  }

  return { start, end };
}

/**
 * 按标记定位并替换段落。生成段落以 0 缩进书写，替换时自动匹配原标记的缩进。
 */
function replaceSections(content, replacements) {
  const lines = content.split('\n');

  const ranges = replacements.map((item) => {
    const range = findSection(lines, item.startMarker);
    const indent = (lines[range.start].match(/^\s*/) || [''])[0];
    return {
      ...range,
      replacement: indentBlock(item.replacement, indent),
      startMarker: item.startMarker,
    };
  });

  ranges.sort((a, b) => b.start - a.start);

  for (const range of ranges) {
    lines.splice(
      range.start,
      range.end - range.start + 1,
      ...range.replacement.split('\n')
    );
  }

  return lines.join('\n');
}

function createScriptManager({ scriptPath, backupPrefix = 'bak-panel' } = {}) {
  if (!scriptPath) throw new Error('createScriptManager 需要 scriptPath');

  const scriptDir = path.dirname(scriptPath);
  const scriptName = path.basename(scriptPath);

  function assertScriptExists() {
    if (!fs.existsSync(scriptPath)) {
      const error = new Error(`Script.js 不存在: ${scriptPath}`);
      error.status = 404;
      throw error;
    }
  }

  function read() {
    assertScriptExists();
    return fs.readFileSync(scriptPath, 'utf8');
  }

  function validateSyntax(content, label = scriptName) {
    try {
      // Electron 内嵌 Node 提供 vm，无需发行环境另行安装 node 可执行文件。
      new vm.Script(content, { filename: label });
    } catch (err) {
      const error = new Error(`语法校验失败（${label}）：${err.message}`);
      error.status = 422;
      throw error;
    }
  }

  function backup() {
    fs.mkdirSync(scriptDir, { recursive: true });
    const base = `${scriptName}.${backupPrefix}-${timestamp()}`;
    let fileName = base;
    let counter = 1;
    while (fs.existsSync(path.join(scriptDir, fileName))) {
      fileName = `${base}-${counter}`;
      counter += 1;
    }

    const destination = path.join(scriptDir, fileName);
    fs.copyFileSync(scriptPath, destination);
    return destination;
  }

  function atomicWrite(content) {
    const tmpPath = path.join(
      scriptDir,
      `.${scriptName}.tmp-${process.pid}-${Date.now()}`
    );
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, scriptPath);
  }

  function apply({ providerSection, groupsSection }) {
    assertScriptExists();

    const logs = [];
    const original = read();
    logs.push(`读取 ${scriptName}（${Buffer.byteLength(original)} 字节）`);

    const updated = replaceSections(original, [
      { startMarker: SECTION1_START, replacement: providerSection },
      { startMarker: SECTION2_START, replacement: groupsSection },
    ]);
    logs.push('已定位并替换两个托管段落');

    validateSyntax(updated);
    logs.push('语法校验通过（node --check）');

    const backupPath = backup();
    logs.push(`已创建备份：${path.basename(backupPath)}`);

    atomicWrite(updated);
    logs.push(`已原子写回 ${scriptName}（${Buffer.byteLength(updated)} 字节）`);

    return {
      logs,
      backupPath,
      content: updated,
    };
  }

  function listBackups() {
    if (!fs.existsSync(scriptDir)) return [];

    return fs
      .readdirSync(scriptDir)
      .filter((file) => BACKUP_PATTERN.test(file))
      .map((file) => {
        const stat = fs.statSync(path.join(scriptDir, file));
        return {
          file,
          size: stat.size,
          time: formatDateTime(stat.mtime),
          mtime: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  function restore(fileName) {
    const safeName = path.basename(String(fileName || '').trim());
    if (!BACKUP_PATTERN.test(safeName)) {
      const error = new Error('备份文件名不合法，仅支持 Script.js.bak-panel-YYYYMMDD-HHMMSS');
      error.status = 400;
      throw error;
    }

    const sourcePath = path.join(scriptDir, safeName);
    if (!fs.existsSync(sourcePath)) {
      const error = new Error(`备份文件不存在: ${safeName}`);
      error.status = 404;
      throw error;
    }

    const logs = [];
    const content = fs.readFileSync(sourcePath, 'utf8');
    logs.push(`读取备份：${safeName}（${Buffer.byteLength(content)} 字节）`);

    validateSyntax(content, safeName);
    logs.push('备份文件语法校验通过（node --check）');

    const safetyBackup = backup();
    logs.push(`已备份当前版本：${path.basename(safetyBackup)}`);

    atomicWrite(content);
    logs.push(`已回滚 ${scriptName}`);

    return {
      logs,
      restoredFrom: safeName,
      backupOfCurrent: path.basename(safetyBackup),
    };
  }

  return {
    scriptPath,
    scriptDir,
    read,
    apply,
    backup,
    listBackups,
    restore,
    validateSyntax,
  };
}

module.exports = {
  BACKUP_PATTERN,
  createScriptManager,
  replaceSections,
  indentBlock,
  timestamp,
};
