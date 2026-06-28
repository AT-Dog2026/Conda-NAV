const http = require('http');
const fs = require('fs');
const { shell } = require('electron');

const settings = require('./settings');
const tasks = require('./tasks');
const handlers = require('./handlers');
const auth = require('./auth');
const commands = require('./commands');

const { PORT_CANDIDATES } = require('./constants');
let activePort = null;

function sendJSON(res, code, data, req) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Confirmed',
  };
  // CORS 白名单：仅回显合法的 localhost origin
  const origin = req && req.headers && req.headers.origin;
  const allow = auth.corsAllowValue(origin);
  if (allow) headers['Access-Control-Allow-Origin'] = allow;
  res.writeHead(code, headers);
  res.end(JSON.stringify(data));
}

function sendError(res, code, detail, req) {
  sendJSON(res, code, { detail: String(detail) }, req);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
  });
}

function match(pattern, pathname) {
  const keys = [];
  const reStr = pattern.replace(/:([^/]+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  });
  const m = pathname.match(new RegExp(`^${reStr}$`));
  if (!m) return null;
  const params = {};
  keys.forEach((k, i) => { params[k] = m[i + 1]; });
  return params;
}

async function handleRoute(req, m, p, b) {
  if (m === 'GET' && p === '/api/health') {
    return { code: 200, data: { status: 'ok' } };
  }

  if (m === 'GET' && p === '/api/environments') {
    return { code: 200, data: await handlers.listEnvironments() };
  }

  const pkgMatch = match('/api/environments/:name/packages', p);
  if (m === 'GET' && pkgMatch) {
    return { code: 200, data: await handlers.getPackageCount(pkgMatch.name) };
  }

  const pyMatch = match('/api/environments/:name/python-version', p);
  if (m === 'GET' && pyMatch) {
    return { code: 200, data: await handlers.getPythonVersion(pyMatch.name) };
  }

  if (m === 'POST' && p === '/api/environments/package-counts') {
    return { code: 200, data: await handlers.getBatchPackageCounts(b.names) };
  }

  if (m === 'POST' && p === '/api/environments/create') {
    return { code: 200, data: handlers.createEnvironment(b) };
  }

  if (m === 'POST' && p === '/api/environments/clone') {
    return { code: 200, data: handlers.cloneEnvironment(b) };
  }

  if (m === 'POST' && p === '/api/environments/delete') {
    // 安全守卫：删除是高危操作，除 body 二次确认外，额外要求 header 带确认标志
    if (req.headers['x-confirmed'] !== 'true') {
      return { code: 400, error: '删除操作需带 X-Confirmed: true 请求头确认' };
    }
    return { code: 200, data: handlers.deleteEnvironment(b) };
  }

  const cmdMatch = match('/api/environments/:name/activate-cmd', p);
  if (m === 'GET' && cmdMatch) {
    return { code: 200, data: handlers.getActivateCmd(cmdMatch.name) };
  }

  const actMatch = match('/api/environments/:name/activate', p);
  if (m === 'POST' && actMatch) {
    return { code: 200, data: await handlers.activateEnvironment(actMatch.name) };
  }

  if (m === 'GET' && p === '/api/environments/activated') {
    return { code: 200, data: handlers.getActivated() };
  }

  const termMatch = match('/api/environments/:name/terminal', p);
  if (m === 'POST' && termMatch) {
    return { code: 200, data: await handlers.openTerminal(termMatch.name) };
  }

  const pkgsListMatch = match('/api/environments/:name/packages-list', p);
  if (m === 'GET' && pkgsListMatch) {
    return { code: 200, data: await handlers.listPackages(pkgsListMatch.name) };
  }

  if (m === 'POST' && p === '/api/environments/install') {
    return { code: 200, data: handlers.installPackage(b) };
  }

  if (m === 'POST' && p === '/api/environments/uninstall') {
    return { code: 200, data: handlers.uninstallPackage(b) };
  }

  if (m === 'POST' && p === '/api/environments/upgrade') {
    return { code: 200, data: handlers.upgradePackage(b) };
  }

  const exportMatch = match('/api/environments/:name/export', p);
  if (m === 'GET' && exportMatch) {
    return { code: 200, data: await handlers.exportEnvironment(exportMatch.name) };
  }

  const sizeMatch = match('/api/environments/:name/size', p);
  if (m === 'GET' && sizeMatch) {
    return { code: 200, data: await handlers.getEnvSize(sizeMatch.name) };
  }

  if (m === 'GET' && p === '/api/environments/calc-settings') {
    return { code: 200, data: handlers.getCalcEnvSizeSettings() };
  }

  if (m === 'POST' && p === '/api/environments/import') {
    return { code: 200, data: handlers.importEnvironment(b) };
  }

  if (m === 'POST' && p === '/api/environments/import-requirements') {
    return { code: 200, data: handlers.importFromRequirements(b) };
  }

  if (m === 'POST' && p === '/api/environments/install-requirements') {
    return { code: 200, data: handlers.installRequirementsToEnv(b) };
  }

  if (m === 'GET' && p === '/api/tasks') {
    return { code: 200, data: tasks.getTasksForPoll() };
  }

  const cancelMatch = match('/api/tasks/:id/cancel', p);
  if (m === 'POST' && cancelMatch) {
    const ok = tasks.cancelTask(cancelMatch.id);
    return { code: ok ? 200 : 404, data: ok ? { ok: true } : null, error: ok ? null : '任务不存在或已完成' };
  }

  const taskMatch = match('/api/tasks/:taskId', p);
  if (m === 'GET' && taskMatch) {
    return { code: 200, data: tasks.getTask(taskMatch.taskId) };
  }

  if (m === 'GET' && p === '/api/settings') {
    return { code: 200, data: settings.getSettings() };
  }

  if (m === 'POST' && p === '/api/settings') {
    const current = settings.loadSettings();
    settings.saveSettings({
      conda_path: b.conda_path ?? current.conda_path ?? '',
      mamba_path: b.mamba_path ?? current.mamba_path ?? '',
      onboarding_completed: b.onboarding_completed ?? current.onboarding_completed ?? false,
      project_dir: b.project_dir ?? current.project_dir ?? '',
    });
    handlers.invalidateEnvCache();
    return { code: 200, data: { success: true } };
  }

  if (m === 'GET' && p === '/api/settings/conda-status') {
    return { code: 200, data: await handlers.checkCondaStatus() };
  }

  if (m === 'POST' && p === '/api/settings/complete-onboarding') {
    return { code: 200, data: handlers.completeOnboarding(b) };
  }

  if (m === 'POST' && p === '/api/settings/test-conda') {
    return { code: 200, data: settings.testCondaPath(b.path) };
  }

  if (m === 'POST' && p === '/api/settings/auto-detect') {
    return { code: 200, data: handlers.autoDetectSettings() };
  }

  if (m === 'GET' && p === '/api/settings/path') {
    return { code: 200, data: { settings_path: settings.settingsFile } };
  }

  if (m === 'POST' && p === '/api/settings/open-dir') {
    const dirPath = settings.settingsDir;
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    shell.openPath(dirPath);
    return { code: 200, data: { success: true } };
  }

  // ── 开机自启 ──────────────────────────────────────
  if (m === 'POST' && p === '/api/settings/auto-start') {
    const { app } = require('electron');
    app.setLoginItemSettings({
      openAtLogin: !!b.enabled,
      path: app.getPath('exe'),
    });
    settings.saveSettings({ auto_start: !!b.enabled });
    return { code: 200, data: { success: true } };
  }

  // ── 项目目录 ──────────────────────────────────────
  if (m === 'GET' && p === '/api/project-dir') {
    return { code: 200, data: handlers.getProjectDir() };
  }

  if (m === 'POST' && p === '/api/project-dir') {
    return { code: 200, data: handlers.setProjectDir(b.dir) };
  }

  if (m === 'POST' && p === '/api/project/terminal') {
    return { code: 200, data: await handlers.openProjectTerminal(b.envName, b.projectDir) };
  }

  // ── 环境名列表 ────────────────────────────────────
  if (m === 'GET' && p === '/api/environments/names') {
    return { code: 200, data: await handlers.getEnvNames() };
  }

  // ── 托盘刷新（浏览器模式 stub） ────────────────────
  if (m === 'POST' && p === '/api/tray/refresh') {
    return { code: 200, data: { ok: true } };
  }

  // ── 指令集管理 ──────────────────────────────────────
  if (m === 'GET' && p === '/api/commands') {
    return { code: 200, data: commands.getCategories() };
  }

  if (m === 'POST' && p === '/api/commands/category') {
    return { code: 200, data: commands.addCategory(b.name, b.nameEn) };
  }

  if (m === 'PUT' && p === '/api/commands/category') {
    return { code: 200, data: commands.updateCategory(b.id, b.name, b.nameEn) };
  }

  if (m === 'DELETE' && p === '/api/commands/category') {
    commands.deleteCategory(b.id);
    return { code: 200, data: { ok: true } };
  }

  if (m === 'POST' && p === '/api/commands/command') {
    return { code: 200, data: commands.addCommand(b.categoryId, b.command, b.description, b.descriptionEn) };
  }

  if (m === 'PUT' && p === '/api/commands/command') {
    return { code: 200, data: commands.updateCommand(b.categoryId, b.commandId, b.command, b.description, b.descriptionEn) };
  }

  if (m === 'DELETE' && p === '/api/commands/command') {
    commands.deleteCommand(b.categoryId, b.commandId);
    return { code: 200, data: { ok: true } };
  }

  if (m === 'POST' && p === '/api/commands/reset') {
    return { code: 200, data: commands.resetToDefault() };
  }

  return { code: 404, error: `Not Found: ${m} ${p}` };
}

