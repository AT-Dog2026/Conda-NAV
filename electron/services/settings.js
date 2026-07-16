const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { readCondarc } = require('./condarc');

// ── 配置文件路径 ─────────────────────────────────────
const isWin = process.platform === 'win32';
const settingsDir = isWin
  ? path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), 'CondaNAV')
  : path.join(require('os').homedir(), '.conda-nav');

const settingsFile = path.join(settingsDir, 'settings.json');

// 确保目录存在
if (!fs.existsSync(settingsDir)) {
  fs.mkdirSync(settingsDir, { recursive: true });
}

// ── 内存缓存（避免启动时重复 I/O 和路径扫描）───────
let _settingsCache = null;
let _autoDetectCondaCache;
let _autoDetectCondaTime = 0;
let _autoDetectMambaCache;
let _autoDetectMambaTime = 0;
const DETECT_CACHE_TTL = 30000;

function invalidateSettingsCache() { _settingsCache = null; }

// ── 加载 / 保存 ──────────────────────────────────────
function loadSettings() {
  if (_settingsCache) return _settingsCache;
  try {
    if (fs.existsSync(settingsFile)) {
      const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      // 兼容旧版本配置：缺失字段自动补默认值
      _settingsCache = {
        conda_path: raw.conda_path ?? '',
        mamba_path: raw.mamba_path ?? '',
        onboarding_completed: raw.onboarding_completed ?? false,
        project_dir: raw.project_dir ?? '',
        calc_env_size: raw.calc_env_size ?? false,
        calc_timeout_sec: normalizeCalcTimeoutSec(raw.calc_timeout_sec),
        auto_start: raw.auto_start ?? false,
        silent_start: raw.silent_start ?? false,
        basic_op_mode: raw.basic_op_mode ?? 'terminal',
        activated_env: raw.activated_env ?? null,
        projects: Array.isArray(raw.projects) ? raw.projects : [],
      };
      return _settingsCache;
    }
  } catch { /* ignore */ }
  _settingsCache = {
    conda_path: '',
    mamba_path: '',
    onboarding_completed: false,
    project_dir: '',
    calc_env_size: false,
    calc_timeout_sec: 30,
    auto_start: false,
    silent_start: false,
    basic_op_mode: 'terminal',
    activated_env: null,
    projects: [],
  };
  return _settingsCache;
}

// 把任意输入归一化为合法的「计算超时秒数」：默认 30，范围 [5, 300]
function normalizeCalcTimeoutSec(raw) {
  const def = 30;
  if (raw === null || raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(300, Math.max(5, Math.round(n)));
}

function saveSettings(data) {
  invalidateSettingsCache();
  const current = loadSettings();
  fs.writeFileSync(settingsFile, JSON.stringify({
    conda_path: data.conda_path ?? current.conda_path ?? '',
    mamba_path: data.mamba_path ?? current.mamba_path ?? '',
    onboarding_completed: data.onboarding_completed ?? current.onboarding_completed ?? false,
    project_dir: data.project_dir ?? current.project_dir ?? '',
    calc_env_size: data.calc_env_size ?? current.calc_env_size ?? false,
    calc_timeout_sec: normalizeCalcTimeoutSec(data.calc_timeout_sec ?? current.calc_timeout_sec),
    auto_start: data.auto_start ?? current.auto_start ?? false,
    silent_start: data.silent_start ?? current.silent_start ?? false,
    basic_op_mode: data.basic_op_mode ?? current.basic_op_mode ?? 'terminal',
    activated_env: data.activated_env !== undefined ? data.activated_env : (current.activated_env ?? null),
    projects: data.projects !== undefined ? data.projects : (current.projects ?? []),
  }, null, 2), 'utf-8');
  // 写入后再次清缓存，确保后续读取命中磁盘最新数据
  invalidateSettingsCache();
}

function condaExeCandidates(condaRoot) {
  if (!condaRoot) return [];
  return [
    path.join(condaRoot, 'Scripts', 'conda.exe'),
    path.join(condaRoot, 'condabin', 'conda.bat'),
    path.join(condaRoot, 'bin', 'conda'),
  ];
}

function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return path.resolve(p);
  }
  return '';
}

