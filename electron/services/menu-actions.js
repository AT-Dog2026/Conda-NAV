// ═══════════════════════════════════════════════════════
// 菜单动作单一数据源
// 原生右键菜单 / 悬浮窗 / 悬浮窗内 context menu 三处共享
// ═══════════════════════════════════════════════════════

const handlers = require('./handlers');
const state = require('./state');
const settings = require('./settings');
const { clipboard } = require('electron');

// 切换环境子菜单上限（超出显示「更多环境…」打开主窗口）
const SWITCH_ENV_MAX = 50;

/**
 * 构建菜单动作列表（异步，因为要拉环境列表）。
 * @param {object} ctx - 暴露给 handler 的上下文：
 *   { mainWindow, floatingWindow, tray, refreshAll, openFloatingWidget,
 *     hideFloatingWidget, toggleFloatingWidget, isFloatingVisible,
 *     showBall, hideBall, toggleBall, isBallVisible }
 * @returns {Promise<Array<ActionDescriptor>>}
 */
async function buildMenuActions(ctx) {
  const activated = state.getActivatedEnv();
  const s = settings.loadSettings();
  const projectDir = s.project_dir || '';

  let envNames = [];
  try {
    const envs = await handlers.getEnvNames();
    envNames = envs.map(e => e.name);
  } catch { /* 使用空列表 */ }

  const actions = [];

  // ── A. 状态 + 环境（最顶部） ─────────────────────────
  actions.push({
    id: 'status-activated',
    label: activated ? `当前激活: ${activated}` : '未激活环境',
    labelKey: activated ? 'tray.statusActivated' : 'tray.statusNone',
    labelParams: activated ? { env: activated } : {},
    category: 'status',
    icon: activated ? 'dot-circle-active' : 'dot-circle',
    frequency: 'info',
    separatorBefore: false,
    enabled: false,           // 原生菜单中作为信息展示项
    isStatus: true,
    activated,
    handler: null,            // 信息项不可点击
  });

  // 切换环境：子菜单
  const switchSubActions = [];
  if (envNames.length === 0) {
    switchSubActions.push({
      id: 'switch-env-empty',
      label: '(无环境)',
      labelKey: 'tray.noEnvs',
      category: 'env',
      icon: null,
      enabled: false,
      handler: null,
    });
  } else {
    for (const name of envNames.slice(0, SWITCH_ENV_MAX)) {
      switchSubActions.push({
        id: `switch-env:${name}`,
        label: name,
        category: 'env',
        icon: null,
        type: 'radio',
        checked: name === activated,
        handler: async () => {
          try {
            await handlers.activateEnvironment(name);
            if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
              ctx.mainWindow.webContents.send('tray:env-activated', name);
            }
            await ctx.refreshAll?.();
          } catch { /* ignore */ }
        },
      });
    }
    if (envNames.length > SWITCH_ENV_MAX) {
      switchSubActions.push({
        id: 'switch-env-more',
        label: `更多环境… (+${envNames.length - SWITCH_ENV_MAX})`,
        labelKey: 'tray.moreEnvs',
        labelParams: { count: envNames.length - SWITCH_ENV_MAX },
        category: 'env',
        icon: 'chevron',
        handler: () => {
          ctx.showMain?.('envs');
        },
      });
    }
  }

  actions.push({
    id: 'switch-env',
    label: '切换环境',
    labelKey: 'tray.switchEnv',
    category: 'env',
    icon: 'swap',
    frequency: 'high',
    submenu: switchSubActions,
    handler: null,
  });

  actions.push({
    id: 'open-terminal',
    label: activated ? `用终端打开 - ${activated}` : '用终端打开',
    labelKey: 'tray.openTerminal',
    labelParams: activated ? { env: activated } : {},
    category: 'env',
    icon: 'terminal',
    frequency: 'high',
    enabled: !!activated,
    handler: async () => {
      if (!activated) return;
      try { await handlers.openTerminal(activated); } catch { /* ignore */ }
    },
  });

  // 在项目目录打开终端（仅当 project_dir 已设置）
  if (projectDir && activated) {
    actions.push({
      id: 'open-project-terminal',
      label: `在项目目录打开终端 - ${activated}`,
      labelKey: 'tray.openProjectTerminal',
      labelParams: { env: activated },
      category: 'env',
      icon: 'folder-terminal',
      frequency: 'high',
      handler: async () => {
        try { await handlers.openProjectTerminal(activated, projectDir); } catch { /* ignore */ }
      },
    });
  }

  // 打开环境目录
  if (activated) {
    actions.push({
      id: 'open-env-folder',
      label: `打开环境目录 - ${activated}`,
      labelKey: 'tray.openEnvFolder',
      labelParams: { env: activated },
      category: 'env',
      icon: 'folder',
      frequency: 'medium',
      handler: async () => {
        try {
          const envs = await handlers.getEnvNames();
          const env = envs.find(e => e.name === activated);
          if (env && env.path) {
            const { shell } = require('electron');
            shell.openPath(env.path);
          }
        } catch { /* ignore */ }
      },
    });
  }

  // 复制激活命令
  if (activated) {
    actions.push({
      id: 'copy-activate-cmd',
      label: `复制激活命令 - conda activate ${activated}`,
      labelKey: 'tray.copyActivateCmd',
      labelParams: { env: activated },
      category: 'env',
      icon: 'copy',
      frequency: 'medium',
      handler: () => {
        try { clipboard.writeText(`conda activate ${activated}`); } catch { /* ignore */ }
      },
    });
  }

  // ── B. 窗口控制（中间） ─────────────────────────────
  actions.push({
    id: 'show-main',
    label: '显示主窗口',
    labelKey: 'tray.showMain',
    category: 'window',
    icon: 'window',
    frequency: 'medium',
    separatorBefore: true,
    handler: () => ctx.showMain?.(),
  });
  actions.push({
    id: 'toggle-ball',
    label: ctx.isBallVisible?.() ? '隐藏悬浮球' : '显示悬浮球',
    labelKey: ctx.isBallVisible?.() ? 'tray.hideBall' : 'tray.openBall',
    category: 'window',
    icon: 'dot-circle',
    frequency: 'medium',
    handler: () => ctx.toggleBall?.(),
  });

  // ── C. 系统（底部） ────────────────────────────────
  actions.push({
    id: 'quit',
    label: '退出',
    labelKey: 'tray.quit',
    category: 'system',
    icon: 'close',
    frequency: 'low',
    separatorBefore: true,
    handler: () => {
      const { app } = require('electron');
      app.isQuitting = true;
      app.quit();
    },
  });

  return actions;
}

