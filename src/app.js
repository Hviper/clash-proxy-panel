'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');

const paths = require('./paths');
const { createConfigStore } = require('./config-store');
const {
  createMihomoClient,
  readActiveProfile,
  DEFAULT_DELAY_URL,
  DEFAULT_DELAY_TIMEOUT,
} = require('./mihomo');
const { createScriptManager } = require('./script-manager');
const { checkPort, checkPorts } = require('./ports');
const {
  buildProviderSection,
  buildGroupsSection,
} = require('./generator');
const {
  HttpError,
  asInteger,
  assertHttpUrl,
  normalizeSubscription,
  normalizeGroup,
  normalizeListener,
} = require('./validators');

const MAIN_MIXED_PORT = 7890;
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function isProxyProvider(provider) {
  return Boolean(provider) && provider.vehicleType !== 'Compatible';
}

function normalizeUpdatedAt(value) {
  if (!value || typeof value !== 'string' || value.startsWith('0001')) return null;
  return value;
}

function lastDelay(node) {
  const history = Array.isArray(node && node.history) ? node.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry && typeof entry.delay === 'number') return entry.delay;
  }
  return null;
}

function nextSubscriptionId(config) {
  let max = 0;
  for (const id of Object.keys(config.subscriptions)) {
    const match = /^p(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  let candidate = max + 1;
  while (config.subscriptions[`p${candidate}`]) candidate += 1;
  return `p${candidate}`;
}

/**
 * 从 query 或 body 中解析自定义测速的 url 与 timeout，缺省时使用默认值。
 * body 优先于 query。
 */
function resolveDelayOptions(req) {
  const body = req.body || {};

  const rawUrl =
    body.url !== undefined && body.url !== null && body.url !== ''
      ? body.url
      : req.query.url;
  const url =
    rawUrl === undefined || rawUrl === null || rawUrl === ''
      ? DEFAULT_DELAY_URL
      : String(rawUrl).trim();
  assertHttpUrl(url, '测速地址 url');

  const rawTimeout =
    body.timeout !== undefined && body.timeout !== null && body.timeout !== ''
      ? body.timeout
      : req.query.timeout;
  const timeout =
    rawTimeout === undefined || rawTimeout === null || rawTimeout === ''
      ? DEFAULT_DELAY_TIMEOUT
      : asInteger(rawTimeout, '超时时间 timeout', { min: 1, max: 60000 });

  return { url, timeout };
}

function collectPorts(config) {  return Array.from(
    new Set([
      MAIN_MIXED_PORT,
      ...config.listeners
        .map((listener) => Number(listener.port))
        .filter((port) => Number.isInteger(port) && port > 0),
    ])
  );
}

/**
 * 保留输入顺序执行异步任务，最多同时运行 limit 个任务。
 * apply 刷新订阅时需要避免无界并发，同时也要避免串行等待过长。
 */
async function mapWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(Number(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function isTimeoutError(error) {
  if (!error) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  if (error.code === 'ABORT_ERR' || error.code === 'UND_ERR_ABORTED') return true;
  return isTimeoutError(error.cause);
}

function createApp(options = {}) {
  const configPath = options.configPath || paths.CONFIG_PATH;
  const scriptPath = options.scriptPath || paths.SCRIPT_PATH;
  const profilesPath = options.profilesPath || paths.PROFILES_YAML;
  const publicDir = options.publicDir || paths.PUBLIC_DIR;
  const apiToken = options.apiToken || null;

  const store =
    options.store ||
    createConfigStore({
      configPath,
    });

  const mihomo =
    options.mihomo ||
    createMihomoClient({
      baseUrl: options.mihomoApi || paths.MIHOMO_API,
      secretPath: options.clashConfigPath || paths.CLASH_VERGE_CONFIG,
      fallbackSecret: options.fallbackSecret || paths.FALLBACK_SECRET,
    });

  const scriptManager =
    options.scriptManager ||
    createScriptManager({
      scriptPath,
    });

  const checkPortsImpl = options.checkPorts || checkPorts;
  const checkPortImpl = options.checkPort || checkPort;

  // 初始化配置文件（不存在时自动创建默认配置）
  store.read();

  // apply / restore 共用互斥锁：正在进行配置操作时，重复请求立即 409。
  let configurationBusy = false;
  function withConfigurationLock(handler) {
    if (configurationBusy) {
      throw new HttpError(409, '配置操作正在进行中，请稍后再试');
    }
    configurationBusy = true;
    return Promise.resolve()
      .then(() => handler())
      .finally(() => { configurationBusy = false; });
  }

  const app = express();

  // 仅允许本机访问，阻止 DNS rebinding 与跨站请求改写配置
  app.use((req, res, next) => {
    const host = String(req.headers.host || '').split(':')[0];
    if (host && !LOCAL_HOSTS.has(host)) {
      return res.status(403).json({
        success: false,
        error: '仅允许通过本机地址访问',
        message: '仅允许通过本机地址访问',
      });
    }

    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGIN.test(origin)) {
      return res.status(403).json({
        success: false,
        error: '禁止跨站请求',
        message: '禁止跨站请求',
      });
    }

    return next();
  });

  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || LOCAL_ORIGIN.test(origin)),
    })
  );
  app.use((req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; base-uri 'none'; form-action 'none'"
    );
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  // Web 模式不配置 token，保持原有本机使用方式；Electron 每次启动生成随机 token。
  app.use('/api', (req, res, next) => {
    if (!apiToken || req.get('X-Panel-Token') === apiToken) return next();
    return res.status(401).json({
      success: false,
      error: '未授权的桌面请求',
      message: '未授权的桌面请求',
    });
  });

  app.get(
    '/api/status',
    asyncHandler(async (req, res) => {
      const config = store.read();

      let mihomoRunning = false;
      let coreVersion = null;
      let coreVersionRaw = null;
      try {
        const version = await mihomo.getVersion();
        mihomoRunning = true;
        coreVersionRaw = version && version.version ? version.version : null;
        coreVersion = coreVersionRaw ? coreVersionRaw.replace(/^v/i, '') : null;
      } catch {
        mihomoRunning = false;
      }

      const profile = readActiveProfile(profilesPath);
      const ports = await checkPortsImpl(collectPorts(config));

      res.json({
        mihomoRunning,
        coreVersion,
        coreVersionRaw,
        activeProfile: profile ? profile.name : null,
        activeProfileUid: profile ? profile.uid : null,
        ports,
        lastAppliedAt: config.lastAppliedAt || null,
      });
    })
  );

  app.get(
    '/api/subscriptions',
    asyncHandler(async (req, res) => {
      const config = store.read();

      let providers = {};
      try {
        const data = await mihomo.getProviders();
        providers = (data && data.providers) || {};
      } catch {
        providers = {};
      }

      const subscriptions = {};
      for (const sub of Object.values(config.subscriptions)) {
        const provider = providers[sub.id];
        const usable = isProxyProvider(provider);
        const nodes = usable && Array.isArray(provider.proxies) ? provider.proxies : [];

        subscriptions[sub.id] = {
          ...sub,
          providerExists: usable,
          nodeCount: nodes.length,
          aliveCount: nodes.filter((node) => node && node.alive).length,
          updatedAt: usable ? normalizeUpdatedAt(provider.updatedAt) : null,
        };
      }

      res.json(subscriptions);
    })
  );

  app.post(
    '/api/subscriptions',
    asyncHandler(async (req, res) => {
      const config = store.read();
      const body = req.body || {};

      let existing = null;
      if (body.id !== undefined && body.id !== null && body.id !== '') {
        existing = config.subscriptions[String(body.id)] || null;
      } else if (typeof body.name === 'string') {
        existing =
          Object.values(config.subscriptions).find(
            (sub) => sub.name === body.name.trim()
          ) || null;
      }

      const subscription = normalizeSubscription(body, existing);
      if (!subscription.id) subscription.id = nextSubscriptionId(config);

      const isUpdate = Boolean(config.subscriptions[subscription.id]);
      config.subscriptions[subscription.id] = subscription;
      store.write(config);

      res.status(isUpdate ? 200 : 201).json({
        ok: true,
        subscription,
      });
    })
  );

  app.delete(
    '/api/subscriptions/:id',
    asyncHandler(async (req, res) => {
      const config = store.read();
      const id = req.params.id;

      if (!config.subscriptions[id]) {
        throw new HttpError(404, `订阅不存在: ${id}`);
      }

      delete config.subscriptions[id];

      const groupsUpdated = [];
      for (const group of config.groups) {
        if (Array.isArray(group.use) && group.use.includes(id)) {
          group.use = group.use.filter((item) => item !== id);
          groupsUpdated.push(group.name);
        }
      }

      store.write(config);
      res.json({ ok: true, deleted: id, groupsUpdated });
    })
  );

  app.post(
    '/api/subscriptions/:id/refresh',
    asyncHandler(async (req, res) => {
      const config = store.read();
      const id = req.params.id;

      if (!config.subscriptions[id]) {
        throw new HttpError(404, `订阅不存在: ${id}`);
      }

      try {
        await mihomo.updateProvider(id);
      } catch (err) {
        if (err.status === 404) {
          throw new HttpError(
            404,
            `Mihomo 中不存在 provider "${id}"，请先执行应用配置 (POST /api/apply)`
          );
        }
        throw err;
      }

      res.json({
        ok: true,
        id,
        refreshedAt: new Date().toISOString(),
      });
    })
  );

  app.get(
    '/api/nodes',
    asyncHandler(async (req, res) => {
      const data = await mihomo.getProviders();
      const providers = (data && data.providers) || {};

      const nodes = [];
      for (const [id, provider] of Object.entries(providers)) {
        if (!isProxyProvider(provider)) continue;
        for (const node of Array.isArray(provider.proxies) ? provider.proxies : []) {
          nodes.push({
            name: node.name,
            type: node.type,
            delay: lastDelay(node),
            alive: Boolean(node.alive),
            provider: id,
            providerName: provider.name || id,
          });
        }
      }

      res.json(nodes);
    })
  );

  app.get(
    '/api/groups',
    asyncHandler(async (req, res) => {
      const config = store.read();
      let mihomoProxies = {};
      try {
        mihomoProxies = await mihomo.getProxies();
      } catch {}
      const groupsWithNow = config.groups.map((g) => {
        const live = mihomoProxies?.proxies?.[g.name] || {};
        return {
          ...g,
          now: live.now || null,
          all: Array.isArray(live.all) ? live.all : [],
        };
      });
      res.json(groupsWithNow);
    })
  );

  app.post(
    '/api/groups',
    asyncHandler(async (req, res) => {
      const config = store.read();
      const body = req.body || {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) throw new HttpError(400, '代理组名称 name 不能为空');

      const index = config.groups.findIndex((group) => group.name === name);
      const existing = index >= 0 ? config.groups[index] : null;
      const group = normalizeGroup(body, existing);

      if (index >= 0) {
        config.groups[index] = group;
      } else {
        config.groups.push(group);
      }

      store.write(config);
      res.status(index >= 0 ? 200 : 201).json({ ok: true, group });
    })
  );

  app.delete(
    '/api/groups/:name',
    asyncHandler(async (req, res) => {
      const config = store.read();
      const name = req.params.name;
      const index = config.groups.findIndex((group) => group.name === name);

      if (index === -1) {
        throw new HttpError(404, `代理组不存在: ${name}`);
      }

      config.groups.splice(index, 1);

      const removedListeners = [];
      config.listeners = config.listeners.filter((listener) => {
        if (listener.proxy === name) {
          removedListeners.push(listener.name);
          return false;
        }
        return true;
      });

      store.write(config);
      res.json({ ok: true, deleted: name, removedListeners });
    })
  );

  app.post(
    '/api/groups/:name/delay',
    asyncHandler(async (req, res) => {
      const group = req.params.name;
      const { url, timeout } = resolveDelayOptions(req);

      let delays;
      try {
        delays = await mihomo.testGroupDelay(group, url, timeout);
      } catch (err) {
        if (err.status === 404) {
          throw new HttpError(404, `Mihomo 中不存在代理组: ${group}`);
        }
        throw err;
      }

      res.json({
        success: true,
        group,
        url,
        delays: delays && typeof delays === 'object' ? delays : {},
      });
    })
  );

  app.post(
    '/api/groups/:name/select',
    asyncHandler(async (req, res) => {
      const group = req.params.name;
      const body = req.body || {};
      const proxyName = typeof body.proxy === 'string' ? body.proxy.trim() : '';
      if (!proxyName) {
        throw new HttpError(400, '节点名称 proxy 不能为空');
      }

      try {
        await mihomo.selectProxy(group, proxyName);
      } catch (err) {
        if (err.status === 404) {
          throw new HttpError(404, `Mihomo 中不存在代理组: ${group}`);
        }
        throw err;
      }

      res.json({ success: true, group, proxy: proxyName });
    })
  );

  app.post(
    '/api/proxies/:name/delay',
    asyncHandler(async (req, res) => {
      const proxy = req.params.name;
      const { url, timeout } = resolveDelayOptions(req);

      let data;
      try {
        data = await mihomo.testProxyDelay(proxy, url, timeout);
      } catch (err) {
        if (err.status === 404) {
          throw new HttpError(404, `Mihomo 中不存在节点: ${proxy}`);
        }
        throw err;
      }

      const delay =
        data && typeof data.delay === 'number' ? data.delay : null;

      res.json({ success: true, proxy, url, delay });
    })
  );

  app.get('/api/listeners', (req, res) => {
    const config = store.read();
    res.json(config.listeners);
  });

  app.post(
    '/api/listeners',
    asyncHandler(async (req, res) => {
      const config = store.read();
      const body = req.body || {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) throw new HttpError(400, '监听器名称 name 不能为空');

      const index = config.listeners.findIndex((listener) => listener.name === name);
      const existing = index >= 0 ? config.listeners[index] : null;
      const listener = normalizeListener(body, existing);

      const conflict = config.listeners.find(
        (item) => item.name !== listener.name && Number(item.port) === listener.port
      );
      if (conflict) {
        throw new HttpError(
          409,
          `端口 ${listener.port} 已被监听器 "${conflict.name}" 占用`
        );
      }

      if (index >= 0) {
        config.listeners[index] = listener;
      } else {
        config.listeners.push(listener);
      }

      store.write(config);
      res.status(index >= 0 ? 200 : 201).json({ ok: true, listener });
    })
  );

  app.delete(
    '/api/listeners/:name',
    asyncHandler(async (req, res) => {
      const config = store.read();
      const name = req.params.name;
      const index = config.listeners.findIndex((listener) => listener.name === name);

      if (index === -1) {
        throw new HttpError(404, `监听器不存在: ${name}`);
      }

      config.listeners.splice(index, 1);
      store.write(config);
      res.json({ ok: true, deleted: name });
    })
  );

  app.get(
    '/api/test-port',
    asyncHandler(async (req, res) => {
      const port = Number(req.query.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new HttpError(400, 'port 必须是 1-65535 之间的整数');
      }

      const startedAt = Date.now();
      const ok = await checkPortImpl(port, '127.0.0.1', 1500);
      res.json({ ok, port, latency: Date.now() - startedAt });
    })
  );

  app.post(
    '/api/apply',
    asyncHandler(async (req, res) => {
      const result = await withConfigurationLock(async () => {
        const config = store.read();

        const currentGroupNames = config.groups.map((group) => group.name);
        const currentListenerNames = config.listeners.map((listener) => listener.name);

        const staleGroupNames = (config.appliedGroupNames || []).filter(
          (name) => !currentGroupNames.includes(name)
        );
        const staleListenerNames = (config.appliedListenerNames || []).filter(
          (name) => !currentListenerNames.includes(name)
        );

        const providerSection = buildProviderSection(config.subscriptions);
        const groupsSection = buildGroupsSection({
          groups: config.groups,
          listeners: config.listeners,
          staleGroupNames,
          staleListenerNames,
        });

        const applied = scriptManager.apply({ providerSection, groupsSection });
        const logs = [...applied.logs];

        const subscriptionIds = Object.keys(config.subscriptions);
        const providers = await mapWithConcurrency(subscriptionIds, 4, async (id) => {
          try {
            await mihomo.updateProvider(id);
            logs.push(`已刷新订阅 provider：${id}`);
            return { id, ok: true };
          } catch (err) {
            logs.push(`刷新订阅 provider 失败：${id} - ${err.message}`);
            return { id, ok: false, error: err.message };
          }
        });

        const failedProviders = providers.filter((item) => !item.ok);

        logs.push('提示：代理组与监听端口需 Clash Verge 重新生成配置后生效');

        const ports = await checkPortsImpl(collectPorts(config));
        logs.push(
          `端口检测：${Object.entries(ports)
            .map(([port, open]) => `${port}=${open ? 'open' : 'closed'}`)
            .join(', ')}`
        );

        config.appliedGroupNames = currentGroupNames;
        config.appliedListenerNames = currentListenerNames;
        config.lastAppliedAt = new Date().toISOString();
        store.write(config);

        const scriptWritten = true;
        const partial = failedProviders.length > 0;
        const success = !partial;

        return {
          success,
          ok: success,
          partial,
          scriptWritten,
          message: partial
            ? '配置已写入 Script.js，但部分订阅刷新失败，请稍后重试'
            : '配置已安全写入 Script.js 并刷新 provider',
          logs,
          backup: path.basename(applied.backupPath),
          providers,
          failedProviders: failedProviders.map((item) => item.id),
          ports,
          appliedAt: config.lastAppliedAt,
        };
      });

      res.json(result);
    })
  );

  app.get('/api/backups', (req, res) => {
    res.json(scriptManager.listBackups());
  });

  app.post(
    '/api/backups/restore',
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const file = body.file || body.name;
      if (!file) {
        throw new HttpError(400, '缺少备份文件名 file');
      }

      const result = await withConfigurationLock(async () => {
        const restored = scriptManager.restore(file);
        const config = store.read();
        config.appliedGroupNames = [];
        config.appliedListenerNames = [];
        store.write(config);

        return {
          success: true,
          ok: true,
          message: `已回滚到 ${restored.restoredFrom}`,
          restoredFrom: restored.restoredFrom,
          backupOfCurrent: restored.backupOfCurrent,
          logs: restored.logs,
          manifestReset: true,
          note: '回滚仅还原 Script.js；面板记录已清空，需重新执行“应用配置”后才会生效',
        };
      });

      res.json(result);
    })
  );

  app.use(express.static(publicDir));

  app.use('/api', (req, res) => {
    const message = `接口不存在: ${req.method} ${req.originalUrl}`;
    res.status(404).json({ success: false, error: message, message });
  });

  app.use((req, res) => {
    res.status(404).send('Not Found');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status && Number.isInteger(err.status) ? err.status : 500;
    if (status >= 500) {
      console.error('[clash-proxy-panel]', err);
    }
    const message = err.message || 'Internal Server Error';
    res.status(status).json({
      success: false,
      error: message,
      message,
    });
  });

  return app;
}

module.exports = { createApp };