async function start() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${activePort}`);
    const p = url.pathname;
    const m = req.method;
    const origin = req.headers.origin;

    // OPTIONS 预检：仅放行白名单 origin
    if (req.method === 'OPTIONS') {
      const allow = auth.corsAllowValue(origin);
      const headers = {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Confirmed',
      };
      if (allow) headers['Access-Control-Allow-Origin'] = allow;
      res.writeHead(204, headers);
      res.end();
      return;
    }

    // 鉴权：除 /api/health 外，必须携带正确 Bearer token
    if (!auth.isAuthorized(req, p)) {
      sendError(res, 401, '未授权：缺少或错误的 Token', req);
      return;
    }

    const b = (m === 'POST' || m === 'PUT' || m === 'DELETE') ? await parseBody(req) : {};

    try {
      const result = await handleRoute(req, m, p, b);
      if (result.error) return sendError(res, result.code, result.error, req);
      return sendJSON(res, result.code, result.data, req);
    } catch (e) {
      console.error('HTTP API Error:', e);
      sendError(res, 500, e.message, req);
    }
  });

  for (const port of PORT_CANDIDATES) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE') reject(err);
          else console.error('HTTP API 错误:', err.message);
        });
        server.listen(port, '127.0.0.1', () => {
          activePort = port;
          console.log(`HTTP API 服务器已启动: http://127.0.0.1:${port}`);
          resolve();
        });
      });
      return server;
    } catch { /* port busy, try next */ }
  }
  console.error('HTTP API 所有端口被占用 (8000-8003)');
  return server;
}

function getPort() { return activePort; }

module.exports = { start, getPort, PORT_CANDIDATES };
