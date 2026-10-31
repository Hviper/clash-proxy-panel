'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, session, ipcMain, dialog } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../src/app');
const paths = require('../src/paths');

let mainWindow;
let tray;
let server;
let serverBaseUrl;
let isQuitting = false;
const apiToken = crypto.randomBytes(32).toString('hex');

function configPath() { return path.join(app.getPath('userData'), 'config.json'); }
function expectedOrigin() { return new URL(serverBaseUrl).origin; }

function migrateConfigIfNeeded() {
  const destination = configPath();
  if (fs.existsSync(destination)) return;
  const legacy = path.join(paths.PROJECT_ROOT, 'data', 'config.json');
  if (!fs.existsSync(legacy)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(legacy, destination);
}

function startServer() {
  migrateConfigIfNeeded();
  const expressApp = createApp({ configPath: configPath(), apiToken, publicDir: paths.PUBLIC_DIR });
  return new Promise((resolve, reject) => {
    server = http.createServer(expressApp);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function assertMainFrame(event) {
  if (!mainWindow || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url === '') {
    throw new Error('拒绝来自非主窗口的桌面请求');
  }
  if (new URL(event.senderFrame.url).origin !== expectedOrigin()) {
    throw new Error('拒绝来自非本地页面的桌面请求');
  }
}

async function desktopRequest(event, pathname, options = {}) {
  assertMainFrame(event);
  if (typeof pathname !== 'string' || !pathname.startsWith('/api/')) throw new Error('桌面请求仅允许 /api/ 路径');
  const method = String(options.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'DELETE'].includes(method)) throw new Error('桌面请求仅允许 GET、POST、DELETE 方法');
  const headers = { ...(options.headers || {}), 'X-Panel-Token': apiToken };
  const init = { method, headers };
  if (options.body !== undefined) {
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }
  // 设置独立超时，避免核心无响应导致渲染进程无限 loading。
  let response;
  try {
    response = await fetch(`${serverBaseUrl}${pathname}`, { ...init, signal: AbortSignal.timeout(30000) });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      return { ok: false, status: 504, data: { success: false, error: '桌面请求超时，请重试', message: '桌面请求超时，请重试' } };
    }
    throw err;
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: response.ok, status: response.status, data };
}

function createWindow(baseUrl) {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 960, minHeight: 640, show: false, title: 'Clash Proxy Panel',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    try { if (new URL(targetUrl).origin !== expectedOrigin()) event.preventDefault(); } catch { event.preventDefault(); }
  });
  mainWindow.on('close', (event) => { if (!isQuitting) { event.preventDefault(); mainWindow.hide(); } });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(baseUrl);
}

function trayImage() {
  // 以真实 RGBA 位图生成模板图标，避免 SVG 或损坏 PNG 在 macOS 菜单栏失效。
  const size = 18;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 3; y < 15; y += 1) {
    for (let x = 3; x < 15; x += 1) {
      const edge = x === 3 || x === 14 || y === 3 || y === 14;
      const diagonal = x === y || x + y === 17;
      if (!edge && !diagonal) continue;
      const index = (y * size + x) * 4;
      pixels[index] = 0;
      pixels[index + 1] = 0;
      pixels[index + 2] = 0;
      pixels[index + 3] = 255;
    }
  }
  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 });
  if (image.isEmpty()) throw new Error('无法创建菜单栏图标');
  image.setTemplateImage(true);
  return image;
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Clash Proxy Panel');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示面板', click: () => mainWindow.show() },
    { label: '隐藏面板', click: () => mainWindow.hide() },
    { type: 'separator' }, { label: '退出', accelerator: 'Command+Q', click: () => app.quit() },
  ]));
  tray.on('click', () => mainWindow.show());
}

function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Clash Proxy Panel', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit', accelerator: 'Command+Q' }] },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

function restrictRequests() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url);
      callback({ cancel: url.origin !== expectedOrigin() && url.protocol !== 'devtools:' });
    } catch { callback({ cancel: true }); }
  });
}

async function boot() {
  await app.whenReady();
  serverBaseUrl = await startServer();
  restrictRequests();
  ipcMain.handle('desktop:request', desktopRequest);
  ipcMain.handle('desktop:show-window', (event) => { assertMainFrame(event); mainWindow.show(); });
  ipcMain.handle('desktop:hide-window', (event) => { assertMainFrame(event); mainWindow.hide(); });
  createMenu(); createWindow(serverBaseUrl); createTray();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  boot().catch((error) => {
    console.error('桌面应用启动失败:', error);
    dialog.showErrorBox('Clash Proxy Panel 启动失败', error.message);
    app.exit(1);
  });
}

app.on('before-quit', () => { isQuitting = true; if (server) server.close(); });
app.on('window-all-closed', (event) => event.preventDefault());
app.on('activate', () => { if (mainWindow) mainWindow.show(); });
