const path = require('path');
const conda = require('./conda');
const settings = require('./settings');

const tasks = new Map();
const queue = [];
let processing = false;
let mainWindow = null;

const TASK_RETENTION_MS = 30 * 60 * 1000;
const MAX_TASKS = 100;

function setMainWindow(win) { mainWindow = win; }

function pushUpdate(task) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 移除不可序列化的属性（_procHolder 包含子进程对象）
    const cleanTask = { ...task };
    delete cleanTask._procHolder;
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
  const task = {
    task_id: taskId,
    task_type: type,
    status: 'pending',
    progress: 0,
    message: '排队中...',
    created_at: new Date().toISOString(),
    finished_at: null,
  };
  tasks.set(taskId, task);
  queue.push({ taskId, type, params, task, onComplete });
  pushUpdate(task);
  processQueue();
  return taskId;
}

async function processQueue() {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const item = queue.shift();
    await processTask(item.taskId, item.type, item.params, item.task);
    if (item.onComplete) item.onComplete();
    cleanupOldTasks();
  }

  processing = false;
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

  try {
    const condaExe = settings.getCondaCmd();
    const procHolder = { proc: null };
    task._procHolder = procHolder;

    update(5, `开始执行 ${type} 操作...`, 'running');

    if (type === 'create') {
      const { name } = params;
      const pyVer = params.python_version || '3.12';
      update(20, `正在创建环境 '${name}'...`);
      const { ok, msg } = await conda.createEnvironment(condaExe, name, pyVer, procHolder);
      update(ok ? 100 : 0, msg, ok ? 'completed' : 'failed');

    } else if (type === 'clone') {
      const { source, target } = params;
      update(20, `正在克隆 '${source}' -> '${target}'...`);
      const { ok, msg } = await conda.cloneEnvironment(condaExe, source, target, procHolder);
      update(ok ? 100 : 0, msg, ok ? 'completed' : 'failed');

    } else if (type === 'delete') {
      const { name } = params;
      update(30, `正在删除环境 '${name}'...`);
      const { ok, msg } = await conda.removeEnvironment(condaExe, name, procHolder);
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
      } else {
        update(ok ? 100 : 0, msg, ok ? 'completed' : 'failed');
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
      const { ok, msg } = await conda.installPackage(condaExe, envPath, name, pkg, manager, procHolder);
      update(ok ? 100 : 0, msg, ok ? 'completed' : 'failed');

    } else if (type === 'uninstall') {
      const { name, package: pkg, manager } = params;
      update(30, `正在卸载 '${pkg}' (${manager}) 从 '${name}'...`);
      const envPath = await resolveEnvPath(name);
      const { ok, msg } = await conda.uninstallPackage(condaExe, envPath, name, pkg, manager, procHolder);
      update(ok ? 100 : 0, msg, ok ? 'completed' : 'failed');

    } else if (type === 'upgrade') {
      const { name, package: pkg, manager } = params;
      update(15, `正在升级 '${pkg}' (${manager}) 在 '${name}'...`);
      const envPath = await resolveEnvPath(name);
      const { ok, msg } = await conda.upgradePackage(condaExe, envPath, name, pkg, manager, procHolder);
      update(ok ? 100 : 0, msg, ok ? 'completed' : 'failed');

    } else if (type === 'import') {
      const { file, name } = params;
      update(15, `正在从 yml 导入环境 '${name}'...`);
      const { ok, msg } = await conda.importEnv(condaExe, file, name, procHolder);
      update(ok ? 100 : 0, msg, ok ? 'completed' : 'failed');

    } else if (type === 'import-req') {
      const { file, name, python_version } = params;
      const pyVer = python_version || '3.12';
      update(10, `正在创建环境 '${name}' (Python ${pyVer})...`);
      const { ok, msg } = await conda.importFromRequirements(condaExe, file, name, pyVer, procHolder);
      update(ok ? 100 : 0, msg, ok ? 'completed' : 'failed');

    } else if (type === 'install-req-to-env') {
      const { file, name } = params;
      update(15, `正在在环境 '${name}' 中安装 requirements.txt...`);
      const envPath = await resolveEnvPath(name);
      const { ok, msg } = await conda.installRequirementsToEnv(condaExe, envPath, name, file, procHolder);
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
