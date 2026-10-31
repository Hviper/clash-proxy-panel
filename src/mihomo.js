'use strict';

const fs = require('fs');
const paths = require('./paths');

const DEFAULT_DELAY_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_DELAY_TIMEOUT = 5000;

function delayQuery(url, timeout) {
  return `url=${encodeURIComponent(url)}&timeout=${timeout}`;
}

function stripQuotes(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

/**
 * 从 clash-verge.yaml 中读取 external-controller 的 secret，读取失败时使用显式传入的值。
 */
function readSecret(secretPath, fallbackSecret) {
  try {
    const text = fs.readFileSync(secretPath, 'utf8');
    const match = text.match(/^\s*secret:\s*(.+?)\s*$/m);
    if (match) {
      const secret = stripQuotes(match[1]);
      if (secret) return secret;
    }
  } catch {
    // 配置文件不存在或不可读时静默使用兜底密钥
  }
  return fallbackSecret;
}

/**
 * 解析 profiles.yaml 中的 current 字段，并映射到配置项名称。
 */
function readActiveProfile(profilesPath) {
  try {
    const text = fs.readFileSync(profilesPath, 'utf8');
    const currentMatch = text.match(/^current:\s*(.+?)\s*$/m);
    if (!currentMatch) return null;

    const uid = stripQuotes(currentMatch[1]);
    if (!uid) return null;

    const lines = text.split(/\r?\n/);
    let inCurrentItem = false;
    let name = null;

    for (const line of lines) {
      const uidMatch = line.match(/^-\s+uid:\s*(.+?)\s*$/);
      if (uidMatch) {
        inCurrentItem = stripQuotes(uidMatch[1]) === uid;
        continue;
      }
      if (!inCurrentItem) continue;

      const nameMatch = line.match(/^\s+name:\s*(.+?)\s*$/);
      if (nameMatch) {
        const value = stripQuotes(nameMatch[1]);
        if (value && value !== 'null') {
          name = value;
          break;
        }
      }
    }

    return { uid, name: name || uid };
  } catch {
    return null;
  }
}

function createMihomoClient(options = {}) {
  const baseUrl = (options.baseUrl || paths.MIHOMO_API).replace(/\/+$/, '');
  const secretPath = options.secretPath || paths.CLASH_VERGE_CONFIG;
  const fallbackSecret = options.fallbackSecret || paths.FALLBACK_SECRET;
  const timeout = options.timeout || 5000;

  let secretCache = { value: null, at: 0 };
  const SECRET_TTL = 30000;

  function getSecret() {
    if (secretCache.value && Date.now() - secretCache.at < SECRET_TTL) {
      return secretCache.value;
    }
    const secret = readSecret(secretPath, fallbackSecret);
    secretCache = { value: secret, at: Date.now() };
    return secret;
  }

  async function request(method, apiPath, body, reqTimeout) {
    const secret = getSecret();
    const headers = secret ? { Authorization: `Bearer ${secret}` } : {};
    const init = {
      method,
      headers,
      signal: AbortSignal.timeout(reqTimeout || timeout),
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(`${baseUrl}${apiPath}`, init);
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        const error = new Error(`Mihomo ${method} ${apiPath} 超时或已被取消`);
        error.status = 504;
        error.data = null;
        throw error;
      }
      throw err;
    }
    const text = await response.text();

    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      const message =
        data && typeof data === 'object' && data.message
          ? data.message
          : typeof data === 'string'
            ? data
            : response.statusText;
      const error = new Error(
        `Mihomo ${method} ${apiPath} 失败: HTTP ${response.status}${message ? ` - ${message}` : ''}`
      );
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  return {
    baseUrl,
    getSecret,

    getVersion() {
      return request('GET', '/version');
    },

    getProviders() {
      return request('GET', '/providers/proxies');
    },

    updateProvider(name) {
      return request('PUT', `/providers/proxies/${encodeURIComponent(name)}`);
    },

    getProxies() {
      return request('GET', '/proxies');
    },

    selectProxy(groupName, proxyName) {
      return request('PUT', `/proxies/${encodeURIComponent(groupName)}`, {
        name: proxyName,
      });
    },

    /**
     * 对代理组内所有节点使用自定义地址测速。
     * Mihomo 返回形如 { "节点名": 延迟毫秒 } 的对象，失败的节点延迟为 -1 或 0。
     */
    testGroupDelay(groupName, url = DEFAULT_DELAY_URL, timeout = DEFAULT_DELAY_TIMEOUT) {
      const probeTimeout = Number(timeout) || DEFAULT_DELAY_TIMEOUT;
      return request(
        'GET',
        `/group/${encodeURIComponent(groupName)}/delay?${delayQuery(url, probeTimeout)}`,
        undefined,
        Math.min(probeTimeout + 1500, 10000)
      );
    },

    /**
     * 对单个节点使用自定义地址测速。
     * Mihomo 返回形如 { delay: 123 } 的对象。
     */
    testProxyDelay(proxyName, url = DEFAULT_DELAY_URL, timeout = DEFAULT_DELAY_TIMEOUT) {
      const probeTimeout = Number(timeout) || DEFAULT_DELAY_TIMEOUT;
      return request(
        'GET',
        `/proxies/${encodeURIComponent(proxyName)}/delay?${delayQuery(url, probeTimeout)}`,
        undefined,
        Math.min(probeTimeout + 1000, 8000)
      );
    },

    /**
     * 对 provider 内的单个节点测速。
     *
     * 订阅 provider 的节点不会注册到 /proxies 顶层，只能通过
     * /providers/proxies/{provider}/{name}/healthcheck 定位；
     * 直接请求 /proxies/{name}/delay 会返回 404。
     * Mihomo 返回形如 { delay: 123 } 的对象。
     */
    testProviderProxyDelay(providerName, proxyName, url = DEFAULT_DELAY_URL, timeout = DEFAULT_DELAY_TIMEOUT) {
      const probeTimeout = Number(timeout) || DEFAULT_DELAY_TIMEOUT;
      return request(
        'GET',
        `/providers/proxies/${encodeURIComponent(providerName)}/${encodeURIComponent(proxyName)}/healthcheck?${delayQuery(url, probeTimeout)}`,
        undefined,
        Math.min(probeTimeout + 1000, 8000)
      );
    },
  };
}

module.exports = {
  createMihomoClient,
  readSecret,
  readActiveProfile,
  stripQuotes,
  delayQuery,
  DEFAULT_DELAY_URL,
  DEFAULT_DELAY_TIMEOUT,
};
