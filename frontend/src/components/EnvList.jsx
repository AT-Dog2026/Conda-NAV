import React, { useMemo, useState, useEffect } from 'react';
import {
  Card, Button, Space, Input, Tooltip, Tag, Typography, Empty, Spin, Badge, Dropdown, Pagination,
} from 'antd';
import {
  PlusOutlined, ReloadOutlined, CopyOutlined,
  DeleteOutlined, BranchesOutlined, SearchOutlined,
  PythonOutlined, FolderOpenOutlined, AppstoreOutlined,
  PlayCircleOutlined, CheckCircleOutlined, UnorderedListOutlined,
  ExportOutlined, MoreOutlined, CloseCircleOutlined, LoadingOutlined,
  ConsoleSqlOutlined,
} from '@ant-design/icons';
import { useI18n } from '../i18n/context';
import { isProtectedEnv } from '../utils/envName';
import api from '../api';

const { Text, Paragraph } = Typography;

export default function EnvList({
  environments, loading, searchText, onSearchChange,
  onCreate, onClone, onDelete, onCopyActivate, onActivate, activatedEnv, onRefresh,
  onManagePackages, onExport, onExportReq, onCleanInvalid, calcSignal,
  exportingEnv, onOpenTerminal, onOpenProjectTerminal, projectDir,
}) {
  const { t } = useI18n();

  // 计算大小的全局开关（关闭时列表不自动扫盘，但支持单卡点击计算）
  const [calcEnabled, setCalcEnabled] = useState(null); // null=未加载
  const [calcVersion, setCalcVersion] = useState(0);    // 切换后强制 EnvCard 重查
  useEffect(() => {
    let cancelled = false;
    api.getCalcEnvSizeSettings()
      .then((res) => { if (!cancelled) setCalcEnabled(!!res.data.calc_env_size); })
      .catch(() => { if (!cancelled) setCalcEnabled(false); });
    return () => { cancelled = true; };
  }, [calcSignal]);

  // calcSignal 变化 = 设置被改过，bump version 让 EnvCard 重新评估加载状态
  useEffect(() => {
    if (calcSignal > 0) setCalcVersion((n) => n + 1);
  }, [calcSignal]);

  const filtered = useMemo(() => {
    if (!searchText.trim()) return environments;
    const q = searchText.toLowerCase();
    return environments.filter(
      (env) => env.name.toLowerCase().includes(q) || env.path.toLowerCase().includes(q)
    );
  }, [environments, searchText]);

  // ── 分页 ────────────────────────────────────────────
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 12;
  // 搜索条件变化时回到第一页
  useEffect(() => { setPage(1); }, [searchText]);

  const paginated = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  return (
    <div>
      <div className="action-bar">
        <Space wrap>
          <Input
            prefix={<SearchOutlined />}
            placeholder={t('env.search')}
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            allowClear
            style={{ width: '100%', maxWidth: 360, minWidth: 180 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
            {t('env.create')}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={onRefresh} loading={loading}>
            {t('env.refresh')}
          </Button>
        </Space>
        <Text type="secondary">
          {t('env.total', { n: filtered.length })}
          {searchText && t('env.filtered')}
        </Text>
      </div>

      <Spin spinning={loading}>
        {filtered.length === 0 && !loading ? (
          <div className="empty-state">
            <Empty description={searchText ? t('env.noMatch') : t('env.empty')} />
          </div>
        ) : (
          <div className="env-grid">
            {paginated.map((env) => (
              <EnvCard
                key={env.path}
                env={env}
                highlight={searchText}
                calcEnabled={calcEnabled}
                calcVersion={calcVersion}
                onClone={() => onClone(env)}
                onDelete={() => onDelete(env)}
                onCopyActivate={() => onCopyActivate(env.name)}
                onActivate={() => onActivate(env.name)}
                onManagePackages={() => onManagePackages(env)}
                onExport={() => onExport(env.name)}
                onExportReq={() => onExportReq(env.name)}
                onCleanInvalid={() => onCleanInvalid(env.path)}
                onOpenTerminal={() => onOpenTerminal(env.name)}
                onOpenProjectTerminal={() => onOpenProjectTerminal(env.name)}
                isActivated={activatedEnv === env.name}
                exportingEnv={exportingEnv}
                projectDir={projectDir}
              />
            ))}
          </div>
        )}
        {filtered.length > PAGE_SIZE && (
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <Pagination
              current={page}
              pageSize={PAGE_SIZE}
              total={filtered.length}
              onChange={setPage}
              showSizeChanger
              pageSizeOptions={['12', '24', '36']}
              showTotal={(total) => t('env.total', { n: total })}
            />
          </div>
        )}
      </Spin>
    </div>
  );
}

function EnvCard({ env, highlight, calcEnabled, calcVersion, onClone, onDelete, onCopyActivate, onActivate, onManagePackages, onExport, onExportReq, onCleanInvalid, onOpenTerminal, onOpenProjectTerminal, isActivated, exportingEnv, projectDir }) {
  const { t } = useI18n();
  const [activating, setActivating] = useState(false);
  const [envSize, setEnvSize] = useState(null);
  const [sizeError, setSizeError] = useState(false);
  const [sizeRetry, setSizeRetry] = useState(0);
  const [manuallyTriggered, setManuallyTriggered] = useState(false); // 关闭态下用户是否点了「点击计算」
  const isProtected = isProtectedEnv(env.name);
  const isInvalid = env.invalid === true;

  // 是否真正发起一次大小计算：
  //  - 全局开启(calcEnabled=true)：自动计算
  //  - 全局关闭：仅当用户点了「点击计算」(manuallyTriggered) 才算一次
  const shouldLoad = (calcEnabled === true) || manuallyTriggered;

  // 异步加载磁盘占用（超时/出错时进入 sizeError 状态，支持手动重试）
  useEffect(() => {
    if (!shouldLoad) { setEnvSize(null); setSizeError(false); return; }
    let cancelled = false;
    const load = async () => {
      setSizeError(false);
      setEnvSize(null);
      try {
        const res = await api.getEnvSize(env.name);
        if (!cancelled && res.data) {
          // 后端超时降级返回 timeout:true —— 显示可重试
          if (res.data.timeout) { if (!cancelled) setSizeError(true); }
          else setEnvSize(res.data);
        }
      } catch { if (!cancelled) setSizeError(true); }
    };
    load();
    return () => { cancelled = true; };
  }, [env.name, sizeRetry, shouldLoad]);

  // calcVersion 变化（用户在设置里切了开关）：关闭→开启时自动加载，开启→关闭时清空
  useEffect(() => {
    if (calcVersion === 0) return;
    setManuallyTriggered(false);
    if (calcEnabled === false) { setEnvSize(null); setSizeError(false); }
  }, [calcVersion, calcEnabled]);

  const highlightText = (text) => {
    if (!highlight || !text) return text;
    const idx = text.toLowerCase().indexOf(highlight.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <span className="search-highlight">{text.slice(idx, idx + highlight.length)}</span>
        {text.slice(idx + highlight.length)}
      </>
    );
  };

  // 处理激活，带loading状态
  const handleActivate = async () => {
    setActivating(true);
    await onActivate();
    setActivating(false);
  };

  // 右键菜单项
  const contextMenuItems = [
    { key: 'open-terminal', icon: <ConsoleSqlOutlined />, label: t('env.openInTerminal'), onClick: onOpenTerminal },
    ...(projectDir ? [{ key: 'open-project-terminal', icon: <FolderOpenOutlined />, label: t('project.openProjectCmd'), onClick: onOpenProjectTerminal }] : []),
    { key: 'copy-path', icon: <CopyOutlined />, label: t('env.copyPath'), onClick: () => onCopyActivate() },
    { key: 'open-folder', icon: <FolderOpenOutlined />, label: t('env.openInExplorer'), onClick: () => { window.electron?.invoke('shell:open-path', env.path); } },
  ];

  // 更多菜单项
  const moreMenuItems = [
    {
      key: 'copy-path',
      icon: <CopyOutlined />,
      label: t('env.copyPath'),
      onClick: onCopyActivate,
    },
    {
      key: 'open-folder',
      icon: <FolderOpenOutlined />,
      label: t('env.openInExplorer'),
      onClick: () => { window.electron?.invoke('shell:open-path', env.path); },
    },
    {
      key: 'clone',
      icon: <BranchesOutlined />,
      label: t('env.clone'),
      onClick: onClone,
      disabled: isProtected,
    },
    {
      key: 'packages',
      icon: <UnorderedListOutlined />,
      label: t('pkg.title'),
      onClick: onManagePackages,
    },
    {
      key: 'export-yml',
      icon: exportingEnv?.name === env.name && exportingEnv?.type === 'yml' ? <LoadingOutlined /> : <ExportOutlined />,
      label: t('env.exportYml'),
      onClick: onExport,
      disabled: exportingEnv?.name === env.name,
    },
    {
      key: 'export-req',
      icon: exportingEnv?.name === env.name && exportingEnv?.type === 'req' ? <LoadingOutlined /> : <ExportOutlined />,
      label: t('env.exportReq'),
      onClick: onExportReq,
      disabled: exportingEnv?.name === env.name,
    },
  ];

  const ActivateButton = () => {
    if (isActivated) {
      return (
        <Tooltip title={t('env.activated')}>
          <Button size="small" icon={<CheckCircleOutlined />} type="primary" style={{ background: 'var(--color-primary)', borderColor: 'var(--color-primary)' }}>
            {t('env.activated') || '已激活'}
          </Button>
        </Tooltip>
      );
    }
    return (
      <Tooltip title={t('env.activate')}>
        <Button size="small" icon={<PlayCircleOutlined />} type="primary" ghost loading={activating} onClick={handleActivate}>
          {activating ? t('env.activating') : t('env.activate')}
        </Button>
      </Tooltip>
    );
  };

  return (
    <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
      <Card
      className={`env-card${isActivated ? ' activated' : ''}`}
      size="small"
      onDoubleClick={handleActivate}
      title={
        <Space>
          <PythonOutlined style={{ color: isInvalid ? 'var(--color-error)' : 'var(--color-python)', fontSize: 18 }} />
          <strong>{highlightText(env.name)}</strong>
          {isInvalid && <Tag color="error" icon={<CloseCircleOutlined />}>{t('env.invalid')}</Tag>}
          {isProtected && <Tag color="red">{t('env.protected')}</Tag>}

        </Space>
      }
      extra={
        <Tooltip title={t('env.copyActivateCmd')}>
          <span className="copy-btn" onClick={onCopyActivate}>
            <CopyOutlined />
          </span>
        </Tooltip>
      }
      actions={
        isInvalid
          ? [
              <Tooltip title={t('env.cleanInvalidHint')} key="clean">
                <Button size="small" icon={<DeleteOutlined />} danger onClick={onCleanInvalid}>
                  {t('env.clean')}
                </Button>
              </Tooltip>,
            ]
          : isProtected
            ? [
                <ActivateButton key="activate" />,
                <Dropdown key="more" menu={{ items: moreMenuItems }} trigger={['click']}>
                  <Button size="small" icon={<MoreOutlined />}>
                    {t('env.more')}
                  </Button>
                </Dropdown>,
              ]
            : [
                <ActivateButton key="activate" />,
                <Button size="small" icon={<DeleteOutlined />} danger onClick={onDelete} key="delete">
                  {t('env.delete')}
                </Button>,
                <Dropdown key="more" menu={{ items: moreMenuItems }} trigger={['click']}>
                  <Button size="small" icon={<MoreOutlined />}>
                    {t('env.more')}
                  </Button>
                </Dropdown>,
              ]
      }
    >
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <div>
          <Text type="secondary"><FolderOpenOutlined style={{ marginRight: 4 }} />{t('env.path')}：</Text>
          <Paragraph ellipsis={{ rows: 1, tooltip: env.path }} style={{ display: 'inline', margin: 0, fontSize: 13 }}>
            {highlightText(env.path)}
          </Paragraph>
        </div>
        <div>
          <Text type="secondary"><PythonOutlined style={{ marginRight: 4 }} />{t('env.python')}：</Text>
          <Tag color="blue">{env.python_version || t('env.unknown')}</Tag>
        </div>
        <div>
          <Text type="secondary"><AppstoreOutlined style={{ marginRight: 4 }} />{t('env.packages')}：</Text>
          {env.package_count === -1 ? (
            <span style={{ color: 'var(--color-loading-text)' }}>{t('env.loading')}</span>
          ) : (
            <Badge count={env.package_count} showZero color="var(--color-primary)" overflowCount={9999} />
          )}
        </div>
        <div>
          <Text type="secondary"><AppstoreOutlined style={{ marginRight: 4 }} />{t('env.size')}：</Text>
          {!shouldLoad ? (
            // 全局关闭且未点过「计算」：显示可点击标签，单卡触发一次计算
            <Tooltip title={t('env.clickToCalcHint')}>
              <Tag
                color="default"
                style={{ cursor: 'pointer' }}
                onClick={() => setManuallyTriggered(true)}
              >
                {t('env.clickToCalc')}
              </Tag>
            </Tooltip>
          ) : sizeError ? (
            <Tooltip title={t('env.sizeTimeoutHint')}>
              <Tag
                color="warning"
                style={{ cursor: 'pointer' }}
                onClick={() => setSizeRetry((n) => n + 1)}
              >
                {t('env.sizeTimeoutRetry')}
              </Tag>
            </Tooltip>
          ) : envSize === null ? (
            <span style={{ color: 'var(--color-loading-text)', fontSize: 13 }}>{t('env.calculating')}</span>
          ) : (
            <Tag color="default">{envSize.display || '-'}</Tag>
          )}
        </div>
      </Space>
    </Card>
    </Dropdown>
  );
}
