'use strict';

const { createApp } = require('./src/app');
const paths = require('./src/paths');

const app = createApp();

const server = app.listen(paths.PORT, paths.HOST, () => {
  console.log('Clash 代理面板后端已启动');
  console.log(`  地址:        http://${paths.HOST}:${paths.PORT}`);
  console.log(`  配置文件:    ${paths.CONFIG_PATH}`);
  console.log(`  Script.js:   ${paths.SCRIPT_PATH}`);
  console.log(`  Mihomo API:  ${paths.MIHOMO_API}`);
});

server.on('error', (err) => {
  console.error('服务启动失败:', err.message);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭服务...`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