// ── 自动探测 ─────────────────────────────────────────
function autoDetectConda() {
  const now = Date.now();
  if (_autoDetectCondaCache !== undefined && now - _autoDetectCondaTime < DETECT_CACHE_TTL) {
    return _autoDetectCondaCache;
  }

  let result = '';

  // 1) 环境变量
  for (const key of ['CONDA_EXE', 'CONDA_PREFIX']) {
    const val = process.env[key];
    if (!val) continue;
    const candidate = key === 'CONDA_PREFIX'
      ? path.join(val, 'Scripts', 'conda.exe')
      : val;
    if (fs.existsSync(candidate)) { result = path.resolve(candidate); break; }
  }
  if (result) { _autoDetectCondaCache = result; _autoDetectCondaTime = now; return result; }

  // 2) .condarc root_prefix
  const condarc = readCondarc();
  if (condarc.root_prefix) {
    const fromRoot = firstExisting(condaExeCandidates(condarc.root_prefix));
    if (fromRoot) { _autoDetectCondaCache = fromRoot; _autoDetectCondaTime = now; return fromRoot; }
  }

  // 3) 常见路径
  const home = require('os').homedir();
  const folders = ['anaconda3', 'miniconda3', 'Anaconda3', 'Miniconda3', 'miniforge3', 'Miniforge3'];
  const roots = ['C:\\', 'D:\\', 'E:\\', home, 'C:\\ProgramData', 'C:\\Program Files'];

  for (const folder of folders) {
    for (const root of roots) {
      const candidate = path.join(root, folder, 'Scripts', 'conda.exe');
      if (fs.existsSync(candidate)) { result = path.resolve(candidate); break; }
    }
    if (result) break;
  }
  if (result) { _autoDetectCondaCache = result; _autoDetectCondaTime = now; return result; }

  // 4) envs_dirs 的父目录推断 conda 根
  for (const dir of condarc.envs_dirs) {
    const parent = path.dirname(dir);
    const fromParent = firstExisting(condaExeCandidates(parent));
    if (fromParent) { _autoDetectCondaCache = fromParent; _autoDetectCondaTime = now; return fromParent; }
  }

  // 5) which
  try {
    const result = require('child_process').execSync('where conda 2>nul', { encoding: 'utf-8' }).trim();
    if (result) {
      const found = result.split('\n')[0].trim();
      _autoDetectCondaCache = found;
      _autoDetectCondaTime = now;
      return found;
    }
  } catch { /* ignore */ }

  _autoDetectCondaCache = '';
  _autoDetectCondaTime = now;
  return '';
}

function autoDetectMamba(condaPath) {
  const now = Date.now();
  if (_autoDetectMambaCache !== undefined && now - _autoDetectMambaTime < DETECT_CACHE_TTL) {
    return _autoDetectMambaCache;
  }

  const condaDir = path.dirname(condaPath);
  if (condaDir) {
    for (const name of ['mamba.exe', 'micromamba.exe']) {
      const candidate = path.join(condaDir, name);
      if (fs.existsSync(candidate)) {
        _autoDetectMambaCache = path.resolve(candidate);
        _autoDetectMambaTime = now;
        return _autoDetectMambaCache;
      }
    }
  }
  try {
    const result = require('child_process').execSync('where mamba 2>nul', { encoding: 'utf-8' }).trim();
    if (result) {
      _autoDetectMambaCache = result.split('\n')[0].trim();
      _autoDetectMambaTime = now;
      return _autoDetectMambaCache;
    }
  } catch { /* ignore */ }
  _autoDetectMambaCache = '';
  _autoDetectMambaTime = now;
  return '';
}

// ── 获取设置（含自动探测） ──────────────────────────
function getSettings() {
  const settings = loadSettings();
  if (!settings.conda_path) settings.conda_path = autoDetectConda();
  if (!settings.mamba_path) settings.mamba_path = autoDetectMamba(settings.conda_path);
  return settings;
}

