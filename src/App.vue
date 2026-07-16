<script setup>
import { computed, onMounted, ref } from 'vue';
import {
  Activity,
  CalendarClock,
  CheckCircle2,
  CirclePlus,
  Download,
  Play,
  Save,
  ShieldCheck,
  Trash2,
  Upload
} from '@lucide/vue';

const loading = ref(true);
const saving = ref(false);
const runningId = ref('');
const activeSiteId = ref('');
const activeAdapterId = ref('');
const activeView = ref('sites');
const history = ref([]);
const notice = ref(null);
let noticeTimer = null;
const config = ref({
  adapters: [],
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
});

const activeSite = computed(() => {
  return config.value.sites.find((site) => site.id === activeSiteId.value) || config.value.sites[0];
});

const activeAdapter = computed(() => {
  return config.value.adapters.find((adapter) => adapter.id === activeAdapterId.value) || config.value.adapters[0];
});

const groupedSites = computed(() => {
  return config.value.adapters.map((adapter) => ({
    ...adapter,
    sites: config.value.sites.filter((site) => site.adapter === adapter.id)
  }));
});

const latestBySite = computed(() => {
  return history.value.reduce((map, item) => {
    if (!map[item.siteId]) {
      map[item.siteId] = item;
    }

    return map;
  }, {});
});

const scheduleTime = computed({
  get() {
    return config.value.schedule.times?.[0] || '09:00';
  },
  set(value) {
    config.value.schedule.times = [value || '09:00'];
  }
});

function uid(prefix = 'site') {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function showNotice(type, message) {
  notice.value = { type, message: formatNoticeMessage(message) };
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = null;
  }, type === 'error' ? 4200 : 2400);
}

function formatNoticeMessage(message) {
  if (!message) {
    return '操作完成';
  }

  if (typeof message !== 'string') {
    return String(message);
  }

  try {
    const parsed = JSON.parse(message);
    return parsed?.error?.message || parsed?.message || message;
  } catch {
    return message;
  }
}

function normalizeConfig(nextConfig) {
  config.value = {
    ...config.value,
    ...nextConfig,
    schedule: {
      ...config.value.schedule,
      ...(nextConfig.schedule || {})
    },
    runtime: {
      ...config.value.runtime,
      ...(nextConfig.runtime || {})
    }
  };

  if (!activeSiteId.value && config.value.sites.length) {
    activeSiteId.value = config.value.sites[0].id;
  }

  if (!activeAdapterId.value && config.value.adapters.length) {
    activeAdapterId.value = config.value.adapters[0].id;
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json'
    },
    ...options
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || '请求失败');
  }

  return response.json();
}

async function loadAll() {
  loading.value = true;
  try {
    const [nextConfig, nextHistory] = await Promise.all([
      requestJson('/api/config'),
      requestJson('/api/history')
    ]);
    normalizeConfig(nextConfig);
    history.value = nextHistory;
  } catch (error) {
    showNotice('error', error.message || '加载配置失败');
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    // 保存前将签到路径文本缓冲解析回数组
    config.value.adapters.forEach(syncCheckinPaths);
    normalizeConfig(
      await requestJson('/api/config', {
        method: 'PUT',
        body: JSON.stringify(config.value)
      })
    );
    showNotice('success', '配置已保存');
    return true;
  } catch (error) {
    showNotice('error', error.message || '保存失败');
    return false;
  } finally {
    saving.value = false;
  }
}

async function runSite(site) {
  runningId.value = site.id;
  try {
    const result = await requestJson(`/api/sites/${site.id}/run`, { method: 'POST' });
    if (result?.session !== undefined) {
      site.session = result.session;
    }
    if (result?.newApiUser !== undefined) {
      site.newApiUser = result.newApiUser;
    }
    history.value = [result, ...history.value.filter(Boolean)];
    showNotice(result?.ok ? 'success' : 'error', result?.result || '签到任务已完成');
  } catch (error) {
    showNotice('error', error.message || '签到失败');
  } finally {
    runningId.value = '';
  }
}

function addSite(adapterId = 'newapi') {
  const nextSite = {
    id: uid(adapterId),
    adapter: adapterId,
    name: '新站点',
    enabled: true,
    baseUrl: '',
    username: '',
    password: '',
    newApiUser: '',
    session: ''
  };

  config.value.sites.push(nextSite);
  activeSiteId.value = nextSite.id;
}

