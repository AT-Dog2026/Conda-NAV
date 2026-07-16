const { spawn, exec, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { readCondarc } = require('./condarc');
// ── 常量 ──────────────────────────────────────────────
const PROTECTED_ENVS = new Set(['base', 'root']);
const ENV_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function validateNewEnvName(name) {
  if (!name) return '环境名不能为空';
  if (PROTECTED_ENVS.has(name.toLowerCase())) return `环境名 '${name}' 是保留名，禁止操作`;
  if (!ENV_NAME_RE.test(name)) return '环境名只能包含字母、数字、下划线、连字符，且不能以连字符开头';
  return null;
}

/**
 * 安全断言：环境名必须严格匹配白名单正则。
 * 用于拼接到 shell 命令前的硬性校验，防止命令注入。
 * 与 validateNewEnvName 不同：不区分保留名（base/root 也允许通过，因为它们本就合法），
 * 只阻止危险字符。注入防御的最后一道防线。
 */
function assertSafeEnvName(name) {
  if (typeof name !== 'string' || !ENV_NAME_RE.test(name)) {
    throw new Error(`非法环境名: '${name}'`);
  }
  return name;
}

/** 安全断言：工作目录必须是已存在的绝对路径 */
function assertSafePath(p, label = '路径') {
  if (typeof p !== 'string' || !p || !path.isAbsolute(p)) {
    throw new Error(`非法${label}: '${p}'`);
  }
  // 禁止路径穿越保留字之外的危险形式：仅校验绝对且存在
  if (!fs.existsSync(p)) {
    throw new Error(`${label}不存在: '${p}'`);
  }
  return p;
}

function getPythonExe(envPath) {
  if (process.platform === 'win32') return path.join(envPath, 'python.exe');
  return path.join(envPath, 'bin', 'python');
}

/** 从 conda-meta 目录读取 Python 版本与包数量（无子进程，毫秒级） */
function readEnvMetadataFromDisk(envPath) {
  const metaDir = path.join(envPath, 'conda-meta');
  if (!fs.existsSync(metaDir)) {
    return { python_version: '', package_count: -1 };
  }

  let python_version = '';
  let package_count = 0;

  try {
    const files = fs.readdirSync(metaDir);
    for (const f of files) {
      if (!f.endsWith('.json') || f === 'state.json') continue;
      package_count++;

      if (!python_version && /^python\d*-/.test(f)) {
        const m = f.match(/^python\d*-(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)/);
        if (m) python_version = m[1];
      }
    }

    if (!python_version) {
      for (const f of files) {
        if (!f.startsWith('python') || !f.endsWith('.json')) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(metaDir, f), 'utf-8'));
          if (data.version) {
            python_version = String(data.version);
            break;
          }
        } catch { /* ignore */ }
      }
    }
  } catch {
    return { python_version: '', package_count: -1 };
  }

  return { python_version, package_count };
}

/**
 * 异步版本：避免 readdirSync 阻塞主进程 IPC。
 * 包数量只数文件名不读内容，开销集中在 readdir 本身，改异步即可消除阻塞。
 */
async function readEnvMetadataFromDiskAsync(envPath) {
  const metaDir = path.join(envPath, 'conda-meta');
  try {
    if (!fs.existsSync(metaDir)) return { python_version: '', package_count: -1 };

    let python_version = '';
    let package_count = 0;
    const files = await fs.promises.readdir(metaDir);

    for (const f of files) {
      if (!f.endsWith('.json') || f === 'state.json') continue;
      package_count++;
      if (!python_version && /^python\d*-/.test(f)) {
        const m = f.match(/^python\d*-(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)/);
        if (m) python_version = m[1];
      }
    }

    if (!python_version) {
      for (const f of files) {
        if (!f.startsWith('python') || !f.endsWith('.json')) continue;
        try {
          const data = JSON.parse(await fs.promises.readFile(path.join(metaDir, f), 'utf-8'));
          if (data.version) { python_version = String(data.version); break; }
        } catch { /* ignore */ }
      }
    }
    return { python_version, package_count };
  } catch {
    return { python_version: '', package_count: -1 };
  }
}

