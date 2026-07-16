import React, { useState, useEffect, useCallback } from 'react';
import {
  Modal, Table, Input, Button, Space, Tag, Select, message,
  Typography, Tooltip, Popconfirm, Empty, Spin,
} from 'antd';
import {
  SearchOutlined, ReloadOutlined, DownloadOutlined, DeleteOutlined,
  ArrowUpOutlined, AppstoreOutlined, UploadOutlined,
} from '@ant-design/icons';
import { useI18n } from '../i18n/context';
import { addLog } from './TerminalDrawer';
import api from '../api';
import { openFileDialog } from './common';

const { Text } = Typography;

/**
 * 包管理面板：列出环境内全部包（conda + pip），支持安装/卸载/升级。
 * 写操作走任务队列（queue 模式）或打开 CMD 终端（terminal 模式）。
 */
export default function PackageModal({ env, open, onClose, onTaskSubmitted, basicOpMode, condaExe }) {
  const { t } = useI18n();
  const [packages, setPackages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');

  // 安装区状态
  const [installName, setInstallName] = useState('');
  const [installManager, setInstallManager] = useState('conda');

  const fetchPackages = useCallback(async () => {
    if (!env) return;
    setLoading(true);
    addLog('cmd', `env:packages-list`, `${env.name}`);
    try {
      const res = await api.listPackages(env.name);
      setPackages(res.data.packages || []);
      addLog('success', t('pkg.fetched', { n: (res.data.packages || []).length }), env.name);
    } catch (err) {
      addLog('error', t('pkg.fetchFail'), err.message);
      message.error(t('pkg.fetchFail') + err.message);
    } finally {
      setLoading(false);
    }
  }, [env, t]);

  useEffect(() => {
    if (open && env) {
      setInstallName('');
      setSearchText('');
      fetchPackages();
    }
  }, [open, env, fetchPackages]);

  const filtered = searchText.trim()
    ? packages.filter(
        (p) => p.name.toLowerCase().includes(searchText.toLowerCase())
      )
    : packages;

  // 终端模式：构造命令并打开 CMD 终端
  const runPkgInTerminal = (command, logLabel) => {
    if (!window.electron?.invoke) {
      message.error(t('env.terminalUnavailable'));
      addLog('error', 'terminal:unavailable', command);
      return;
    }
    try {
      window.electron.invoke('terminal:run-command', { command, workDir: '.' });
      addLog('cmd', logLabel, command);
      message.success(t('env.terminalOpened'));
    } catch (e) {
      message.error(t('env.openTerminalFail') + ': ' + e.message);
      addLog('error', logLabel, e.message);
    }
  };

  // 提交包操作任务
  const submitPkgTask = async (kind, pkgName, manager) => {
    // Terminal 模式：直接打开 CMD 终端执行
    if (basicOpMode === 'terminal') {
      let command;
      const c = condaExe || 'conda';
      if (manager === 'pip') {
        if (kind === 'install') command = `"${c}" run -n ${env.name} pip install ${pkgName}`;
        else if (kind === 'uninstall') command = `"${c}" run -n ${env.name} pip uninstall ${pkgName} -y`;
        else if (kind === 'upgrade') command = `"${c}" run -n ${env.name} pip install --upgrade ${pkgName}`;
      } else {
        if (kind === 'install') command = `"${c}" install -n ${env.name} ${pkgName} -y`;
        else if (kind === 'uninstall') command = `"${c}" remove -n ${env.name} ${pkgName} -y`;
        else if (kind === 'upgrade') command = `"${c}" update -n ${env.name} ${pkgName} -y`;
      }
      runPkgInTerminal(command, `pkg:${kind}:terminal`);
      if (kind === 'install') setInstallName('');
      return;
    }

    // Queue 模式：走任务队列 API
    const payload = { name: env.name, package: pkgName, manager };
    try {
      let res;
      if (kind === 'install') res = await api.installPackage(payload);
      else if (kind === 'uninstall') res = await api.uninstallPackage(payload);
      else if (kind === 'upgrade') res = await api.upgradePackage(payload);

      message.success(t('pkg.submitted'));
      addLog('success', t('pkg.submitted'), `${kind} ${pkgName} @ ${env.name}`);
      onTaskSubmitted?.(res.data.task_id, kind);
      if (kind === 'install') setInstallName('');
    } catch (err) {
      message.error(err.message || t('error.operationFailed'));
      addLog('error', t('error.operationFailed'), err.message);
    }
  };

  const handleInstall = () => {
    const name = installName.trim();
    if (!name) {
      message.warning(t('pkg.nameRequired'));
      return;
    }
    submitPkgTask('install', name, installManager);
  };

  const handleInstallRequirements = async () => {
    const filePath = await openFileDialog({
      title: t('pkg.selectReq'),
      filters: [{ name: 'requirements.txt', extensions: ['txt'] }, { name: t('common.allFiles'), extensions: ['*'] }],
    });
    if (!filePath) return;

    // Terminal 模式
    if (basicOpMode === 'terminal') {
      const c = condaExe || 'conda';
      const command = `"${c}" run -n ${env.name} pip install -r "${filePath}"`;
      runPkgInTerminal(command, 'pkg:install-req:terminal');
      return;
    }

    // Queue 模式
    try {
      const res = await api.installRequirementsToEnv({ name: env.name, file: filePath });
      message.success(t('pkg.submitted'));
      addLog('success', t('pkg.submitted'), `install requirements.txt @ ${env.name}`);
      onTaskSubmitted?.(res.data.task_id, 'install-req-to-env');
    } catch (err) {
      message.error(err.message || t('error.operationFailed'));
      addLog('error', t('error.operationFailed'), err.message);
    }
  };

  const columns = [
    {
      title: t('pkg.colName'),
      dataIndex: 'name',
      key: 'name',
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: (text) => <Text strong>{text}</Text>,
    },
    {
      title: t('pkg.colVersion'),
      dataIndex: 'version',
      key: 'version',
      minWidth: 120,
      render: (v) => v ? <Tag>{v}</Tag> : <Text type="secondary">-</Text>,
    },
    {
      title: t('pkg.colSource'),
      dataIndex: 'manager',
      key: 'manager',
      minWidth: 90,
      render: (m) => (
        <Tag color={m === 'pip' ? 'blue' : 'green'}>{m || 'conda'}</Tag>
      ),
    },
    {
      title: t('pkg.colActions'),
      key: 'actions',
      width: 90,
      render: (_, record) => (
        <Space size={4}>
          <Tooltip title={t('pkg.upgrade')}>
            <Button
              size="small"
              icon={<ArrowUpOutlined />}
              onClick={() => submitPkgTask('upgrade', record.name, record.manager || 'conda')}
            />
          </Tooltip>
          <Popconfirm
            title={t('pkg.confirmUninstall', { name: record.name })}
            okText={t('pkg.uninstall')}
            cancelText={t('delete.cancel')}
            okButtonProps={{ danger: true }}
            onConfirm={() => submitPkgTask('uninstall', record.name, record.manager || 'conda')}
          >
            <Tooltip title={t('pkg.uninstall')}>
              <Button size="small" icon={<DeleteOutlined />} danger />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Modal
      title={
        <Space>
          <AppstoreOutlined style={{ color: 'var(--color-primary)' }} />
          <span>{t('pkg.title')}</span>
          {env && <Tag color="processing">{env.name}</Tag>}
        </Space>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={760}
      destroyOnClose
    >
      {/* 安装区 */}
      <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
        <Input
          prefix={<DownloadOutlined />}
          placeholder={t('pkg.installPlaceholder')}
          value={installName}
          onChange={(e) => setInstallName(e.target.value)}
          onPressEnter={handleInstall}
          style={{ flex: 1 }}
        />
        <Select
          value={installManager}
          onChange={setInstallManager}
          style={{ minWidth: 90, width: 'auto' }}
          options={[
            { value: 'conda', label: 'conda' },
            { value: 'pip', label: 'pip' },
          ]}
        />
        <Button type="primary" icon={<DownloadOutlined />} onClick={handleInstall}>
          {t('pkg.install')}
        </Button>
        <Button icon={<UploadOutlined />} onClick={handleInstallRequirements}>
          {t('pkg.installReq')}
        </Button>
      </Space.Compact>

      {/* 搜索 + 刷新 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('pkg.search')}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear
          style={{ width: '100%', maxWidth: 360, minWidth: 180 }}
        />
        <Space>
          <Text type="secondary">{t('pkg.total', { n: filtered.length })}</Text>
          <Button icon={<ReloadOutlined />} onClick={fetchPackages} loading={loading} />
        </Space>
      </div>

      <Spin spinning={loading}>
        {filtered.length === 0 && !loading ? (
          <Empty description={searchText ? t('pkg.noMatch') : t('pkg.empty')} />
        ) : (
          <Table
            dataSource={filtered}
            columns={columns}
            rowKey={(r) => `${r.manager}-${r.name}`}
            size="small"
            pagination={{ pageSize: 12, size: 'small', showSizeChanger: false }}
          />
        )}
      </Spin>
    </Modal>
  );
}
