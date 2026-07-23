// ═══════════════════════════════════════════════════════
// Conda NAV 悬浮窗渲染逻辑
// ═══════════════════════════════════════════════════════

const api = window.electron;
if (!api) {
  console.error('preload 未注入 window.electron');
}

// ── 状态 ────────────────────────────────────────────
let currentActions = [];
let currentMode = 'panel';      // 'panel' | 'collapsed'
let currentDock = null;         // null | 'top' | 'bottom' | 'left' | 'right'
let isExpanded = false;         // 兼容字段，新模式不再使用
let isDragging = false;
let pressStart = null;
let wasDragging = false;         // 标记刚完成拖动，阻止后续 click 误触发
const MOVE_THRESHOLD_PX = 4;

// ── DOM 引用 ────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const widgetRoot = $('#widgetRoot');
const dragHandle = $('#dragHandle');
const statusBanner = $('#statusBanner');
const statusDot = $('#statusDot');
const statusLabel = $('#statusLabel');
const statusSub = $('#statusSub');
const heroProjectTerminal = $('#heroProjectTerminal');
const heroTerminal = $('#heroTerminal');
const heroMainWindow = $('#heroMainWindow');
const envListSection = $('#envListSection');
const envListScroll = $('#envListScroll');
const actionsList = $('#actionsList');
const closeBtn = $('#closeBtn');
const barExpandBtn = $('#barExpandBtn');

// ── 主题应用 ────────────────────────────────────────
function applyTheme(mode, isDark) {
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  if (mode) document.documentElement.setAttribute('data-theme-mode', mode);
}

async function initTheme() {
  try {
    const { mode, isDark } = await api.invoke('theme:get');
    applyTheme(mode, isDark);
  } catch { applyTheme('dark', true); }
}

api?.on('theme:changed', ({ mode, isDark } = {}) => {
  applyTheme(mode, isDark);
});

// 窗口即将显示时触发淡入动画
// 解决 hide/show 切换时可能出现的闪烁感
api?.on('widget:will-show', () => {
  if (widgetRoot.classList.contains('ready')) {
    widgetRoot.style.opacity = '0';
    widgetRoot.style.transform = 'translateY(-4px) scale(0.98)';
    setTimeout(() => {
      widgetRoot.style.opacity = '';
      widgetRoot.style.transform = '';
    }, 16);
  }
});

// ── 模式切换（panel / collapsed） ────────────────────
function setMode(mode, dock = null) {
  currentMode = mode;
  currentDock = dock;
  document.body.classList.remove('panel', 'collapsed');
  document.body.classList.add(mode);
  if (dock) document.body.setAttribute('data-dock', dock);
  else document.body.removeAttribute('data-dock');
}

api?.on('widget:set-mode', (mode, dock) => {
  setMode(mode, dock);
});
api?.on('widget:set-dock', (dock) => {
  currentDock = dock;
  if (dock) document.body.setAttribute('data-dock', dock);
  else document.body.removeAttribute('data-dock');
});

// ── 渲染 ────────────────────────────────────────────
function groupActions(actions) {
  // 按 category 分组并保留顺序
  const groups = [];
  const seen = new Map();
  for (const a of actions) {
    if (a.category === 'status') continue; // 状态走 banner
    if (!seen.has(a.category)) {
      const g = { category: a.category, items: [] };
      seen.set(a.category, g);
      groups.push(g);
    }
    seen.get(a.category).items.push(a);
  }
  return groups;
}

function actionIcon(action) {
  if (!action.icon) return '';
  return `<img src="${action.icon}" alt="" />`;
}

function renderStatus(action) {
  if (!action) {
    statusBanner.classList.add('none');
    statusLabel.textContent = '未激活环境';
    statusSub.textContent = '';
    return;
  }
  const activated = action.activated;
  statusBanner.classList.toggle('none', !activated);
  statusLabel.textContent = activated ? `当前激活: ${activated}` : '未激活环境';
  statusSub.textContent = activated ? '点击动作快速操作' : '请在主窗口或右键菜单激活';
}