// ── 执行 conda 命令 ──────────────────────────────────
function run(cmd, timeout = 120000, procHolder = null, onStdout = null) {
  return new Promise((resolve) => {
    const [exe, ...args] = cmd;
    const proc = spawn(exe, args, {
      shell: process.platform === 'win32' && !exe.endsWith('.exe'),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 暴露进程引用，供外部 cancel（tasks 层使用）
    if (procHolder) procHolder.proc = proc;

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      if (onStdout) onStdout(chunk);
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (onStdout) onStdout(d.toString());
    });

    const timer = setTimeout(() => {
      proc.kill();
      resolve({ rc: -1, stdout: '', stderr: '操作超时' });
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ rc: code, stdout, stderr });
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve({ rc: -1, stdout: '', stderr: `找不到可执行文件: ${exe}` });
    });
  });
}

// ── 跨平台终端辅助 ───────────────────────────────────
function getTerminalLauncher() {
  if (process.platform === 'win32') {
    // 优先 Windows Terminal
    try {
      // wt.exe 通常在 %LOCALAPPDATA%\Microsoft\WindowsApps 或 System32
      const wtPath = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
      if (fs.existsSync(wtPath)) return { name: 'Windows Terminal', exe: 'wt.exe' };
      // 尝试 PATH 查找
      const { spawnSync } = require('child_process');
      const r = spawnSync('where', ['wt.exe'], { shell: true, windowsHide: true, encoding: 'utf-8' });
      if (r.status === 0 && r.stdout.trim()) return { name: 'Windows Terminal', exe: 'wt.exe' };
    } catch { /* fallback */ }
    return { name: 'CMD', exe: 'cmd' };
  }

  if (process.platform === 'darwin') {
    return { name: 'Terminal', exe: 'open', args: ['-a', 'Terminal'] };
  }

  // Linux: 依次尝试
  const terminals = ['gnome-terminal', 'konsole', 'x-terminal-emulator', 'xterm'];
  const { spawnSync } = require('child_process');
  for (const t of terminals) {
    const r = spawnSync('which', [t], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout.trim()) {
      return { name: t, exe: t };
    }
  }
  return { name: 'xterm', exe: 'xterm' };
}

function getCondaRoot(condaExe) {
  const condaDir = path.dirname(condaExe);
  const base = path.basename(condaDir).toLowerCase();
  if (base === 'scripts' || base === 'condabin' || base === 'bin') {
    return path.dirname(condaDir);
  }
  return condaDir;
}

function resolveEnvName(envPath, condaRoot) {
  if (path.resolve(envPath) === path.resolve(condaRoot)) return 'base';
  let name = path.basename(envPath);
  if (name === '.' || name === '..' || !name) {
    name = path.basename(path.dirname(envPath));
  }
  return name;
}

/** 从 environments.txt、envs/、.condarc envs_dirs 发现环境路径 */
function discoverEnvPaths(condaExe) {
  const condaRoot = getCondaRoot(condaExe);
  const paths = new Map();

  if (condaRoot && fs.existsSync(condaRoot)) {
    paths.set(path.resolve(condaRoot), condaRoot);
  }

  const envTxt = path.join(os.homedir(), '.conda', 'environments.txt');
  if (fs.existsSync(envTxt)) {
    for (const line of fs.readFileSync(envTxt, 'utf-8').split(/\r?\n/)) {
      const p = line.trim();
      if (p && fs.existsSync(p)) paths.set(path.resolve(p), p);
    }
  }

  const scanEnvDir = (dir) => {
    if (!dir || !fs.existsSync(dir)) return;
    try {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) paths.set(path.resolve(p), p);
      }
    } catch { /* ignore */ }
  };

  scanEnvDir(path.join(condaRoot, 'envs'));

  const condarc = readCondarc();
  if (condarc.root_prefix && fs.existsSync(condarc.root_prefix)) {
    paths.set(path.resolve(condarc.root_prefix), condarc.root_prefix);
    scanEnvDir(path.join(condarc.root_prefix, 'envs'));
  }
  for (const dir of condarc.envs_dirs) {
    scanEnvDir(dir);
  }

  return { condaRoot, paths: [...paths.values()] };
}

