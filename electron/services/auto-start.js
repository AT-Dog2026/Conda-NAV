// ═══════════════════════════════════════════════════════
// 开机自启管理（Windows Startup 文件夹快捷方式方案）
//
// 使用 .lnk 快捷方式替代 setLoginItemSettings 的注册表方案，
// 以便任务管理器「启动」页正确显示应用名称和图标。
// ═══════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const SHORTCUT_NAME = 'Conda NAV.lnk';

/**
 * 获取 Windows 启动文件夹路径
 * %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
 */
function getStartupFolderPath(app) {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function getShortcutPath(app) {
  return path.join(getStartupFolderPath(app), SHORTCUT_NAME);
}

/**
 * 解析快捷方式使用的图标路径
 * - 开发模式：使用项目根目录的 icon.ico（electron.exe 没有应用图标）
 * - 打包模式：直接用 exe 路径（electron-builder 已将 icon.ico 嵌入 exe）
 *   注意：不能用 asar 内的 icon.ico，Windows 快捷方式无法读取 asar 路径
 */
function resolveIconPath(app, electronDir) {
  if (!app.isPackaged) {
    const projectIcon = path.join(electronDir, '..', 'icon.ico');
    if (fs.existsSync(projectIcon)) return projectIcon;
  }
  return app.getPath('exe');
}

/**
 * PowerShell 单引号字符串转义：将 ' 替换为 ''
 * 单引号字符串在 PowerShell 中是字面量，不进行变量展开，最安全
 */
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * 创建或移除开机自启快捷方式
 * @param {Electron.App} app       Electron app 实例
 * @param {string}       electronDir __dirname（electron 目录绝对路径）
 * @param {boolean}      enabled    是否启用自启
 * @returns {Promise<{ success: boolean, fallback?: boolean }>}
 */
async function setAutoStart(app, electronDir, enabled) {
  const shortcutPath = getShortcutPath(app);

  // 始终清理旧的注册表自启条目（从 setLoginItemSettings 迁移）
  app.setLoginItemSettings({ openAtLogin: false });

  if (!enabled) {
    if (fs.existsSync(shortcutPath)) {
      try { fs.unlinkSync(shortcutPath); } catch { /* ignore */ }
    }
    return { success: true };
  }

  // 若快捷方式已存在，先删除再重建，确保配置最新
  if (fs.existsSync(shortcutPath)) {
    try { fs.unlinkSync(shortcutPath); } catch { /* ignore */ }
  }

  const exePath = app.getPath('exe');
  const iconPath = resolveIconPath(app, electronDir);
  let args = '';

  // 开发模式：electron.exe 需要项目根目录路径作为参数
  if (!app.isPackaged) {
    args = path.join(electronDir, '..');
  }

  // 使用 PowerShell + WScript.Shell COM 对象创建 .lnk 快捷方式
  const psScript = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$s = $ws.CreateShortcut(${psQuote(shortcutPath)})`,
    `$s.TargetPath = ${psQuote(exePath)}`,
    `$s.Arguments = ${psQuote(args)}`,
    `$s.IconLocation = ${psQuote(iconPath)}`,
    `$s.WorkingDirectory = ${psQuote(path.dirname(exePath))}`,
    '$s.Save()',
  ].join('\n');

  const { execFile } = require('child_process');

  return new Promise((resolve) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', psScript,
    ], { windowsHide: true }, (err) => {
      if (err) {
        // 快捷方式创建失败时回退到 setLoginItemSettings
        app.setLoginItemSettings({
          openAtLogin: true,
          path: exePath,
          args: args ? [args] : [],
        });
        resolve({ success: true, fallback: true });
      } else {
        resolve({ success: true });
      }
    });
  });
}

/**
 * 检查自启快捷方式是否存在
 */
function isAutoStartEnabled(app) {
  return fs.existsSync(getShortcutPath(app));
}

module.exports = { setAutoStart, isAutoStartEnabled, getShortcutPath };
