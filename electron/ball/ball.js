// ═══════════════════════════════════════════════════════
// Conda NAV 悬浮球渲染逻辑
// ═══════════════════════════════════════════════════════

const api = window.electron;
if (!api) {
  console.error('preload 未注入 window.electron');
}

// ── 常量 ────────────────────────────────────────────
const LONGPRESS_MS = 500;           // 长按阈值
const CLICK_MOVE_THRESHOLD = 6;     // 判定为拖拽的最大移动像素

// ── 状态 ────────────────────────────────────────────
let pressStart = null;              // { screenX, screenY, time }
let longpressTimer = null;          // 长按定时器
let isDragging = false;
let hasMoved = false;
let isMenuOpen = false;

// ── DOM 引用 ────────────────────────────────────────
const ball = document.getElementById('ball');

// ── 主题 ────────────────────────────────────────────
function applyTheme(mode, isDark) {
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
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

// ── 右键菜单关闭回调 ────────────────────────────────
api?.on('ball:menu-closed', () => {
  isMenuOpen = false;
  ball.classList.remove('menu-open');
});

// ── 主进程轮询检测鼠标释放 ──────────────────────────
// 透明窗口外无法接收 mouseup，主进程检测鼠标静止 300ms 后发送此消息
api?.on('ball:force-drag-end', () => {
  handleDragEnd();
});

// ── 判定是否产生位移 ────────────────────────────────
function hasMovedEnough(start, current) {
  const dx = Math.abs(current.screenX - start.screenX);
  const dy = Math.abs(current.screenY - start.screenY);
  return dx > CLICK_MOVE_THRESHOLD || dy > CLICK_MOVE_THRESHOLD;
}

// ── 清除长按定时器 ──────────────────────────────────
function clearLongpress() {
  if (longpressTimer) {
    clearTimeout(longpressTimer);
    longpressTimer = null;
    ball.classList.remove('longpress-active');
  }
}

// ── 进入拖动状态 ────────────────────────────────────
function enterDrag() {
  isDragging = true;
  hasMoved = true;
  clearLongpress();
  ball.classList.add('dragging');
  // 通知主进程启动轮询（主进程通过 getCursorScreenPoint 获取坐标）
  api?.send('ball:drag-start');
}

// ── 结束拖动状态 ────────────────────────────────────
function handleDragEnd() {
  if (!isDragging) return;
  ball.classList.remove('dragging');
  api?.send('ball:drag-end');
  isDragging = false;
  pressStart = null;
}

// ── 鼠标按下（左键） ────────────────────────────────
function onMouseDown(e) {
  if (e.button !== 0) return;
  pressStart = { screenX: e.screenX, screenY: e.screenY, time: Date.now() };
  hasMoved = false;
  isDragging = false;

  // 显示长按进度环
  ball.classList.add('longpress-active');

  // 启动长按定时器
  longpressTimer = setTimeout(() => {
    // 只有在未产生位移时才进入拖动
    if (!hasMoved && pressStart) {
      enterDrag();
    }
    longpressTimer = null;
  }, LONGPRESS_MS);
}

// ── 鼠标移动 ────────────────────────────────────────
function onMouseMove(e) {
  if (!pressStart) return;

  // 检测位移：一旦移动超过阈值，立即进入拖动状态（无需等待长按动画）
  if (!hasMoved && !isDragging && hasMovedEnough(pressStart, e)) {
    hasMoved = true;
    enterDrag();
    return;
  }

  // 拖动位置更新由主进程轮询处理，渲染进程无需发送 drag-move
}

// ── 鼠标释放 ────────────────────────────────────────
function onMouseUp(e) {
  if (e.button !== 0) return;
  clearLongpress();

  if (isDragging) {
    handleDragEnd();
    return;
  }

  // 未发生位移 + 未进入拖动 = 单击
  if (pressStart && !hasMoved) {
    // 点击反馈动画
    ball.classList.add('clicked');
    setTimeout(() => ball.classList.remove('clicked'), 150);
    // 打开悬浮窗
    api?.invoke('ball:click').catch(() => {});
  }

  pressStart = null;
}

// ── 右键菜单 ────────────────────────────────────────
function onContextMenu(e) {
  e.preventDefault();
  isMenuOpen = true;
  ball.classList.add('menu-open');
  // 菜单关闭由主进程的 menu.popup callback 通知 ball:menu-closed
  api?.invoke('ball:show-context-menu', e.screenX, e.screenY).catch(() => {
    isMenuOpen = false;
    ball.classList.remove('menu-open');
  });
}

// ── 鼠标进入/离开球体（控制窗口穿透） ───────────────
function onMouseEnter() {
  api?.send('ball:mouse-enter');
}
function onMouseLeave() {
  api?.send('ball:mouse-leave');
}

// ── 事件绑定 ────────────────────────────────────────
ball.addEventListener('mousedown', onMouseDown);
ball.addEventListener('mouseenter', onMouseEnter);
ball.addEventListener('mouseleave', onMouseLeave);
window.addEventListener('mousemove', onMouseMove);
window.addEventListener('mouseup', onMouseUp);
ball.addEventListener('contextmenu', onContextMenu);

// 阻止默认拖拽行为
ball.addEventListener('dragstart', (e) => e.preventDefault());

// ── 初始化 ──────────────────────────────────────────
initTheme().catch((e) => console.error('悬浮球主题初始化失败:', e));