/** 异步版本：将 readdirSync/statSync/existsSync 改为 fs.promises */
async function discoverEnvPathsAsync(condaExe) {
  const condaRoot = getCondaRoot(condaExe);
  const paths = new Map();

  if (condaRoot) {
    try { await fs.promises.access(condaRoot); paths.set(path.resolve(condaRoot), condaRoot); }
    catch { /* ignore */ }
  }

  const envTxt = path.join(os.homedir(), '.conda', 'environments.txt');
  try {
    const content = await fs.promises.readFile(envTxt, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const p = line.trim();
      if (!p) continue;
      try { await fs.promises.access(p); paths.set(path.resolve(p), p); }
      catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  const scanEnvDir = async (dir) => {
    if (!dir) return;
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) paths.set(path.resolve(path.join(dir, entry.name)), path.join(dir, entry.name));
      }
    } catch { /* ignore */ }
  };

  await scanEnvDir(path.join(condaRoot, 'envs'));

  const condarc = readCondarc();
  if (condarc.root_prefix) {
    try {
      await fs.promises.access(condarc.root_prefix);
      paths.set(path.resolve(condarc.root_prefix), condarc.root_prefix);
      await scanEnvDir(path.join(condarc.root_prefix, 'envs'));
    } catch { /* ignore */ }
  }
  for (const dir of condarc.envs_dirs) {
    await scanEnvDir(dir);
  }

  return { condaRoot, paths: [...paths.values()] };
}

function buildEnvEntry(envPath, condaRoot) {
  const meta = readEnvMetadataFromDisk(envPath);
  const metaDir = path.join(envPath, 'conda-meta');
  const invalid = !fs.existsSync(metaDir);
  return {
    name: resolveEnvName(envPath, condaRoot),
    path: envPath,
    python_version: meta.python_version,
    package_count: meta.package_count,
    invalid,
  };
}

/** 异步版本：并行读取 conda-meta，消除主进程 I/O 阻塞 */
async function buildEnvEntryAsync(envPath, condaRoot) {
  const meta = await readEnvMetadataFromDiskAsync(envPath);
  let invalid = false;
  try { await fs.promises.access(path.join(envPath, 'conda-meta')); }
  catch { invalid = true; }
  return {
    name: resolveEnvName(envPath, condaRoot),
    path: envPath,
    python_version: meta.python_version,
    package_count: meta.package_count,
    invalid,
  };
}

async function listEnvironmentsViaConda(condaExe) {
  const { rc, stdout } = await run([condaExe, 'env', 'list', '--json', '-q'], 30000);
  if (rc !== 0 || !stdout.trim()) return [];

  let data;
  try { data = JSON.parse(stdout); } catch { return []; }

  const condaRoot = getCondaRoot(condaExe);
  const envs = await Promise.all(
    (data.envs || []).map((envPath) => buildEnvEntryAsync(envPath, condaRoot))
  );
  return envs;
}

// ── 环境列表（优先读 environments.txt + conda-meta） ─
async function listEnvironments(condaExe) {
  const { condaRoot, paths } = await discoverEnvPathsAsync(condaExe);

  if (paths.length > 0) {
    const envs = await Promise.all(
      paths.map((envPath) => buildEnvEntryAsync(envPath, condaRoot))
    );
    return envs.sort((a, b) => a.name.localeCompare(b.name));
  }

  return listEnvironmentsViaConda(condaExe);
}

async function getPythonVersion(envPath) {
  const meta = readEnvMetadataFromDisk(envPath);
  if (meta.python_version) return meta.python_version;

  const pyExe = getPythonExe(envPath);
  if (!fs.existsSync(pyExe)) return '';
  const { rc, stdout } = await run([pyExe, '--version'], 3000);
  if (rc === 0 && stdout) {
    const parts = stdout.trim().split(/\s+/);
    if (parts.length >= 2) return parts[1];
  }
  return '';
}