// ── 返回可用的 conda 命令 ──────────────────────────
function getCondaCmd() {
  const settings = getSettings();

  // 优先 mamba
  if (settings.mamba_path && fs.existsSync(settings.mamba_path)) {
    return settings.mamba_path;
  }
  if (settings.conda_path && fs.existsSync(settings.conda_path)) {
    return settings.conda_path;
  }

  // 从 PATH 找
  try {
    const mamba = require('child_process').execSync('where mamba 2>nul', { encoding: 'utf-8' }).trim();
    if (mamba) return mamba.split('\n')[0].trim();
  } catch { /* ignore */ }
  try {
    const conda = require('child_process').execSync('where conda 2>nul', { encoding: 'utf-8' }).trim();
    if (conda) return conda.split('\n')[0].trim();
  } catch { /* ignore */ }

  return 'conda';
}

// ── 测试 conda 路径 ─────────────────────────────────
function testCondaPath(testPath) {
  if (!testPath || !fs.existsSync(testPath)) {
    return Promise.resolve({ ok: false, info: '文件不存在' });
  }
  return new Promise((resolve) => {
    execFile(testPath, ['--version'], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        const code = err.killed ? '超时' : (err.message || '执行失败');
        resolve({ ok: false, info: code });
        return;
      }
      const ver = (stdout || stderr || '').trim();
      resolve({ ok: true, info: ver });
    });
  });
}

async function checkCondaStatus() {
  const settings = loadSettings();
  const condaPath = settings.conda_path || autoDetectConda();
  const mambaPath = settings.mamba_path || autoDetectMamba(condaPath);

  if (!condaPath || !fs.existsSync(condaPath)) {
    return {
      ready: false,
      conda_path: condaPath || '',
      mamba_path: mambaPath || '',
      conda_ok: false,
      conda_info: '未找到 conda，请安装 Anaconda/Miniconda 或在设置中指定路径',
      needs_onboarding: !settings.onboarding_completed,
    };
  }

  const test = await testCondaPath(condaPath);
  return {
    ready: test.ok,
    conda_path: condaPath,
    mamba_path: mambaPath,
    conda_ok: test.ok,
    conda_info: test.info,
    needs_onboarding: !settings.onboarding_completed || !test.ok,
  };
}

// ── 激活环境持久化 ──────────────────────────────────
function getActivatedEnv() {
  return loadSettings().activated_env || null;
}

function setActivatedEnv(name) {
  saveSettings({ activated_env: name || null });
}

// ── 项目 CRUD ────────────────────────────────────────
function generateId() {
  return 'proj-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function getProjects() {
  return loadSettings().projects || [];
}

function addProject({ name, path: projPath, boundEnv = '' }) {
  if (!name || !projPath) throw new Error('项目名称和路径不能为空');
  const projects = getProjects();
  if (projects.some(p => p.name === name)) throw new Error('项目名称已存在');
  const project = { id: generateId(), name, path: projPath, boundEnv };
  projects.push(project);
  saveSettings({ projects });
  return project;
}

function updateProject(id, updates) {
  const projects = getProjects();
  const idx = projects.findIndex(p => p.id === id);
  if (idx === -1) throw new Error('项目不存在');
  // 如果修改了名称，检查是否与其他项目重名
  if (updates.name && updates.name !== projects[idx].name) {
    if (projects.some(p => p.id !== id && p.name === updates.name)) throw new Error('项目名称已存在');
  }
  projects[idx] = { ...projects[idx], ...updates };
  saveSettings({ projects });
  return projects[idx];
}

function deleteProject(id) {
  const projects = getProjects();
  const idx = projects.findIndex(p => p.id === id);
  if (idx === -1) throw new Error('项目不存在');
  projects.splice(idx, 1);
  saveSettings({ projects });
}

module.exports = {
  settingsFile,
  settingsDir,
  loadSettings,
  saveSettings,
  getSettings,
  getCondaCmd,
  autoDetectConda,
  autoDetectMamba,
  testCondaPath,
  checkCondaStatus,
  normalizeCalcTimeoutSec,
  getActivatedEnv,
  setActivatedEnv,
  getProjects,
  addProject,
  updateProject,
  deleteProject,
};
