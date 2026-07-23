const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage, ipcMain, nativeTheme, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

// 启动耗时统计基准点（进程启动时刻）
const BOOT_T0 = Date.now();

// 主进程标题：PowerShell/Process Explorer 可识别（任务管理器"进程"标签页不显示）
process.title = 'Conda NAV (main)';

// Windows 任务管理器进程名：必须在 app ready 之前设置，进程启动后无法更改
app.name = 'Conda NAV';
if (process.platform === 'win32') {
  app.setAppUserModelId('com.atdog.conda-nav');
}

// Windows 透明窗口 DWM 合成灰底修复
// 禁用硬件加速，改用软件合成路径，避免透明窗口出现灰色矩形阴影
app.disableHardwareAcceleration();

// ── 服务模块 ─────────────────────────────────────────
const settingsService = require('./services/settings');
const tasksService = require('./services/tasks');
const httpApi = require('./services/http-api');
const handlers = require('./services/handlers');
const state = require('./services/state');
const auth = require('./services/auth');
const autoStart = require('./services/auto-start');

let mainWindow = null;
let floatingWindow = null;        // 悬浮窗（可拖拽停靠）
let tray = null;
let currentDockSide = null;       // 当前停靠边：null | 'top' | 'bottom'
let menuActionsCache = null;      // 上一次构建的菜单动作列表（避免重复构建）
let widgetPersistTimer = null;    // 悬浮窗状态防抖保存计时器
let menuIconCache = new Map();    // 菜单图标缓存：name-theme -> nativeImage
let windowState = { isMaximized: false, isMinimized: false };
let contextMenuWindow = null;     // 自定义右键菜单窗口

// ── 悬浮球 ────────────────────────────────────────
const BALL_SIZE = 48;             // 悬浮球本体尺寸
const BALL_WINDOW_SIZE = 120;     // 窗口尺寸（给 SVG 模糊阴影留足够空间）
let ballWindow = null;
let ballDragState = null;         // 拖动状态标记
let ballPersistTimer = null;      // 悬浮球状态防抖保存计时器
let ballHovering = false;         // 鼠标是否在球上（控制穿透状态）

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

  mainWindow.once('ready-to-show', () => {
    console.log(`[boot] main window ready-to-show: ${Date.now() - BOOT_T0}ms`);
    if (showOnReady) mainWindow.show();
  });
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

// ── 菜单 / 悬浮窗 ────────────────────────────────────
const menuActions = require('./services/menu-actions');

// 构建菜单动作上下文（暴露给 menu-actions 的 handler）
function buildMenuContext() {
  return {
    mainWindow,
    floatingWindow,
    tray,
    refreshAll,
    showMain: (tab) => {
      handleShowFromTray();
      if (tab && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tray:open-tab', tab);
      }
    },
    openFloatingWidget,
    hideFloatingWidget,
    toggleFloatingWidget,
    isFloatingVisible: () => !!(floatingWindow && !floatingWindow.isDestroyed() && floatingWindow.isVisible()),
    showBall,
    hideBall,
    toggleBall,
    isBallVisible: () => !!(ballWindow && !ballWindow.isDestroyed() && ballWindow.isVisible()),
  };
}

// 把 menu-actions 的 ActionDescriptor 列表转换为 Electron Menu 模板
function actionsToMenuTemplate(actions, ctx) {
  const tpl = [];
  for (const a of actions) {
    if (a.visible === false) continue;
    if (a.separatorBefore) tpl.push({ type: 'separator' });
    if (a.type === 'separator') { tpl.push({ type: 'separator' }); continue; }

    const item = {
      id: a.id,
      label: a.label,
      enabled: a.enabled !== false,
    };
    // 状态项的视觉强化：在原生菜单中只能靠 label 前缀
    if (a.isStatus) {
      item.label = a.activated ? `● ${a.label}` : `○ ${a.label}`;
    }
    if (a.type === 'radio') {
      item.type = 'radio';
      item.checked = !!a.checked;
    }
    // 图标
    if (a.icon) {
      const img = getMenuIcon(a.icon);
      if (img && !img.isEmpty()) item.icon = img;
    }
    if (a.submenu) {
      item.submenu = actionsToMenuTemplate(a.submenu, ctx);
    } else if (a.handler) {
      item.click = async () => {
        try { await a.handler(ctx); } catch (e) { console.error('菜单动作执行失败:', e); }
        // 动作执行后刷新托盘菜单，确保标签状态同步
        // （例如 "打开悬浮窗" ↔ "关闭悬浮窗"）
        try { await ctx.refreshAll?.(); } catch { /* ignore */ }
      };
    }
    tpl.push(item);
  }
  return tpl;
}

// 获取菜单图标（PNG 缓存；主题切换时由调用方清空 menuIconCache）
function getMenuIcon(name) {
  if (!name) return null;
  const isDark = nativeTheme.shouldUseDarkColors;
  const cacheKey = `${name}-${isDark ? 'dark' : 'light'}`;
  if (menuIconCache.has(cacheKey)) return menuIconCache.get(cacheKey);

  const sf = getSystemScaleFactor();
  const suffix = sf >= 1.5 ? '2x' : '1x';
  const iconPath = path.join(__dirname, 'assets', 'icons', 'menu', `${cacheKey}-${suffix}.png`);
  let img;
  try {
    if (fs.existsSync(iconPath)) {
      img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) {
        img = img.resize({ width: 16, height: 16, quality: 'best' });
      }
    }
  } catch { /* ignore */ }
  if (!img || img.isEmpty()) img = nativeImage.createEmpty();
  menuIconCache.set(cacheKey, img);
  return img;
}

// 序列化图标为 base64 dataURL（供悬浮窗使用）
function serializeIcon(name) {
  const img = getMenuIcon(name);
  if (!img || img.isEmpty()) return null;
  try {
    const buf = img.toPNG();
    return 'data:image/png;base64,' + buf.toString('base64');
  } catch { return null; }
}