// ── 包数量（优先磁盘，失败再调 conda） ───────────────
async function getEnvPackageCount(condaExe, envPath) {
  const meta = readEnvMetadataFromDisk(envPath);
  if (meta.package_count >= 0) return meta.package_count;

  const { rc, stdout } = await run([condaExe, 'list', '-p', envPath, '--json', '-q'], 60000);
  if (rc === 0 && stdout.trim()) {
    try {
      const pkgs = JSON.parse(stdout);
      return Array.isArray(pkgs) ? pkgs.length : -1;
    } catch { /* ignore */ }
  }
  return -1;
}

// ── 创建环境 ─────────────────────────────────────────
async function createEnvironment(condaExe, name, pythonVersion = '3.12', procHolder = null, onStdout = null) {
  const { rc, stdout, stderr } = await run(
    [condaExe, 'create', '-n', name, `python=${pythonVersion}`, '-y', '--json'],
    600000,
    procHolder,
    onStdout
  );
  if (rc === 0) return { ok: true, msg: `环境 '${name}' 创建成功` };
  return { ok: false, msg: stderr || stdout || '创建失败，未知错误' };
}

// ── 克隆环境 ─────────────────────────────────────────
async function cloneEnvironment(condaExe, source, target, procHolder = null, onStdout = null) {
  const { rc, stdout, stderr } = await run(
    [condaExe, 'create', '-n', target, '--clone', source, '-y', '--json'],
    600000,
    procHolder,
    onStdout
  );
  if (rc === 0) {
    // 解析 conda JSON 输出获取实际路径
    let prefix = '';
    try {
      const json = JSON.parse(stdout);
      if (json.prefix) prefix = json.prefix;
    } catch {}
    return { ok: true, msg: `环境 '${source}' 克隆为 '${target}' 成功`, prefix };
  }
  return { ok: false, msg: stderr || stdout || '克隆失败，未知错误' };
}

// ── 删除环境 ─────────────────────────────────────────
async function removeEnvironment(condaExe, name, procHolder = null, onStdout = null) {
  const { rc, stdout, stderr } = await run(
    [condaExe, 'env', 'remove', '-n', name, '-y', '--json'],
    300000,
    procHolder,
    onStdout
  );
  if (rc === 0) return { ok: true, msg: `环境 '${name}' 已删除` };
  return { ok: false, msg: stderr || stdout || '删除失败，未知错误' };
}

// ── 清理无效环境（直接删除目录） ─────────────────────────────────
function cleanInvalidEnvironment(envPath) {
  assertSafePath(envPath, '环境路径');

  // 检查是否为无效环境（无 conda-meta）
  const metaDir = path.join(envPath, 'conda-meta');
  if (fs.existsSync(metaDir)) {
    return { ok: false, msg: '该环境是有效的 conda 环境，应使用标准删除方式' };
  }

  // 安全检查：确保目录在 envs 目录下
  const condaRoot = path.dirname(envPath);
  if (!condaRoot.endsWith('envs') && !condaRoot.includes('envs')) {
    return { ok: false, msg: '目录不在标准 envs 路径下，拒绝删除' };
  }

  try {
    // 使用 fs.rm 递归删除（Node.js 14.14+）
    fs.rmSync(envPath, { recursive: true, force: true });
    return { ok: true, msg: `无效环境目录 '${path.basename(envPath)}' 已清理` };
  } catch (e) {
    return { ok: false, msg: `清理失败: ${e.message}` };
  }
}

// ── 打开终端（跨平台）────────────────────────────────
function openTerminal(condaExe, envPath, envName) {
  assertSafeEnvName(envName);
  const activateCmd = buildActivateCmd(condaExe, envPath, envName);
  if (!activateCmd) return { ok: false, msg: '找不到 conda 激活脚本，请确保 conda 安装完整' };

  return launchTerminal(envName, activateCmd);
}

// ── 在指定目录打开终端（激活环境 + cd） ─────────────────
function openTerminalAtDir(condaExe, envPath, envName, workDir) {
  assertSafeEnvName(envName);
  if (workDir) assertSafePath(workDir, '工作目录');
  const activateCmd = buildActivateCmd(condaExe, envPath, envName);
  if (!activateCmd) return { ok: false, msg: '找不到 conda 激活脚本，请确保 conda 安装完整' };

  return launchTerminal(envName, activateCmd, workDir);
}

