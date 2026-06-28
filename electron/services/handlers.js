const settings = require('./settings');
const conda = require('./conda');
const tasks = require('./tasks');
const state = require('./state');

const ENV_CACHE_TTL = 30000;
let envListCache = null;
let envListCacheTime = 0;

async function getCachedEnvironments(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && envListCache && now - envListCacheTime < ENV_CACHE_TTL) {
    return envListCache;
  }
  const condaExe = settings.getCondaCmd();
  envListCache = await conda.listEnvironments(condaExe);
  envListCacheTime = now;
  return envListCache;
}

function invalidateEnvCache() {
  envListCache = null;
  envListCacheTime = 0;
}

async function findEnv(name) {
  const envs = await getCachedEnvironments();
  return envs.find((e) => e.name === name) || null;
}

async function listEnvironments() {
  return getCachedEnvironments(true);
}

async function getPackageCount(name) {
  const env = await findEnv(name);
  if (!env) throw new Error(`环境 '${name}' 不存在`);
  // 优先异步读 conda-meta，避免阻塞主进程 IPC
  const meta = await conda.readEnvMetadataFromDiskAsync(env.path);
  if (meta.package_count >= 0) return meta.package_count;
  const condaExe = settings.getCondaCmd();
  return conda.getEnvPackageCount(condaExe, env.path);
}

async function getBatchPackageCounts(names) {
  if (!Array.isArray(names) || names.length === 0) return {};
  const envs = await getCachedEnvironments();
  const condaExe = settings.getCondaCmd();
  const result = {};
  for (const name of names) {
    const env = envs.find((e) => e.name === name);
    if (!env) {
      result[name] = -1;
      continue;
    }
    result[name] = await conda.getEnvPackageCount(condaExe, env.path);
  }
  return result;
}

async function getPythonVersion(name) {
  const env = await findEnv(name);
  if (!env) throw new Error(`环境 '${name}' 不存在`);
  return conda.getPythonVersion(env.path);
}

function createEnvironment({ name, python_version = '3.12' }) {
  const err = conda.validateNewEnvName(name);
  if (err) throw new Error(err);
  return tasks.submitTask('create', { name, python_version }, invalidateEnvCache);
}

function cloneEnvironment({ source, target }) {
  if (!source) throw new Error('源环境不能为空');
  const err = conda.validateNewEnvName(target);
  if (err) throw new Error(err);
  if (source.toLowerCase() === target.toLowerCase()) {
    throw new Error('源环境和目标环境不能相同');
  }
  return tasks.submitTask('clone', { source, target }, invalidateEnvCache);
}

function deleteEnvironment({ name, confirm }) {
  const err = conda.validateNewEnvName(name);
  if (err) throw new Error(err);
  if ((confirm || '').toLowerCase() !== name.toLowerCase()) {
    throw new Error('确认名称不匹配，删除取消');
  }
  return tasks.submitTask('delete', { name }, invalidateEnvCache);
}

function cleanInvalidEnvironment({ envPath }) {
  // 清理无效环境目录（无 conda-meta）
  return tasks.submitTask('clean-invalid', { envPath }, invalidateEnvCache);
}

function getActivateCmd(name) {
  return `conda activate ${name}`;
}

async function activateEnvironment(name) {
  if (!name) throw new Error('环境名不能为空');
  const env = await findEnv(name);
  if (!env) throw new Error(`环境 '${name}' 不存在`);
  state.setActivatedEnv(name);
  return { success: true, message: `环境 '${name}' 已标记为激活`, activated_env: name };
}

function getActivated() {
  return { activated_env: state.getActivatedEnv() };
}

async function openTerminal(name) {
  if (!name) throw new Error('环境名不能为空');
  const env = await findEnv(name);
  if (!env) throw new Error(`环境 '${name}' 不存在`);
  const condaExe = settings.getCondaCmd();
  const result = conda.openTerminal(condaExe, env.path, name);
  if (!result.ok) throw new Error(result.msg);
  return result;
}

function autoDetectSettings() {
  const condaPath = settings.autoDetectConda();
  const mambaPath = settings.autoDetectMamba(condaPath);
  return { conda_path: condaPath, mamba_path: mambaPath };
}

function checkCondaStatus() {
  return settings.checkCondaStatus();
}