// 动态构建托盘右键菜单（基于 menu-actions 单一数据源）
async function buildTrayMenu() {
  const ctx = buildMenuContext();
  const actions = await menuActions.buildMenuActions(ctx);
  menuActionsCache = actions;
  return actionsToMenuTemplate(actions, ctx);
}

// 刷新托盘菜单 + 推送给悬浮窗
async function refreshAll() {
  if (!tray || tray.isDestroyed()) return;
  const ctx = buildMenuContext();
  const actions = await menuActions.buildMenuActions(ctx);
  menuActionsCache = actions;
  // 1) 重建托盘菜单
  try {
    tray.setContextMenu(Menu.buildFromTemplate(actionsToMenuTemplate(actions, ctx)));
  } catch (e) { console.error('托盘菜单构建失败:', e); }
  // 2) 推送序列化动作给悬浮窗（若已显示）
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    try {
      const serialized = menuActions.serializeForRenderer(actions, serializeIcon);
      floatingWindow.webContents.send('menu:updated', serialized);
    } catch { /* ignore */ }
  }
}

// 兼容旧名（部分代码可能仍引用）
const refreshTrayMenu = refreshAll;

function createTray() {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('Conda NAV');

  // 双击：打开主窗口
  tray.on('double-click', () => {
    handleShowFromTray();
  });

  // 延迟刷新菜单（conda 命令耗时，不阻塞托盘创建）
  setImmediate(() => refreshAll().catch(() => {}));
}

// ── 悬浮窗生命周期 ────────────────────────────────────
function positionNearTray(win) {
  try {
    const trayBounds = tray.getBounds();
    const display = screen.getDisplayMatching(trayBounds);
    const wa = display.workArea;
    const [w, h] = win.getSize();
    let x = trayBounds.x + trayBounds.width / 2 - w / 2;
    let y = trayBounds.y + trayBounds.height + 4;
    x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - w - 8));
    y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - h - 8));
    win.setPosition(Math.round(x), Math.round(y));
  } catch { /* ignore */ }
}

// 将悬浮窗定位在悬浮球附近
// 水平策略：球在屏幕左半→窗在球右侧；球在右半→窗在球左侧（尽量远离屏幕边缘）
// 垂直策略：优先球上方，空间不足则球下方
function positionNearBall(win) {
  if (!ballWindow || ballWindow.isDestroyed()) return;
  const ballBounds = ballWindow.getBounds();
  const display = screen.getDisplayMatching(ballBounds);
  const wa = display.workArea;
  const [w, h] = win.getSize();
  const ballCx = ballBounds.x + ballBounds.width / 2;
  const screenMidX = wa.x + wa.width / 2;
  const gap = 8;

  // 水平方向：哪边空间大放哪边
  let x;
  if (ballCx < screenMidX) {
    // 球在左半 → 窗在球右侧，左对齐球的右边缘
    x = Math.round(ballBounds.x + ballBounds.width + gap);
  } else {
    // 球在右半 → 窗在球左侧，右对齐球的左边缘
    x = Math.round(ballBounds.x - w - gap);
  }
  // 水平边界校正
  x = Math.max(wa.x + gap, Math.min(x, wa.x + wa.width - w - gap));

  // 垂直方向：优先球上方（顶部对齐球顶部），空间不够则放球下方
  let y = Math.round(ballBounds.y + ballBounds.height / 2 - h / 2);
  // 垂直边界校正
  y = Math.max(wa.y + gap, Math.min(y, wa.y + wa.height - h - gap));

  win.setPosition(x, y);
}

function createFloatingWindow() {
  if (floatingWindow && !floatingWindow.isDestroyed()) return floatingWindow;

  const s = settingsService.loadSettings();
  const ws = s.widget_state || {};
  // 兼容旧配置：'bar' → 视为 'panel'（新模式不再有 bar）
  let initialMode = ws.mode || 'panel';
  if (initialMode === 'bar') initialMode = 'panel';
  const initialDocked = ws.docked || null;

  // 尺寸约束：将保存的值限制在 min/max 范围内，避免历史超标配置导致窗口过大
  const MIN_W = 260, MIN_H = 48, MAX_W = 420, MAX_H = 560;
  const clampW = (v) => Math.max(MIN_W, Math.min(MAX_W, v));
  const clampH = (v) => Math.max(MIN_H, Math.min(MAX_H, v));
  const width = clampW(ws.width || 280);
  const height = clampH(ws.height || 380);

  floatingWindow = new BrowserWindow({
    width, height,
    minWidth: MIN_W, minHeight: MIN_H,
    maxWidth: MAX_W, maxHeight: MAX_H,
    title: 'Conda NAV - 悬浮窗',
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    show: false,
    backgroundColor: '#00000000',
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'widget-preload.js'),
    },
  });

  // 初始位置：若上次是收缩态，恢复为收缩标签；否则用保存的位置或托盘附近
  if (initialMode === 'collapsed' && initialDocked) {
    const primary = screen.getPrimaryDisplay();
    collapseToEdge(initialDocked, primary);
  } else if (typeof ws.x === 'number' && typeof ws.y === 'number') {
    floatingWindow.setPosition(ws.x, ws.y);
  } else {
    positionNearTray(floatingWindow);
  }

  floatingWindow.loadFile(path.join(__dirname, 'widget', 'index.html'));

  floatingWindow.on('moved', handleWidgetMoved);
  floatingWindow.on('resize', handleWidgetResized);
  floatingWindow.on('closed', () => { floatingWindow = null; currentDockSide = null; });
  // 失焦自动关闭：点击其他窗口/桌面时收起悬浮窗
  // 跳过两种临时失焦场景：拖拽中、右键菜单打开中
  floatingWindow.on('blur', () => {
    if (floatingWindow.isDestroyed()) return;
    if (widgetDragOffset || widgetMenuOpen) return;
    floatingWindow.hide();
  });

  // 加载完成后推送当前菜单动作 + 初始模式
  floatingWindow.webContents.once('did-finish-load', () => {
    refreshAll().catch(() => {});
    floatingWindow.webContents.send('widget:set-mode', initialMode, initialMode === 'collapsed' ? initialDocked : null);
  });

  return floatingWindow;
}