// ── 构造激活命令字符串（跨平台） ───────────────────────
function buildActivateCmd(condaExe, envPath, envName) {
  const condaRoot = getCondaRoot(condaExe);

  if (process.platform === 'win32') {
    const condaBat = path.join(condaRoot, 'condabin', 'conda.bat');
    if (fs.existsSync(condaBat)) return `call "${condaBat}" activate ${envName}`;
    if (envPath) {
      const activateBat = path.join(condaRoot, 'Scripts', 'activate.bat');
      if (fs.existsSync(activateBat)) return `call "${activateBat}" "${envPath}"`;
    }
    return null;
  }

  // macOS / Linux：用 conda shell hook 初始化后 activate
  const condaSh = path.join(condaRoot, 'etc', 'profile.d', 'conda.sh');
  if (fs.existsSync(condaSh)) return `source "${condaSh}" && conda activate ${envName}`;
  // 回退：用户 shell 可能已有 conda init
  return `conda activate ${envName}`;
}

// ── 启动终端窗口（跨平台） ─────────────────────────────
function launchTerminal(envName, activateCmd, workDir) {
  const winTitle = `Conda NAV - ${envName}`;

  if (process.platform === 'win32') {
    const term = getTerminalLauncher();
    if (term.exe === 'wt.exe') {
      // Windows Terminal: 新建标签
      const wtArgs = ['-w', '0', 'nt', '-d', workDir || '.', 'cmd', '/k', activateCmd];
      exec(`wt.exe ${wtArgs.map(a => `"${a}"`).join(' ')}`, { windowsHide: true }, () => {}).unref();
    } else {
      // cmd
      let cmd = `start "${winTitle}"`;
      if (workDir && fs.existsSync(workDir)) cmd += ` /d "${workDir}"`;
      cmd += ` cmd /k ${activateCmd}`;
      exec(cmd, { windowsHide: true }, () => {}).unref();
    }
    return { ok: true, msg: `终端已打开，环境 '${envName}' 已激活` };
  }

  if (process.platform === 'darwin') {
    // macOS Terminal.app
    try {
      const script = [
        `tell application "Terminal"`,
        `  activate`,
        `  do script "${activateCmd}"`,
        `end tell`,
      ].join('\n');
      exec(`osascript -e '${script.replace(/'/g, `'"'"'`)}'`, { windowsHide: true }, () => {}).unref();
      return { ok: true, msg: `终端已打开，环境 '${envName}' 已激活` };
    } catch (e) {
      return { ok: false, msg: `打开终端失败: ${e.message}` };
    }
  }

  // Linux
  try {
    const term = getTerminalLauncher();
    if (term.args) {
      exec([term.exe, ...term.args, '--', 'bash', '-c', activateCmd].join(' '), { windowsHide: true }, () => {}).unref();
    } else {
      exec(`${term.exe} -- bash -c '${activateCmd}'`, { windowsHide: true }, () => {}).unref();
    }
    return { ok: true, msg: `终端已打开，环境 '${envName}' 已激活` };
  } catch (e) {
    return { ok: false, msg: `请在终端执行: ${activateCmd}` };
  }
}

// ── 打开终端并执行自定义命令（用于 requirements.txt 等场景） ─
function openTerminalWithCmd(command, workDir) {
  return launchTerminal('Terminal', command, workDir || '.');
}


// ── 包名安全校验（会拼接到 conda/pip 命令） ──────────────
// 允许字母、数字、下划线、连字符、点（如 scikit-learn）、可选 [version] / == 版本约束
const PKG_NAME_RE = /^[A-Za-z0-9_.-]+(?:\s*[<>=!~]=?\s*[\w.*+~-]+)?$/;

function assertSafePkgName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('包名不能为空');
  }
  // 拒绝明显的注入尝试：分号、管道、换行、反引号、$
  if (/[;&|`$\\\n\r]/.test(name)) {
    throw new Error(`非法包名: '${name}'`);
  }
  if (!PKG_NAME_RE.test(name.trim())) {
    throw new Error(`非法包名: '${name}'`);
  }
  return name.trim();
}

// ── 包列表 ─────────────────────────────────────────────
/**
 * 列出环境内的包。优先 conda list（含 pip 区分），失败回退读 python -m pip list。
 * 返回 { packages: [{ name, version, channel, manager }] }
 */
async function listPackages(condaExe, envPath) {
  const { rc, stdout } = await run([condaExe, 'list', '-p', envPath, '--json', '-q'], 60000);
  if (rc === 0 && stdout.trim()) {
    try {
      const arr = JSON.parse(stdout);
      if (Array.isArray(arr)) {
        const packages = arr
          .filter((p) => p && typeof p === 'object' && p.name)
          .map((p) => ({
            name: String(p.name),
            version: String(p.version || ''),
            channel: String(p.channel || ''),
            // conda list 中 pip 装的包 channel 为 pypi
            manager: (String(p.channel || '').toLowerCase() === 'pypi') ? 'pip' : 'conda',
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { packages };
      }
    } catch { /* fallthrough */ }
  }

  // 回退：读 pip list
  const pyExe = getPythonExe(envPath);
  if (fs.existsSync(pyExe)) {
    const { rc: rc2, stdout: out2 } = await run(
      [pyExe, '-m', 'pip', 'list', '--format=json'],
      60000
    );
    if (rc2 === 0 && out2.trim()) {
      try {
        const arr = JSON.parse(out2);
        if (Array.isArray(arr)) {
          const packages = arr
            .filter((p) => p && p.name)
            .map((p) => ({
              name: String(p.name),
              version: String(p.version || ''),
              channel: '',
              manager: 'pip',
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
          return { packages };
        }
      } catch { /* ignore */ }
    }
  }

  return { packages: [] };
}

// ── 安装包 ─────────────────────────────────────────────
async function installPackage(condaExe, envPath, envName, pkgSpec, manager = 'conda', procHolder = null, onStdout = null) {
  assertSafeEnvName(envName);
  assertSafePkgName(pkgSpec);
  if (manager === 'pip') {
    const pyExe = getPythonExe(envPath);
    if (!fs.existsSync(pyExe)) return { ok: false, msg: '环境中找不到 python 可执行文件' };
    const { rc, stdout, stderr } = await run(
      [pyExe, '-m', 'pip', 'install', pkgSpec],
      600000,
      procHolder,
      onStdout
    );
    if (rc === 0) return { ok: true, msg: `pip: '${pkgSpec}' 安装成功` };
    return { ok: false, msg: stderr || stdout || 'pip 安装失败' };
  }
  // conda
  const { rc, stdout, stderr } = await run(
    [condaExe, 'install', '-n', envName, pkgSpec, '-y', '--json'],
    600000,
    procHolder,
    onStdout
  );
  if (rc === 0) return { ok: true, msg: `conda: '${pkgSpec}' 安装成功` };
  return { ok: false, msg: stderr || stdout || 'conda 安装失败' };
}

// ── 卸载包 ─────────────────────────────────────────────
async function uninstallPackage(condaExe, envPath, envName, pkgName, manager = 'conda', procHolder = null, onStdout = null) {
  assertSafeEnvName(envName);
  assertSafePkgName(pkgName);
  if (manager === 'pip') {
    const pyExe = getPythonExe(envPath);
    if (!fs.existsSync(pyExe)) return { ok: false, msg: '环境中找不到 python 可执行文件' };
    const { rc, stdout, stderr } = await run(
      [pyExe, '-m', 'pip', 'uninstall', '-y', pkgName],
      300000,
      procHolder,
      onStdout
    );
    if (rc === 0) return { ok: true, msg: `pip: '${pkgName}' 已卸载` };
    return { ok: false, msg: stderr || stdout || 'pip 卸载失败' };
  }
  const { rc, stdout, stderr } = await run(
    [condaExe, 'remove', '-n', envName, pkgName, '-y', '--json'],
    300000,
    procHolder,
    onStdout
  );
  if (rc === 0) return { ok: true, msg: `conda: '${pkgName}' 已卸载` };
  return { ok: false, msg: stderr || stdout || 'conda 卸载失败' };
}

// ── 升级包 ─────────────────────────────────────────────
async function upgradePackage(condaExe, envPath, envName, pkgName, manager = 'conda', procHolder = null, onStdout = null) {
  assertSafeEnvName(envName);
  assertSafePkgName(pkgName);
  if (manager === 'pip') {
    const pyExe = getPythonExe(envPath);
    if (!fs.existsSync(pyExe)) return { ok: false, msg: '环境中找不到 python 可执行文件' };
    const { rc, stdout, stderr } = await run(
      [pyExe, '-m', 'pip', 'install', '--upgrade', pkgName],
      600000,
      procHolder,
      onStdout
    );
    if (rc === 0) return { ok: true, msg: `pip: '${pkgName}' 已升级` };
    return { ok: false, msg: stderr || stdout || 'pip 升级失败' };
  }
  const { rc, stdout, stderr } = await run(
    [condaExe, 'update', '-n', envName, pkgName, '-y', '--json'],
    600000,
    procHolder,
    onStdout
  );
  if (rc === 0) return { ok: true, msg: `conda: '${pkgName}' 已升级` };
  return { ok: false, msg: stderr || stdout || 'conda 升级失败' };
}

// ── 导出 environment.yml ────────────────────────────────
async function exportEnv(condaExe, name) {
  assertSafeEnvName(name);
  const { rc, stdout, stderr } = await run(
    [condaExe, 'env', 'export', '-n', name],
    60000
  );
  if (rc === 0 && stdout.trim()) return { ok: true, content: stdout };
  return { ok: false, msg: stderr || stdout || '导出失败' };
}

// ── 导出 requirements.txt (pip freeze) ──────────────────
async function pipFreeze(condaExe, name) {
  assertSafeEnvName(name);
  const { rc, stdout, stderr } = await run(
    [condaExe, 'run', '-n', name, 'pip', 'freeze'],
    60000
  );
  if (rc === 0 && stdout.trim()) return { ok: true, content: stdout };
  return { ok: false, msg: stderr || stdout || '导出 requirements.txt 失败' };
}

// ── 从 yml 导入环境 ────────────────────────────────────
async function importEnv(condaExe, filePath, name, procHolder = null, onStdout = null) {
  assertSafeEnvName(name);
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
  const { rc, stdout, stderr } = await run(
    [condaExe, 'env', 'create', '-f', filePath, '-n', name],
    600000,
    procHolder,
    onStdout
  );
  if (rc === 0) return { ok: true, msg: `环境 '${name}' 导入成功` };
  return { ok: false, msg: stderr || stdout || '导入失败' };
}

// ── 从 requirements.txt 导入环境 ───────────────────────
async function importFromRequirements(condaExe, filePath, name, pythonVersion = '3.12', procHolder = null, onStdout = null) {
  assertSafeEnvName(name);
  assertSafePath(filePath, 'requirements.txt');
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);

  // Step 1: 创建空环境
  const createResult = await createEnvironment(condaExe, name, pythonVersion, procHolder, onStdout);
  if (!createResult.ok) return createResult;

  // Step 2: 获取环境路径
  const envs = await listEnvironments(condaExe);
  const env = envs.find(e => e.name === name);
  if (!env) return { ok: false, msg: `环境 '${name}' 创建成功但无法找到路径` };

  // Step 3: 使用 pip install -r requirements.txt
  const pipExe = getPythonExe(env.path);
  const { rc, stdout, stderr } = await run(
    [pipExe, '-m', 'pip', 'install', '-r', filePath],
    600000,
    procHolder,
    onStdout
  );

  if (rc === 0) return { ok: true, msg: `环境 '${name}' 从 requirements.txt 导入成功` };
  return { ok: false, msg: stderr || stdout || 'pip 安装失败' };
}

/**
 * 在已有的环境中安装 requirements.txt 中的包
 * @param {string} condaExe conda 路径
 * @param {string} envPath 环境路径
 * @param {string} envName 环境名
 * @param {string} filePath requirements.txt 文件路径
 * @param {object} procHolder 进程持有者
 * @returns {object} { ok, msg }
 */
async function installRequirementsToEnv(condaExe, envPath, envName, filePath, procHolder = null, onStdout = null) {
  assertSafeEnvName(envName);
  assertSafePath(filePath, 'requirements.txt');
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
  if (!fs.existsSync(envPath)) throw new Error(`环境路径不存在: ${envPath}`);

  const pipExe = getPythonExe(envPath);
  if (!fs.existsSync(pipExe)) return { ok: false, msg: '环境中找不到 python 可执行文件' };

  const { rc, stdout, stderr } = await run(
    [pipExe, '-m', 'pip', 'install', '-r', filePath],
    600000,
    procHolder,
    onStdout
  );

  if (rc === 0) return { ok: true, msg: `已在环境 '${envName}' 中安装 requirements.txt 中的包` };
  return { ok: false, msg: stderr || stdout || 'pip 安装失败' };
}

// ── 磁盘占用（异步遍历目录，返回字节数）──────────────
// 并发分批 stat：大环境（几万个文件）下，串行 await stat 会非常慢，
// 这里把同一批目录下的文件 stat 并发化（控制并发数避免句柄/内存暴涨）。
const SIZE_STAT_CONCURRENCY = 64;

async function statBatchSize(files) {
  let sum = 0;
  // 分片并发，每片最多 SIZE_STAT_CONCURRENCY 个文件
  for (let i = 0; i < files.length; i += SIZE_STAT_CONCURRENCY) {
    const slice = files.slice(i, i + SIZE_STAT_CONCURRENCY);
    const results = await Promise.all(
      slice.map((f) => fs.promises.stat(f).then((s) => s.size).catch(() => 0))
    );
    for (const sz of results) sum += sz;
  }
  return sum;
}

// 中止信号：getEnvSize 在每个目录循环检查一次，true 则抛出该错误
class SizeCalcAborted extends Error {
  constructor() { super('SIZE_CALC_TIMEOUT'); this.name = 'SizeCalcAborted'; }
}

async function getEnvSize(envPath, shouldAbort) {
  let totalSize = 0;
  const dirs = [envPath];
  while (dirs.length > 0) {
    // 每个目录检查一次是否超时；超时则中止当前计算（后台续算会接管）
    if (shouldAbort && shouldAbort()) throw new SizeCalcAborted();
    const dir = dirs.pop();
    let items;
    try {
      items = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch { continue; }
    const files = [];
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        dirs.push(full);
      } else if (item.isFile()) {
        files.push(full);
      }
    }
    // 本目录下的文件并发 stat，跳过非文件项（软链等）以避免重复计数
    totalSize += await statBatchSize(files);
  }
  return totalSize;
}

/** 字节转可读大小 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function parseCommandArgs(command) {
  const args = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ' ' && !inQuotes) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

async function runCommand(condaExe, command) {
  return new Promise((resolve) => {
    const args = parseCommandArgs(command);
    execFile(condaExe, args, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        resolve(stderr || error.message);
      } else {
        resolve(stdout || '');
      }
    });
  });
}

module.exports = {
  validateNewEnvName,
  assertSafeEnvName,
  assertSafePath,
  assertSafePkgName,
  run,
  runCommand,
  readEnvMetadataFromDisk,
  readEnvMetadataFromDiskAsync,
  listEnvironments,
  getPythonVersion,
  getEnvPackageCount,
  createEnvironment,
  cloneEnvironment,
  removeEnvironment,
  cleanInvalidEnvironment,
  listPackages,
  installPackage,
  uninstallPackage,
  upgradePackage,
  exportEnv,
  pipFreeze,
  importEnv,
  importFromRequirements,
  installRequirementsToEnv,
  getEnvSize,
  formatSize,
  openTerminal,
  openTerminalAtDir,
  getTerminalLauncher,
  launchTerminal,
  openTerminalWithCmd,
};
