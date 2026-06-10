import { appendHistory, getConfig } from './store.js';
import { adapters } from './adapters/index.js';

const runningSites = new Set();

function nowTimeKey(date = new Date()) {
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${date.toDateString()} ${hour}:${minute}`;
}

function currentTime(date = new Date()) {
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${hour}:${minute}`;
}

function isSiteDue(site, schedule, date = new Date()) {
  if (!schedule.enabled) {
    return false;
  }

  if (schedule.mode === 'interval') {
    if (!site.lastRunAt) {
      return true;
    }

    const elapsed = Date.now() - new Date(site.lastRunAt).getTime();
    return elapsed >= Math.max(1, Number(schedule.intervalMinutes || 1440)) * 60 * 1000;
  }

  const time = currentTime(date);
  const runKey = nowTimeKey(date);
  return (schedule.times || []).includes(time) && site.lastRunKey !== runKey;
}

async function runSite(site, runtime, adapterConfig) {
  const scriptId = adapterConfig?.script || site.adapter;
  const adapter = adapters[scriptId];
  if (!adapter) {
    const entry = {
      ok: false,
      siteId: site.id,
      siteName: site.name,
      adapter: site.adapter,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: `未知适配器：${scriptId}`,
      logs: []
    };
    await appendHistory(entry);
    return entry;
  }

  if (runningSites.has(site.id)) {
    return null;
  }

  runningSites.add(site.id);
  try {
    const entry = await adapter(site, runtime, adapterConfig);
    await appendHistory(entry);
    return entry;
  } finally {
    runningSites.delete(site.id);
  }
}

async function markRun(siteId) {
  const config = await getConfig();
  const runKey = nowTimeKey();
  config.sites = config.sites.map((site) => {
    if (site.id !== siteId) {
      return site;
    }

    return {
      ...site,
      lastRunAt: new Date().toISOString(),
      lastRunKey: runKey
    };
  });

  return config;
}

export class Scheduler {
  constructor({ saveConfig }) {
    this.timer = null;
    this.saveConfig = saveConfig;
  }

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        console.error('[scheduler]', error);
      });
    }, 60 * 1000);

    this.tick().catch((error) => {
      console.error('[scheduler]', error);
    });
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    const config = await getConfig();
    const dueSites = config.sites.filter((site) => isSiteDue(site, config.schedule));

    for (const site of dueSites) {
      const adapterConfig = config.adapters.find((adapter) => adapter.id === site.adapter);
      const updated = await markRun(site.id);
      await this.saveConfig(updated);
      await runSite(site, config.runtime, adapterConfig);
    }
  }

  async runNow(siteId) {
    const config = await getConfig();
    const sites = siteId ? config.sites.filter((site) => site.id === siteId) : config.sites;
    const results = [];

    for (const site of sites) {
      const adapterConfig = config.adapters.find((adapter) => adapter.id === site.adapter);
      const result = await runSite(site, config.runtime, adapterConfig);
      if (result) {
        results.push(result);
      }
    }

    return results;
  }
}