function openFloatingWidget() {
  if (!floatingWindow || floatingWindow.isDestroyed()) {
    createFloatingWindow();
  }
  if (!floatingWindow.isVisible()) {
    // 通知渲染端即将显示，触发淡入动画（避免白屏/闪烁）
    floatingWindow.webContents.send('widget:will-show');
    floatingWindow.show();
    floatingWindow.focus();
  } else {
    floatingWindow.focus();
  }
  // Windows 上 focus() 会重置 skipTaskbar 行为，需重新断言以避免任务栏出现条目
  floatingWindow.setSkipTaskbar(true);
}

function hideFloatingWidget() {
  if (floatingWindow && !floatingWindow.isDestroyed() && floatingWindow.isVisible()) {
    floatingWindow.hide();
  }
}

function toggleFloatingWidget() {
  if (floatingWindow && !floatingWindow.isDestroyed() && floatingWindow.isVisible()) {
    hideFloatingWidget();
  } else {
    openFloatingWidget();
  }
}

// 持久化悬浮窗状态（防抖 300ms）
function persistWidgetState(patch) {
  if (!patch) return;
  const s = settingsService.loadSettings();
  const ws = { ...(s.widget_state || {}), ...patch };
  settingsService.saveSettings({ widget_state: ws });
}

function schedulePersistWidgetState(patch) {
  if (widgetPersistTimer) clearTimeout(widgetPersistTimer);
  widgetPersistTimer = setTimeout(() => {
    widgetPersistTimer = null;
    persistWidgetState(patch);
  }, 300);
}

// 边缘收缩检测：拖到屏幕边缘 → 自动收缩为小标签
const DOCK_SNAP_PX = 8;
const COLLAPSE_TAB_W = 96;   // 收缩标签宽度
const COLLAPSE_TAB_H = 24;   // 收缩标签高度

function handleWidgetMoved() {
  if (!floatingWindow || floatingWindow.isDestroyed()) return;
  const [x, y] = floatingWindow.getPosition();
  const [w, h] = floatingWindow.getSize();
  const display = screen.getDisplayMatching({ x, y, width: w, height: h });
  const wa = display.workArea;

  // 已收缩态：不再做边缘检测（避免抖动）；位置保存由 expand 时处理
  if (currentDockSide) {
    schedulePersistWidgetState({ collapsed: currentDockSide });
    return;
  }

  // 拖动中：跳过边缘吸附，仅保存位置，避免收缩/展开循环导致尺寸变化
  if (widgetDragOffset) {
    schedulePersistWidgetState({ x, y, docked: null, mode: 'panel' });
    return;
  }

  const distTop = y - wa.y;
  const distBottom = (wa.y + wa.height) - (y + h);
  const distLeft = x - wa.x;
  const distRight = (wa.x + wa.width) - (x + w);

  let dockSide = null;
  if (Math.abs(distTop) <= DOCK_SNAP_PX) dockSide = 'top';
  else if (Math.abs(distBottom) <= DOCK_SNAP_PX) dockSide = 'bottom';
  else if (Math.abs(distLeft) <= DOCK_SNAP_PX) dockSide = 'left';
  else if (Math.abs(distRight) <= DOCK_SNAP_PX) dockSide = 'right';

  if (dockSide) {
    collapseToEdge(dockSide, display);
  } else {
    // 自由移动：保存位置
    schedulePersistWidgetState({ x, y, docked: null, mode: 'panel' });
  }
}

function handleWidgetResized() {
  if (!floatingWindow || floatingWindow.isDestroyed()) return;
  if (currentDockSide) return; // 收缩态尺寸由 collapseToEdge 控制
  // 拖动中尺寸锁定：如果 resize 是意外触发的，立即恢复到拖动起始尺寸
  if (widgetDragSize) {
    const [w, h] = floatingWindow.getSize();
    if (w !== widgetDragSize.width || h !== widgetDragSize.height) {
      floatingWindow.setSize(widgetDragSize.width, widgetDragSize.height);
      return;
    }
  }
  const [w, h] = floatingWindow.getSize();
  schedulePersistWidgetState({ width: w, height: h });
}

// 收缩到屏幕边缘：窗口变小为 96x24 的小标签，仅露出边缘
function collapseToEdge(side, display) {
  if (!floatingWindow || floatingWindow.isDestroyed()) return;
  const wa = display.workArea;
  const tw = COLLAPSE_TAB_W;
  const th = COLLAPSE_TAB_H;

  let cx, cy;
  if (side === 'top') {
    cx = wa.x + (wa.width - tw) / 2;
    cy = wa.y;                    // 顶边贴顶
  } else if (side === 'bottom') {
    cx = wa.x + (wa.width - tw) / 2;
    cy = wa.y + wa.height - th;   // 底边贴底
  } else if (side === 'left') {
    cx = wa.x;                    // 左边贴左
    cy = wa.y + (wa.height - th) / 2;
  } else { // right
    cx = wa.x + wa.width - tw;
    cy = wa.y + (wa.height - th) / 2;
  }

  floatingWindow.setResizable(true);
  floatingWindow.setSize(tw, th);
  floatingWindow.setPosition(Math.round(cx), Math.round(cy));
  floatingWindow.setResizable(false);
  currentDockSide = side;
  try {
    floatingWindow.webContents.send('widget:set-mode', 'collapsed', side);
  } catch { /* ignore */ }
  persistWidgetState({ docked: side, mode: 'collapsed', collapsed: side });
}

