const path = require('path');
const conda = require('./conda');
const settings = require('./settings');

const tasks = new Map();
const queue = [];
let processing = false;
let lastActivity = 0;
let currentProcessingId = null;
let mainWindow = null;

const TASK_RETENTION_MS = 30 * 60 * 1000;
const MAX_TASKS = 100;
const QUEUE_STUCK_MS = 15 * 60 * 1000; // 15分钟无活动视为卡死

function setMainWindow(win) { mainWindow = win; }

function pushUpdate(task) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 移除不可序列化的属性（_procHolder 包含子进程对象）
    const cleanTask = { ...task };
    delete cleanTask._procHolder;
    // 保留 _stdout 用于前端展示（限制大小）
    mainWindow.webContents.send('task:update', cleanTask);
  }
}

function cleanupOldTasks() {
  const now = Date.now();
  if (tasks.size <= MAX_TASKS) return;
  for (const [id, task] of tasks) {
    if (task.status === 'completed' || task.status === 'failed') {
      const finished = task.finished_at ? new Date(task.finished_at).getTime() : 0;
      if (finished && now - finished > TASK_RETENTION_MS) {
        tasks.delete(id);
      }
    }
  }
}

function submitTask(type, params, onComplete) {
  const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  // 提取展示用环境名
  let envName = '';
  if (type === 'clone') envName = params.target || '';
  else if (type === 'delete') envName = params.name || '';
  else if (type === 'create' || type === 'install' || type === 'uninstall' || type === 'upgrade' || type === 'import' || type === 'import-req' || type === 'install-req-to-env') {
    envName = params.name || '';
  } else if (type === 'clean-invalid') {
    envName = require('path').basename(params.envPath || '');
  }
  const task = {
    task_id: taskId,
    task_type: type,
    status: 'pending',
    progress: 0,
    message: '排队中...',
    created_at: new Date().toISOString(),
    finished_at: null,
    envName,
  };
  tasks.set(taskId, task);
  queue.push({ taskId, type, params, task, onComplete });
  pushUpdate(task);
  processQueue();
  return taskId;
}

async function processQueue() {
  // 恢复机制：如果上一次处理卡死（15分钟无活动），重置锁
  if (processing && Date.now() - lastActivity > QUEUE_STUCK_MS) {
    console.error('processQueue: detected stuck queue (last activity', Math.round((Date.now() - lastActivity) / 60000), 'min ago), resetting');
    // 将当前卡住的任务标记为失败
    if (currentProcessingId) {
      const t = tasks.get(currentProcessingId);
      if (t && t.status === 'running') {
        t.status = 'failed';
        t.message = '任务超时，进程被强制终止';
        t.finished_at = new Date().toISOString();
        try { if (t._procHolder?.proc) t._procHolder.proc.kill(); } catch {}
        pushUpdate(t);
      }
    }
    processing = false;
    currentProcessingId = null;
  }

  if (processing) return;
  processing = true;
  lastActivity = Date.now();

  try {
    while (queue.length > 0) {
      const item = queue.shift();
      currentProcessingId = item.taskId;
      lastActivity = Date.now();

      try {
        // 每个任务最多执行 15 分钟，超时直接放弃
        const result = await Promise.race([
          processTask(item.taskId, item.type, item.params, item.task),
          new Promise((_, reject) => setTimeout(() => reject(new Error('任务执行超时')), QUEUE_STUCK_MS)),
        ]);
        try { if (item.onComplete) item.onComplete(); } catch (e) { console.error('Task onComplete error:', e.message); }
      } catch (e) {
        console.error('Task processing error:', e.message);
        // 如果超时，尝试杀掉子进程
        const t = tasks.get(item.taskId);
        if (t) {
          try { if (t._procHolder?.proc) t._procHolder.proc.kill(); } catch {}
          if (t.status === 'pending' || t.status === 'running') {
            t.status = 'failed';
            t.message = `任务异常: ${e.message}`;
            t.finished_at = new Date().toISOString();
            pushUpdate(t);
          }
        }
      }
      currentProcessingId = null;
      lastActivity = Date.now();
      cleanupOldTasks();
    }
  } finally {
    processing = false;
    currentProcessingId = null;
  }
}

function getTask(taskId) {
  return tasks.get(taskId) || null;
}

function getAllActiveTasks() {
  const result = [];
  for (const t of tasks.values()) {
    if (t.status === 'running' || t.status === 'pending') result.push(t);
  }
  return result;
}

function getTasksForPoll() {
  const now = Date.now();
  const result = [];
  for (const t of tasks.values()) {
    if (t.status === 'running' || t.status === 'pending') {
      result.push(t);
    } else if (t.finished_at) {
      const elapsed = now - new Date(t.finished_at).getTime();
      if (elapsed < 600000) result.push(t);
    }
  }
  return result;
}