function renderHero(actions) {
  const statusAction = actions.find(a => a.isStatus);
  const activated = statusAction?.activated || null;

  const openTerminal = actions.find(a => a.id === 'open-terminal');
  const openProjectTerminal = actions.find(a => a.id === 'open-project-terminal');

  heroTerminal.disabled = !openTerminal || openTerminal.enabled === false;
  heroProjectTerminal.disabled = !openProjectTerminal || openProjectTerminal.enabled === false;

  heroProjectTerminal.style.display = openProjectTerminal ? '' : 'none';

  // 渲染环境列表（始终显示）
  const switchEnv = actions.find(a => a.id === 'switch-env');
  if (switchEnv && switchEnv.submenu && switchEnv.submenu.length > 0) {
    renderEnvList(switchEnv.submenu, activated);
  } else {
    envListScroll.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'env-item';
    el.style.opacity = '0.5';
    el.innerHTML = `<span class="env-item-dot"></span><span class="env-item-name">未检测到环境</span>`;
    envListScroll.appendChild(el);
  }
}

function renderEnvList(envItems, activated) {
  envListScroll.innerHTML = '';
  for (const item of envItems) {
    if (item.id === 'switch-env-more') {
      const el = document.createElement('div');
      el.className = 'env-item';
      el.innerHTML = `<span class="env-item-dot" style="background:var(--color-info)"></span><span class="env-item-name">${escapeHtml(item.label)}</span>`;
      el.addEventListener('click', () => invokeAction(item.id));
      envListScroll.appendChild(el);
      continue;
    }
    if (item.id === 'switch-env-empty') {
      const el = document.createElement('div');
      el.className = 'env-item';
      el.style.opacity = '0.5';
      el.innerHTML = `<span class="env-item-dot"></span><span class="env-item-name">${escapeHtml(item.label)}</span>`;
      envListScroll.appendChild(el);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'env-item' + (item.checked ? ' active' : '');
    el.innerHTML = `<span class="env-item-dot"></span><span class="env-item-name">${escapeHtml(item.label)}</span>`;
    el.addEventListener('click', () => invokeAction(item.id));
    envListScroll.appendChild(el);
  }
}

function renderActions(actions) {
  actionsList.innerHTML = '';
  // 跳过 status / 已在 hero 的主操作 / 窗口控制项（悬浮窗内无需这些）
  const hiddenIds = new Set([
    'open-terminal', 'open-project-terminal', 'switch-env', 'status-activated',
    'show-main', 'toggle-widget', 'toggle-ball',
  ]);
  const visible = actions.filter(a => !hiddenIds.has(a.id));

  let lastSep = true;
  for (const action of visible) {
    if (action.separatorBefore && !lastSep) {
      const sep = document.createElement('div');
      sep.className = 'widget-separator';
      actionsList.appendChild(sep);
    }
    lastSep = false;

    const btn = document.createElement('button');
    btn.className = 'widget-action';
    btn.disabled = action.enabled === false;
    btn.dataset.id = action.id;
    btn.innerHTML = `
      <span class="widget-action-icon">${actionIcon(action)}</span>
      <span class="widget-action-label">${escapeHtml(action.label)}</span>
    `;
    btn.addEventListener('click', () => invokeAction(action.id));
    actionsList.appendChild(btn);
  }

  if (visible.length === 0) {
    actionsList.innerHTML = `
      <div class="empty-state">
        未检测到 Conda 环境<br/>
        <button data-action="open-settings">打开设置</button>
      </div>
    `;
    const btn = actionsList.querySelector('button[data-action="open-settings"]');
    if (btn) btn.addEventListener('click', () => api?.invoke('widget:show-main', 'settings'));
  }
}

function renderAll(actions) {
  currentActions = actions;
  const statusAction = actions.find(a => a.isStatus);
  renderStatus(statusAction);
  renderHero(actions);
  renderActions(actions);
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── 动作调用 ────────────────────────────────────────
async function invokeAction(id, payload) {
  try {
    await api.invoke('menu:invoke-action', id, payload);
  } catch (e) {
    console.error('动作调用失败:', e);
  }
}

// ── 拉取动作列表 ────────────────────────────────────
async function fetchActions() {
  try {
    const actions = await api.invoke('menu:get-actions');
    if (Array.isArray(actions)) renderAll(actions);
  } catch (e) {
    console.error('拉取菜单动作失败:', e);
  }
}

api?.on('menu:updated', (actions) => {
  if (Array.isArray(actions)) renderAll(actions);
});

// ── 即时拖拽 ────────────────────────────────────────
// 使用绝对坐标偏移方案：拖动开始时记录 offset = cursor - windowPos
// 拖动中用 cursor - offset 直接计算窗口位置，无累积误差
function onMouseDown(e) {
  if (e.button !== 0) return;             // 仅左键
  if (e.target.closest('.widget-header-actions')) return;

  isDragging = false;
  pressStart = { x: e.screenX, y: e.screenY };
}

function onMouseMove(e) {
  if (!pressStart) return;

  if (!isDragging) {
    const dx = Math.abs(e.screenX - pressStart.x);
    const dy = Math.abs(e.screenY - pressStart.y);
    if (dx <= MOVE_THRESHOLD_PX && dy <= MOVE_THRESHOLD_PX) return;
    isDragging = true;
    document.body.classList.add('dragging');
    // 通知主进程进入拖动态，记录初始偏移
    api?.send('widget:drag-start', e.screenX, e.screenY);
    return;
  }

  // 拖动中：发送绝对鼠标坐标，主进程用 offset 计算窗口位置
  api?.send('widget:drag-move', e.screenX, e.screenY);
}

function onMouseUp() {
  if (!pressStart) return;
  if (isDragging) {
    wasDragging = true;
    isDragging = false;
    document.body.classList.remove('dragging');
    api?.send('widget:drag-end');
    setTimeout(() => { wasDragging = false; }, 100);
  }
  pressStart = null;
}

dragHandle.addEventListener('mousedown', onMouseDown);
window.addEventListener('mousemove', onMouseMove);
window.addEventListener('mouseup', onMouseUp);

// 右键 → 弹出 context menu（与托盘一致）
widgetRoot.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api?.invoke('widget:show-context-menu', e.screenX, e.screenY).catch(() => {});
});