// 从收缩态展开：恢复为 panel 形态，靠在同一边缘内侧
function expandFromEdge() {
  if (!floatingWindow || floatingWindow.isDestroyed()) return;
  const s = settingsService.loadSettings();
  const ws = s.widget_state || {};
  // 展开尺寸：使用保存值（约束到 min/max 范围），无保存值时用默认 320x440
  const MAX_W = 420, MAX_H = 560, MIN_W = 260, MIN_H = 48;
  const w = Math.max(MIN_W, Math.min(MAX_W, (ws.width && ws.width > MIN_W) ? ws.width : 320));
  const h = Math.max(MIN_H, Math.min(MAX_H, (ws.height && ws.height > MIN_H) ? ws.height : 440));
  const side = currentDockSide;

  const display = screen.getDisplayMatching(floatingWindow.getBounds());
  const wa = display.workArea;

  let cx, cy;
  if (side === 'top') {
    cx = wa.x + (wa.width - w) / 2;
    cy = wa.y + 4;
  } else if (side === 'bottom') {
    cx = wa.x + (wa.width - w) / 2;
    cy = wa.y + wa.height - h - 4;
  } else if (side === 'left') {
    cx = wa.x + 4;
    cy = wa.y + (wa.height - h) / 2;
  } else { // right
    cx = wa.x + wa.width - w - 4;
    cy = wa.y + (wa.height - h) / 2;
  }

  floatingWindow.setResizable(true);
  floatingWindow.setSize(w, h);
  floatingWindow.setPosition(Math.round(cx), Math.round(cy));
  floatingWindow.setResizable(false);
  currentDockSide = null;
  try {
    floatingWindow.webContents.send('widget:set-mode', 'panel', null);
  } catch { /* ignore */ }
  persistWidgetState({ docked: null, mode: 'panel', collapsed: null, width: w, height: h });
}

// ── 悬浮球生命周期 ────────────────────────────────────
function getDefaultBallPosition() {
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  // 默认右下角，距右边和底部各 20px
  const x = wa.x + wa.width - BALL_WINDOW_SIZE - 20;
  const y = wa.y + wa.height - BALL_WINDOW_SIZE - 20;
  return { x: Math.round(x), y: Math.round(y) };
}

function clampBallPosition(x, y) {
  const display = screen.getDisplayMatching({ x: x + BALL_WINDOW_SIZE / 2, y: y + BALL_WINDOW_SIZE / 2, width: BALL_WINDOW_SIZE, height: BALL_WINDOW_SIZE });
  const wa = display.workArea;
  const cx = Math.max(wa.x, Math.min(x, wa.x + wa.width - BALL_WINDOW_SIZE));
  const cy = Math.max(wa.y, Math.min(y, wa.y + wa.height - BALL_WINDOW_SIZE));
  return { x: Math.round(cx), y: Math.round(cy) };
}

function setBallPosition(x, y) {
  if (!ballWindow || ballWindow.isDestroyed()) return;
  // 用 setBounds 同时设置位置和尺寸，防止 Windows DWM 在 setPosition 时意外改变透明窗口大小
  ballWindow.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: BALL_WINDOW_SIZE,
    height: BALL_WINDOW_SIZE,
  });
}

function createBallWindow() {
  if (ballWindow && !ballWindow.isDestroyed()) return ballWindow;

  const s = settingsService.loadSettings();
  const bs = s.ball_state || {};

  ballWindow = new BrowserWindow({
    width: BALL_WINDOW_SIZE,
    height: BALL_WINDOW_SIZE,
    title: 'Conda NAV - 悬浮球',
    frame: false,
    transparent: true,
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'ball-preload.js'),
    },
  });

  // 默认穿透点击（透明区域不阻碍下面的窗口）
  // forward: true 让鼠标事件继续转发给 Chromium，渲染进程仍可通过 hover 检测
  ballWindow.setIgnoreMouseEvents(true, { forward: true });

  // 恢复位置：优先使用保存的位置，否则使用默认右下角
  if (typeof bs.x === 'number' && typeof bs.y === 'number') {
    const clamped = clampBallPosition(bs.x, bs.y);
    setBallPosition(clamped.x, clamped.y);
  } else {
    const pos = getDefaultBallPosition();
    setBallPosition(pos.x, pos.y);
  }

  ballWindow.loadFile(path.join(__dirname, 'ball', 'index.html'));

  ballWindow.on('closed', () => {
    ballWindow = null;
    ballDragState = null;
    ballHovering = false;
  });

  return ballWindow;
}

function showBall() {
  if (!ballWindow || ballWindow.isDestroyed()) {
    createBallWindow();
  }
  if (!ballWindow.isVisible()) {
    ballWindow.show();
  }
  // 保存可见性
  settingsService.saveSettings({ ball_visible: true });
}

function hideBall() {
  if (ballWindow && !ballWindow.isDestroyed() && ballWindow.isVisible()) {
    ballWindow.hide();
  }
  settingsService.saveSettings({ ball_visible: false });
}

function toggleBall() {
  if (ballWindow && !ballWindow.isDestroyed() && ballWindow.isVisible()) {
    hideBall();
  } else {
    showBall();
  }
}

// 持久化悬浮球位置（防抖 300ms）
function persistBallState(x, y) {
  settingsService.saveSettings({ ball_state: { x, y } });
}

function schedulePersistBallState(x, y) {
  if (ballPersistTimer) clearTimeout(ballPersistTimer);
  ballPersistTimer = setTimeout(() => {
    ballPersistTimer = null;
    persistBallState(x, y);
  }, 300);
}

// ═══════════════════════════════════════════════════════
// ── 右键菜单定位（Windows/macOS 原生行为：平移而非翻转） ─
// ═══════════════════════════════════════════════════════
// 1) 菜单出现在光标处
// 2) 若超出屏幕边缘 → 向反方向平移使菜单完全可见（不翻转到光标另一侧）
// 3) 避让悬浮球（仅 widget 菜单）：若菜单与球体重叠，选择空间最大的方向推开
const MENU_ESTIMATE_WIDTH = 220;
const MENU_ESTIMATE_HEIGHT = 300;
const MENU_SCREEN_MARGIN = 8;

function rectIntersect(a, b) {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x ||
           a.y + a.height <= b.y || b.y + b.height <= a.y);
}

