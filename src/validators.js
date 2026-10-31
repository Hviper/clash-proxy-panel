'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function asString(value, field, { max = 2048, allowEmpty = false, fallback } = {}) {
  let result;
  if (value === undefined || value === null) {
    result = fallback;
  } else {
    result = String(value).trim();
  }

  if (!allowEmpty && (result === undefined || result === null || result === '')) {
    throw new HttpError(400, `${field} 不能为空`);
  }
  if (result !== undefined && result !== null && result.length > max) {
    throw new HttpError(400, `${field} 长度不能超过 ${max} 个字符`);
  }
  return result;
}

function asInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  const source = value === undefined || value === null || value === '' ? fallback : value;
  const result = Number(source);
  if (!Number.isInteger(result)) {
    throw new HttpError(400, `${field} 必须是整数`);
  }
  if (result < min || result > max) {
    throw new HttpError(400, `${field} 必须在 ${min} 到 ${max} 之间`);
  }
  return result;
}

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 'true' || value === 1 || value === '1';
}

function assertHttpUrl(value, field) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, `${field} 不是合法的 URL`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new HttpError(400, `${field} 必须是 http 或 https 地址`);
  }
  return value;
}

const GROUP_TYPES = ['select', 'url-test', 'fallback', 'load-balance', 'relay'];
const LISTENER_TYPES = ['mixed', 'http', 'socks', 'redir', 'tproxy', 'tun'];

function normalizeSubscription(input = {}, existing = null) {
  let id = null;
  if (input.id !== undefined && input.id !== null && String(input.id).trim() !== '') {
    id = String(input.id).trim();
  } else if (existing && existing.id) {
    id = existing.id;
  }

  if (id !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new HttpError(400, '订阅 id 只能包含字母、数字、下划线和中划线，长度 1-64');
  }

  const name = asString(input.name, '订阅名称', {
    max: 100,
    fallback: existing ? existing.name : undefined,
  });

  const url = asString(input.url, '订阅 url', {
    max: 2048,
    fallback: existing ? existing.url : undefined,
  });
  assertHttpUrl(url, '订阅 url');

  const prefix = asString(input.prefix, '节点前缀', {
    max: 100,
    allowEmpty: true,
    fallback: existing ? existing.prefix || '' : '',
  });

  const interval = asInteger(input.interval, '更新间隔 interval', {
    min: 60,
    max: 604800,
    fallback: existing ? existing.interval : 86400,
  });

  return { id, name, url, prefix, interval };
}

function normalizeGroup(input = {}, existing = null) {
  const name = asString(input.name, '代理组名称', {
    max: 100,
    fallback: existing ? existing.name : undefined,
  });

  const type = asString(input.type, '代理组类型', {
    max: 30,
    fallback: existing ? existing.type : 'select',
  });
  if (!GROUP_TYPES.includes(type)) {
    throw new HttpError(400, `代理组类型必须是：${GROUP_TYPES.join(', ')}`);
  }

  let use;
  if (input.use !== undefined) {
    if (!Array.isArray(input.use)) {
      throw new HttpError(400, 'use 必须是订阅 id 数组');
    }
    use = input.use.map((item) => String(item).trim()).filter(Boolean);
  } else {
    use = existing && Array.isArray(existing.use) ? [...existing.use] : [];
  }

  const filter = asString(input.filter, '过滤器 filter', {
    max: 500,
    allowEmpty: true,
    fallback: existing ? existing.filter || '' : '',
  });

  if (filter) {
    const source = filter.replace(/^\(\?[a-z]+\)/i, '');
    try {
      // 只做基础校验，真正的匹配在生成的 Script.js 中执行
      new RegExp(source);
    } catch (err) {
      throw new HttpError(400, `过滤器不是合法的正则表达式: ${err.message}`);
    }
  }

  const testUrl = asString(input.testUrl, '测速地址 testUrl', {
    max: 2048,
    fallback: existing ? existing.testUrl : 'https://www.google.com/generate_204',
  });
  assertHttpUrl(testUrl, '测速地址 testUrl');

  const interval = asInteger(input.interval, '测速间隔 interval', {
    min: 0,
    max: 86400,
    fallback: existing ? existing.interval : 300,
  });

  const includeActiveProfile = asBoolean(
    input.includeActiveProfile,
    existing ? Boolean(existing.includeActiveProfile) : false
  );

  return { name, type, use, filter, testUrl, interval, includeActiveProfile };
}

function normalizeListener(input = {}, existing = null) {
  const name = asString(input.name, '监听器名称', {
    max: 100,
    fallback: existing ? existing.name : undefined,
  });

  const port = asInteger(input.port, '监听端口 port', {
    min: 1,
    max: 65535,
    fallback: existing ? existing.port : undefined,
  });

  const proxy = asString(input.proxy, '监听器绑定的代理组 proxy', {
    max: 100,
    fallback: existing ? existing.proxy : undefined,
  });

  const type = asString(input.type, '监听器类型 type', {
    max: 30,
    fallback: existing ? existing.type : 'mixed',
  });
  if (!LISTENER_TYPES.includes(type)) {
    throw new HttpError(400, `监听器类型必须是：${LISTENER_TYPES.join(', ')}`);
  }

  const listen = asString(input.listen, '监听地址 listen', {
    max: 100,
    fallback: existing ? existing.listen : '127.0.0.1',
  });

  const udp = asBoolean(input.udp, existing ? existing.udp !== false : true);

  return { name, port, proxy, type, listen, udp };
}

module.exports = {
  HttpError,
  asString,
  asInteger,
  asBoolean,
  assertHttpUrl,
  normalizeSubscription,
  normalizeGroup,
  normalizeListener,
  GROUP_TYPES,
  LISTENER_TYPES,
};