function completeOnboarding(data = {}) {
  const current = settings.loadSettings();
  settings.saveSettings({
    conda_path: data.conda_path !== undefined ? data.conda_path : current.conda_path,
    mamba_path: data.mamba_path !== undefined ? data.mamba_path : current.mamba_path,
    onboarding_completed: true,
    calc_env_size: data.calc_env_size !== undefined ? data.calc_env_size : current.calc_env_size,
  });
  invalidateEnvCache();
  return { success: true };
}

// ── 项目目录 ──────────────────────────────────────────
function getProjectDir() {
  const s = settings.loadSettings();
  return { project_dir: s.project_dir || '' };
}

function setProjectDir(dir) {
  settings.saveSettings({ project_dir: dir || '' });
  return { success: true, project_dir: dir || '' };
}

// ── 在项目目录打开终端 ─────────────────────────────────
async function openProjectTerminal(envName, projectDir) {
  if (!envName) throw new Error('环境名不能为空');
  if (!projectDir) throw new Error('请先设置项目目录');
  const env = await findEnv(envName);
  if (!env) throw new Error(`环境 '${envName}' 不存在`);
  const condaExe = settings.getCondaCmd();
  const result = conda.openTerminalAtDir(condaExe, env.path, envName, projectDir);
  if (!result.ok) throw new Error(result.msg);
  return result;
}

// ── 获取环境名列表（供托盘菜单使用） ──────────────────
async function getEnvNames() {
  const envs = await getCachedEnvironments();
  return envs.map(e => ({ name: e.name, path: e.path }));
}

// ── 包管理 ──────────────────────────────────────────────
async function listPackages(name) {
  const env = await findEnv(name);
  if (!env) throw new Error(`环境 '${name}' 不存在`);
  const condaExe = settings.getCondaCmd();
  return conda.listPackages(condaExe, env.path);
}

function installPackage({ name, package: pkgSpec, manager = 'conda' }) {
  if (!name) throw new Error('环境名不能为空');
  if (!pkgSpec) throw new Error('包名不能为空');
  // 同步校验（提交前），实际执行时 tasks 内再校验一次
  conda.assertSafePkgName(pkgSpec);
  return tasks.submitTask('install', { name, package: pkgSpec, manager });
}

function uninstallPackage({ name, package: pkgName, manager = 'conda' }) {
  if (!name) throw new Error('环境名不能为空');
  if (!pkgName) throw new Error('包名不能为空');
  conda.assertSafePkgName(pkgName);
  return tasks.submitTask('uninstall', { name, package: pkgName, manager });
}

function upgradePackage({ name, package: pkgName, manager = 'conda' }) {
  if (!name) throw new Error('环境名不能为空');
  if (!pkgName) throw new Error('包名不能为空');
  conda.assertSafePkgName(pkgName);
  return tasks.submitTask('upgrade', { name, package: pkgName, manager });
}

// ── 导出 / 导入 environment.yml ────────────────────────
async function exportEnvironment(name) {
  if (!name) throw new Error('环境名不能为空');
  const env = await findEnv(name);
  if (!env) throw new Error(`环境 '${name}' 不存在`);
  const condaExe = settings.getCondaCmd();
  return conda.exportEnv(condaExe, name);
}

function importEnvironment({ file, name }) {
  if (!file) throw new Error('请选择 environment.yml 文件');
  if (!name) throw new Error('请输入新环境名');
  const err = conda.validateNewEnvName(name);
  if (err) throw new Error(err);
  return tasks.submitTask('import', { file, name }, invalidateEnvCache);
}

function importFromRequirements({ file, name, python_version }) {
  if (!file) throw new Error('请选择 requirements.txt 文件');
  if (!name) throw new Error('请输入新环境名');
  const err = conda.validateNewEnvName(name);
  if (err) throw new Error(err);
  return tasks.submitTask('import-req', { file, name, python_version }, invalidateEnvCache);
}

function installRequirementsToEnv({ name, file }) {
  if (!name) throw new Error('环境名不能为空');
  if (!file) throw new Error('请选择 requirements.txt 文件');
  conda.assertSafeEnvName(name);
  return tasks.submitTask('install-req-to-env', { name, file }, invalidateEnvCache);
}

