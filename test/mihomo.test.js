'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readSecret, readActiveProfile } = require('../src/mihomo');

function tempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clash-panel-mihomo-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return { file, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('readSecret 读取 clash-verge.yaml 中的 secret', () => {
  const temp = tempFile(
    'clash-verge.yaml',
    ['mixed-port: 7890', 'external-controller: 127.0.0.1:9097', 'secret: "abc123"', ''].join('\n')
  );
  try {
    assert.equal(readSecret(temp.file, 'fallback'), 'abc123');
  } finally {
    temp.cleanup();
  }
});

test('readSecret 在文件缺失或没有 secret 时使用显式的空值', () => {
  assert.equal(readSecret('/definitely/not/exist.yaml', ''), '');

  const temp = tempFile('clash-verge.yaml', 'mixed-port: 7890\n');
  try {
    assert.equal(readSecret(temp.file, ''), '');
  } finally {
    temp.cleanup();
  }
});

test('readActiveProfile 将 current uid 映射为名称', () => {
  const temp = tempFile(
    'profiles.yaml',
    [
      'current: RW4u7uHNoAkT',
      'items:',
      '- uid: Other',
      '  type: remote',
      '  name: 其他',
      '- uid: RW4u7uHNoAkT',
      '  type: remote',
      '  name: 白羊座',
      '  file: RW4u7uHNoAkT.yaml',
      '',
    ].join('\n')
  );
  try {
    assert.deepEqual(readActiveProfile(temp.file), {
      uid: 'RW4u7uHNoAkT',
      name: '白羊座',
    });
  } finally {
    temp.cleanup();
  }
});

test('readActiveProfile 在文件缺失时返回 null', () => {
  assert.equal(readActiveProfile('/definitely/not/exist.yaml'), null);
});