function computeMenuPosition(cursorX, cursorY, avoidWindow = null) {
  const display = screen.getDisplayMatching({ x: cursorX, y: cursorY, width: 1, height: 1 });
  const wa = display.workArea;
  const menuW = MENU_ESTIMATE_WIDTH;
  const menuH = MENU_ESTIMATE_HEIGHT;
  const margin = MENU_SCREEN_MARGIN;

  let x = cursorX;
  let y = cursorY;

  // 平移到工作区内（不翻转，与 Windows 原生右键菜单一致）
  if (x + menuW > wa.x + wa.width - margin) {
    x = wa.x + wa.width - menuW - margin;
  }
  if (y + menuH > wa.y + wa.height - margin) {
    y = wa.y + wa.height - menuH - margin;
  }
  x = Math.max(wa.x + margin, x);
  y = Math.max(wa.y + margin, y);

  // 避让悬浮球（仅当 avoidWindow 指定时）：选择能容纳菜单且空间最大的方向
  if (avoidWindow && !avoidWindow.isDestroyed()) {
    const b = avoidWindow.getBounds();
    if (rectIntersect({ x, y, width: menuW, height: menuH }, b)) {
      // 四个方向的候选位置 + 各方向可用空间
      const candidates = [
        { x: b.x + b.width + margin, y,                         space: wa.x + wa.width - (b.x + b.width) - margin },
        { x: b.x - menuW - margin,   y,                         space: b.x - wa.x - margin },
        { x,                         y: b.y + b.height + margin, space: wa.y + wa.height - (b.y + b.height) - margin },
        { x,                         y: b.y - menuH - margin,    space: b.y - wa.y - margin },
      ];
      // 过滤掉超出工作区的方向，按空间降序选最优
      const valid = candidates.filter(c =>
        c.x >= wa.x + margin && c.x + menuW <= wa.x + wa.width - margin &&
        c.y >= wa.y + margin && c.y + menuH <= wa.y + wa.height - margin
      );
      if (valid.length) {
        valid.sort((a, b) => b.space - a.space);
        x = valid[0].x;
        y = valid[0].y;
      }
    }
  }

  return { x: Math.round(x), y: Math.round(y) };
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

// ── 原生主题（监听变化推送给前端 + 悬浮窗）──────────
ipcMain.handle('native-theme:get', () => nativeTheme.shouldUseDarkColors);
nativeTheme.on('updated', () => {
  const isDark = nativeTheme.shouldUseDarkColors;
  if (mainWindow) mainWindow.webContents.send('native-theme:changed', isDark);
  // 同步给悬浮窗（若已存在）
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.webContents.send('theme:changed', { mode: 'system', isDark });
  }
  // 同步给悬浮球（若已存在）
  if (ballWindow && !ballWindow.isDestroyed()) {
    ballWindow.webContents.send('theme:changed', { mode: 'system', isDark });
  }
  // 系统主题切换可能影响菜单图标着色，刷新菜单
  refreshAll().catch(() => {});
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

// ── 悬浮窗 / 菜单动作 IPC ────────────────────────────
// 内部触发主题切换（来自 menu-actions 的 toggle-theme handler）
ipcMain.on('theme:set-internal', async (_e, mode) => {
  const valid = ['dark', 'light', 'system'].includes(mode) ? mode : 'dark';
  nativeTheme.themeSource = valid;
  settingsService.saveSettings({ theme_mode: valid });
  const isDark = nativeTheme.shouldUseDarkColors;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('theme:changed', { mode: valid, isDark });
  }
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.webContents.send('theme:changed', { mode: valid, isDark });
  }
  if (ballWindow && !ballWindow.isDestroyed()) {
    ballWindow.webContents.send('theme:changed', { mode: valid, isDark });
  }
  menuIconCache.clear();
  await refreshAll().catch(() => {});
});

// 悬浮窗拉取菜单动作列表（序列化形式）
ipcMain.handle('menu:get-actions', async () => {
  const ctx = buildMenuContext();
  const actions = menuActionsCache || await menuActions.buildMenuActions(ctx);
  menuActionsCache = actions;
  return menuActions.serializeForRenderer(actions, serializeIcon);
});

// 悬浮窗点击动作 → 主进程执行
ipcMain.handle('menu:invoke-action', async (_e, id, payload) => {
  const ctx = buildMenuContext();
  const actions = menuActionsCache || await menuActions.buildMenuActions(ctx);
  const result = await menuActions.invokeAction(actions, id, payload, ctx);
  // 执行后刷新（环境激活、主题等可能改变菜单）
  await refreshAll().catch(() => {});
  return result;
});

// 悬浮窗拖拽：绝对坐标偏移方案（消除累积误差）
// 拖动开始时记录 offset = cursor - windowPos
// 拖动中用 cursor - offset 直接计算窗口位置，每帧都是绝对定位
// 使用 setBounds 显式指定尺寸，防止 setPosition 在 DWM 合成下意外改变窗口大小
let widgetDragOffset = null;
let widgetDragSize = null;
let widgetMenuOpen = false;   // 悬浮窗右键菜单打开期间，忽略 blur 关闭

ipcMain.on('widget:drag-start', (_e, cursorScreenX, cursorScreenY) => {
  if (!floatingWindow || floatingWindow.isDestroyed()) return;
  const [x, y] = floatingWindow.getPosition();
  const [w, h] = floatingWindow.getSize();
  widgetDragOffset = {
    x: cursorScreenX - x,
    y: cursorScreenY - y,
  };
  widgetDragSize = { width: w, height: h };
});

ipcMain.on('widget:drag-move', (_e, cursorScreenX, cursorScreenY) => {
  if (!floatingWindow || floatingWindow.isDestroyed() || !widgetDragOffset || !widgetDragSize) return;
  const x = Math.round(cursorScreenX - widgetDragOffset.x);
  const y = Math.round(cursorScreenY - widgetDragOffset.y);
  // 用 setBounds 同时设置位置和尺寸，确保尺寸在拖动中保持不变
  // （Windows DWM 有时会在 setPosition 时意外调整透明窗口大小）
  floatingWindow.setBounds({
    x, y,
    width: widgetDragSize.width,
    height: widgetDragSize.height,
  });
  // moved 事件会触发 handleWidgetMoved 做边缘检测
});

