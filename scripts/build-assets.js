'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'public', 'vendor');

function copy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

copy(
  path.join(root, 'node_modules', 'vue', 'dist', 'vue.global.prod.js'),
  path.join(vendor, 'vue.global.prod.js')
);
copy(
  path.join(root, 'node_modules', 'lucide', 'dist', 'umd', 'lucide.js'),
  path.join(vendor, 'lucide.js')
);

const tailwindConfig = path.join(root, 'tailwind.config.js');
if (!fs.existsSync(tailwindConfig)) {
  throw new Error('缺少由前端负责维护的 tailwind.config.js');
}
execFileSync(
  process.execPath,
  [
    path.join(root, 'node_modules', 'tailwindcss', 'lib', 'cli.js'),
    '-c', tailwindConfig,
    '-i', path.join(root, 'scripts', 'tailwind.input.css'),
    '-o', path.join(vendor, 'tailwind.css'),
    '--minify',
  ],
  { cwd: root, stdio: 'inherit' }
);