// ── 按钮事件 ────────────────────────────────────────
closeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  e.preventDefault();
  document.body.classList.add('closing');
  api?.invoke('widget:close').catch((err) => {
    console.error('关闭悬浮窗失败:', err);
  });
  setTimeout(() => {
    document.body.classList.remove('closing');
  }, 300);
});

heroTerminal.addEventListener('click', (e) => { e.stopPropagation(); invokeAction('open-terminal'); });
heroProjectTerminal.addEventListener('click', (e) => { e.stopPropagation(); invokeAction('open-project-terminal'); });
heroMainWindow.addEventListener('click', (e) => { e.stopPropagation(); api?.invoke('widget:show-main'); });

// 收缩标签：单击 → 展开
barExpandBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  // 拖动刚结束时不触发展开，防止拖动后误放大窗口
  if (wasDragging) return;
  if (currentMode === 'collapsed') {
    // 收缩态点击 → 通知主进程展开
    await api?.invoke('widget:set-mode', 'panel', null).catch(() => {});
    return;
  }
  isExpanded = !isExpanded;
  document.body.classList.toggle('expanded', isExpanded);
  await api?.invoke('widget:set-expanded', isExpanded).catch(() => {});
});

// 收缩态下，整个 widgetRoot 单击也触发展开
widgetRoot.addEventListener('click', (e) => {
  if (wasDragging) return;         // 拖动后不触发展开
  if (currentMode !== 'collapsed') return;
  // 由 barExpandBtn 自己处理，避免双触发
  if (e.target.closest('#barExpandBtn')) return;
  api?.invoke('widget:set-mode', 'panel', null).catch(() => {});
});

// ── 初始化 ──────────────────────────────────────────
async function init() {
  await initTheme();
  await fetchActions();
  // 内容就绪后淡入，避免加载过程中出现白屏/泛白
  // 使用 requestAnimationFrame 确保下一帧渲染时已有完整内容
  requestAnimationFrame(() => {
    widgetRoot.classList.add('ready');
  });
}

init().catch((e) => console.error('悬浮窗初始化失败:', e));