ipcMain.on('widget:drag-end', () => {
  widgetDragOffset = null;
  widgetDragSize = null;
});

// 悬浮窗请求持久化当前状态（拖拽/收展结束时调用）
ipcMain.handle('widget:persist-state', async (_e, patch) => {
  if (patch) persistWidgetState(patch);
  return { ok: true };
});

// 悬浮窗请求切换模式（panel / collapsed）— 收缩/展开由主进程统一控制
ipcMain.handle('widget:set-mode', async (_e, mode, docked) => {
  if (!floatingWindow || floatingWindow.isDestroyed()) return;
  if (mode === 'collapsed' && (docked === 'top' || docked === 'bottom' || docked === 'left' || docked === 'right')) {
    const display = screen.getDisplayMatching(floatingWindow.getBounds());
    collapseToEdge(docked, display);
  } else if (mode === 'panel') {
    expandFromEdge();
  }
  return { ok: true };
});

// 悬浮窗条状形态展开/收起（保留兼容，但新模式下不再使用）
ipcMain.handle('widget:set-expanded', async (_e, expanded) => {
  if (!floatingWindow || floatingWindow.isDestroyed()) return { ok: false };
  const targetH = expanded ? 240 : 48;
  floatingWindow.setResizable(true);
  const [w] = floatingWindow.getSize();
  floatingWindow.setSize(w, targetH);
  floatingWindow.setResizable(false);
  persistWidgetState({ expanded: !!expanded, height: targetH });
  return { ok: true };
});

// 悬浮窗请求关闭 —— 真正关闭窗口（而非仅 hide），下次打开重新创建
// 这样可避免关闭动画与隐藏态不同步导致的「X 按钮失效」错觉
ipcMain.handle('widget:close', async () => {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    try { floatingWindow.destroy(); } catch { /* ignore */ }
    floatingWindow = null;
    currentDockSide = null;
  }
  return { ok: true };
});

// 悬浮窗请求显示主窗口
ipcMain.handle('widget:show-main', async (_e, tab) => {
  handleShowFromTray();
  if (tab && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tray:open-tab', tab);
  }
  return { ok: true };
});

// 悬浮窗请求刷新环境列表（重建托盘菜单 + 推送更新到悬浮窗）
ipcMain.handle('widget:refresh-all', async () => {
  await refreshAll().catch(() => {});
  return { ok: true };
});

// 悬浮窗右键 → 弹出自定义右键菜单
ipcMain.handle('widget:show-context-menu', async (_e, _screenX, _screenY) => {
  if (!tray || tray.isDestroyed()) return;
  if (!floatingWindow || floatingWindow.isDestroyed()) return;
  floatingWindow.focus();
  floatingWindow.setSkipTaskbar(true);
  const cursor = screen.getCursorScreenPoint();
  widgetMenuOpen = true;
  await showContextMenu(cursor.x, cursor.y, floatingWindow);
  return { ok: true };
});

// ── 悬浮球 IPC ──────────────────────────────────────
// 悬浮球单击 → 打开悬浮窗（先定位到球附近再显示，避免跳动）
ipcMain.handle('ball:click', async () => {
  if (!floatingWindow || floatingWindow.isDestroyed()) {
    createFloatingWindow();
  }
  if (!floatingWindow.isVisible()) {
    // 先定位再显示，避免用户看到位置跳动
    if (ballWindow && !ballWindow.isDestroyed()) {
      positionNearBall(floatingWindow);
    }
    // 先通知渲染端准备显示（重置动画），再显示窗口
    // 避免 focus() 导致的焦点闪烁
    floatingWindow.webContents.send('widget:will-show');
    floatingWindow.setSkipTaskbar(true);
    floatingWindow.show();
  } else {
    floatingWindow.setSkipTaskbar(true);
    floatingWindow.focus();
  }
  return { ok: true };
});

// 悬浮球鼠标进入/离开 → 控制窗口穿透
ipcMain.on('ball:mouse-enter', () => {
  if (!ballWindow || ballWindow.isDestroyed()) return;
  ballHovering = true;
  ballWindow.setIgnoreMouseEvents(false);
});
ipcMain.on('ball:mouse-leave', () => {
  if (!ballWindow || ballWindow.isDestroyed()) return;
  ballHovering = false;
  // 拖动中不恢复穿透
  if (!ballDragState) {
    ballWindow.setIgnoreMouseEvents(true, { forward: true });
  }
});

// ── 悬浮球拖动（主进程轮询方案） ────────────────────
// 窗口默认穿透（setIgnoreMouseEvents + forward）
// 鼠标进入球体时关闭穿透，接收点击/拖拽
// 拖动手开始时，球平滑移动到鼠标中心（短动画过渡，不突兀）
// 动画结束后直接跟随鼠标（球心对准），不再计算 offset
// 极大跨度自动停止（防止鼠标释放后球乱飞）
// 鼠标静止时不更新位置（避免累积漂移）
// 鼠标静止超过 300ms 判定为释放（透明窗口外无法接收 mouseup）
let dragPollTimer = null;
let lastCursorPos = null;
let dragStaticCount = 0;
const DRAG_POLL_MS = 16;
const DRAG_STATIC_LIMIT = 31;  // 500ms / 16ms ≈ 31
const DRAG_JUMP_THRESHOLD = 200; // 单帧移动超过 200px 视为极大跨度，停止拖动
const DRAG_SNAP_DURATION = 120; // 吸附到鼠标中心的动画时长（ms）

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function clearDragPoll() {
  if (dragPollTimer) {
    clearInterval(dragPollTimer);
    dragPollTimer = null;
  }
}