// ── 磁盘占用 ────────────────────────────────────────────
// 成功结果的缓存：同一 env.path 在 SIZE_CACHE_TTL 内直接复用，避免重复扫盘
// 计算超时（命中超时返回但后台仍在算）的中间态用 inflightSizeCache 跟踪，算完回填缓存
const SIZE_CACHE_TTL = 60000; // 60s
const sizeCache = new Map();        // path -> { bytes, display, ts }
const inflightSizeCache = new Map(); // path -> Promise（后台续算）

function getCachedSize(envPath) {
  const hit = sizeCache.get(envPath);
  if (hit && Date.now() - hit.ts < SIZE_CACHE_TTL) return hit;
  return null;
}

function setCachedSize(envPath, bytes) {
  sizeCache.set(envPath, { bytes, display: conda.formatSize(bytes), ts: Date.now() });
}

// 读取「计算大小」设置（开关 + 超时秒数），供前端查询当前策略
function getCalcEnvSizeSettings() {
  const s = settings.loadSettings();
  return {
    calc_env_size: !!s.calc_env_size,
    calc_timeout_sec: settings.normalizeCalcTimeoutSec(s.calc_timeout_sec),
  };
}

async function getEnvSize(name) {
  const env = await findEnv(name);
  if (!env) throw new Error(`环境 '${name}' 不存在`);

  // 1) 命中缓存直接返回
  const cached = getCachedSize(env.path);
  if (cached) return { bytes: cached.bytes, display: cached.display };

  // 2) 已有后台续算在跑：等它，避免重复扫盘
  const inflight = inflightSizeCache.get(env.path);
  if (inflight) {
    const bytes = await inflight;
    return { bytes, display: conda.formatSize(bytes) };
  }

  // 3) 带超时地计算。超时不报错，而是降级：发起一个不带超时的后台续算
  //    把结果回填缓存，而当前请求立刻返回 timeout 标志（前端显示「重试」）
  const timeoutSec = settings.normalizeCalcTimeoutSec(settings.loadSettings().calc_timeout_sec);
  const deadline = Date.now() + timeoutSec * 1000;
  const shouldAbort = () => Date.now() > deadline;

  const task = (async () => {
    let bytes;
    try {
      bytes = await conda.getEnvSize(env.path, shouldAbort);
    } catch (e) {
      if (e && e.message === 'SIZE_CALC_TIMEOUT') {
        // 超时：甩一个不带超时的后台续算，并替换 inflight 标记
        // 这样后续请求会等待后台任务，而不是反复命中已超时的旧 task
        const bgTask = conda.getEnvSize(env.path)
          .then((b) => { setCachedSize(env.path, b); return b; })
          .catch(() => {})
          .finally(() => inflightSizeCache.delete(env.path));
        inflightSizeCache.set(env.path, bgTask);
        throw e; // 往上传，让外层降级
      }
      throw e;
    }
    setCachedSize(env.path, bytes);
    inflightSizeCache.delete(env.path);
    return bytes;
  })();
  inflightSizeCache.set(env.path, task);

  try {
    const bytes = await task;
    return { bytes, display: conda.formatSize(bytes) };
  } catch (e) {
    if (e && e.message === 'SIZE_CALC_TIMEOUT') {
      // 后台续算已甩出，当前请求降级返回超时标志
      return { bytes: -1, display: '-', timeout: true };
    }
    throw e;
  }
}

// ── 在终端执行命令（requirements.txt pip install 等） ───
function openTerminalWithCmd({ command, workDir }) {
  if (!command) throw new Error('命令不能为空');
  const result = conda.openTerminalWithCmd(command, workDir || '.');
  if (!result.ok) throw new Error(result.msg);
  return result;
}

module.exports = {
  listEnvironments,
  getPackageCount,
  getBatchPackageCounts,
  getPythonVersion,
  createEnvironment,
  cloneEnvironment,
  deleteEnvironment,
  cleanInvalidEnvironment,
  getActivateCmd,
  activateEnvironment,
  getActivated,
  openTerminal,
  autoDetectSettings,
  checkCondaStatus,
  completeOnboarding,
  invalidateEnvCache,
  getProjectDir,
  setProjectDir,
  openProjectTerminal,
  getEnvNames,
  listPackages,
  installPackage,
  uninstallPackage,
  upgradePackage,
  exportEnvironment,
  importEnvironment,
  importFromRequirements,
  installRequirementsToEnv,
  getEnvSize,
  getCalcEnvSizeSettings,
  openTerminalWithCmd,
};
