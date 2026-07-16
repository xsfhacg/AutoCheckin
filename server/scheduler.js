import { appendHistory, getConfig, getHistory, saveConfig } from './store.js';
import { adapters } from './adapters/index.js';

const runningSites = new Set();

// 连续失败自动关闭的天数阈值
const MAX_CONSECUTIVE_FAIL_DAYS = 3;

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
  // 单站点未启用定时，跳过
  if (site.enabled === false) {
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

// 检查指定站点是否连续 N 个不同日期都签到失败
// 按日期分组取每天最后一次结果，看最近 N 天是否全部失败
function hasConsecutiveFailDays(history, siteId, days) {
  const siteRecords = history.filter((item) => item.siteId === siteId);
  if (siteRecords.length === 0) {
    return false;
  }

  // 按日期分组，每天取最后一条记录的结果（history 是倒序，最新的在前）
  const dayMap = new Map();
  for (const record of siteRecords) {
    const dateStr = new Date(record.finishedAt || record.startedAt).toDateString();
    if (!dayMap.has(dateStr)) {
      // 第一次遇到该日期即为最近一条
      dayMap.set(dateStr, record.ok);
    }
  }

  // 按日期从近到远排序，检查连续 N 天是否全部失败
  const sortedDays = [...dayMap.entries()].sort((a, b) => new Date(b[0]) - new Date(a[0]));
  if (sortedDays.length < days) {
    return false;
  }

  for (let i = 0; i < days; i++) {
    if (sortedDays[i][1] !== false) {
      return false;
    }
  }

  return true;
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
    const ranSiteIds = [];

    for (const site of dueSites) {
      const adapterConfig = config.adapters.find((adapter) => adapter.id === site.adapter);
      const updated = await markRun(site.id);
      await this.saveConfig(updated);
      await runSite(site, config.runtime, adapterConfig);
      ranSiteIds.push(site.id);
    }

    // 签到完成后检查是否有站点连续失败达到阈值，自动关闭
    if (ranSiteIds.length > 0) {
      await this.checkAndAutoDisable(ranSiteIds);
    }
  }

  // 检查指定站点是否连续失败达到阈值，达到则自动关闭签到
  async checkAndAutoDisable(siteIds) {
    const history = await getHistory();
    let configChanged = false;
    const config = await getConfig();

    for (const siteId of siteIds) {
      const site = config.sites.find((s) => s.id === siteId);
      if (!site || site.enabled === false) {
        continue;
      }

      if (hasConsecutiveFailDays(history, siteId, MAX_CONSECUTIVE_FAIL_DAYS)) {
        site.enabled = false;
        console.warn(`[scheduler] 站点 ${site.name || siteId} 连续 ${MAX_CONSECUTIVE_FAIL_DAYS} 天签到失败，已自动关闭`);
        configChanged = true;
      }
    }

    if (configChanged) {
      await saveConfig(config);
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
