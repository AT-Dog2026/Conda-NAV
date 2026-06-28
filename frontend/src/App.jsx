import React, { useState, useCallback, useEffect, Suspense, lazy } from 'react';
import {
  Layout, Typography, ConfigProvider, theme, Space, Tag, message,
  Modal, Input, Alert, Button, Tooltip, Dropdown, Popconfirm,
} from 'antd';
import {
  SettingOutlined, ExclamationCircleOutlined, ToolOutlined,
  CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, ConsoleSqlOutlined,
  SunOutlined, MoonOutlined, PlusOutlined, LoadingOutlined,
  FolderOpenOutlined, FolderOutlined, CodeOutlined, ImportOutlined,
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
import { addLog } from './components/TerminalDrawer';
import { useI18n } from './i18n/context';
import api, { isElectron } from './api';
import './App.css';

const { Header, Content, Footer } = Layout;
const { Title, Text } = Typography;

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

  // 包管理面板
  const [pkgModalEnv, setPkgModalEnv] = useState(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [condaReady, setCondaReady] = useState(true);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [quickCmdOpen, setQuickCmdOpen] = useState(false);

  const [beStatus, setBeStatus] = useState('idle');

  // 计算大小设置变更信号：设置弹窗/引导保存后 bump，EnvList 据此重查开关状态
  const [calcSignal, setCalcSignal] = useState(0);

  // 当前激活的环境
  const [activatedEnv, setActivatedEnv] = useState(null);

  // 项目目录
  const [projectDir, setProjectDir] = useState('');

  // 主题状态（dark / light / system），默认 dark
  const [themeMode, setThemeMode] = useState('dark');
  const [systemIsDark, setSystemIsDark] = useState(true);
  const isDarkMode = themeMode === 'system' ? systemIsDark : themeMode === 'dark';

  // 启动时读取系统主题
  useEffect(() => {
    if (window.electron?.invoke) {
      window.electron.invoke('native-theme:get').then((d) => setSystemIsDark(!!d));
      window.electron.on('native-theme:changed', (d) => setSystemIsDark(!!d));
    }
  }, []);

  // 启动时健康检查
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
    // 加载当前激活环境
    api.getActivated()
      .then(res => setActivatedEnv(res.data.activated_env))
      .catch(() => {});
    // 加载项目目录
    api.getProjectDir()
      .then(res => setProjectDir(res.data.project_dir || ''))
      .catch(() => {});
  }, [t]);

  // 监听托盘菜单事件
  useEffect(() => {
    const unsubs = [];
    if (window.electron?.on) {
      // 托盘切换环境
      const unsub1 = window.electron.on('tray:env-activated', (name) => {
        setActivatedEnv(name);
        message.success(`已切换至环境: ${name}`);
        addLog('success', t('env.activated') || '环境激活成功', name);
      });
      unsubs.push(unsub1);
      // 托盘新建环境
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

  // ── 导出 environment.yml ─────────────────────────────
  const handleExport = async (name) => {
    try {
      addLog('cmd', 'env:export', `conda env export -n ${name}`);
      const res = await api.exportEnvironment(name);
      const content = res.data?.content || res.data;
      if (!content) {
        message.error(t('env.exportFail'));
        return;
      }
      // Electron: 原生保存对话框；浏览器: Blob 下载
      if (isElectron()) {
        const filePath = await api.openExportDialog({
          title: `导出 environment.yml - ${name}`,
          defaultPath: `${name}_environment.yml`,
        });
        if (!filePath) return;
        // 通过 IPC 写文件
        await window.electron.invoke('fs:write-file', { path: filePath, content });
        message.success(t('env.exported', { path: filePath }));
        addLog('success', t('env.exported', { path: filePath }), name);
      } else {
        const blob = new Blob([content], { type: 'text/yaml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${name}_environment.yml`; a.click();
        URL.revokeObjectURL(url);
        message.success(t('env.exported', { path: `${name}_environment.yml` }));
      }
    } catch (err) {
      message.error(t('env.exportFail') + ': ' + err.message);
      addLog('error', t('env.exportFail'), err.message);
    }
  };

  // ── 从 yml 或 requirements.txt 导入 ───────────────────────
  const [importFilePath, setImportFilePath] = useState(null);
  const [importType, setImportType] = useState('yml'); // 'yml' | 'req'

  const handleImportRequest = async (type = 'yml') => {
    setImportType(type);
    try {
      if (isElectron()) {
        const filters = type === 'yml'
          ? [{ name: 'YAML', extensions: ['yml', 'yaml'] }]
          : [{ name: 'Text', extensions: ['txt'] }];
        const title = type === 'yml' ? '选择 environment.yml' : '选择 requirements.txt';
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

  // 预填充任务初始状态，确保 TaskDrawer 初始化时有正确的 task_type
  const initTask = (taskId, taskType) => {
    setTasks((prev) => {
      if (prev[taskId]) return prev; // 已有真实数据则跳过
      return { ...prev, [taskId]: { task_id: taskId, task_type: taskType, status: 'pending', progress: 0, message: t('task.pending') } };
    });
  };

  // 包操作任务提交后：加入任务追踪 + 打开任务抽屉
  const handlePkgTaskSubmitted = (taskId, taskType) => {
    if (taskId) {
      initTask(taskId, taskType || '');
      setActiveTaskIds((prev) => [...prev, taskId]);
      setDrawerOpen(true);
    }
  };

  const handleSubmit = async (values) => {
    setModalOpen(false);
    let taskId;
    try {
      if (modalMode === 'create') {
        const res = await api.createEnvironment(values);
        taskId = res.data.task_id;
        initTask(taskId, 'create');
      } else if (modalMode === 'import') {
        if (!importFilePath) {
          message.error(importType === 'yml' ? t('env.selectYmlFile') : t('env.selectTxtFile'));
          return;
        }
        // 导入操作：打开终端手动执行，不走任务队列
        let command;
        if (importType === 'yml') {
          command = `conda env create -f "${importFilePath}" -n ${values.name}`;
        } else if (values.is_existing) {
          command = `conda activate ${values.name} && pip install -r "${importFilePath}"`;
        } else {
          const pyVer = values.python_version || '3.12';
          command = `conda create -n ${values.name} python=${pyVer} -y && conda activate ${values.name} && pip install -r "${importFilePath}"`;
        }
        window.electron?.invoke('terminal:run-command', { command, workDir: projectDir || '.' });
        addLog('cmd', 'terminal:run-command', command);
        message.success(t('env.terminalOpened') || '终端已打开，请在终端中查看安装进度');
        setImportFilePath(null);
        return; // 跳过后续任务流程
      } else {
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
    try {
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
    try {
      const res = await api.cleanInvalidEnvironment(envPath);
      initTask(res.data.task_id, 'clean-invalid');
      setActiveTaskIds((prev) => [...prev, res.data.task_id]);
      setDrawerOpen(true);
      message.success(t('task.submitted'));
      addLog('cmd', 'env:clean-invalid', `清理无效环境目录: ${envPath}`);
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

  // 执行实际的环境激活
  const handleActivate = async (envName) => {
    try {
      const res = await api.activateEnvironment(envName);
      if (res.data.success) {
        setActivatedEnv(envName);
        message.success(res.data.message);
        addLog('success', t('env.activated') || '环境激活成功', envName);
        // 刷新托盘菜单
        api.refreshTray().catch(() => {});
      } else {
        message.error(res.data.message);
        addLog('error', t('env.activateFail') || '环境激活失败', res.data.message);
      }
    } catch (err) {
      message.error(err.message || t('error.operationFailed'));
    }
  };

  // 打开终端
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

  // 选择项目目录
  const handleSelectProjectDir = async () => {
    try {
      const dir = await api.openDirectoryDialog({ title: '选择项目目录' });
      if (dir) {
        await api.setProjectDir(dir);
        setProjectDir(dir);
        message.success(t('project.setSuccess'));
      }
    } catch (err) {
      message.error(t('project.setFail'));
    }
  };

  // 打开项目CMD（激活环境 + cd到项目目录）
  const handleOpenProjectTerminal = async () => {
    if (!projectDir) {
      message.warning(t('project.setFirst'));
      return;
    }
    if (!activatedEnv) {
      message.warning('请先激活一个环境');
      return;
    }
    try {
      const res = await api.openProjectTerminal(activatedEnv, projectDir);
      if (res.data.ok || res.data.success) {
        message.success(t('env.openTerminalSuccess'));
        addLog('success', '项目终端已打开', `${activatedEnv} @ ${projectDir}`);
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
      return task && task.status !== 'completed' && task.status !== 'failed';
    }));
    setTasks((prev) => {
      const next = {};
      Object.keys(prev).forEach((id) => {
        if (prev[id] && prev[id].status !== 'completed' && prev[id].status !== 'failed') {
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

  const statusTags = {
    checking: { icon: <SyncOutlined spin />, color: 'processing', text: t('status.checking') },
    connected: { icon: <CheckCircleOutlined />, color: 'success', text: t('status.connected') },
    disconnected: { icon: <CloseCircleOutlined />, color: 'error', text: t('status.disconnected') },
  };
  const st = statusTags[beStatus];

  return (
    <ConfigProvider
      locale={antdLocales[locale] || zhCN}
      theme={{
        algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { colorPrimary: '#4CAF50', borderRadius: 6 },
      }}
    >
      <Layout style={{ minHeight: '100vh' }}>
        <Header style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: isDarkMode ? '#1f1f1f' : '#fff',
          borderBottom: `1px solid ${isDarkMode ? '#363636' : '#f0f0f0'}`,
          padding: '0 24px',
        }}>
          <Space style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
            <SettingOutlined style={{ fontSize: 22, color: '#4CAF50', flexShrink: 0 }} />
            <Title level={4} style={{ margin: 0, color: isDarkMode ? '#fff' : '#000', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{t('app.title')}</Title>
          </Space>
          <Space style={{ flexShrink: 0 }}>
            {st && <Tag icon={st.icon} color={st.color}>{st.text}</Tag>}
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
                {t('env.import') || '导入'}
              </Button>
            </Dropdown>
            <Button type="text" icon={<CodeOutlined />} onClick={() => setQuickCmdOpen(true)}>
              {t('app.quickCommands')}
            </Button>
            <Button type="text" icon={activeTaskIds.length > 0 ? <LoadingOutlined spin /> : <ToolOutlined />} onClick={() => setDrawerOpen(true)}>
              {t('app.tasks')}
              {activeTaskIds.length > 0 && <span style={{ marginLeft: 4 }}>({activeTaskIds.length})</span>}
            </Button>
            <Button type="text" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>
              {t('app.settings')}
            </Button>
            <Popconfirm
              title={(() => {
                const next = themeMode === 'dark' ? 'light' : themeMode === 'light' ? 'system' : 'dark';
                const nameMap = { light: t('app.lightMode'), dark: t('app.darkMode'), system: t('app.systemMode') };
                const themeName = nameMap[next] || '';
                return (
                  <span>
                    {t('app.themeSwitchTo')}
                    <span style={{ color: '#ff4d4f', fontWeight: 'bold' }}>{themeName}</span>
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
          </Space>
        </Header>

        {/* 当前项目模块 */}
        <div style={{
          background: isDarkMode ? '#1a1a2e' : '#e3f2fd',
          borderBottom: `1px solid ${isDarkMode ? '#2a2a4a' : '#bbdefb'}`,
          padding: '6px 24px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}>
          <Space size={4}>
            <FolderOutlined style={{ color: '#4CAF50', fontSize: 15 }} />
            <Text strong style={{ fontSize: 13, color: isDarkMode ? '#aaa' : '#555' }}>
              {t('project.title')}:
            </Text>
          </Space>
          {projectDir ? (
            <Space size={8} style={{ flex: 1, minWidth: 0 }}>
              <Tag
                color="processing"
                style={{
                  maxWidth: 500,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  margin: 0,
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
                >
                  {t('project.changeDir')}
                </Button>
              </Tooltip>
            </Space>
          ) : (
            <Space size={4}>
              <Text type="secondary" style={{ fontSize: 12, fontStyle: 'italic' }}>
                {t('project.noProject')}
              </Text>
              <Button
                size="small"
                type="link"
                icon={<FolderOpenOutlined />}
                onClick={handleSelectProjectDir}
              >
                {t('project.selectDir')}
              </Button>
            </Space>
          )}
        </div>

        {/* 当前激活环境显示 */}
        {activatedEnv && (
          <div style={{
            background: isDarkMode ? '#262626' : '#e8f5e9',
            borderBottom: `1px solid ${isDarkMode ? '#363636' : '#c8e6c9'}`,
            padding: '8px 24px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}>
            <Text type="secondary">{t('env.currentlyActivated') || '当前激活'}:</Text>
            <Tag color="success" icon={<CheckCircleOutlined />}>{activatedEnv}</Tag>
            <Button
              size="small"
              type="primary"
              ghost
              icon={<ConsoleSqlOutlined />}
              onClick={() => handleOpenTerminal(activatedEnv)}
            >
              {t('env.openInTerminal')}
            </Button>
            {projectDir && (
              <Tooltip title={t('project.cmdHint')}>
                <Button
                  size="small"
                  type="primary"
                  ghost
                  icon={<CodeOutlined />}
                  onClick={handleOpenProjectTerminal}
                >
                  {t('project.openProjectCmd')}
                </Button>
              </Tooltip>
            )}
          </div>
        )}

        <Content style={{ padding: '24px', maxWidth: 1200, margin: '0 auto', width: '100%' }}>
          {!condaReady && !onboardingOpen && (
            <Alert
              type="warning"
              showIcon
              message={t('onboarding.bannerTitle')}
              description={t('onboarding.bannerDesc')}
              action={
                <Button size="small" type="primary" onClick={() => setSettingsOpen(true)}>
                  {t('app.settings')}
                </Button>
              }
              style={{ marginBottom: 16 }}
            />
          )}
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
            onExport={handleExport}
            onCleanInvalid={handleCleanInvalid}
            calcSignal={calcSignal}
          />
        </Content>

        <Footer style={{ textAlign: 'center', color: '#999' }}>
          {t('app.title')} &copy; {new Date().getFullYear()} — {t('app.desc')}
        </Footer>
      </Layout>

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

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            onOpenTerminal={() => {
              setTerminalOpen(true);
              setSettingsOpen(false);
            }}
            onSaved={() => {
              api.checkCondaStatus().then((res) => {
                setCondaReady(!!res.data.ready);
                if (res.data.ready) fetchEnvironments();
              });
              setCalcSignal((n) => n + 1);
            }}
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

      {quickCmdOpen && (
        <Suspense fallback={null}>
          <CommandsModal
            open={quickCmdOpen}
            onClose={() => setQuickCmdOpen(false)}
          />
        </Suspense>
      )}
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
          <ExclamationCircleOutlined style={{ color: '#faad14' }} />
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