function endDragBySystem() {
  if (!ballWindow || ballWindow.isDestroyed()) return;
  clearDragPoll();
  ballWindow.webContents.send('ball:force-drag-end');
  const [x, y] = ballWindow.getPosition();
  schedulePersistBallState(x, y);
  ballDragState = null;
  if (!ballHovering) {
    ballWindow.setIgnoreMouseEvents(true, { forward: true });
  }
}

function dragPoll() {
  if (!ballDragState || !ballWindow || ballWindow.isDestroyed()) {
    clearDragPoll();
    return;
  }
  const pos = screen.getCursorScreenPoint();
  const moveDist = Math.hypot(pos.x - lastCursorPos.x, pos.y - lastCursorPos.y);

  // 极大跨度检测：单帧移动超过阈值，停止拖动
  if (moveDist > DRAG_JUMP_THRESHOLD) {
    endDragBySystem();
    return;
  }

  // 吸附动画阶段：球平滑移动到鼠标中心
  if (ballDragState.phase === 'animating') {
    const now = Date.now();
    const elapsed = now - ballDragState.animStart;
    const t = Math.min(1, elapsed / DRAG_SNAP_DURATION);
    const eased = easeOutCubic(t);

    // 鼠标移动了，更新目标位置（让动画跟随鼠标）
    if (moveDist >= 1) {
      ballDragState.targetX = pos.x - BALL_WINDOW_SIZE / 2;
      ballDragState.targetY = pos.y - BALL_WINDOW_SIZE / 2;
      dragStaticCount = 0;
    } else {
      dragStaticCount++;
      if (dragStaticCount > DRAG_STATIC_LIMIT) {
        endDragBySystem();
        return;
      }
    }

    const curX = ballDragState.startX + (ballDragState.targetX - ballDragState.startX) * eased;
    const curY = ballDragState.startY + (ballDragState.targetY - ballDragState.startY) * eased;
    const clamped = clampBallPosition(curX, curY);
    setBallPosition(clamped.x, clamped.y);

    lastCursorPos = { x: pos.x, y: pos.y };

    // 动画结束，切换到跟随模式
    if (t >= 1) {
      ballDragState.phase = 'following';
    }
    return;
  }

  // 跟随模式：球心对准鼠标
  // 鼠标静止：不更新位置，避免累积漂移
  if (moveDist < 1) {
    dragStaticCount++;
    if (dragStaticCount > DRAG_STATIC_LIMIT) {
      endDragBySystem();
    }
    return;
  }

  // 鼠标移动了，直接跟随
  dragStaticCount = 0;
  const x = pos.x - BALL_WINDOW_SIZE / 2;
  const y = pos.y - BALL_WINDOW_SIZE / 2;
  const clamped = clampBallPosition(x, y);
  setBallPosition(clamped.x, clamped.y);
  lastCursorPos = { x: pos.x, y: pos.y };
}

// 悬浮球拖动开始：启动吸附动画，然后跟随鼠标
ipcMain.on('ball:drag-start', () => {
  if (!ballWindow || ballWindow.isDestroyed()) return;
  // 拖动期间确保不穿透，能接收鼠标事件
  ballWindow.setIgnoreMouseEvents(false);
  const [winX, winY] = ballWindow.getPosition();
  const cursor = screen.getCursorScreenPoint();
  const targetX = cursor.x - BALL_WINDOW_SIZE / 2;
  const targetY = cursor.y - BALL_WINDOW_SIZE / 2;

  ballDragState = {
    phase: 'animating',     // animating → following
    startX: winX,
    startY: winY,
    targetX: targetX,
    targetY: targetY,
    animStart: Date.now(),
  };

  lastCursorPos = { x: cursor.x, y: cursor.y };
  dragStaticCount = 0;
  clearDragPoll();
  dragPollTimer = setInterval(dragPoll, DRAG_POLL_MS);
});

// 悬浮球拖动结束：停止轮询并持久化位置
ipcMain.on('ball:drag-end', () => {
  clearDragPoll();
  if (!ballWindow || ballWindow.isDestroyed()) return;
  const [x, y] = ballWindow.getPosition();
  schedulePersistBallState(x, y);
  ballDragState = null;
  // 拖动结束后，如果鼠标不在球上则恢复穿透
  if (!ballHovering) {
    ballWindow.setIgnoreMouseEvents(true, { forward: true });
  }
});

