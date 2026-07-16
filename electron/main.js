const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage, ipcMain, nativeTheme, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

// ── 服务模块 ─────────────────────────────────────────
const settingsService = require('./services/settings');
const tasksService = require('./services/tasks');
const httpApi = require('./services/http-api');
const handlers = require('./services/handlers');
const state = require('./services/state');
const auth = require('./services/auth');

let mainWindow = null;
let tray = null;
let windowState = { isMaximized: false, isMinimized: false };

// 判断是否是开发模式
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged || process.defaultApp;

// 获取资源路径（开发 / 打包均相对 electron 目录）
function getResourcePath(...args) {
  return path.join(__dirname, '..', ...args);
}

// 获取系统 DPI 缩放因子
function getSystemScaleFactor() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const scaleFactor = primaryDisplay.scaleFactor;
  return scaleFactor || 1.0;
}

// 根据 DPI 缩放计算图标尺寸
function getScaledIconSize(baseSize) {
  const scaleFactor = getSystemScaleFactor();
  return Math.round(baseSize * scaleFactor);
}

// 创建默认图标（通用）
function createDefaultIcon() {
  for (const rel of ['build/icon.png', 'icon.ico', 'icon.png']) {
    const iconPath = getResourcePath(rel);
    if (fs.existsSync(iconPath)) return nativeImage.createFromPath(iconPath);
  }
  const size = 256;
  const canvas = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const offset = i * 4;
    canvas[offset] = 76;
    canvas[offset + 1] = 175;
    canvas[offset + 2] = 80;
    canvas[offset + 3] = 255;
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

// 创建托盘专用图标（缩放到系统托盘合适尺寸，避免马赛克）
function createTrayIcon() {
  let iconPath = null;
  for (const rel of ['icon.ico', 'build/icon.png', 'icon.png']) {
    const fullPath = getResourcePath(rel);
    if (fs.existsSync(fullPath)) {
      iconPath = fullPath;
      break;
    }
  }

  if (iconPath) {
    const icon = nativeImage.createFromPath(iconPath);
    // Windows 系统托盘图标基础尺寸 16px，按 DPI 缩放
    const traySize = getScaledIconSize(16);
    return icon.resize({ width: traySize, height: traySize, quality: 'best' });
  }
  return createDefaultIcon();
}

// ── 窗口 ────────────────────────────────────────────
async function createWindow(options = {}) {
  const { showOnReady = true } = options;
  const icon = createDefaultIcon();
  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    minWidth: 1000, minHeight: 600,
    title: 'Conda NAV', icon: icon,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  // 注入到 tasks 服务，用于推送进度
  tasksService.setMainWindow(mainWindow);

  if (isDev) {
    const tryPorts = [5173, 5174, 5175, 5176, 5177, 3000, 3001, 3002, 3003];
    let loaded = false;
    for (const port of tryPorts) {
      try {
        await mainWindow.loadURL(`http://localhost:${port}`);
        console.log(`前端已加载: http://localhost:${port}`);
        loaded = true;
        break;
      } catch { console.log(`端口 ${port} 不可用`); }
    }
    if (!loaded) {
      setTimeout(async () => {
        try { await mainWindow.loadURL('http://localhost:5173'); if (showOnReady) mainWindow.show(); }
        catch { dialog.showErrorBox('前端加载失败', '请确保 npm run dev:fe 已启动'); }
      }, 5000);
    }
  } else {
    mainWindow.loadFile(getResourcePath('frontend', 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => { if (showOnReady) mainWindow.show(); });
  mainWindow.on('maximize', () => { windowState.isMaximized = true; });
  mainWindow.on('unmaximize', () => { windowState.isMaximized = false; });
  mainWindow.on('minimize', () => { windowState.isMinimized = true; });
  mainWindow.on('restore', () => { windowState.isMinimized = false; });
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) { event.preventDefault(); handleHideToTray(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── 托盘 ────────────────────────────────────────────
function handleHideToTray() {
  if (mainWindow) {
    windowState.isMaximized = mainWindow.isMaximized();
    windowState.isMinimized = mainWindow.isMinimized();
    mainWindow.hide();
  }
}
function handleShowFromTray() {
  if (mainWindow) {
    mainWindow.show();
    if (windowState.isMaximized) mainWindow.maximize();
    else if (windowState.isMinimized) mainWindow.restore();
    mainWindow.focus();
  } else { createWindow(); }
}

// 动态构建托盘右键菜单
async function buildTrayMenu() {
  const activated = state.getActivatedEnv();
  let envNames = [];
  try {
    const envs = await handlers.getEnvNames();
    envNames = envs.map(e => e.name);
  } catch { /* 使用空列表 */ }

  const template = [
    { label: '显示主窗口', click: handleShowFromTray },
    { type: 'separator' },
  ];

  // 当前激活环境显示
  if (activated) {
    template.push({ label: `当前激活: ${activated}`, enabled: false });
  } else {
    template.push({ label: '未激活环境', enabled: false });
  }

  // 切换环境子菜单
  if (envNames.length > 0) {
    const switchItems = envNames.slice(0, 20).map(name => ({
      label: name,
      type: 'radio',
      checked: name === activated,
      click: async () => {
        try {
          await handlers.activateEnvironment(name);
          // 通知前端刷新激活状态
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('tray:env-activated', name);
          }
          // 重建菜单
          const newTemplate = await buildTrayMenu();
          tray.setContextMenu(Menu.buildFromTemplate(newTemplate));
        } catch { /* ignore */ }
      },
    }));
    template.push({ label: '切换环境', submenu: switchItems });
  }

  // 打开终端
  if (activated) {
    template.push({
      label: `用终端打开 - ${activated}`,
      click: () => {
        handlers.openTerminal(activated).catch(() => {});
      },
    });
  }

  // 新建环境
  template.push({
    label: '新建环境',
    click: () => {
      handleShowFromTray();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tray:create-env');
      }
    },
  });

  template.push({ type: 'separator' });
  template.push({ label: '退出', click: () => { app.isQuitting = true; app.quit(); } });

  return template;
}

async function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const template = await buildTrayMenu();
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Conda NAV');
  tray.on('double-click', handleShowFromTray);

  refreshTrayMenu();
}

// ═══════════════════════════════════════════════════════
// ── IPC Handlers ─────────────────────────────────────
// ═══════════════════════════════════════════════════════

// ── Shell (从主进程打开) ────────────────────────────
ipcMain.handle('open-path', async (_e, dirPath) => shell.openPath(dirPath));
ipcMain.handle('open-external', async (_e, url) => shell.openExternal(url));

// ── 环境 / 任务 / 设置（统一 handlers） ─────────────
ipcMain.handle('env:list', () => handlers.listEnvironments());
ipcMain.handle('env:packages', (_e, name) => handlers.getPackageCount(name));
ipcMain.handle('env:packages-batch', (_e, names) => handlers.getBatchPackageCounts(names));
ipcMain.handle('env:python-version', (_e, name) => handlers.getPythonVersion(name));
ipcMain.handle('env:create', (_e, data) => handlers.createEnvironment(data));
ipcMain.handle('env:clone', (_e, data) => handlers.cloneEnvironment(data));
ipcMain.handle('env:delete', (_e, data) => handlers.deleteEnvironment(data));
ipcMain.handle('env:clean-invalid', (_e, data) => handlers.cleanInvalidEnvironment(data));
ipcMain.handle('env:activate-cmd', (_e, name) => handlers.getActivateCmd(name));
ipcMain.handle('env:activate', (_e, name) => handlers.activateEnvironment(name));
ipcMain.handle('env:activated', () => handlers.getActivated());
ipcMain.handle('env:terminal', (_e, name) => handlers.openTerminal(name));
// ── 包管理 ───────────────────────────────────────────
ipcMain.handle('env:packages-list', (_e, name) => handlers.listPackages(name));
ipcMain.handle('env:install', (_e, data) => handlers.installPackage(data));
ipcMain.handle('env:uninstall', (_e, data) => handlers.uninstallPackage(data));
ipcMain.handle('env:upgrade', (_e, data) => handlers.upgradePackage(data));
// ── 导出 / 导入 ───────────────────────────────────────
ipcMain.handle('env:export', (_e, name) => handlers.exportEnvironment(name));
ipcMain.handle('env:export-req', (_e, name) => handlers.exportRequirements(name));
ipcMain.handle('env:import', (_e, data) => handlers.importEnvironment(data));
ipcMain.handle('env:install-requirements', (_e, data) => handlers.installRequirementsToEnv(data));

// ── 任务取消 ─────────────────────────────────────────
ipcMain.handle('task:cancel', (_e, taskId) => tasksService.cancelTask(taskId));

// ── 磁盘占用 ─────────────────────────────────────────
ipcMain.handle('env:size', (_e, name) => handlers.getEnvSize(name));
ipcMain.handle('env:calc-settings', () => handlers.getCalcEnvSizeSettings());

// ── 系统 Shell 操作 ──────────────────────────────────
ipcMain.handle('shell:open-path', (_e, dirPath) => {
  try { shell.openPath(dirPath); return true; } catch { return false; }
});

// ── 原生主题（监听变化推送给前端）─────────────────────
ipcMain.handle('native-theme:get', () => nativeTheme.shouldUseDarkColors);
nativeTheme.on('updated', () => {
  if (mainWindow) mainWindow.webContents.send('native-theme:changed', nativeTheme.shouldUseDarkColors);
});

// ── 全局快捷键 ───────────────────────────────────────
try {
  globalShortcut.register('CommandOrControl+Shift+C', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
} catch { console.error('全局快捷键注册失败'); }

// ── 文件写入（导出 yml 等） ──────────────────────────
ipcMain.handle('fs:write-file', async (_e, { path: filePath, content }) => {
  require('fs').writeFileSync(filePath, content, 'utf-8');
  return true;
});

ipcMain.handle('task:status', (_e, taskId) => tasksService.getTask(taskId));
ipcMain.handle('settings:get', () => settingsService.getSettings());
ipcMain.handle('settings:save', (_e, data) => settingsService.saveSettings(data));
ipcMain.handle('settings:test-conda', (_e, { path: testPath }) => settingsService.testCondaPath(testPath));
ipcMain.handle('settings:auto-detect', () => handlers.autoDetectSettings());
ipcMain.handle('settings:conda-status', () => handlers.checkCondaStatus());
ipcMain.handle('settings:complete-onboarding', (_e, data) => handlers.completeOnboarding(data));
ipcMain.handle('settings:path', () => ({ settings_path: settingsService.settingsFile }));
ipcMain.handle('settings:open-dir', async () => {
  const dirPath = settingsService.settingsDir;
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  shell.openPath(dirPath);
  return { success: true };
});

// ── 开机自启 ───────────────────────────────────────
ipcMain.handle('settings:set-auto-start', async (_e, enabled) => {
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    path: app.getPath('exe'),
  });
  settingsService.saveSettings({ auto_start: !!enabled });
  return { success: true };
});
  ipcMain.handle('health', () => ({ status: 'ok' }));
  ipcMain.handle('get-http-port', () => httpApi.getPort());
  // 返回本地 HTTP token，供浏览器模式 fetch 携带（IPC 模式不需要 token）
  ipcMain.handle('auth:get-token', () => auth.getToken());

ipcMain.handle('dialog:open-file', async (_e, options = {}) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title: options.title || '选择文件',
    properties: ['openFile'],
    filters: options.filters || [
      { name: '可执行文件', extensions: ['exe', 'bat', ''] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

	// ── 目录选择对话框 ─────────────────────────────────
	ipcMain.handle('dialog:open-directory', async (_e, options = {}) => {
	  const win = BrowserWindow.getFocusedWindow() || mainWindow;
	  const result = await dialog.showOpenDialog(win, {
	    title: options.title || '选择目录',
	    properties: ['openDirectory'],
	  });
	  if (result.canceled || !result.filePaths.length) return null;
	  return result.filePaths[0];
	});

	// ── 保存文件对话框（导出 environment.yml 等）───────
	ipcMain.handle('dialog:save-file', async (_e, options = {}) => {
	  const win = BrowserWindow.getFocusedWindow() || mainWindow;
	  const result = await dialog.showSaveDialog(win, {
	    title: options.title || '保存文件',
	    defaultPath: options.defaultPath || 'environment.yml',
	    filters: options.filters || [
	      { name: 'YAML', extensions: ['yml', 'yaml'] },
	      { name: '所有文件', extensions: ['*'] },
	    ],
	  });
	  if (result.canceled || !result.filePath) return null;
	  return result.filePath;
	});

// ── 项目目录 ────────────────────────────────────────
ipcMain.handle('project:get-dir', () => handlers.getProjectDir());
ipcMain.handle('project:set-dir', (_e, dir) => handlers.setProjectDir(dir));
ipcMain.handle('project:terminal', (_e, { envName, projectDir }) =>
  handlers.openProjectTerminal(envName, projectDir)
);
// ── 项目管理 CRUD ───────────────────────────────────
ipcMain.handle('project:list', () => handlers.getProjects());
ipcMain.handle('project:add', (_e, data) => handlers.addProject(data));
ipcMain.handle('project:update', (_e, { id, ...data }) => handlers.updateProject(id, data));
ipcMain.handle('project:delete', (_e, { id }) => handlers.deleteProject(id));
ipcMain.handle('project:delete-dir', (_e, { id }) => handlers.deleteProjectDir(id));
// ── 终端执行自定义命令（requirements.txt pip install 等）──
ipcMain.handle('terminal:run-command', (_e, data) => handlers.openTerminalWithCmd(data));

// ── 托盘菜单刷新 ────────────────────────────────────
ipcMain.handle('tray:refresh', async () => {
  await refreshTrayMenu();
  return { ok: true };
});

// ── 环境名列表（供托盘/右键菜单） ───────────────────
ipcMain.handle('env:names', () => handlers.getEnvNames());

// ── 指令集管理 ──────────────────────────────────────
const commands = require('./services/commands');
ipcMain.handle('commands:get', async () => {
  return commands.getCategories();
});
ipcMain.handle('commands:add-category', async (_e, { name, nameEn }) => {
  return commands.addCategory(name, nameEn);
});
ipcMain.handle('commands:update-category', async (_e, { id, name, nameEn }) => {
  return commands.updateCategory(id, name, nameEn);
});
ipcMain.handle('commands:delete-category', async (_e, { id }) => {
  commands.deleteCategory(id);
  return { ok: true };
});
ipcMain.handle('commands:add-command', async (_e, { categoryId, command, description, descriptionEn }) => {
  return commands.addCommand(categoryId, command, description, descriptionEn);
});
ipcMain.handle('commands:update-command', async (_e, { categoryId, commandId, command, description, descriptionEn }) => {
  return commands.updateCommand(categoryId, commandId, command, description, descriptionEn);
});
ipcMain.handle('commands:delete-command', async (_e, { categoryId, commandId }) => {
  commands.deleteCommand(categoryId, commandId);
  return { ok: true };
});
ipcMain.handle('commands:reset', async () => {
  return commands.resetToDefault();
});

// ── 窗口标题栏主题（跟随应用而非系统） ──────────────
nativeTheme.themeSource = 'dark';
ipcMain.handle('theme:set', (_e, isDark) => {
  nativeTheme.themeSource = isDark ? 'dark' : 'light';
});

// ═══════════════════════════════════════════════════════
// ── 单实例锁 ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // 已有实例在运行，提示用户并退出
  dialog.showMessageBoxSync({
    type: 'info',
    title: 'Conda NAV',
    message: 'Conda NAV 正在运行，无法重复运行',
    detail: 'Conda NAV 已在后台运行。您可以点击系统托盘图标或按 Ctrl+Shift+C 打开主窗口。',
    buttons: ['确定'],
  });
  app.quit();
} else {
  app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
    // 有人尝试启动第二个实例，将现有窗口提到前台
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

// ═══════════════════════════════════════════════════════
// ── 应用启动 ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════

app.whenReady().then(() => {
  console.log('isDev:', isDev, 'app.isPackaged:', app.isPackaged);
  // 初始化本地鉴权 token（持久化，跨重启稳定）
  console.log('本地 HTTP token 已就绪');

  // 从持久化设置恢复激活环境
  state.init();

  // 开机自启：读取设置并同步
  const settings = settingsService.loadSettings();
  if (settings.auto_start) {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: app.getPath('exe'),
    });
  }

  createTray();
  // 静默自启：开机自启且静默时，不显示主窗口
  const showOnReady = !(settings.auto_start && settings.silent_start);
  createWindow({ showOnReady });
  // 延迟到下一个事件循环启动 HTTP API，不阻塞窗口首次渲染
  setImmediate(() => httpApi.start());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

} // else: gotTheLock

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && mainWindow) mainWindow.hide();
});

app.on('before-quit', () => { app.isQuitting = true; });

process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
});