// ── 取消任务 ────────────────────────────────────────────
function cancelTask(taskId) {
  const task = tasks.get(taskId);
  if (!task) return false;

  // 1. 从队列中移除 pending 任务
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].taskId === taskId) {
      queue.splice(i, 1);
      task.status = 'cancelled';
      task.message = '任务已取消';
      task.finished_at = new Date().toISOString();
      pushUpdate(task); // 同步状态到前端
      return true;
    }
  }

  // 2. 如果正在运行，杀掉子进程
  if (task._procHolder && task._procHolder.proc) {
    try { task._procHolder.proc.kill(); } catch {}
    task.status = 'cancelled';
    task.message = '任务已取消';
    task.finished_at = new Date().toISOString();
    pushUpdate(task); // 同步状态到前端
    return true;
  }

  return false;
}

// 根据环境名解析其磁盘路径（包操作需要 -p 指向路径）
async function resolveEnvPath(name) {
  const envs = await conda.listEnvironments(settings.getCondaCmd());
  const env = envs.find((e) => e.name === name);
  if (!env || !env.path) throw new Error(`未找到环境 '${name}'`);
  return env.path;
}

async function processTask(taskId, type, params, task) {
  const update = (progress, message, status = 'running') => {
    task.progress = progress;
    task.message = message;
    task.status = status;
    if (status === 'completed' || status === 'failed') {
      task.finished_at = new Date().toISOString();
    }
    pushUpdate(task);
  };

  // 实时 conda 终端输出收集（过滤 JSON 避免显示包列表）
  const onCmdStdout = (chunk) => {
    if (!task._stdout) task._stdout = '';
    const cleaned = chunk.split('\n')
      .filter(line => {
        const t = line.trim();
        if (!t) return false;                          // 跳过空行
        if (/^\s*[{}\[\],]/.test(line)) return false;  // 跳过 JSON 结构行
        if (/^\s*"\w+":/.test(t)) return false;         // 跳过 JSON 键值对行
        return true;
      })
      .join('\n');
    if (cleaned) {
      task._stdout = (task._stdout + cleaned + '\n').slice(-3000);
      pushUpdate(task);
    }
  };

  try {
    const condaExe = settings.getCondaCmd();
    const procHolder = { proc: null };
    task._procHolder = procHolder;

    update(5, `开始执行 ${type} 操作...`, 'running');

    if (type === 'create') {
      const { name } = params;
      const pyVer = params.python_version || '3.12';
      update(20, `正在创建环境 '${name}'...`);
      const { ok, msg } = await conda.createEnvironment(condaExe, name, pyVer, procHolder, onCmdStdout);
      if (ok) {
        // 验证：确认新环境已在列表中且包含包
        let verified = false;
        try {
          const envsAfter = await conda.listEnvironments(condaExe);
          const newEnv = envsAfter.find(e => e.name === name);
          if (newEnv && newEnv.package_count > 0) {
            update(100, `环境 "${name}" 创建成功 ✓ — ${newEnv.package_count} 个包`, 'completed');
            verified = true;
          }
        } catch {}
        if (!verified) update(100, msg, 'completed');
      } else {
        update(0, msg, 'failed');
      }

    } else if (type === 'clone') {
      const { source, target } = params;
      // 克隆前记录源环境包数量
      let srcPkgCount = -1;
      try {
        const envs = await conda.listEnvironments(condaExe);
        const srcEnv = envs.find(e => e.name === source);
        if (srcEnv) srcPkgCount = srcEnv.packages;
      } catch {}
      update(20, `正在克隆 '${source}' -> '${target}'...`);
      const { ok, msg, prefix } = await conda.cloneEnvironment(condaExe, source, target, procHolder, onCmdStdout);
      if (ok) {
        // 严谨验证：用 conda list -p <path> --json 直接查询
        let verified = false;
        try {
          const verifyPath = prefix || '';
          if (verifyPath) {
            const tgtPkgCount = await conda.getEnvPackageCount(condaExe, verifyPath);
            if (tgtPkgCount > 0) {
              if (srcPkgCount >= 0 && tgtPkgCount === srcPkgCount) {
                update(100, `环境 "${target}" 克隆成功 ✓ — 包数量 ${tgtPkgCount}，与源环境一致`, 'completed');
              } else {
                update(100, `环境 "${target}" 克隆成功 ✓ — ${tgtPkgCount} 个包`, 'completed');
              }
              verified = true;
            }
          }
        } catch {}
        // 回退：用 env list 检测
        if (!verified) {
          try {
            const envsAfter = await conda.listEnvironments(condaExe);
            const tgtEnv = envsAfter.find(e => e.name === target);
            if (tgtEnv && tgtEnv.packages > 0) {
              update(100, `环境 "${target}" 克隆完成 (${tgtEnv.packages} 个包)`, 'completed');
              verified = true;
            }
          } catch {}
        }
        if (!verified) update(100, msg, 'completed');
      } else {
        update(0, msg, 'failed');
      }

    } else if (type === 'delete') {
      const { name } = params;
      update(30, `正在删除环境 '${name}'...`);
      const { ok, msg } = await conda.removeEnvironment(condaExe, name, procHolder, onCmdStdout);
      if (!ok && msg.includes('DirectoryNotACondaEnvironmentError')) {
        let envPath = '';
        try {
          const jsonData = JSON.parse(msg);
          if (jsonData.target_directory) {
            envPath = jsonData.target_directory;
          }
        } catch {
          const pathMatch = msg.match(/target directory:\s*([^\n"]+)/);
          if (pathMatch) {
            envPath = pathMatch[1].trim().replace(/\\\\/g, '\\');
          }
        }
        task.extra = { envPath, canForceDelete: true };
        update(0, msg, 'failed');
      } else if (ok) {
        // 验证：检查环境是否已从列表中消失
        let verified = false;
        try {
          const envsAfter = await conda.listEnvironments(condaExe);
          const stillExists = envsAfter.some(e => e.name === name);
          if (!stillExists) {
            update(100, `环境 "${name}" 已删除 ✓`, 'completed');
            verified = true;
          }
        } catch {}
        if (!verified) update(100, msg, 'completed');
      } else {
        update(0, msg, 'failed');
      }

    } else if (type === 'clean-invalid') {
      const { envPath } = params;
      update(30, `正在清理无效环境目录 '${path.basename(envPath)}'...`);
      const { ok, msg } = conda.cleanInvalidEnvironment(envPath);
      update(ok ? 100 : 0, msg, ok ? 'completed' : 'failed');

    } else if (type === 'install') {
      const { name, package: pkg, manager } = params;
      update(15, `正在安装 '${pkg}' (${manager}) 到 '${name}'...`);
      const envPath = await resolveEnvPath(name);
      const { ok, msg } = await conda.installPackage(condaExe, envPath, name, pkg, manager, procHolder, onCmdStdout);
      update(ok ? 100 : 0, msg, ok ? 'completed' : 'failed');

    } else if (type === 'uninstall') {
      const { name, package: pkg, manager } = params;
      update(30, `正在卸载 '${pkg}' (${manager}) 从 '${name}'...`);
      const envPath = await resolveEnvPath(name);
      const { ok, msg } = await conda.uninstallPackage(condaExe, envPath, name, pkg, manager, procHolder, onCmdStdout);
      update(ok ? 100 : 0, msg, ok ? 'completed' : 'failed');

    } else if (type === 'upgrade') {
      const { name, package: pkg, manager } = params;
      update(15, `正在升级 '${pkg}' (${manager}) 在 '${name}'...`);
      const envPath = await resolveEnvPath(name);
      const { ok, msg } = await conda.upgradePackage(condaExe, envPath, name, pkg, manager, procHolder, onCmdStdout);
      update(ok ? 100 : 0, msg, ok ? 'completed' : 'failed');

    } else if (type === 'import') {
      const { file, name } = params;
      update(15, `正在从 yml 导入环境 '${name}'...`);
      const { ok, msg } = await conda.importEnv(condaExe, file, name, procHolder, onCmdStdout);
      update(ok ? 100 : 0, msg, ok ? 'completed' : 'failed');

    } else if (type === 'import-req') {
      const { file, name, python_version } = params;
      const pyVer = python_version || '3.12';
      update(10, `正在创建环境 '${name}' (Python ${pyVer})...`);
      const { ok, msg } = await conda.importFromRequirements(condaExe, file, name, pyVer, procHolder, onCmdStdout);
      update(ok ? 100 : 0, msg, ok ? 'completed' : 'failed');

    } else if (type === 'install-req-to-env') {
      const { file, name } = params;
      update(15, `正在在环境 '${name}' 中安装 requirements.txt...`);
      const envPath = await resolveEnvPath(name);
      const { ok, msg } = await conda.installRequirementsToEnv(condaExe, envPath, name, file, procHolder, onCmdStdout);
      update(ok ? 100 : 0, msg, ok ? 'completed' : 'failed');

    } else {
      update(0, `未知任务类型: ${type}`, 'failed');
    }
  } catch (e) {
    update(0, `任务异常: ${e.message}`, 'failed');
  }
}

module.exports = {
  setMainWindow,
  submitTask,
  getTask,
  getAllActiveTasks,
  getTasksForPoll,
  cancelTask,
};
