'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const METHODS = new Set(['GET', 'POST', 'DELETE']);

function request(pathname, options = {}) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/api/')) {
    return Promise.reject(new Error('仅允许请求 /api/ 路径'));
  }
  const method = String(options.method || 'GET').toUpperCase();
  if (!METHODS.has(method)) {
    return Promise.reject(new Error('仅允许 GET、POST、DELETE 请求'));
  }
  return ipcRenderer.invoke('desktop:request', pathname, { ...options, method });
}

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  platform: 'darwin',
  request,
  showWindow: () => ipcRenderer.invoke('desktop:show-window'),
  hideWindow: () => ipcRenderer.invoke('desktop:hide-window'),
}));