// 创建自定义右键菜单窗口
function createContextMenuWindow() {
  if (contextMenuWindow && !contextMenuWindow.isDestroyed()) return;
  contextMenuWindow = new BrowserWindow({
    width: 220,
    height: 300,
    show: false,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const menuPath = path.join(__dirname, 'context-menu', 'index.html');
  contextMenuWindow.loadFile(menuPath);
  contextMenuWindow.on('blur', () => {
    hideContextMenu();
  });
}

// 隐藏右键菜单
function hideContextMenu() {
  if (contextMenuWindow && !contextMenuWindow.isDestroyed()) {
    contextMenuWindow.hide();
    contextMenuWindow.webContents.send('context-menu:close');
  }
  widgetMenuOpen = false;
}

// 显示右键菜单（转换为自定义菜单格式）
async function showContextMenu(x, y, win) {
  createContextMenuWindow();
  if (!contextMenuWindow || contextMenuWindow.isDestroyed()) return;
  const ctx = buildMenuContext();
  const actions = await menuActions.buildMenuActions(ctx);
  menuActionsCache = actions;
  // 转换为自定义菜单格式
  const menuItems = actionsToMenuTemplate(actions, ctx).map(item => {
    if (item.type === 'separator') {
      return { type: 'separator' };
    }
    return {
      id: item.id,
      label: item.label || '',
      icon: '',
      shortcut: item.accelerator || '',
      enabled: item.enabled !== false,
      submenu: item.submenu ? item.submenu.map(sub => ({
        id: sub.id,
        label: sub.label || '',
        enabled: sub.enabled !== false,
      })) : undefined,
    };
  });
  // 定位菜单（避免超出屏幕边界）
  const cursor = { x, y };
  const display = screen.getDisplayNearestPoint(cursor);
  const wa = display.workArea;
  const [menuW, menuH] = contextMenuWindow.getSize();
  let posX = cursor.x;
  let posY = cursor.y;
  if (posX + menuW > wa.x + wa.width) {
    posX = wa.x + wa.width - menuW - 8;
  }
  if (posY + menuH > wa.y + wa.height) {
    posY = wa.y + wa.height - menuH - 8;
  }
  posX = Math.max(wa.x + 8, posX);
  posY = Math.max(wa.y + 8, posY);
  contextMenuWindow.setPosition(posX, posY);
  contextMenuWindow.webContents.send('context-menu:show', { items: menuItems });
  contextMenuWindow.show();
  contextMenuWindow.focus();
}

// 右键菜单点击处理
ipcMain.handle('context-menu:click', async (_e, actionId) => {
  hideContextMenu();
  if (!menuActionsCache) return;
  const action = menuActionsCache.find(a => a.id === actionId);
  if (action && action.handler) {
    await action.handler();
  }
});

// 悬浮球右键 → 弹出自定义右键菜单
ipcMain.handle('ball:show-context-menu', async (_e, _screenX, _screenY) => {
  if (!tray || tray.isDestroyed()) return;
  if (!ballWindow || ballWindow.isDestroyed()) return;
  ballWindow.setIgnoreMouseEvents(false);
  ballWindow.setFocusable(true);
  ballWindow.focus();
  ballWindow.setSkipTaskbar(true);
  const cursor = screen.getCursorScreenPoint();
  widgetMenuOpen = true;
  await showContextMenu(cursor.x, cursor.y, ballWindow);
  return { ok: true };
});

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
  await autoStart.setAutoStart(app, __dirname, !!enabled);
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
// 懒加载：commands 服务仅在首次调用时 require，避免启动时同步加载 JSON 文件
let _commands = null;
function getCommands() {
  if (!_commands) _commands = require('./services/commands');
  return _commands;
}
ipcMain.handle('commands:get', async () => {
  return getCommands().getCategories();
});
ipcMain.handle('commands:add-category', async (_e, { name, nameEn }) => {
  return getCommands().addCategory(name, nameEn);
});
ipcMain.handle('commands:update-category', async (_e, { id, name, nameEn }) => {
  return getCommands().updateCategory(id, name, nameEn);
});
ipcMain.handle('commands:delete-category', async (_e, { id }) => {
  getCommands().deleteCategory(id);
  return { ok: true };
});
ipcMain.handle('commands:add-command', async (_e, { categoryId, command, description, descriptionEn }) => {
  return getCommands().addCommand(categoryId, command, description, descriptionEn);
});
ipcMain.handle('commands:update-command', async (_e, { categoryId, commandId, command, description, descriptionEn }) => {
  return getCommands().updateCommand(categoryId, commandId, command, description, descriptionEn);
});
ipcMain.handle('commands:delete-command', async (_e, { categoryId, commandId }) => {
  getCommands().deleteCommand(categoryId, commandId);
  return { ok: true };
});
ipcMain.handle('commands:reset', async () => {
  return getCommands().resetToDefault();
});

// ── 窗口标题栏主题（跟随应用而非系统） ──────────────
// 启动时从持久化设置恢复（替换原硬编码 'dark'）
nativeTheme.themeSource = settingsService.loadSettings().theme_mode || 'dark';

// 修复：原实现把字符串模式当布尔值，导致选 light/system 仍被强制为 dark
ipcMain.handle('theme:set', (_e, mode) => {
  const valid = ['dark', 'light', 'system'].includes(mode) ? mode : 'dark';
  nativeTheme.themeSource = valid;
  settingsService.saveSettings({ theme_mode: valid });
  const isDark = nativeTheme.shouldUseDarkColors;
  // 广播给主窗口 + 悬浮窗，保持同步
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('theme:changed', { mode: valid, isDark });
  }
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.webContents.send('theme:changed', { mode: valid, isDark });
  }
  if (ballWindow && !ballWindow.isDestroyed()) {
    ballWindow.webContents.send('theme:changed', { mode: valid, isDark });
  }
  // 主题切换影响菜单图标着色，刷新菜单
  menuIconCache.clear();
  refreshAll().catch(() => {});
  return { mode: valid, isDark };
});

// 供悬浮窗启动时拉取当前主题
ipcMain.handle('theme:get', () => ({
  mode: settingsService.loadSettings().theme_mode || 'dark',
  isDark: nativeTheme.shouldUseDarkColors,
}));

// ═══════════════════════════════════════════════════════
// ── 单实例锁 ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // 已有实例在运行，等 app ready 后再弹窗提示并退出
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({
      type: 'info',
      title: 'Conda NAV',
      message: 'Conda NAV 正在运行，无法重复运行',
      detail: 'Conda NAV 已在后台运行。您可以点击系统托盘图标或按 Ctrl+Shift+C 打开主窗口。',
      buttons: ['确定'],
    });
    app.quit();
  });
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
  console.log(`[boot] app ready: ${Date.now() - BOOT_T0}ms`);

  // 从持久化设置恢复激活环境（同步，命中缓存，极快）
  state.init();

  const settings = settingsService.loadSettings();
  const showOnReady = !(settings.auto_start && settings.silent_start);

  // 1. 优先创建主窗口并开始加载（最耗时的 loadURL/loadFile 尽早启动）
  createWindow({ showOnReady });
  console.log(`[boot] main window created: ${Date.now() - BOOT_T0}ms`);

  // 2. 下一帧创建托盘 + 悬浮球（不阻塞主窗口首次渲染）
  setImmediate(() => {
    createTray();
    // createTray 内的 refreshAll 会异步执行 conda 命令，不阻塞此处
    if (settings.ball_visible !== false) {
      showBall();
    }
  });

  // 3. 再下一帧启动 HTTP API + 同步自启设置
  setImmediate(() => {
    httpApi.start();
    if (settings.auto_start) {
      autoStart.setAutoStart(app, __dirname, true);
    }
  });

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
