import React, { useState, useCallback, useEffect, Suspense, lazy } from 'react';
import {
  Layout, Typography, ConfigProvider, theme, Space, Tag, message,
  Modal, Input, Alert, Button, Tooltip, Dropdown, Popconfirm, App as AntdApp,
} from 'antd';
import {
  SettingOutlined, ExclamationCircleOutlined, ToolOutlined,
  CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, ConsoleSqlOutlined,
  SunOutlined, MoonOutlined, PlusOutlined, LoadingOutlined,
  CodeOutlined, ImportOutlined, FolderOpenOutlined,
  ExperimentOutlined, ProjectOutlined,
} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import EnvList from './components/EnvList';
const CreateModal = lazy(() => import('./components/CreateModal'));
const PackageModal = lazy(() => import('./components/PackageModal'));
const TaskDrawer = lazy(() => import('./components/TaskDrawer'));
const SettingsModal = lazy(() => import('./components/SettingsModal'));
const OnboardingModal = lazy(() => import('./components/OnboardingModal'));
const TerminalDrawer = lazy(() => import('./components/TerminalDrawer'));
const CommandsModal = lazy(() => import('./components/CommandsModal'));
const ProjectPanel = lazy(() => import('./components/ProjectPanel'));
import { addLog } from './components/TerminalDrawer';
import { useI18n } from './i18n/context';
import api, { isElectron } from './api';
import './App.css';

const { Header, Footer } = Layout;
const { Text } = Typography;

const antdLocales = { 'zh-CN': zhCN, 'en-US': enUS };