/**
 * 把动作列表转换为可序列化形式（剥离 handler / type 等不可克隆字段）。
 * icon 字段由 main.js 的 getMenuIcon 在序列化时填充为 base64 dataURL。
 */
function serializeForRenderer(actions, iconResolver) {
  const out = [];
  for (const a of actions) {
    if (a.visible === false) continue;
    const item = {
      id: a.id,
      label: a.label,
      labelKey: a.labelKey || null,
      labelParams: a.labelParams || {},
      category: a.category,
      icon: a.icon ? (iconResolver ? iconResolver(a.icon) : null) : null,
      iconKey: a.icon || null,
      frequency: a.frequency || 'medium',
      enabled: a.enabled !== false,
      isStatus: !!a.isStatus,
      activated: a.activated || null,
      checked: !!a.checked,
      type: a.type || null,
      separatorBefore: !!a.separatorBefore,
      submenu: a.submenu ? serializeForRenderer(a.submenu, iconResolver) : null,
    };
    out.push(item);
  }
  return out;
}

/**
 * 按 id 查找并执行动作。
 * 支持子菜单项 id（如 "switch-env:myenv"）。
 */
async function invokeAction(actions, id, payload, ctx) {
  for (const a of actions) {
    if (a.id === id) {
      if (a.handler) return await a.handler(ctx, payload);
      return null;
    }
    if (a.submenu) {
      const r = await invokeAction(a.submenu, id, payload, ctx);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

module.exports = {
  buildMenuActions,
  serializeForRenderer,
  invokeAction,
  SWITCH_ENV_MAX,
};
