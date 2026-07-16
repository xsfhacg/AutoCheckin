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

  // 支持粘贴整段 Cookie 或单独的 session 值
  const sessionMatch = text.match(/(?:^|[;\s])session=([^;\s]+)/i);
  const userMatch = text.match(/(?:^|[;\s])new-api-user\s*[:=]\s*([^\s;]+)/i) || text.match(/(?:^|\n)\s*new-api-user\s*[:=]\s*([^\s;]+)/i);
  const vidMatch = text.match(/(?:^|[;\s])newapi_vid=([^;\s]+)/i);
  const deviceFpMatch = text.match(/x-device-fp\s*[:=]\s*([0-9a-fA-F]+)/i);
  const deviceSigMatch = text.match(/x-device-sig\s*[:=]\s*([0-9a-fA-F]+)/i);

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

  // 设备指纹相关字段：NewAPI 部分加强分支（如维云）需要
  if (vidMatch) {
    jar.newapi_vid = vidMatch[1].trim();
  }
  if (deviceFpMatch) {
    jar.__deviceFp = deviceFpMatch[1].trim();
  }
  if (deviceSigMatch) {
    jar.__deviceSig = deviceSigMatch[1].trim();
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .filter(([name]) => !name.startsWith('__'))
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function hasSessionCookie(jar) {
  return Boolean(jar.session);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 判断是否为可重试的网络/超时错误
function isRetryableNetworkError(error) {
  if (!error) {
    return false;
  }
  const name = error.name || '';
  const message = error.message || '';
  return (
    name === 'AbortError' ||           // 超时
    name === 'TypeError' ||             // fetch 网络层错误（DNS、连接拒绝等）
    name === 'FetchError' ||
    /fetch|network|timeout|econnreset|socket hang up|etimedout|enotfound|econnrefused/i.test(message)
  );
}

// 判断是否为可重试的服务端错误状态码
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

async function request(site, runtime, jar, url, options = {}, log) {
  const maxRetries = Number(runtime.maxRetries) || 2;
  const baseDelay = Number(runtime.retryDelayMs) || 2000;

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await requestOnce(site, runtime, jar, url, options);

      // 服务端 429/5xx：可重试，且还有重试次数
      if (isRetryableStatus(result.response.status) && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        log?.(`服务端返回 ${result.response.status}，${delay / 1000}s 后重试（第 ${attempt + 1}/${maxRetries} 次）`);
        await sleep(delay);
        continue;
      }

      return result;
    } catch (error) {
      lastError = error;
      if (isRetryableNetworkError(error) && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        log?.(`请求失败：${error.message}，${delay / 1000}s 后重试（第 ${attempt + 1}/${maxRetries} 次）`);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('请求失败且重试次数已用完');
}

async function requestOnce(site, runtime, jar, url, options = {}) {
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

  // 设备指纹头：部分 NewAPI 加强分支（如维云）强制校验
  const vid = jar.newapi_vid;
  if (vid) {
    headers['x-device-vid'] = vid;
  }
  if (jar.__deviceFp) {
    headers['x-device-fp'] = jar.__deviceFp;
  }
  if (jar.__deviceSig) {
    headers['x-device-sig'] = jar.__deviceSig;
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
      }, log);

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
  let authExpired = false;

  for (const path of paths) {
    const url = resolveUrl(site, path);
    log(`尝试签到接口：${path}`);
    const result = await request(site, runtime, jar, url, {
      method: 'POST',
      referer: resolveUrl(site, routes.checkinPagePath)
    }, log);
    lastResult = { path, ...result };

    if (isEndpointMismatch(result.response.status, result.payload)) {
      log(`签到接口不可用：${path}，${getPayloadMessage(result.payload) || `HTTP ${result.response.status}`}`);
      continue;
    }

    if (isAuthExpired(result.response.status, result.text)) {
      authExpired = true;
      log(`签到接口认证失效：${path}，${getPayloadMessage(result.payload) || `HTTP ${result.response.status}`}`);
      continue;
    }

    return lastResult;
  }

  // 记录最后的认证状态，供外层判断是否需要重登
  lastResult.__authExpired = authExpired;
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
  const shouldTrySessionFirst = hasSessionCookie(jar);

  try {
    log(shouldTrySessionFirst ? '读取已有 Session，会优先使用 Session 签到' : '没有 Session，会使用账号密码登录');
    if (!shouldTrySessionFirst) {
      await login(site, runtime, jar, log, routes);
    }

    let result = await checkin(site, runtime, jar, log, routes);

    if (!result || result.__authExpired || isAuthExpired(result.response.status, result.text)) {
      delete result?.__authExpired;
      log(shouldTrySessionFirst ? 'Session 失效或已过期，改用账号密码重新登录' : '登录状态不可用，重新调用账号密码登录');
      await login(site, runtime, jar, log, routes);
      result = await checkin(site, runtime, jar, log, routes);
    }

    if (!result) {
      throw new Error('没有可用的签到接口路径');
    }

    delete result.__authExpired;

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