function addAdapter() {
  const nextAdapter = {
    id: uid('adapter'),
    name: '新分类',
    script: 'newapi',
    description: '基于 NewAPI 接口签到',
    routes: {
      loginApiPath: '/api/user/login?turnstile=',
      checkinApiPaths: ['/api/user/checkin']
    }
  };

  config.value.adapters.push(nextAdapter);
  activeAdapterId.value = nextAdapter.id;
  activeView.value = 'adapters';
  showNotice('success', '已新增分类，请完善配置后保存');
}

function ensureAdapterRoutes(adapter) {
  adapter.routes ||= {};
  adapter.routes.loginApiPath ||= '/api/user/login';
  adapter.routes.checkinApiPaths ||= [
    '/api/user/checkin',
    '/api/user/check_in',
    '/api/user/check-in',
    '/api/user/signin',
    '/api/user/sign_in'
  ];
  // 文本缓冲：供 textarea v-model 使用，避免实时解析导致无法回车换行
  if (adapter.routes.checkinApiPathsText === undefined) {
    adapter.routes.checkinApiPathsText = adapter.routes.checkinApiPaths.join('\n');
  }
  return adapter.routes;
}

// 保存配置前，将文本缓冲解析回数组
function syncCheckinPaths(adapter) {
  const text = adapter.routes?.checkinApiPathsText;
  if (text !== undefined) {
    adapter.routes.checkinApiPaths = text
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

function removeSite(siteId) {
  config.value.sites = config.value.sites.filter((site) => site.id !== siteId);
  activeSiteId.value = config.value.sites[0]?.id || '';
}

// 切换站点定时开关并立即保存
async function toggleSiteEnabled(site) {
  site.enabled = site.enabled === false;
  await save();
}

// AES-GCM 加密相关
const ENCRYPT_KEY = 'xsfhacg-token-2026';

async function deriveKey() {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(ENCRYPT_KEY),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode('auto-checkin-salt'),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// 加密密码：返回 "enc:" 前缀 + Base64(iv + 密文)
async function encryptPassword(plain) {
  if (!plain) {
    return '';
  }
  const key = await deriveKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plain)
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return 'enc:' + btoa(String.fromCharCode(...combined));
}

// 解密密码：兼容 "enc:" 前缀的 AES 加密、旧 Base64 编码、明文
async function decryptPassword(value) {
  if (!value) {
    return '';
  }
  // AES-GCM 加密格式
  if (value.startsWith('enc:')) {
    try {
      const key = await deriveKey();
      const combined = Uint8Array.from(atob(value.slice(4)), (c) => c.charCodeAt(0));
      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
      );
      return new TextDecoder().decode(decrypted);
    } catch {
      return value;
    }
  }
  // 兼容旧的 Base64 编码
  try {
    const decoded = decodeURIComponent(escape(atob(value)));
    return decoded === value ? value : decoded;
  } catch {
    // 解码失败说明是明文，直接返回
    return value;
  }
}

// 导出站点列表为 JSON 文件（密码用 AES-GCM 加密）
async function exportSites() {
  const sites = await Promise.all(
    config.value.sites.map(async (site) => ({
      ...site,
      password: await encryptPassword(site.password)
    }))
  );
  const data = {
    type: 'auto-checkin-sites',
    version: 2,
    exportedAt: new Date().toISOString(),
    sites
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `auto-checkin-sites-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showNotice('success', `已导出 ${sites.length} 个站点（密码已加密）`);
}

// 导入站点列表
function importSites() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const sites = Array.isArray(data) ? data : data.sites;
      if (!Array.isArray(sites)) {
        throw new Error('文件格式不正确：缺少 sites 数组');
      }
      const validSites = sites.filter((s) => s && s.id && s.adapter);
      if (validSites.length === 0) {
        throw new Error('文件中没有有效的站点数据');
      }
      // 解密密码（兼容 AES 加密、旧 Base64 编码、明文）
      const decodedSites = await Promise.all(
        validSites.map(async (site) => ({
          ...site,
          password: await decryptPassword(site.password)
        }))
      );
      // 合并：同 id 覆盖，新 id 追加
      const existingIds = new Set(config.value.sites.map((s) => s.id));
      let added = 0;
      let updated = 0;
      for (const site of decodedSites) {
        if (existingIds.has(site.id)) {
          const idx = config.value.sites.findIndex((s) => s.id === site.id);
          config.value.sites[idx] = { ...site };
          updated++;
        } else {
          config.value.sites.push({ ...site });
          existingIds.add(site.id);
          added++;
        }
      }
      showNotice('success', `导入完成：新增 ${added} 个，更新 ${updated} 个，请点击保存配置生效`);
    } catch (error) {
      showNotice('error', error.message || '导入失败');
    }
  };
  input.click();
}

function formatDate(value) {
  if (!value) {
    return '暂无';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

onMounted(loadAll);
</script>

<template>
  <main class="shell">
    <Transition name="notice">
      <div v-if="notice" class="notice" :class="notice.type">
        <strong>{{ notice.type === 'error' ? '操作失败' : '操作成功' }}</strong>
        <span>{{ notice.message }}</span>
      </div>
    </Transition>

    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">
          <ShieldCheck :size="24" />
        </div>
        <div>
          <p>Auto Checkin</p>
          <span>网页签到中枢</span>
        </div>
      </div>

      <nav class="view-nav">
        <button :class="{ active: activeView === 'sites' }" @click="activeView = 'sites'">
          站点配置
        </button>
        <button :class="{ active: activeView === 'adapters' }" @click="activeView = 'adapters'">
          分类配置
        </button>
      </nav>

      <section v-if="activeView === 'sites'" class="sidebar-section">
        <div class="section-title">
          <span>网页分类</span>
          <button class="icon-button" title="新增 NewAPI 站点" @click="addSite('newapi')">
            <CirclePlus :size="18" />
          </button>
        </div>

        <div v-for="group in groupedSites" :key="group.id" class="adapter-group">
          <div class="adapter-name">
            <Activity :size="16" />
            <span>{{ group.name }}</span>
          </div>
          <button
            v-for="site in group.sites"
            :key="site.id"
            class="site-tab"
            :class="{ active: activeSite?.id === site.id }"
            @click="activeSiteId = site.id"
          >
            <span>{{ site.name || '未命名站点' }}</span>
            <small>{{ latestBySite[site.id]?.ok ? '正常' : latestBySite[site.id] ? '失败' : '待运行' }}</small>
          </button>
        </div>
      </section>

      <section v-else class="sidebar-section">
        <div class="section-title">
          <span>分类列表</span>
          <button class="icon-button" title="新增分类" @click="addAdapter">
            <CirclePlus :size="18" />
          </button>
        </div>

        <div class="adapter-group">
          <button
            v-for="adapter in config.adapters"
            :key="adapter.id"
            class="site-tab"
            :class="{ active: activeAdapter?.id === adapter.id }"
            @click="activeAdapterId = adapter.id"
          >
            <span>{{ adapter.name || '未命名分类' }}</span>
            <small>{{ adapter.script || adapter.id }}</small>
          </button>
        </div>
      </section>
    </aside>

    <section class="workspace">
      <header class="topbar">
        <div>
          <p class="eyebrow">持续运行 / Cookie 会话 / 轻量 HTTP 适配器</p>
          <h1>{{ activeView === 'sites' ? '签到配置' : '分类配置' }}</h1>
        </div>
        <div class="actions">
          <template v-if="activeView === 'sites'">
            <button class="ghost" :disabled="loading" @click="importSites" title="从 JSON 文件导入站点">
              <Upload :size="18" />
              <span>导入</span>
            </button>
            <button class="ghost" :disabled="loading || config.sites.length === 0" @click="exportSites" title="导出站点列表为 JSON 文件">
              <Download :size="18" />
              <span>导出</span>
            </button>
          </template>
          <button class="primary" :disabled="saving || loading" @click="save">
            <Save :size="18" />
            <span>{{ saving ? '保存中' : '保存配置' }}</span>
          </button>
        </div>
      </header>

      <div v-if="loading" class="loading-panel">加载配置中...</div>

      <template v-else-if="activeView === 'sites'">
        <section class="panel schedule-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Schedule</p>
              <h2>定时调度</h2>
              <p class="hint">在下方各站点中单独控制是否参与定时签到</p>
            </div>
          </div>

          <div class="schedule-grid">
            <label class="field">
              <span>运行模式</span>
              <select v-model="config.schedule.mode">
                <option value="daily">每天固定时间</option>
                <option value="interval">间隔频率</option>
              </select>
            </label>

            <label v-if="config.schedule.mode === 'interval'" class="field">
              <span>间隔分钟</span>
              <input v-model.number="config.schedule.intervalMinutes" min="1" type="number" />
            </label>

            <label v-else class="field">
              <span>执行时间</span>
              <input v-model="scheduleTime" type="time" />
            </label>

            <label class="field">
              <span>请求超时秒数</span>
              <input v-model.number="config.runtime.requestTimeoutSeconds" min="3" type="number" />
            </label>
          </div>
        </section>

        <section v-if="activeSite" class="panel editor-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Site</p>
              <h2>{{ activeSite.name || '站点配置' }}</h2>
            </div>
            <div class="actions">
              <label class="switch site-switch" title="是否参与定时签到">
                <input
                  :checked="activeSite.enabled !== false"
                  type="checkbox"
                  @change="toggleSiteEnabled(activeSite)"
                />
                <span></span>
              </label>
              <button class="ghost danger" @click="removeSite(activeSite.id)">
                <Trash2 :size="16" />
                <span>删除</span>
              </button>
              <button class="primary" :disabled="runningId === activeSite.id" @click="runSite(activeSite)">
                <Play :size="17" />
                <span>{{ runningId === activeSite.id ? '运行中' : '立即签到' }}</span>
              </button>
            </div>
          </div>

          <p class="hint">当前站点定时签到：{{ activeSite.enabled === false ? '已关闭' : '已开启' }}（不影响手动"立即签到"）</p>

          <div class="form-grid">
            <label class="field">
              <span>站点名称</span>
              <input v-model="activeSite.name" placeholder="例如 Helpcoder" />
            </label>
            <label class="field">
              <span>主域名</span>
              <input v-model="activeSite.baseUrl" placeholder="https://example.com" />
            </label>
            <label class="field">
              <span>适配脚本</span>
              <select v-model="activeSite.adapter">
                <option v-for="adapter in config.adapters" :key="adapter.id" :value="adapter.id">
                  {{ adapter.name }}
                </option>
              </select>
            </label>
            <label class="field">
              <span>账号</span>
              <input v-model="activeSite.username" autocomplete="username" />
            </label>
            <label class="field">
              <span>密码</span>
              <input v-model="activeSite.password" autocomplete="current-password" type="password" />
            </label>
            <label class="field">
              <span>USER_ID</span>
              <input v-model="activeSite.newApiUser" placeholder="New-Api-User" />
            </label>
            <label class="field wide">
              <span>Session</span>
              <textarea
                v-model="activeSite.session"
                rows="3"
                placeholder="可粘贴 session 值，也可粘贴完整 Cookie：session=..."
              ></textarea>
            </label>
          </div>
        </section>

        <section class="panel history-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">History</p>
              <h2>运行记录</h2>
            </div>
            <CalendarClock :size="22" />
          </div>

          <div class="history-list">
            <article v-for="item in history" :key="`${item.siteId}-${item.startedAt}`" class="history-item">
              <CheckCircle2 :class="{ failed: !item.ok }" :size="20" />
              <div>
                <strong>{{ item.siteName }}</strong>
                <p>{{ item.result }}</p>
              </div>
              <time>{{ formatDate(item.finishedAt) }}</time>
            </article>
            <p v-if="history.length === 0" class="empty">还没有运行记录</p>
          </div>
        </section>
      </template>

      <template v-else>
        <section v-if="activeAdapter" class="panel editor-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Adapters</p>
              <h2>{{ activeAdapter.name || '分类配置' }}</h2>
            </div>
          </div>

          <div class="form-grid">
            <label class="field">
              <span>分类名称</span>
              <input v-model="activeAdapter.name" placeholder="例如 NewAPI" />
            </label>
            <label class="field">
              <span>适配脚本</span>
              <select v-model="activeAdapter.script">
                <option value="newapi">NewAPI</option>
              </select>
            </label>
            <label class="field">
              <span>分类标识</span>
              <input
                v-model="activeAdapter.id"
                placeholder="例如 newapi"
                @input="activeAdapterId = activeAdapter.id"
              />
            </label>
            <label class="field wide">
              <span>说明</span>
              <input v-model="activeAdapter.description" placeholder="这个分类适配的网页说明" />
            </label>
            <label class="field wide">
              <span>登录接口路径</span>
              <input v-model="ensureAdapterRoutes(activeAdapter).loginApiPath" placeholder="/api/user/login?turnstile=" />
            </label>
            <label class="field wide">
              <span>签到接口候选路径</span>
              <textarea
                v-model="ensureAdapterRoutes(activeAdapter).checkinApiPathsText"
                rows="7"
                placeholder="/api/user/checkin"
              ></textarea>
            </label>
          </div>
        </section>

        <section v-else class="panel loading-panel">还没有分类配置</section>
      </template>
    </section>
  </main>
</template>
