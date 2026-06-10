import fs from 'node:fs/promises';
import { getSessionPath } from '../store.js';

const defaultRoutes = {
  loginPagePath: '/login',
  checkinPagePath: '/console/personal',
  loginApiPath: '/api/user/login?turnstile=',
  checkinApiPaths: [
  '/api/user/checkin',
  '/api/user/check_in',
  '/api/user/check-in',
  '/api/user/signin',
  '/api/user/sign_in',
  '/api/user/daily_checkin',
  '/api/user/daily_check_in'
  ]
};

function normalizePathList(value, fallback) {
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }

  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return fallback;
}

function getRoutes(adapterConfig = {}) {
  return {
    ...defaultRoutes,
    ...(adapterConfig.routes || {}),
    checkinApiPaths: normalizePathList(
      adapterConfig.routes?.checkinApiPaths,
      defaultRoutes.checkinApiPaths
    )
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getOrigin(site) {
  const baseUrl = site.apiBaseUrl || site.baseUrl || site.loginUrl;
  const normalized = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  return new URL(normalized).origin;
}

function resolveUrl(site, value) {
  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  return new URL(value, getOrigin(site)).toString();
}

function splitSetCookie(header) {
  if (!header) {
    return [];
  }

  return header.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g);
}

function applySetCookies(jar, response) {
  const headers = response.headers.getSetCookie?.() || splitSetCookie(response.headers.get('set-cookie'));
  for (const header of headers) {
    const [pair] = header.split(';');
    const index = pair.indexOf('=');
    if (index > 0) {
      jar[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
    }
  }
}

function applyManualSession(jar, value) {
  const text = String(value || '').trim();
  if (!text) {
    return;
  }

  const sessionMatch = text.match(/(?:^|[;\s])session=([^;\s]+)/i);
  const userMatch = text.match(/(?:^|\n)\s*new-api-user\s*[:=]\s*([^\s;]+)/i);

  if (sessionMatch) {
    jar.session = sessionMatch[1].trim();
  } else if (!text.includes('=')) {
    jar.session = text;
  }

  if (userMatch) {
    jar.__newApiUser = userMatch[1].trim();
  } else if (jar.session && !jar.__newApiUser) {
    jar.__newApiUser = '1';
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .filter(([name]) => !name.startsWith('__'))
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function isAuthExpired(status, payloadText) {
  return (
    status === 401 ||
    /未登录|请登录|login required|unauthorized|token/i.test(payloadText)
  );
}

function isSuccessful(payload, status) {
  if (status < 200 || status >= 300) {
    return false;
  }

  if (!payload || typeof payload !== 'object') {
    return true;
  }

  if (payload.success === true || payload.ok === true) {
    return true;
  }

  if (payload.code === 0 || payload.status === 'success') {
    return true;
  }

  return !/失败|错误|invalid|error/i.test(String(payload.message || payload.msg || ''));
}

function getPayloadMessage(payload) {
  if (!payload) {
    return '';
  }

  if (typeof payload === 'string') {
    return payload;
  }

  return payload.message || payload.msg || payload.error?.message || JSON.stringify(payload);
}

function extractUserId(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const data = payload.data || payload.user || payload;
  return String(
    data.id ||
      data.user_id ||
      data.userId ||
      data.user?.id ||
      data.user?.user_id ||
      ''
  );
}

function isEndpointMismatch(status, payload) {
  const message = getPayloadMessage(payload);
  return (
    status === 404 ||
    status === 405 ||
    /invalid url|not found|method not allowed|cannot\s+(post|get)/i.test(message)
  );
}

async function readSession(sessionPath) {
  if (!(await fileExists(sessionPath))) {
    return {};
  }

  try {
    const saved = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
    return saved.cookies || {};
  } catch {
    return {};
  }
}

async function writeSession(sessionPath, cookies) {
  await fs.writeFile(
    sessionPath,
    JSON.stringify(
      {
        type: 'http-cookie-jar',
        updatedAt: new Date().toISOString(),
        cookies
      },
      null,
      2
    )
  );
}

async function request(site, runtime, jar, url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(runtime.requestTimeoutSeconds || 0) * 1000 || runtime.requestTimeoutMs || 20000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Accept: 'application/json, text/plain, */*',
    Cookie: cookieHeader(jar),
    Origin: getOrigin(site),
    Referer: options.referer || getOrigin(site),
    ...options.headers
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (jar.__newApiUser) {
    headers['New-Api-User'] = jar.__newApiUser;
  }

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      signal: controller.signal,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });

    applySetCookies(jar, response);
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    return {
      response,
      payload,
      text
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function login(site, runtime, jar, log, routes) {
  const rawUsername = site.username || '';
  const usernameLocalPart = rawUsername.includes('@') ? rawUsername.split('@')[0] : rawUsername;
  const loginPaths = normalizePathList(routes.loginApiPath, [defaultRoutes.loginApiPath]);
  const loginPathCandidates = Array.from(
    new Set([
      ...loginPaths,
      ...loginPaths.map((path) => (path.includes('?') ? path : `${path}?turnstile=`))
    ])
  );
  const payloads = Array.from(
    new Map(
      [
        { username: rawUsername, password: site.password || '' },
        { username: usernameLocalPart, password: site.password || '' },
        { email: rawUsername, password: site.password || '' }
      ].map((payload) => [JSON.stringify(payload), payload])
    ).values()
  );

  log('Cookie 失效或不存在，开始调用登录接口');

  for (const path of loginPathCandidates) {
    const url = resolveUrl(site, path);
    for (const body of payloads) {
      const { response, payload, text } = await request(site, runtime, jar, url, {
        method: 'POST',
        body,
        referer: resolveUrl(site, routes.loginPagePath)
      });

      if (isSuccessful(payload, response.status) && !isAuthExpired(response.status, text)) {
        jar.__newApiUser = extractUserId(payload) || jar.__newApiUser || '1';
        log(`登录接口成功：${path}`);
        log(`已记录 New-Api-User：${jar.__newApiUser}`);
        return;
      }

      log(`登录接口未通过：${path}，${getPayloadMessage(payload) || `HTTP ${response.status}`}`);
    }
  }

  throw new Error('登录接口失败，请检查账号密码、接口路径或站点是否开启验证码');
}

async function checkin(site, runtime, jar, log, routes) {
  const paths = normalizePathList(routes.checkinApiPaths, defaultRoutes.checkinApiPaths);
  let lastResult = null;

  for (const path of paths) {
    const url = resolveUrl(site, path);
    log(`尝试签到接口：${path}`);
    const result = await request(site, runtime, jar, url, {
      method: 'POST',
      referer: resolveUrl(site, routes.checkinPagePath)
    });
    lastResult = { path, ...result };

    if (isEndpointMismatch(result.response.status, result.payload)) {
      log(`签到接口不可用：${path}，${getPayloadMessage(result.payload) || `HTTP ${result.response.status}`}`);
      continue;
    }

    if (!isAuthExpired(result.response.status, result.text)) {
      return lastResult;
    }
  }

  return lastResult;
}

export async function runNewApiCheckin(site, runtime = {}, adapterConfig = {}) {
  const startedAt = new Date().toISOString();
  const logs = [];
  const log = (message) => logs.push({ time: new Date().toISOString(), message });
  const sessionPath = getSessionPath(site.id);
  const jar = await readSession(sessionPath);
  applyManualSession(jar, site.session);
  if (site.newApiUser) {
    jar.__newApiUser = String(site.newApiUser).trim();
  }
  const routes = getRoutes(adapterConfig);

  try {
    log(Object.keys(jar).length ? '读取已有 Cookie 会话' : '没有 Cookie 会话，首次运行需要登录');
    if (Object.keys(jar).length === 0) {
      await login(site, runtime, jar, log, routes);
    }

    let result = await checkin(site, runtime, jar, log, routes);

    if (!result || isAuthExpired(result.response.status, result.text)) {
      await login(site, runtime, jar, log, routes);
      result = await checkin(site, runtime, jar, log, routes);
    }

    if (!result) {
      throw new Error('没有可用的签到接口路径');
    }

    await writeSession(sessionPath, jar);
    const message = getPayloadMessage(result.payload) || `HTTP ${result.response.status}`;
    log(`签到接口：${result.path}`);

    return {
      ok: isSuccessful(result.payload, result.response.status),
      siteId: site.id,
      siteName: site.name,
      adapter: site.adapter,
      startedAt,
      finishedAt: new Date().toISOString(),
      result: message,
      session: jar.session || '',
      newApiUser: jar.__newApiUser || '',
      logs
    };
  } catch (error) {
    await writeSession(sessionPath, jar).catch(() => {});
    log(error.message);

    return {
      ok: false,
      siteId: site.id,
      siteName: site.name,
      adapter: site.adapter,
      startedAt,
      finishedAt: new Date().toISOString(),
      result: error.message,
      session: jar.session || '',
      newApiUser: jar.__newApiUser || '',
      logs
    };
  }
}
