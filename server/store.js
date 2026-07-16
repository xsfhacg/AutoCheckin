import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const configPath = path.join(dataDir, 'config.json');
const historyPath = path.join(dataDir, 'history.json');
const sessionsDir = path.join(dataDir, 'sessions');

const defaultConfig = {
  adapters: [
    {
      id: 'newapi',
      name: 'NewAPI',
      script: 'newapi',
      description: 'NewAPI console personal check-in via HTTP API',
      routes: {
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
      }
    }
  ],
  sites: [],
  schedule: {
    enabled: true,
    mode: 'daily',
    times: ['09:00'],
    intervalMinutes: 1440,
    runOnStart: false
  },
  runtime: {
    requestTimeoutSeconds: 20
  }
};

function getOriginFromUrl(value) {
  if (!value) {
    return '';
  }

  try {
    const raw = String(value).trim();
    const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(normalized).origin;
  } catch {
    return '';
  }
}

function normalizeConfig(config = {}) {
  const runtime = {
    ...defaultConfig.runtime,
    ...(config.runtime || {})
  };

  if (runtime.requestTimeoutSeconds == null && runtime.requestTimeoutMs != null) {
    runtime.requestTimeoutSeconds = Math.max(1, Math.round(Number(runtime.requestTimeoutMs) / 1000));
  }
  delete runtime.requestTimeoutMs;

  const adapterIdMap = {};
  const inputAdapters = config.adapters?.length ? config.adapters : defaultConfig.adapters;
  const normalizedInputAdapters = inputAdapters.map((adapter) => {
    const isGeneratedNewApi =
      adapter.id !== 'newapi' &&
      String(adapter.id || '').startsWith('adapter-') &&
      String(adapter.name || '').trim().toLowerCase() === 'newapi' &&
      (adapter.script || 'newapi') === 'newapi';

    if (!isGeneratedNewApi) {
      return adapter;
    }

    adapterIdMap[adapter.id] = 'newapi';
    return {
      ...adapter,
      id: 'newapi',
      name: 'NewAPI',
      script: 'newapi'
    };
  });

  const adaptersById = new Map();
  for (const adapter of [...defaultConfig.adapters, ...normalizedInputAdapters]) {
    const defaultAdapter = defaultConfig.adapters.find((item) => item.id === adapter.id);
    adaptersById.set(adapter.id, {
      ...defaultAdapter,
      ...adapter,
      script: adapter.script || defaultAdapter?.script || adapter.id,
      routes: {
        ...(defaultAdapter?.routes || {}),
        ...(adapter.routes || {})
      }
    });
  }

  const adapters = Array.from(adaptersById.values());

  const sites = (config.sites || []).map((site) => {
    const { checkinUrl, loginUrl, loginApiPath, checkinApiPath, ...rest } = site;
    const baseUrl = getOriginFromUrl(rest.baseUrl) || getOriginFromUrl(loginUrl);
    return {
      ...rest,
      adapter: adapterIdMap[rest.adapter] || rest.adapter,
      baseUrl
    };
  });

  return {
    ...defaultConfig,
    ...config,
    adapters,
    sites,
    schedule: {
      ...defaultConfig.schedule,
      ...(config.schedule || {})
    },
    runtime
  };
}

async function ensureDataFiles() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });

  try {
    await fs.access(configPath);
  } catch {
    await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2));
  }

  try {
    await fs.access(historyPath);
  } catch {
    await fs.writeFile(historyPath, '[]');
  }
}

async function readJson(filePath, fallback) {
  await ensureDataFiles();
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await ensureDataFiles();
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2));
  await fs.rename(tempPath, filePath);
}

export async function getConfig() {
  const config = await readJson(configPath, defaultConfig);
  return normalizeConfig(config);
}

export async function saveConfig(config) {
  await writeJson(configPath, normalizeConfig(config));
  return getConfig();
}

export async function getHistory() {
  return readJson(historyPath, []);
}

export async function appendHistory(entry) {
  const history = await getHistory();
  history.unshift(entry);
  await writeJson(historyPath, history.slice(0, 300));
  return history;
}

export function getSessionPath(siteId) {
  const safeId = String(siteId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(sessionsDir, `${safeId}.json`);
}

export { rootDir };
