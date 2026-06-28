// Conda NAV API —— 双模式：Electron IPC / 浏览器 HTTP fallback

// 浏览器模式端口列表（与 electron/services/constants.js 保持一致）
const PORT_CANDIDATES = [8000, 8001, 8002, 8003];
let _baseUrl = null;
let _token = null;

const isElectron = () => !!(window.electron?.invoke);

// 导出工具函数，供 App.jsx 等组件使用
export { isElectron };

async function getToken() {
  if (_token) return _token;
  if (isElectron()) {
    _token = await window.electron.getToken();
  }
  return _token || '';
}

async function getBaseUrl() {
  if (_baseUrl) return _baseUrl;

  if (isElectron()) {
    const port = await window.electron.invoke('get-http-port');
    _baseUrl = `http://localhost:${port || 8000}`;
    return _baseUrl;
  }

  // 浏览器模式：探测哪个端口可用
  for (const port of PORT_CANDIDATES) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        _baseUrl = `http://localhost:${port}`;
        return _baseUrl;
      }
    } catch { /* try next */ }
  }
  _baseUrl = 'http://localhost:8000'; // fallback
  return _baseUrl;
}

// ── 通用调用：IPC 优先，HTTP  ──────────────────────
async function call(channel, httpPath, { method = 'GET', body = null, ipcArg, confirm = false, timeout = 30000 } = {}) {
  if (isElectron()) {
    const arg = ipcArg !== undefined ? ipcArg : body;
    return arg !== null && arg !== undefined
      ? window.electron.invoke(channel, arg)
      : window.electron.invoke(channel);
  }

  // 浏览器模式：带上 token + 可选确认头
  const base = await getBaseUrl();
  const token = await getToken();
  const opts = { method, signal: AbortSignal.timeout(timeout) };
  opts.headers = { Authorization: `Bearer ${token}` };
  if (confirm) opts.headers['X-Confirmed'] = 'true';
  if (body && method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${httpPath}`, opts);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const err = await res.json(); detail = err.detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

// ── API 函数 ──────────────────────────────────────────
const api = {
  health: () => {
    if (isElectron()) return Promise.resolve({ data: { status: 'ok' } });
    return getBaseUrl().then(base =>
      fetch(`${base}/api/health`).then(r => r.json()).then(d => ({ data: d }))
    );
  },

  // ── 环境列表 ───────────────────────────────────────
  getEnvironments: () =>
    call('env:list', '/api/environments').then((envs) => ({ data: { environments: envs } })),

  // ── 创建 / 克隆 / 删除 ─────────────────────────────
  createEnvironment: (values) =>
    call('env:create', '/api/environments/create', { method: 'POST', body: values })
      .then((taskId) => ({ data: { task_id: taskId, message: '创建任务已提交' } })),

  cloneEnvironment: (data) =>
    call('env:clone', '/api/environments/clone', { method: 'POST', body: data })
      .then((taskId) => ({ data: { task_id: taskId, message: '克隆任务已提交' } })),

  deleteEnvironment: (name, confirmName) =>
    call('env:delete', '/api/environments/delete', { method: 'POST', body: { name, confirm: confirmName }, confirm: true })
      .then((taskId) => ({ data: { task_id: taskId, message: '删除任务已提交' } })),

  cleanInvalidEnvironment: (envPath) =>
    call('env:clean-invalid', '/api/environments/clean-invalid', { method: 'POST', body: { envPath } })
      .then((taskId) => ({ data: { task_id: taskId, message: '清理任务已提交' } })),

  // ── 激活 ──────────────────────────────────────────
  getActivateCmd: (name) =>
    call('env:activate-cmd', `/api/environments/${encodeURIComponent(name)}/activate-cmd`, { ipcArg: name })
      .then((cmd) => ({ data: { command: cmd } })),

  activateEnvironment: (name) =>
    call('env:activate', `/api/environments/${encodeURIComponent(name)}/activate`, { method: 'POST', ipcArg: name })
      .then((res) => ({ data: res })),

  getActivated: () =>
    call('env:activated', '/api/environments/activated').then((res) => ({ data: res })),

  // ── 终端 ──────────────────────────────────────────
  openTerminal: (name) =>
    call('env:terminal', `/api/environments/${encodeURIComponent(name)}/terminal`, { method: 'POST', ipcArg: name })
      .then((res) => ({ data: res })),

  // ── 包管理 ──────────────────────────────────────────
  listPackages: (name) =>
    call('env:packages-list', `/api/environments/${encodeURIComponent(name)}/packages-list`, { ipcArg: name })
      .then((res) => ({ data: res })),

  installPackage: (data) =>
    call('env:install', '/api/environments/install', { method: 'POST', body: data })
      .then((taskId) => ({ data: { task_id: taskId, message: '安装任务已提交' } })),

  uninstallPackage: (data) =>
    call('env:uninstall', '/api/environments/uninstall', { method: 'POST', body: data })
      .then((taskId) => ({ data: { task_id: taskId, message: '卸载任务已提交' } })),

  upgradePackage: (data) =>
    call('env:upgrade', '/api/environments/upgrade', { method: 'POST', body: data })
      .then((taskId) => ({ data: { task_id: taskId, message: '升级任务已提交' } })),

  // ── 导出 / 导入 ─────────────────────────────────────
  exportEnvironment: (name) =>
    call('env:export', `/api/environments/${encodeURIComponent(name)}/export`, { ipcArg: name })
      .then((res) => ({ data: res })),

  importEnvironment: (data) =>
    call('env:import', '/api/environments/import', { method: 'POST', body: data })
      .then((taskId) => ({ data: { task_id: taskId, message: '导入任务已提交' } })),

  // ── 磁盘占用 ──────────────────────────────────────
  // 大环境文件多，遍历耗时可能较长，单独放宽 HTTP 超时
  getEnvSize: (name) =>
    call('env:size', `/api/environments/${encodeURIComponent(name)}/size`, { ipcArg: name, timeout: 120000 })
      .then((res) => ({ data: res })),

  // 计算大小的开关 + 超时秒数设置
  getCalcEnvSizeSettings: () =>
    call('env:calc-settings', '/api/environments/calc-settings')
      .then((res) => ({ data: res })),

  // ── 文件对话框 ──────────────────────────────────────
  openExportDialog: (options) => {
    if (isElectron()) {
      return window.electron.invoke('dialog:save-file', options);
    }
    return Promise.resolve(null);
  },
  openImportDialog: (options) => {
    if (isElectron()) {
      return window.electron.invoke('dialog:open-file', options);
    }
    return Promise.resolve(null);
  },

  // ── 任务 ──────────────────────────────────────────
  getTask: (taskId) =>
    call('task:status', `/api/tasks/${encodeURIComponent(taskId)}`, { ipcArg: taskId }).then((d) => ({ data: d || null })),

  cancelTask: (taskId) =>
    call('task:cancel', `/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', ipcArg: taskId })
      .then((d) => ({ data: d || null })),

  // 任务进度监听（IPC 推送 / 浏览器轮询）
  onTaskUpdate: (callback) => {
    if (isElectron()) {
      return window.electron.on('task:update', callback);
    }
    let timer = null;
    const seen = new Set();
    const run = () => {
      timer = setInterval(async () => {
        try {
          const base = await getBaseUrl();
          const token = await getToken();
          const list = await fetch(`${base}/api/tasks`, {
            signal: AbortSignal.timeout(3000),
            headers: { Authorization: `Bearer ${token}` },
          }).then(r => r.json());
          if (Array.isArray(list)) {
            list.forEach((t) => {
              const key = `${t.task_id}:${t.status}:${t.progress}`;
              if (!seen.has(key)) { seen.add(key); callback(t); }
            });
          }
        } catch { /* ignore */ }
      }, 2000);
    };
    run();
    return () => { clearInterval(timer); timer = null; };
  },

  // ── 系统操作 ──────────────────────────────────────
  openPath: (dirPath) =>
    call('shell:open-path', '/api/system/open-path', { method: 'POST', body: { path: dirPath }, ipcArg: dirPath }),

  // ── 设置 ──────────────────────────────────────────
  getSettings: () =>
    call('settings:get', '/api/settings').then((data) => ({ data })),

  saveSettings: (data) =>
    call('settings:save', '/api/settings', { method: 'POST', body: data }),

  testConda: (data) =>
    call('settings:test-conda', '/api/settings/test-conda', { method: 'POST', body: data })
      .then((res) => ({ data: res })),

  autoDetect: () =>
    call('settings:auto-detect', '/api/settings/auto-detect', { method: 'POST' })
      .then((data) => ({ data })),

  checkCondaStatus: () =>
    call('settings:conda-status', '/api/settings/conda-status').then((data) => ({ data })),

  completeOnboarding: (data) =>
    call('settings:complete-onboarding', '/api/settings/complete-onboarding', { method: 'POST', body: data })
      .then((res) => ({ data: res })),

  getSettingsPath: () =>
    call('settings:path', '/api/settings/path').then((data) => ({ data })),

  openSettingsDir: () =>
    call('settings:open-dir', '/api/settings/open-dir', { method: 'POST' })
      .then((res) => ({ data: res })),

  // ── 项目目录 ──────────────────────────────────────
  getProjectDir: () =>
    call('project:get-dir', '/api/project-dir').then((data) => ({ data })),

  setProjectDir: (dir) =>
    call('project:set-dir', '/api/project-dir', { method: 'POST', body: { dir }, ipcArg: dir })
      .then((res) => ({ data: res })),

  openProjectTerminal: (envName, projectDir) =>
    call('project:terminal', '/api/project/terminal', {
      method: 'POST',
      body: { envName, projectDir },
      ipcArg: { envName, projectDir },
    }).then((res) => ({ data: res })),

  // ── 环境名列表（供托盘） ──────────────────────────
  getEnvNames: () =>
    call('env:names', '/api/environments/names').then((names) => ({ data: names })),

  // ── 托盘刷新 ──────────────────────────────────────
  refreshTray: () =>
    call('tray:refresh', '/api/tray/refresh', { method: 'POST' }),

  // ── 指令集管理 ──────────────────────────────────────
  getCommands: () =>
    call('commands:get', '/api/commands').then((data) => ({ data })),
  addCategory: (body) =>
    call('commands:add-category', '/api/commands/category', { method: 'POST', body }),
  updateCategory: (body) =>
    call('commands:update-category', '/api/commands/category', { method: 'PUT', body }),
  deleteCategory: (body) =>
    call('commands:delete-category', '/api/commands/category', { method: 'DELETE', body }),
  addCommand: (body) =>
    call('commands:add-command', '/api/commands/command', { method: 'POST', body }),
  updateCommand: (body) =>
    call('commands:update-command', '/api/commands/command', { method: 'PUT', body }),
  deleteCommand: (body) =>
    call('commands:delete-command', '/api/commands/command', { method: 'DELETE', body }),
  resetCommands: () =>
    call('commands:reset', '/api/commands/reset', { method: 'POST' }),

  // ── 目录选择对话框（复用已有的 invoke 通道） ──────
  openDirectoryDialog: (options) => {
    if (isElectron()) {
      return window.electron.invoke('dialog:open-directory', options);
    }
    // 浏览器模式：不支持原生对话框
    return Promise.resolve(null);
  },
};

export default api;