export default function App() {
  const { t, locale } = useI18n();

  const [environments, setEnvironments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState('create');
  const [cloneSource, setCloneSource] = useState(null);

  const [deleteTarget, setDeleteTarget] = useState(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeTaskIds, setActiveTaskIds] = useState([]);
  const [tasks, setTasks] = useState({});

  const [pkgModalEnv, setPkgModalEnv] = useState(null);

  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [condaReady, setCondaReady] = useState(true);
  const [terminalOpen, setTerminalOpen] = useState(false);

  const [beStatus, setBeStatus] = useState('idle');

  const [calcSignal, setCalcSignal] = useState(0);
  const [exportingEnv, setExportingEnv] = useState(null); // { name, type } | null

  const [activatedEnv, setActivatedEnv] = useState(null);
  const [projectDir, setProjectDir] = useState('');
  const [tipIndex, setTipIndex] = useState(0);

  const [basicOpMode, setBasicOpMode] = useState('terminal');
  const [condaExe, setCondaExe] = useState('conda');

  const [themeMode, setThemeMode] = useState('dark');
  const [systemIsDark, setSystemIsDark] = useState(true);
  const isDarkMode = themeMode === 'system' ? systemIsDark : themeMode === 'dark';

  // VSCode 风格侧边栏：当前激活标签页
  const [sidebarTab, setSidebarTab] = useState('envs'); // 'envs' | 'projects' | 'settings'

  // 读取系统主题
  useEffect(() => {
    if (window.electron?.invoke) {
      window.electron.invoke('native-theme:get').then((d) => setSystemIsDark(!!d));
      window.electron.on('native-theme:changed', (d) => setSystemIsDark(!!d));
    }
  }, []);

  // 同步 data-theme 到 DOM，驱动 CSS 变量切换
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  // 底部小贴士轮回滚动
  useEffect(() => {
    const tips = t('footer.tips') || [];
    if (!tips.length) return;
    const timer = setInterval(() => {
      setTipIndex((prev) => (prev + 1) % tips.length);
    }, 6000);
    return () => clearInterval(timer);
  }, [t]);

  // 启动时初始化
  useEffect(() => {
    setBeStatus('checking');
    addLog('info', t('log.healthCheck'), '');
    api.health()
      .then((res) => {
        if (res.data?.status === 'ok') {
          setBeStatus('connected');
          addLog('success', t('error.backendConnectOK'), t('error.backendConnectDesc'));
        } else {
          setBeStatus('disconnected');
        }
      })
      .catch(() => {
        setBeStatus('disconnected');
        addLog('error', t('error.backendConnectFail'), '');
      });
    // 加载当前激活环境（已实现持久化）
    api.getActivated()
      .then(res => setActivatedEnv(res.data.activated_env))
      .catch(() => {});
    // 加载项目目录
    api.getProjectDir()
      .then(res => setProjectDir(res.data.project_dir || ''))
      .catch(() => {});
    // 加载设置
    api.getSettings()
      .then(res => {
        setBasicOpMode(res.data.basic_op_mode || 'terminal');
        setCondaExe(res.data.conda_path || 'conda');
      })
      .catch(() => {});
  }, [t]);

  // 托盘菜单事件
  useEffect(() => {
    const unsubs = [];
    if (window.electron?.on) {
      const unsub1 = window.electron.on('tray:env-activated', (name) => {
        setActivatedEnv(name);
        message.success(t('env.switchedTo', { name }));
        addLog('success', t('env.activated'), name);
      });
      unsubs.push(unsub1);
      const unsub2 = window.electron.on('tray:create-env', () => {
        handleCreate();
      });
      unsubs.push(unsub2);
    }
    return () => unsubs.forEach(fn => { try { fn(); } catch {} });
  }, [t]);

  const fetchEnvironments = useCallback(async () => {
    setLoading(true);
    addLog('cmd', 'env:list', t('log.fetchingEnvs'));
    try {
      const start = Date.now();
      const res = await api.getEnvironments();
      const envs = res.data.environments || [];
      setEnvironments(envs);
      addLog('success', t('log.fetchedEnvs', { n: envs.length }), t('log.duration', { ms: Date.now() - start }));
    } catch (err) {
      addLog('error', t('error.fetchEnvs'), err.message);
      message.error(t('error.fetchEnvs') + err.message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (beStatus !== 'connected') return;
    api.checkCondaStatus()
      .then((res) => {
        const d = res.data;
        setCondaReady(!!d.ready);
        if (d.needs_onboarding) setOnboardingOpen(true);
      })
      .catch(() => setCondaReady(false));
  }, [beStatus]);

  useEffect(() => {
    if (beStatus === 'connected' && condaReady) fetchEnvironments();
  }, [beStatus, condaReady, fetchEnvironments]);

  const handleCreate = () => { setModalMode('create'); setCloneSource(null); setModalOpen(true); };
  const handleClone = (env) => { setModalMode('clone'); setCloneSource(env); setModalOpen(true); };
  const handleManagePackages = (env) => { setPkgModalEnv(env); };

  // ── 导出 environment.yml / requirements.txt ───────────
  const handleExport = async (name, type = 'yml') => {
    const isYml = type === 'yml';
    const apiMethod = isYml ? api.exportEnvironment : api.exportRequirements;
    const mime = isYml ? 'text/yaml' : 'text/plain';
    const label = isYml ? 'environment.yml' : 'requirements.txt';

    const hide = message.loading(t('env.exporting', { name }), 0);
    setExportingEnv({ name, type });
    try {
      addLog('cmd', `env:export:${type}`, isYml ? `conda env export -n ${name}` : `conda run -n ${name} pip freeze`);
      const res = await apiMethod(name);
      const content = res.data?.content || res.data;
      if (!content) {
        message.error(t('env.exportFail'));
        return;
      }
      if (isElectron()) {
        const filePath = await api.openExportDialog({
          title: t('env.exportDialogTitle', { label, name }),
          defaultPath: `${name}_${label}`,
        });
        if (!filePath) return;
        await window.electron.invoke('fs:write-file', { path: filePath, content });
        message.success(t('env.exported', { path: filePath }));
        addLog('success', t('env.exported', { path: filePath }), name);
      } else {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${name}_${label}`; a.click();
        URL.revokeObjectURL(url);
        message.success(t('env.exported', { path: `${name}_${label}` }));
      }
    } catch (err) {
      message.error(t('env.exportFail') + ': ' + err.message);
      addLog('error', t('env.exportFail'), err.message);
    } finally {
      hide();
      setExportingEnv(null);
    }
  };

  // ── 导入 ────────────────────────────────────────────
  const [importFilePath, setImportFilePath] = useState(null);
  const [importType, setImportType] = useState('yml');

  const handleImportRequest = async (type = 'yml') => {
    setImportType(type);
    try {
      if (isElectron()) {
        const filters = type === 'yml'
          ? [{ name: 'YAML', extensions: ['yml', 'yaml'] }]
          : [{ name: 'Text', extensions: ['txt'] }];
        const title = type === 'yml' ? t('env.selectYmlDialogTitle') : t('env.selectTxtDialogTitle');
        const filePath = await window.electron.openFileDialog({ title, filters });
        if (!filePath) return;
        setImportFilePath(filePath);
        setModalMode('import');
        setModalOpen(true);
      } else {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = type === 'yml' ? '.yml,.yaml' : '.txt';
        input.onchange = (e) => {
          const file = e.target.files[0];
          if (file) {
            setImportFilePath(file.webkitRelativePath || file.name);
            setModalMode('import');
            setModalOpen(true);
          }
        };
        input.click();
      }
    } catch (err) {
      console.error('Import dialog error:', err);
      message.error(err.message || t('error.operationFailed'));
    }
  };

  const initTask = (taskId, taskType) => {
    setTasks((prev) => {
      if (prev[taskId]) return prev;
      return { ...prev, [taskId]: { task_id: taskId, task_type: taskType, status: 'pending', progress: 0, message: t('task.pending') } };
    });
  };

  const handlePkgTaskSubmitted = (taskId, taskType) => {
    if (taskId) {
      initTask(taskId, taskType || '');
      setActiveTaskIds((prev) => [...prev, taskId]);
      setDrawerOpen(true);
    }
  };

  const runInTerminal = (command, logLabel) => {
    if (!window.electron?.invoke) {
      message.error(t('env.terminalUnavailable'));
      addLog('error', 'terminal:unavailable', command);
      return;
    }
    try {
      window.electron.invoke('terminal:run-command', { command, workDir: projectDir || '.' });
      addLog('cmd', logLabel, command);
      message.success(t('env.terminalOpened'));
    } catch (e) {
      message.error(t('env.openTerminalFail') + ': ' + e.message);
      addLog('error', logLabel, e.message);
    }
  };

  const handleSubmit = async (values) => {
    setModalOpen(false);
    let taskId;
    try {
      if (modalMode === 'create') {
        if (basicOpMode === 'terminal') {
          const pyVer = values.python_version || '3.12';
          const command = `"${condaExe}" create -n ${values.name} python=${pyVer} -y`;
          runInTerminal(command, 'create:terminal');
          return;
        }
        const res = await api.createEnvironment(values);
        taskId = res.data.task_id;
        initTask(taskId, 'create');
      } else if (modalMode === 'import') {
        if (!importFilePath) {
          message.error(importType === 'yml' ? t('env.selectYmlFile') : t('env.selectTxtFile'));
          return;
        }
        if (basicOpMode === 'terminal') {
          let command;
          const c = condaExe || 'conda';
          if (importType === 'yml') {
            command = `"${c}" env create -f "${importFilePath}" -n ${values.name}`;
          } else if (values.is_existing) {
            command = `"${c}" run -n ${values.name} pip install -r "${importFilePath}"`;
          } else {
            const pyVer = values.python_version || '3.12';
            command = `"${c}" create -n ${values.name} python=${pyVer} -y && "${c}" run -n ${values.name} pip install -r "${importFilePath}"`;
          }
          runInTerminal(command, 'import:terminal');
          setImportFilePath(null);
          return;
        }
        let res;
        if (importType === 'yml') {
          res = await api.importEnvironment({ file: importFilePath, name: values.name });
          taskId = res.data.task_id;
          initTask(taskId, 'import');
        } else if (values.is_existing) {
          res = await api.installRequirementsToEnv({ name: values.name, file: importFilePath });
          taskId = res.data.task_id;
          initTask(taskId, 'install-req-to-env');
        } else {
          res = await api.importFromRequirements({
            file: importFilePath,
            name: values.name,
            python_version: values.python_version || '3.12',
          });
          taskId = res.data.task_id;
          initTask(taskId, 'import-req');
        }
        setImportFilePath(null);
      } else {
        // clone mode
        if (basicOpMode === 'terminal') {
          const command = `"${condaExe}" create -n ${values.name} --clone ${cloneSource.name} -y`;
          runInTerminal(command, 'clone:terminal');
          return;
        }
        const res = await api.cloneEnvironment({
          source: cloneSource.name, target: values.name,
        });
        taskId = res.data.task_id;
        initTask(taskId, 'clone');
      }
      setActiveTaskIds((prev) => [...prev, taskId]);
      setDrawerOpen(true);
      message.success(t('task.submitted'));
    } catch (err) {
      message.error(err.message || t('error.operationFailed'));
    }
  };

  const handleDeleteRequest = (env) => setDeleteTarget(env);

  const handleDeleteConfirm = async (confirmName) => {
    const name = deleteTarget.name;
    setDeleteTarget(null);
    
    if ((confirmName || '').toLowerCase() !== name.toLowerCase()) {
      message.error(t('error.deleteCancel'));
      return;
    }

    try {
      if (basicOpMode === 'terminal') {
        const command = `"${condaExe}" env remove -n ${name} -y`;
        runInTerminal(command, 'delete:terminal');
        return;
      }
      const res = await api.deleteEnvironment(name, confirmName);
      initTask(res.data.task_id, 'delete');
      setActiveTaskIds((prev) => [...prev, res.data.task_id]);
      setDrawerOpen(true);
      message.success(t('task.submitted'));
    } catch (err) {
      message.error(err.message || t('error.deleteFail'));
    }
  };

  const handleCleanInvalid = async (envPath) => {
    if (basicOpMode === 'terminal') {
      const isWin = (typeof process !== 'undefined' && process.platform === 'win32') || navigator.userAgent.includes('Windows');
      const command = isWin
        ? `rmdir /s /q "${envPath}"`
        : `rm -rf "${envPath}"`;
      runInTerminal(command, 'clean-invalid:terminal');
      addLog('cmd', 'env:clean-invalid', t('log.terminalDeleteDir', { path: envPath }));
      return;
    }
    try {
      const res = await api.cleanInvalidEnvironment(envPath);
      initTask(res.data.task_id, 'clean-invalid');
      setActiveTaskIds((prev) => [...prev, res.data.task_id]);
      setDrawerOpen(true);
      message.success(t('task.submitted'));
      addLog('cmd', 'env:clean-invalid', t('log.cleanInvalidEnvDir', { path: envPath }));
    } catch (err) {
      message.error(err.message || t('error.operationFailed'));
      addLog('error', t('error.operationFailed'), err.message);
    }
  };

  const handleCopyActivate = async (envName) => {
    try {
      const res = await api.getActivateCmd(envName);
      await navigator.clipboard.writeText(res.data.command);
      message.success(t('env.copyMsg') + res.data.command);
    } catch {
      const cmd = `conda activate ${envName}`;
      await navigator.clipboard.writeText(cmd);
      message.success(t('env.copyMsg') + cmd);
    }
  };

  const handleActivate = async (envName) => {
    try {
      const res = await api.activateEnvironment(envName);
      if (res.data.success) {
        setActivatedEnv(envName);
        message.success(res.data.message);
        addLog('success', t('env.activated'), envName);
        api.refreshTray().catch(() => {});
      } else {
        message.error(res.data.message);
        addLog('error', t('env.activateFail'), res.data.message);
      }
    } catch (err) {
      message.error(err.message || t('error.operationFailed'));
    }
  };

  const handleOpenTerminal = async (envName) => {
    try {
      const res = await api.openTerminal(envName);
      if (res.data.ok || res.data.success) {
        message.success(t('env.openTerminalSuccess'));
        addLog('success', t('env.openTerminalSuccess'), envName);
      } else {
        message.error(res.data.msg || t('env.openTerminalFail'));
        addLog('error', t('env.openTerminalFail'), res.data.msg);
      }
    } catch (err) {
      message.error(err.message || t('env.openTerminalFail'));
    }
  };

  const handleSelectProjectDir = async () => {
    try {
      const dir = await api.openDirectoryDialog({ title: t('project.selectDirDialogTitle') });
      if (dir) {
        await api.setProjectDir(dir);
        setProjectDir(dir);
        message.success(t('project.setSuccess'));
      }
    } catch (err) {
      message.error(t('project.setFail'));
    }
  };

  const handleOpenProjectTerminal = async () => {
    if (!projectDir) {
      message.warning(t('project.setFirst'));
      return;
    }
    if (!activatedEnv) {
      message.warning(t('env.activateFirst'));
      return;
    }
    try {
      const res = await api.openProjectTerminal(activatedEnv, projectDir);
      if (res.data.ok || res.data.success) {
        message.success(t('env.openTerminalSuccess'));
        addLog('success', t('log.openedProjectTerminal'), `${activatedEnv} @ ${projectDir}`);
      } else {
        message.error(res.data.msg || t('env.openTerminalFail'));
      }
    } catch (err) {
      message.error(err.message || t('env.openTerminalFail'));
    }
  };

  // 右键菜单版：接受环境名参数，不依赖全局 activatedEnv
  const handleOpenProjectTerminalForEnv = async (envName) => {
    if (!projectDir) {
      message.warning(t('project.setFirst'));
      return;
    }
    try {
      const res = await api.openProjectTerminal(envName, projectDir);
      if (res.data.ok || res.data.success) {
        message.success(t('env.openTerminalSuccess'));
        addLog('success', t('log.openedProjectTerminal'), `${envName} @ ${projectDir}`);
      } else {
        message.error(res.data.msg || t('env.openTerminalFail'));
      }
    } catch (err) {
      message.error(err.message || t('env.openTerminalFail'));
    }
  };

  const handleTaskDone = useCallback(() => { fetchEnvironments(); }, [fetchEnvironments]);

  const handleTaskUpdate = useCallback((taskId, data) => {
    setTasks((prev) => ({ ...prev, [taskId]: data }));
    if (data.status === 'completed' || data.status === 'failed') {
      handleTaskDone();
    }
  }, [handleTaskDone]);

  const handleClearTasks = useCallback(() => {
    setActiveTaskIds((prev) => prev.filter((id) => {
      const task = tasks[id];
      return task && task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled';
    }));
    setTasks((prev) => {
      const next = {};
      Object.keys(prev).forEach((id) => {
        if (prev[id] && prev[id].status !== 'completed' && prev[id].status !== 'failed' && prev[id].status !== 'cancelled') {
          next[id] = prev[id];
        }
      });
      return next;
    });
  }, [tasks]);

  const handleCancelTask = useCallback(async (taskId) => {
    try {
      await api.cancelTask(taskId);
      message.success(t('task.cancelled'));
      addLog('success', t('task.cancelled'), `task:${taskId}`);
    } catch (err) {
      message.error(t('task.cancelFail') + ': ' + err.message);
    }
  }, [t]);

  const handleOnboardingComplete = useCallback(() => {
    setOnboardingOpen(false);
    setCondaReady(true);
    fetchEnvironments();
    setCalcSignal((n) => n + 1);
  }, [fetchEnvironments]);

  const handleOnboardingSkip = useCallback(async () => {
    try {
      await api.completeOnboarding({});
    } catch { /* ignore */ }
    setOnboardingOpen(false);
    setCondaReady(false);
  }, []);

  const handleSettingsSaved = useCallback(() => {
    api.checkCondaStatus().then((res) => {
      setCondaReady(!!res.data.ready);
      if (res.data.ready) fetchEnvironments();
    });
    api.getSettings().then(res => {
      setBasicOpMode(res.data.basic_op_mode || 'terminal');
      setCondaExe(res.data.conda_path || 'conda');
    }).catch(() => {});
    setCalcSignal((n) => n + 1);
  }, [fetchEnvironments]);

  const statusTags = {
    checking: { icon: <SyncOutlined spin />, color: 'processing', text: t('status.checking') },
    connected: { icon: <CheckCircleOutlined />, color: 'success', text: t('status.connected') },
    disconnected: { icon: <CloseCircleOutlined />, color: 'error', text: t('status.disconnected') },
  };
  const st = statusTags[beStatus];

  // ── 侧边栏标签页定义 ─────────────────────────────────
  const sidebarTabs = [
    {
      key: 'envs',
      icon: <ExperimentOutlined />,
      label: t('sidebar.envs'),
    },
    {
      key: 'projects',
      icon: <ProjectOutlined />,
      label: t('sidebar.projects'),
    },
    {
      key: 'commands',
      icon: <CodeOutlined />,
      label: t('sidebar.commands'),
    },
    {
      key: 'settings',
      icon: <SettingOutlined />,
      label: t('sidebar.settings'),
    },
  ];

  return (
    <ConfigProvider
      locale={antdLocales[locale] || zhCN}
      theme={{
        algorithm: isDarkMode
          ? [
              theme.darkAlgorithm,
              (seedToken, mapToken) => ({
                ...mapToken,
                colorPrimary: '#4CAF50',
                colorPrimaryHover: '#43A047',
                colorPrimaryActive: '#388E3C',
                colorPrimaryBg: 'rgba(76,175,80,0.12)',
                colorPrimaryBgHover: 'rgba(76,175,80,0.18)',
                colorPrimaryBorder: 'rgba(76,175,80,0.3)',
                colorPrimaryBorderHover: 'rgba(76,175,80,0.5)',
              }),
            ]
          : theme.defaultAlgorithm,
        token: {
          colorPrimary: '#4CAF50',
          colorSuccess: isDarkMode ? '#4ADE80' : '#16A34A',
          colorWarning: isDarkMode ? '#FBBF24' : '#D97706',
          colorError: isDarkMode ? '#F87171' : '#DC2626',
          colorInfo: isDarkMode ? '#60A5FA' : '#2563EB',
          borderRadius: 6,
        },
      }}
    >
      <AntdApp>
      <Layout style={{ height: '100vh', overflow: 'hidden' }}>
        {/* ═══ 顶部导航条 (增高) ═══════════════════════ */}
        <Header style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexWrap: 'nowrap',
          background: 'var(--bg-header)',
          borderBottom: '1px solid var(--border-header)',
          padding: '0 24px',
          height: 56,
          lineHeight: 'normal',
        }}>
          <Space style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
            <img src="./icon.png" alt="Conda NAV" style={{ width: 24, height: 24, flexShrink: 0 }} />
            <span className="app-title-text" style={{
              fontSize: 18, fontWeight: 700, color: 'var(--text-heading)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
              lineHeight: '56px',
            }}>{t('app.title')}</span>
          </Space>

          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'nowrap', minWidth: 0, overflow: 'hidden', gap: 8 }}>
            {/* ── 状态栏（项目 + 激活环境） ── */}
            <div className="header-status" style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 8px',
              borderRadius: 6,
              background: 'var(--bg-header-status)',
              border: '1px solid var(--border-header-status)',
              lineHeight: 'normal',
              maxWidth: 'min(55vw, 720px)',
              minWidth: 0,
              overflow: 'hidden',
              flexWrap: 'nowrap',
              flex: '0 1 auto',
            }}>
              <FolderOpenOutlined style={{ color: 'var(--color-primary)', fontSize: 14, flexShrink: 0 }} />
              <Text style={{ fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                {t('project.title')}:
              </Text>
              {projectDir ? (
                <>
                  <Tag
                    color="default"
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      margin: 0,
                      fontSize: 12,
                      borderColor: 'var(--border-secondary)',
                      color: 'var(--text-primary)',
                      background: 'var(--bg-card)',
                      flexShrink: 1,
                      minWidth: 100,
                    }}
                    title={projectDir}
                  >
                    {projectDir}
                  </Tag>
                  <Tooltip title={t('project.changeDir')}>
                    <Button
                      size="small"
                      type="text"
                      icon={<FolderOpenOutlined />}
                      onClick={handleSelectProjectDir}
                    />
                  </Tooltip>
                </>
              ) : (
                <Button
                  size="small"
                  type="link"
                  icon={<FolderOpenOutlined />}
                  onClick={handleSelectProjectDir}
                  style={{ fontSize: 12, padding: '0 4px' }}
                >
                  {t('project.selectDir')}
                </Button>
              )}

              {/* 分隔线 */}
              {(projectDir || activatedEnv) && (
                <div style={{
                  width: 1, height: 16, background: 'var(--border-divider)',
                  flexShrink: 0, margin: '0 2px',
                }} />
              )}

              {/* 激活环境 */}
              {activatedEnv ? (
                <>
                  <Tag
                    icon={<CheckCircleOutlined />}
                    style={{
                      fontSize: 12, margin: 0,
                      color: 'var(--color-primary)',
                      borderColor: 'var(--color-primary)',
                      background: 'transparent',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                    title={activatedEnv}
                  >
                    {activatedEnv}
                  </Tag>
                  <Tooltip title={t('env.openInTerminal')}>
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      icon={<ConsoleSqlOutlined />}
                      onClick={() => handleOpenTerminal(activatedEnv)}
                      style={{ fontSize: 12, padding: '0 7px' }}
                    />
                  </Tooltip>
                  {projectDir && (
                    <Tooltip title={t('project.openProjectCmd')}>
                      <Button
                        size="small"
                        type="primary"
                        icon={<CodeOutlined />}
                        onClick={handleOpenProjectTerminal}
                        style={{ fontSize: 12, padding: '0 7px' }}
                      />
                    </Tooltip>
                  )}
                </>
              ) : (
                <Text style={{ fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                  {t('env.noActivated')}
                </Text>
              )}
            </div>

            <div style={{
              width: 1, height: 24, background: 'var(--border-separator)', margin: '0 4px',
            }} />

            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
              {t('env.create')}
            </Button>
            <Dropdown
              menu={{
                items: [
                  { key: 'yml', label: t('env.importYml'), onClick: () => handleImportRequest('yml') },
                  { key: 'req', label: t('env.importReq'), onClick: () => handleImportRequest('req') },
                ],
              }}
            >
              <Button icon={<ImportOutlined />}>
                {t('env.import')}
              </Button>
            </Dropdown>
            {basicOpMode !== 'terminal' && (
              <Button type="text" icon={activeTaskIds.length > 0 ? <LoadingOutlined spin /> : <ToolOutlined />} onClick={() => setDrawerOpen(true)}>
                {t('app.tasks')}
                {activeTaskIds.length > 0 && <span style={{ marginLeft: 4 }}>({activeTaskIds.length})</span>}
              </Button>
            )}
            <Popconfirm
              title={(() => {
                const next = themeMode === 'dark' ? 'light' : themeMode === 'light' ? 'system' : 'dark';
                const nameMap = { light: t('app.lightMode'), dark: t('app.darkMode'), system: t('app.systemMode') };
                const themeName = nameMap[next] || '';
                return (
                  <span>
                    {t('app.themeSwitchTo')}
                    <span style={{ color: 'var(--color-error)', fontWeight: 'bold' }}>{themeName}</span>
                    {t('app.themeMayCause')}
                  </span>
                );
              })()}
              onConfirm={() => {
                const next = themeMode === 'dark' ? 'light' : themeMode === 'light' ? 'system' : 'dark';
                setThemeMode(next);
                window.electron?.invoke('theme:set', next);
              }}
              okText={t('app.switchTheme')}
              cancelText={t('create.cancel')}
              okButtonProps={{ danger: true, style: { fontWeight: 'bold' } }}
            >
              <Button
                type="text"
                icon={themeMode === 'system' ? <SyncOutlined /> : isDarkMode ? <SunOutlined /> : <MoonOutlined />}
                title={themeMode === 'dark' ? t('app.darkMode') : themeMode === 'light' ? t('app.lightMode') : t('app.systemMode')}
              />
            </Popconfirm>
          </div>
        </Header>

        {/* ═══ 主体：Activity Bar 侧边栏 + 内容区 ═══════════ */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* VSCode 风格 Activity Bar (垂直标签页图标栏) */}
          <div className="activity-bar" style={{
            width: 48,
            background: 'var(--ab-bg)',
            borderRight: '1px solid var(--ab-border)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            paddingTop: 8,
            flexShrink: 0,
            position: 'relative',
          }}>
            {/* 全局浮动指示条 — 平滑平移到激活标签位置 */}
            <div
              className="activity-bar-indicator"
              style={{ top: (() => {
                const idx = sidebarTabs.findIndex(t => t.key === sidebarTab);
                return 8 + (idx >= 0 ? idx : 0) * 48 + 12;
              })() }}
            />
            {sidebarTabs.map((tab) => {
              const isActive = sidebarTab === tab.key;
              return (
                <Tooltip key={tab.key} title={tab.label} placement="right">
                  <div
                    className={`activity-bar-item${isActive ? ' active' : ''}`}
                    onClick={() => setSidebarTab(tab.key)}
                    style={{
                      width: 48,
                      height: 48,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      color: isActive ? 'var(--ab-icon-active)' : 'var(--ab-icon-inactive)',
                      position: 'relative',
                      transition: 'color 0.15s',
                    }}
                  >
                    <span style={{ fontSize: 22, lineHeight: 1 }}>{tab.icon}</span>
                  </div>
                </Tooltip>
              );
            })}
          </div>

          {/* 内容区 */}
          <Layout.Content className="content-scroll" style={{
            flex: 1,
            overflow: 'auto',
            background: 'var(--bg-content)',
          }}>
            {/* 内容区内边距包装 */}
            <div style={{ padding: '24px', maxWidth: 1200, margin: '0 auto', width: '100%' }}>
              {/* Conda 未就绪警告 */}
              {!condaReady && !onboardingOpen && sidebarTab === 'envs' && (
                <Alert
                  type="warning"
                  showIcon
                  message={t('onboarding.bannerTitle')}
                  description={t('onboarding.bannerDesc')}
                  action={
                    <Button size="small" type="primary" onClick={() => setSidebarTab('settings')}>
                      {t('app.settings')}
                    </Button>
                  }
                  style={{ marginBottom: 16 }}
                />
              )}

              {sidebarTab === 'envs' && (
                <div key="envs" className="page-transition-enter">
                  <EnvList
                    environments={environments}
                    loading={loading}
                    searchText={searchText}
                    onSearchChange={setSearchText}
                    onCreate={handleCreate}
                    onClone={handleClone}
                    onDelete={handleDeleteRequest}
                    onCopyActivate={handleCopyActivate}
                    onActivate={handleActivate}
                    activatedEnv={activatedEnv}
                    onRefresh={fetchEnvironments}
                    onManagePackages={handleManagePackages}
                    onExport={(name) => handleExport(name, 'yml')}
                    onExportReq={(name) => handleExport(name, 'req')}
                    onCleanInvalid={handleCleanInvalid}
                    calcSignal={calcSignal}
                    exportingEnv={exportingEnv}
                    onOpenTerminal={handleOpenTerminal}
                    onOpenProjectTerminal={handleOpenProjectTerminalForEnv}
                    projectDir={projectDir}
                  />
                </div>
              )}

              {/* 项目标签页内容 */}
              {sidebarTab === 'projects' && (
                <div key="projects" className="page-transition-enter">
                  <Suspense fallback={
                    <div style={{ textAlign: 'center', padding: 60 }}>
                      <LoadingOutlined style={{ fontSize: 32, color: 'var(--color-primary)' }} />
                    </div>
                  }>
                    <ProjectPanel
                      environments={environments}
                      onRefreshEnvs={fetchEnvironments}
                      isDarkMode={isDarkMode}
                    />
                  </Suspense>
                </div>
              )}

              {/* 指令集标签页内容（内联渲染） */}
              {sidebarTab === 'commands' && (
                <div key="commands" className="page-transition-enter">
                  <Suspense fallback={
                    <div style={{ textAlign: 'center', padding: 60 }}>
                      <LoadingOutlined style={{ fontSize: 32, color: 'var(--color-primary)' }} />
                    </div>
                  }>
                    <CommandsModal inline />
                  </Suspense>
                </div>
              )}

              {/* 设置标签页内容（内联渲染） */}
              {sidebarTab === 'settings' && (
                <div key="settings" className="page-transition-enter">
                  <Suspense fallback={
                    <div style={{ textAlign: 'center', padding: 60 }}>
                      <LoadingOutlined style={{ fontSize: 32, color: 'var(--color-primary)' }} />
                    </div>
                  }>
                    <SettingsModal
                      inline
                      onOpenTerminal={() => setTerminalOpen(true)}
                      onSaved={handleSettingsSaved}
                    />
                  </Suspense>
                </div>
              )}
            </div>
          </Layout.Content>
        </div>

        <Footer
          className="app-footer"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            height: 24,
            lineHeight: '24px',
            padding: '0 12px',
            fontSize: 12,
            background: 'var(--bg-footer)',
            color: 'var(--text-footer)',
            borderTop: '1px solid var(--border-footer)',
            userSelect: 'none',
          }}
        >
          {/* 左侧：状态信息 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {/* Conda 连接状态 */}
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: beStatus === 'connected'
                  ? 'var(--status-connected)'
                  : beStatus === 'checking' ? 'var(--status-checking)' : 'var(--status-disconnected)',
                display: 'inline-block',
                boxShadow: beStatus === 'connected'
                  ? '0 0 4px var(--status-connected)'
                  : beStatus === 'checking' ? '0 0 4px var(--status-checking)' : '0 0 4px var(--status-disconnected)',
              }} />
              <span>{st?.text || t('status.checking')}</span>
            </span>

            {/* 激活环境 */}
            {activatedEnv && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{
                  color: 'var(--color-activated)',
                  fontWeight: 500,
                }}>
                  {activatedEnv}
                </span>
                <span style={{ opacity: 0.6 }}>{t('env.activated')}</span>
              </span>
            )}

            {/* 环境计数 */}
            <span style={{ opacity: 0.7 }}>
              {t('footer.envs', { n: environments.length })}
            </span>
          </div>

          {/* 右侧：模式 + 版权 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>

            {/* 小贴士轮播（带微动效） */}
            {(t('footer.tips') || []).length > 0 && (
              <span
                key={tipIndex}
                className="footer-tip"
                style={{
                  fontSize: 11,
                  fontStyle: 'italic',
                  maxWidth: 320,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {(t('footer.tips') || [])[tipIndex]}
              </span>
            )}

            {/* 版权 */}
            <span style={{ opacity: 0.45 }}>
              {t('footer.copyrighted', { year: new Date().getFullYear() })}
            </span>
          </div>
        </Footer>
      </Layout>

      {/* ── 模态框 / 抽屉 (保持不变) ──────────────────────── */}
      {modalOpen && (
        <Suspense fallback={null}>
          <CreateModal
            open={modalOpen}
            mode={modalMode}
            cloneSource={cloneSource}
            importFilePath={importFilePath}
            importType={importType}
            environments={environments}
            onCancel={() => { setModalOpen(false); setImportFilePath(null); }}
            onSubmit={handleSubmit}
          />
        </Suspense>
      )}

      {pkgModalEnv && (
        <Suspense fallback={null}>
          <PackageModal
            env={pkgModalEnv}
            open={!!pkgModalEnv}
            onClose={() => setPkgModalEnv(null)}
            onTaskSubmitted={handlePkgTaskSubmitted}
            basicOpMode={basicOpMode}
            condaExe={condaExe}
          />
        </Suspense>
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          envName={deleteTarget.name}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {drawerOpen && (
        <Suspense fallback={null}>
          <TaskDrawer
            open={drawerOpen}
            taskIds={activeTaskIds}
            tasks={tasks}
            onClose={() => setDrawerOpen(false)}
            onTaskUpdate={handleTaskUpdate}
            onClear={handleClearTasks}
            onCancel={handleCancelTask}
            onNewTask={(taskId) => setActiveTaskIds((prev) => [...prev, taskId])}
          />
        </Suspense>
      )}

      {onboardingOpen && (
        <Suspense fallback={null}>
          <OnboardingModal
            open={onboardingOpen}
            onComplete={handleOnboardingComplete}
            onSkip={handleOnboardingSkip}
          />
        </Suspense>
      )}

      {terminalOpen && (
        <Suspense fallback={null}>
          <TerminalDrawer
            open={terminalOpen}
            onClose={() => setTerminalOpen(false)}
          />
        </Suspense>
      )}
      </AntdApp>
    </ConfigProvider>
  );
}

// ── 删除确认弹窗 ──────────────────────────────────────

function DeleteConfirmModal({ envName, onConfirm, onCancel }) {
  const { t } = useI18n();
  const [inputValue, setInputValue] = useState('');
  const [confirming, setConfirming] = useState(false);

  const handleOk = async () => {
    setConfirming(true);
    await onConfirm(inputValue);
    setConfirming(false);
  };

  return (
    <Modal
      title={
        <Space>
          <ExclamationCircleOutlined style={{ color: 'var(--color-warning)' }} />
          {t('delete.title')}
        </Space>
      }
      open={true}
      onOk={handleOk}
      onCancel={onCancel}
      okText={t('delete.confirmBtn')}
      cancelText={t('delete.cancel')}
      okButtonProps={{ danger: true, loading: confirming, disabled: inputValue !== envName }}
      destroyOnClose
    >
      <Alert
        message={t('delete.warning')}
        description={t('delete.warningDesc', { name: envName })}
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
      />
      <p>{t('delete.confirmPrompt')} <strong>{envName}</strong>：</p>
      <Input
        placeholder={envName}
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
      />
    </Modal>
  );
}
