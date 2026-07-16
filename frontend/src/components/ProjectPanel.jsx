import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Button, Space, Input, Tag, message, Modal, Select,
  Typography, Tooltip, Empty, Spin, Radio, Alert, Input as AntInput,
} from 'antd';
import {
  PlusOutlined, ReloadOutlined, FolderOpenOutlined, DeleteOutlined, EditOutlined,
  ConsoleSqlOutlined, CodeOutlined, SearchOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';
import { useI18n } from '../i18n/context';
import api from '../api';
import { addLog } from './TerminalDrawer';

const { Text } = Typography;
const { Option } = Select;

export default function ProjectPanel({ environments, onRefreshEnvs, isDarkMode }) {
  const { t } = useI18n();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState(null);
  const [formData, setFormData] = useState({ name: '', path: '', boundEnv: '' });
  const [searchText, setSearchText] = useState('');

  // 删除弹窗状态
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteType, setDeleteType] = useState('ref'); // 'ref' | 'dir'
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getProjects();
      setProjects(res.data.projects || []);
    } catch (err) {
      message.error(t('project.addFail'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const filtered = useMemo(() => {
    if (!searchText.trim()) return projects;
    const q = searchText.toLowerCase();
    return projects.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.path.toLowerCase().includes(q) ||
      (p.boundEnv || '').toLowerCase().includes(q)
    );
  }, [projects, searchText]);

  const handleSelectDir = async () => {
    try {
      const dir = await api.openDirectoryDialog({ title: t('project.projectPathPlaceholder') });
      if (dir) {
        setFormData(prev => ({ ...prev, path: dir }));
        if (!formData.name) {
          const dirName = dir.split(/[/\\]+/).pop() || dir;
          setFormData(prev => ({ ...prev, name: dirName }));
        }
      }
    } catch (err) {
      message.error(t('project.setFail'));
    }
  };

  const handleAdd = () => {
    setEditingProject(null);
    setFormData({ name: '', path: '', boundEnv: '' });
    setModalOpen(true);
  };

  const handleEdit = (project) => {
    setEditingProject(project);
    setFormData({ name: project.name, path: project.path, boundEnv: project.boundEnv || '' });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    if (!formData.name.trim()) {
      message.warning(t('project.nameRequired'));
      return;
    }
    if (!formData.path.trim()) {
      message.warning(t('project.pathRequired'));
      return;
    }
    // 查重：新建时检查项目名是否已存在
    if (!editingProject && projects.some(p => p.name === formData.name.trim())) {
      message.warning(t('project.nameDuplicate'));
      return;
    }
    // 编辑时如果修改了名称，也检查重名
    if (editingProject && formData.name.trim() !== editingProject.name) {
      if (projects.some(p => p.id !== editingProject.id && p.name === formData.name.trim())) {
        message.warning(t('project.nameDuplicate'));
        return;
      }
    }
    try {
      if (editingProject) {
        await api.updateProject(editingProject.id, formData);
        message.success(t('project.updated'));
      } else {
        await api.addProject(formData);
        message.success(t('project.added'));
      }
      setModalOpen(false);
      fetchProjects();
    } catch (err) {
      message.error((editingProject ? t('project.updateFail') : t('project.addFail')) + ': ' + err.message);
    }
  };

  // 打开删除弹窗
  const openDeleteModal = (project) => {
    setDeleteTarget(project);
    setDeleteType('ref');
    setDeleteConfirmName('');
    setDeleteModalOpen(true);
  };

  // 执行删除
  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      if (deleteType === 'dir') {
        // 需要输入名称确认
        if (deleteConfirmName !== deleteTarget.name) {
          message.error(t('delete.cancel'));
          setDeleting(false);
          return;
        }
        await api.deleteProjectDir(deleteTarget.id);
        message.success(t('project.deleted'));
        addLog('success', t('project.dirDeleted'), deleteTarget.path);
      } else {
        await api.deleteProject(deleteTarget.id);
        message.success(t('project.deleted'));
        addLog('success', t('project.recordRemoved'), deleteTarget.name);
      }
      setDeleteModalOpen(false);
      fetchProjects();
    } catch (err) {
      message.error(t('project.deleteFail') + ': ' + err.message);
    } finally {
      setDeleting(false);
    }
  };

  // 一键打开项目 CMD
  const handleOpenProjectCmd = async (project) => {
    if (!project.boundEnv) {
      message.warning(t('project.bindEnvFirst'));
      return;
    }
    try {
      const res = await api.openProjectTerminal(project.boundEnv, project.path);
      if (res.data.ok || res.data.success) {
        message.success(t('env.openTerminalSuccess'));
        addLog('success', t('log.openedProjectTerminal'), `${project.boundEnv} @ ${project.path}`);
      } else {
        message.error(res.data.msg || t('env.openTerminalFail'));
      }
    } catch (err) {
      message.error(err.message || t('env.openTerminalFail'));
    }
  };

  const getEnvColor = (envName) => {
    if (!envName) return 'default';
    const colors = ['blue', 'green', 'purple', 'cyan', 'geekblue', 'magenta', 'orange', 'gold'];
    let hash = 0;
    for (let i = 0; i < envName.length; i++) {
      hash = ((hash << 5) - hash) + envName.charCodeAt(i);
      hash |= 0;
    }
    return colors[Math.abs(hash) % colors.length];
  };

  return (
    <div style={{ width: '100%', maxWidth: 860, margin: '0 auto', padding: '0 8px' }}>
      {/* ── 操作栏 ───────────────────────────────── */}
      <div className="action-bar">
        <Space wrap>
          <Input
            prefix={<SearchOutlined />}
            placeholder={t('project.searchPlaceholder')}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            allowClear
            style={{ width: '100%', maxWidth: 360, minWidth: 180 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            {t('project.addProject')}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={fetchProjects} loading={loading}>
            {t('env.refresh')}
          </Button>
        </Space>
        <Text type="secondary">
          {t('project.total', { n: filtered.length })}
          {searchText && t('env.filtered')}
        </Text>
      </div>

      {/* ── 项目列表 ─────────────────────────────── */}
      <Spin spinning={loading}>
        {projects.length === 0 && !loading ? (
          <div className="empty-state">
            <Empty description={t('project.noProjects')}>
              <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
                {t('project.addProject')}
              </Button>
            </Empty>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <Empty description={t('project.noMatch')} />
          </div>
        ) : (
          <div style={{
            border: '1px solid var(--border-primary)',
            borderRadius: 6,
            overflow: 'hidden',
            background: 'var(--bg-card)',
          }}>
            {/* 列表表头 */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '8px 16px',
              background: 'var(--bg-table-header)',
              borderBottom: '1px solid var(--border-table)',
              fontSize: 12,
              color: 'var(--text-tertiary)',
            }}>
              <span style={{ flex: '1 1 160px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('project.projectName')}</span>
              <span style={{ flex: '2 1 200px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('project.projectPath')}</span>
              <span style={{ flex: '0 1 120px', minWidth: 0, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('project.projectEnv')}</span>
              <span style={{ flex: '0 0 auto', minWidth: 0, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('pkg.colActions')}</span>
            </div>
            {filtered.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                highlight={searchText}
                onEdit={() => handleEdit(project)}
                onDelete={() => openDeleteModal(project)}
                onOpenCmd={() => handleOpenProjectCmd(project)}
                getEnvColor={getEnvColor}
                t={t}
                isDarkMode={isDarkMode}
              />
            ))}
          </div>
        )}
      </Spin>

      {/* ── 添加/编辑弹窗 ────────────────────────── */}
      <Modal
        title={
          <Space>
            <CodeOutlined style={{ color: 'var(--color-primary)' }} />
            {editingProject ? t('project.editProject') : t('project.addProjectTitle')}
          </Space>
        }
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        okText={editingProject ? t('commands.save') : t('create.createBtn')}
        cancelText={t('create.cancel')}
        destroyOnClose
        width={520}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 8 }}>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>{t('project.projectName')}</Text>
            <Input
              placeholder={t('project.projectNamePlaceholder')}
              value={formData.name}
              onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
            />
          </div>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>{t('project.projectPath')}</Text>
            <Input.Search
              placeholder={t('project.projectPathPlaceholder')}
              value={formData.path}
              onChange={(e) => setFormData(prev => ({ ...prev, path: e.target.value }))}
              enterButton={<FolderOpenOutlined />}
              onSearch={handleSelectDir}
            />
          </div>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>{t('project.projectEnv')}</Text>
            <Text type="secondary" style={{ fontSize: 11, marginBottom: 4, display: 'block' }}>
              {t('project.projectEnvHint')}
            </Text>
            <Select
              showSearch
              style={{ width: '100%' }}
              placeholder={t('project.projectEnvPlaceholder')}
              value={formData.boundEnv || undefined}
              onChange={(val) => setFormData(prev => ({ ...prev, boundEnv: val }))}
              allowClear
              onClear={() => setFormData(prev => ({ ...prev, boundEnv: '' }))}
              filterOption={(input, option) =>
                (option?.label ?? option?.value ?? '').toLowerCase().includes(input.toLowerCase())
              }
            >
              {(environments || []).map((env) => (
                <Option key={env.name} value={env.name}>
                  {env.name}
                </Option>
              ))}
            </Select>
          </div>
        </div>
      </Modal>

      {/* ── 删除确认弹窗 (区分两种删除方式) ──────── */}
      <Modal
        title={
          <Space>
            <ExclamationCircleOutlined style={{ color: 'var(--color-warning)' }} />
            <span>{t('project.deleteTitle')} — {deleteTarget?.name}</span>
          </Space>
        }
        open={deleteModalOpen}
        onOk={handleDeleteConfirm}
        onCancel={() => setDeleteModalOpen(false)}
        okText={deleteType === 'dir' ? t('delete.confirmBtn') : t('project.deleteOnlyRef')}
        cancelText={t('delete.cancel')}
        okButtonProps={{
          danger: deleteType === 'dir',
          loading: deleting,
          disabled: deleteType === 'dir' && deleteConfirmName !== deleteTarget?.name,
        }}
        destroyOnClose
        width={540}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* 选择删除方式 */}
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('project.deleteMethod')}</Text>
            <Radio.Group
              value={deleteType}
              onChange={(e) => { setDeleteType(e.target.value); setDeleteConfirmName(''); }}
              style={{ width: '100%' }}
            >
              <Space direction="vertical" style={{ width: '100%' }}>
                <Radio value="ref" style={{ padding: '8px 0' }}>
                  <div>
                    <Text strong>{t('project.deleteOnlyRef')}</Text>
                    <br />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {t('project.deleteOnlyRefDesc')}
                    </Text>
                  </div>
                </Radio>
                <Radio value="dir" style={{ padding: '8px 0' }}>
                  <div>
                    <Text strong style={{ color: 'var(--color-error)' }}>{t('project.deleteWithDir')}</Text>
                    <br />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {t('project.deleteWithDirDesc')}
                    </Text>
                  </div>
                </Radio>
              </Space>
            </Radio.Group>
          </div>

          {/* 删除目录时的警告 */}
          {deleteType === 'dir' && deleteTarget && (
            <>
              <Alert
                type="error"
                showIcon
                message={t('project.deleteWithDirWarning')}
                description={
                  <Text code style={{ wordBreak: 'break-all', fontSize: 12 }}>
                    {deleteTarget.path}
                  </Text>
                }
              />
              <div>
                <Text strong style={{ display: 'block', marginBottom: 4 }}>
                  {t('project.deleteWithDirConfirm')}
                </Text>
                <AntInput
                  placeholder={deleteTarget.name}
                  value={deleteConfirmName}
                  onChange={(e) => setDeleteConfirmName(e.target.value)}
                />
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}

// ── 项目列表项（紧凑行布局） ─────────────────────────
function ProjectCard({ project, highlight, onEdit, onDelete, onOpenCmd, getEnvColor, t, isDarkMode }) {
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

  const envColor = getEnvColor(project.boundEnv);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '10px 16px',
      borderBottom: '1px solid var(--border-table)',
      transition: 'background 0.15s',
    }}
      className="project-list-row"
      onDoubleClick={onOpenCmd}
    >
      {/* 名称 + 图标 */}
      <div style={{ flex: '1 1 160px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        <CodeOutlined style={{ color: 'var(--color-primary)', fontSize: 14, flexShrink: 0 }} />
        <Text
          strong
          ellipsis={{ tooltip: project.name }}
          style={{ fontSize: 13, minWidth: 0 }}
        >
          {highlightText(project.name)}
        </Text>
      </div>

      {/* 路径 */}
      <div style={{ flex: '2 1 200px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
        <FolderOpenOutlined style={{ color: 'var(--color-loading-text)', fontSize: 12, flexShrink: 0 }} />
        <Text
          type="secondary"
          ellipsis={{ tooltip: project.path }}
          style={{ fontSize: 12, minWidth: 0 }}
        >
          {highlightText(project.path)}
        </Text>
      </div>

      {/* 绑定环境 */}
      <div style={{ flex: '0 1 120px', minWidth: 0, textAlign: 'center' }}>
        {project.boundEnv ? (
          <Tag color={envColor} style={{ margin: 0, fontSize: 12, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={project.boundEnv}>{project.boundEnv}</Tag>
        ) : (
          <Tag color="default" style={{ margin: 0, fontSize: 12, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('project.projectNoEnv')}</Tag>
        )}
      </div>

      {/* 操作按钮 */}
      <Space size={2} style={{ flexShrink: 0 }}>
        <Tooltip title={project.boundEnv ? t('project.openProjectCmdBtn') : t('project.bindEnvFirst')}>
          <Button
            size="small"
            type="text"
            icon={<ConsoleSqlOutlined />}
            onClick={(e) => { e.stopPropagation(); onOpenCmd(); }}
            style={{ color: project.boundEnv ? 'var(--color-primary)' : 'var(--color-terminal-disabled)', fontSize: 15 }}
          />
        </Tooltip>
        <Tooltip title={t('project.editProject')}>
          <Button
            size="small"
            type="text"
            icon={<EditOutlined />}
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
          />
        </Tooltip>
        <Tooltip title={t('project.deleteProject')}>
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
          />
        </Tooltip>
      </Space>
    </div>
  );
}
