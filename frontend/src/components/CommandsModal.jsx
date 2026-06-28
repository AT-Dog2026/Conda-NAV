import React, { useState, useEffect } from 'react';
import { Modal, Button, Space, Typography, Input, message, Popconfirm, theme, Tag } from 'antd';
import {
  CodeOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  ReloadOutlined, AppstoreOutlined, TagOutlined,
} from '@ant-design/icons';
import { useI18n } from '../i18n/context';
import api from '../api';

const { Text, Title } = Typography;

// 独立组件，避免每渲染重创建导致 Input 卸载重挂载
function CmdInput({ style: s, ...p }) {
  const { token } = theme.useToken();
  return (
    <Input
      size="small"
      style={{ width: '100%', marginBottom: 6, background: token.colorBgContainer, ...(s || {}) }}
      {...p}
    />
  );
}

export default function CommandsModal({ open, onClose }) {
  const { t, locale } = useI18n();
  const { token } = theme.useToken();
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);

  const [activeCategoryId, setActiveCategoryId] = useState(null);

  const [editingCategory, setEditingCategory] = useState(null);
  const [categoryName, setCategoryName] = useState('');
  const [categoryNameEn, setCategoryNameEn] = useState('');
  const [showAddCategory, setShowAddCategory] = useState(false);

  const [editingCommand, setEditingCommand] = useState(null);
  const [commandText, setCommandText] = useState('');
  const [commandDesc, setCommandDesc] = useState('');
  const [commandDescEn, setCommandDescEn] = useState('');

  const isDark = token.colorBgBase !== '#fff';

  useEffect(() => {
    if (open) {
      loadCommands();
    }
  }, [open]);

  const loadCommands = async () => {
    setLoading(true);
    try {
      const res = await api.getCommands();
      setCategories(res.data);
    } catch {
      message.error(t('commands.loadFail'));
    } finally {
      setLoading(false);
    }
  };

  const copyCommand = async (cmd) => {
    try {
      await navigator.clipboard.writeText(cmd);
      message.success(t('app.copySuccess'));
    } catch {
      message.info(t('app.copyManual', { cmd }));
    }
  };

  // ── 分类操作 ──────────────────────────────────────

  const handleAddCategory = async () => {
    if (!categoryName.trim()) { message.warning(t('commands.categoryNameRequired')); return; }
    try {
      await api.addCategory({ name: categoryName.trim(), nameEn: categoryNameEn.trim() || categoryName.trim() });
      message.success(t('commands.categoryAdded'));
      setCategoryName(''); setCategoryNameEn(''); setShowAddCategory(false);
      loadCommands();
    } catch { message.error(t('commands.categoryAddFail')); }
  };

  const handleEditCategory = (cat, e) => {
    e.stopPropagation();
    setEditingCategory(cat);
    setCategoryName(cat.name);
    setCategoryNameEn(cat.nameEn);
  };

  const handleSaveCategory = async () => {
    if (!editingCategory || !categoryName.trim()) { message.warning(t('commands.categoryNameRequired')); return; }
    try {
      await api.updateCategory({ id: editingCategory.id, name: categoryName.trim(), nameEn: categoryNameEn.trim() || categoryName.trim() });
      message.success(t('commands.categoryUpdated'));
      setEditingCategory(null); setCategoryName(''); setCategoryNameEn('');
      loadCommands();
    } catch { message.error(t('commands.categoryUpdateFail')); }
  };

  const handleCancelCategoryEdit = () => {
    setEditingCategory(null); setCategoryName(''); setCategoryNameEn('');
  };

  const handleDeleteCategory = async (id, e) => {
    e && e.stopPropagation();
    try {
      await api.deleteCategory({ id });
      message.success(t('commands.categoryDeleted'));
      if (activeCategoryId === id) setActiveCategoryId(null);
      loadCommands();
    } catch { message.error(t('commands.categoryDeleteFail')); }
  };

  // ── 指令操作 ──────────────────────────────────────

  const handleAddCommand = () => {
    if (activeCategoryId === null) return;
    setEditingCommand({ isNew: true });
    setCommandText(''); setCommandDesc(''); setCommandDescEn('');
  };

  const handleEditCommand = (command) => {
    setEditingCommand({ command, isNew: false, _catId: command._catId || activeCategoryId });
    setCommandText(command.command);
    setCommandDesc(command.description);
    setCommandDescEn(command.descriptionEn);
  };

  const handleSaveCommand = async () => {
    if (!editingCommand || !commandText.trim()) { message.warning(t('commands.commandRequired')); return; }
    try {
      const catId = activeCategoryId ?? editingCommand._catId ?? editingCommand.command?._catId;
      if (editingCommand.isNew) {
        await api.addCommand({ categoryId: catId, command: commandText.trim(), description: commandDesc.trim(), descriptionEn: commandDescEn.trim() || commandDesc.trim() });
        message.success(t('commands.commandAdded'));
      } else {
        await api.updateCommand({ categoryId: catId, commandId: editingCommand.command.id, command: commandText.trim(), description: commandDesc.trim(), descriptionEn: commandDescEn.trim() || commandDesc.trim() });
        message.success(t('commands.commandUpdated'));
      }
      setEditingCommand(null); setCommandText(''); setCommandDesc(''); setCommandDescEn('');
      loadCommands();
    } catch { message.error(editingCommand.isNew ? t('commands.commandAddFail') : t('commands.commandUpdateFail')); }
  };

  const handleCancelCommandEdit = () => {
    setEditingCommand(null); setCommandText(''); setCommandDesc(''); setCommandDescEn('');
  };

  const handleDeleteCommand = async (cmd) => {
    const categoryId = activeCategoryId ?? cmd._catId;
    if (!categoryId) return;
    try {
      await api.deleteCommand({ categoryId, commandId: cmd.id });
      message.success(t('commands.commandDeleted'));
      loadCommands();
    } catch { message.error(t('commands.commandDeleteFail')); }
  };

  const handleReset = async () => {
    try {
      await api.resetCommands();
      message.success(t('commands.resetSuccess'));
      setActiveCategoryId(null);
      loadCommands();
    } catch { message.error(t('commands.resetFail')); }
  };

  // ── 计算 ──────────────────────────────────────

  const activeCategory = activeCategoryId === null ? null : categories.find((c) => c.id === activeCategoryId);
  const allCommands = activeCategoryId === null
    ? categories.flatMap((c) => (c.commands || []).map((cmd) => ({ ...cmd, _catId: c.id, _catName: locale === 'zh-CN' ? c.name : c.nameEn })))
    : [];

  const currentCommands = activeCategoryId === null ? allCommands : (activeCategory?.commands || []);
  const currentTitle = activeCategoryId === null
    ? t('commands.all')
    : (locale === 'zh-CN' ? activeCategory?.name : activeCategory?.nameEn) || '';

  const totalCount = categories.reduce((sum, c) => sum + (c.commands?.length || 0), 0);

  const sidebarHoverBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)';
  const sidebarActiveBg = isDark ? 'rgba(76,175,80,0.15)' : 'rgba(76,175,80,0.08)';
  const sidebarActiveColor = isDark ? '#81c784' : '#388e3c';

  return (
    <Modal
      title={
        <Space>
          <CodeOutlined style={{ color: '#4CAF50' }} />
          {t('app.quickCommands')}
        </Space>
      }
      open={open}
      onCancel={() => { onClose(); setEditingCategory(null); setEditingCommand(null); setShowAddCategory(false); }}
      footer={null}
      width={960}
      destroyOnHidden
      confirmLoading={loading}
    >
      <div style={{ display: 'flex', maxHeight: '70vh', minHeight: 380 }}>
        {/* ═══ 左侧分类栏 ═══════════════════════════════ */}
        <div
          className="cmd-sidebar"
          style={{
            width: 200, flexShrink: 0,
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            paddingRight: 12, overflowY: 'auto', overflowX: 'hidden',
            minWidth: 0, maxWidth: 200,
            display: 'flex', flexDirection: 'column',
          }}
        >
          {/* 添加分类按钮 - 顶部 */}
          {showAddCategory ? (
            <div style={{ padding: '8px 0', marginBottom: 8, borderRadius: 8, background: token.colorBgElevated, minWidth: 0, overflow: 'hidden' }}>
              <div style={{ padding: '0 4px', minWidth: 0 }}>
                <CmdInput value={categoryName} onChange={(e) => setCategoryName(e.target.value)} placeholder={t('commands.categoryName')} onPressEnter={handleAddCategory} />
                <CmdInput value={categoryNameEn} onChange={(e) => setCategoryNameEn(e.target.value)} placeholder="English" onPressEnter={handleAddCategory} />
                <Space size={4}>
                  <Button size="small" type="primary" onClick={handleAddCategory}>{t('commands.addCategory')}</Button>
                  <Button size="small" onClick={() => { setShowAddCategory(false); setCategoryName(''); setCategoryNameEn(''); }}>{t('create.cancel')}</Button>
                </Space>
              </div>
            </div>
          ) : (
            <Button
              type="dashed" icon={<PlusOutlined />} block size="small"
              onClick={() => { setShowAddCategory(true); setCategoryName(''); setCategoryNameEn(''); }}
              style={{ marginBottom: 6 }}
            >
              {t('commands.addCategory')}
            </Button>
          )}

          {/* 全部 */}
          <div
            className={`cmd-sidebar-item ${activeCategoryId === null ? 'active' : ''}`}
            onClick={() => setActiveCategoryId(null)}
            style={{
              color: activeCategoryId === null ? sidebarActiveColor : token.colorText,
              background: activeCategoryId === null ? sidebarActiveBg : 'transparent',
            }}
          >
            <AppstoreOutlined />
            <span className="cmd-cat-name">{t('commands.all')}</span>
            {totalCount > 0 && <span className="cmd-cat-count">{totalCount}</span>}
          </div>

          {/* 分类列表 */}
          {categories.map((cat) => {
            const isActive = activeCategoryId === cat.id;
            const isEditing = editingCategory?.id === cat.id;
            const cmdCount = cat.commands?.length || 0;
            const catDisplay = locale === 'zh-CN' ? cat.name : cat.nameEn;

            return (
              <div
                key={cat.id}
                className={`cmd-sidebar-item ${isActive ? 'active' : ''}`}
                onClick={() => { if (!isEditing) setActiveCategoryId(cat.id); }}
                style={{
                  cursor: isEditing ? 'default' : 'pointer',
                  color: isActive ? sidebarActiveColor : token.colorText,
                  background: isEditing ? 'transparent' : isActive ? sidebarActiveBg : 'transparent',
                }}
              >
                {isEditing ? (
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <CmdInput value={categoryName} onChange={(e) => setCategoryName(e.target.value)} placeholder={t('commands.categoryName')} onClick={(e) => e.stopPropagation()} />
                    <CmdInput value={categoryNameEn} onChange={(e) => setCategoryNameEn(e.target.value)} placeholder="English" onClick={(e) => e.stopPropagation()} />
                    <Space size={4}>
                      <Button size="small" type="primary" ghost onClick={handleSaveCategory}>{t('commands.save')}</Button>
                      <Button size="small" onClick={handleCancelCategoryEdit}>{t('create.cancel')}</Button>
                    </Space>
                  </div>
                ) : (
                  <>
                    <TagOutlined style={{ opacity: 0.5, flexShrink: 0 }} />
                    <span className="cmd-cat-name">{catDisplay}</span>
                    {cmdCount > 0 && <span className="cmd-cat-count">{cmdCount}</span>}
                    <div className="cmd-cat-actions">
                      <Button size="small" type="text" icon={<EditOutlined style={{ fontSize: 11 }} />} onClick={(e) => handleEditCategory(cat, e)} />
                      <Popconfirm title={t('commands.deleteCategoryConfirm')} onConfirm={(e) => handleDeleteCategory(cat.id, e)} okText={t('env.delete')} cancelText={t('create.cancel')}>
                        <Button size="small" type="text" danger icon={<DeleteOutlined style={{ fontSize: 11 }} />} onClick={(e) => e.stopPropagation()} />
                      </Popconfirm>
                    </div>
                  </>
                )}
              </div>
            );
          })}

        </div>

        {/* ═══ 右侧指令区 ═══════════════════════════════ */}
        <div className="cmd-content" style={{ flex: 1, minWidth: 0, paddingLeft: 20, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {/* 顶部标题栏 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexShrink: 0 }}>
            <Space size={8}>
              <Title level={5} style={{ margin: 0 }}>{currentTitle}</Title>
              {currentCommands.length > 0 && (
                <Tag style={{ margin: 0, lineHeight: '18px', fontSize: 12 }}>
                  {currentCommands.length} {locale === 'zh-CN' ? '条' : 'items'}
                </Tag>
              )}
            </Space>
            <Space size={8}>
              {activeCategoryId !== null && (
                <Button size="small" icon={<PlusOutlined />} onClick={handleAddCommand}>
                  {t('commands.addCmd')}
                </Button>
              )}
              <Popconfirm title={t('commands.resetConfirm')} onConfirm={handleReset} okText={t('commands.reset')} cancelText={t('create.cancel')}>
                <Button size="small" icon={<ReloadOutlined />}>{t('commands.reset')}</Button>
              </Popconfirm>
            </Space>
          </div>

          {/* 点击复制提示 */}
          {currentCommands.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12, marginBottom: 10, display: 'block', flexShrink: 0 }}>
              {t('commands.clickToCopy')}
            </Text>
          )}

          {/* 空状态 */}
          {categories.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: token.colorTextSecondary }}>
              <CodeOutlined style={{ fontSize: 48, marginBottom: 12, display: 'block', opacity: 0.3 }} />
              <div>{t('commands.noCategories')}</div>
            </div>
          ) : currentCommands.length === 0 && !editingCommand?.isNew ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: token.colorTextQuaternary }}>
              <Text type="secondary">{t('commands.noCommands')}</Text>
            </div>
          ) : (
            <>
              {currentCommands.map((cmd) => {
                const isEditing = editingCommand?.command?.id === cmd.id;
                if (isEditing) {
                  return (
                    <div key={cmd.id} className="cmd-edit-card" style={{ background: token.colorBgElevated, border: `1px solid ${token.colorBorder}` }}>
                      <CmdInput value={commandText} onChange={(e) => setCommandText(e.target.value)} placeholder={t('commands.commandPlaceholder')} />
                      <CmdInput value={commandDesc} onChange={(e) => setCommandDesc(e.target.value)} placeholder={t('commands.descPlaceholder')} />
                      <CmdInput value={commandDescEn} onChange={(e) => setCommandDescEn(e.target.value)} placeholder="English description" />
                      <Space>
                        <Button size="small" type="primary" onClick={handleSaveCommand}>{t('commands.save')}</Button>
                        <Button size="small" onClick={handleCancelCommandEdit}>{t('create.cancel')}</Button>
                      </Space>
                    </div>
                  );
                }
                return (
                  <div
                    key={cmd.id}
                    className="cmd-item"
                    style={{ background: token.colorBgElevated }}
                  >
                    <button
                      onClick={() => copyCommand(cmd.command)}
                      className="cmd-btn"
                      style={{
                        minWidth: 220, maxWidth: 300,
                        padding: '6px 10px',
                        background: token.colorBgContainer,
                        border: `1px solid ${token.colorBorder}`,
                        borderRadius: 6,
                        fontSize: 14,
                        cursor: 'pointer',
                        wordBreak: 'break-all',
                        display: '-webkit-box',
                        WebkitBoxOrient: 'vertical',
                        WebkitLineClamp: 5,
                        overflow: 'hidden',
                        lineHeight: 1.5,
                        color: token.colorText,
                        flexShrink: 0,
                        textAlign: 'left',
                      }}
                      title={cmd.command}
                    >
                      {cmd.command}
                    </button>
                    <div className="cmd-item-desc">
                      {activeCategoryId === null && cmd._catName && (
                        <span className="cmd-cat-tag" style={{ background: token.colorFillSecondary, color: token.colorTextSecondary }}>
                          {cmd._catName}
                        </span>
                      )}
                      <div style={{
                        fontSize: 14, color: token.colorText, lineHeight: 1.6,
                        display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden',
                      }}>
                        {locale === 'zh-CN' ? cmd.description : cmd.descriptionEn}
                      </div>
                      {locale === 'zh-CN' && cmd.descriptionEn && (
                        <div style={{ fontSize: 13, color: token.colorTextSecondary, marginTop: 3 }}>{cmd.descriptionEn}</div>
                      )}
                    </div>
                    <div className="cmd-item-actions">
                      <Button size="small" type="text" icon={<EditOutlined />} onClick={() => handleEditCommand(cmd)} />
                      <Popconfirm title={t('commands.deleteCmdConfirm')} onConfirm={() => handleDeleteCommand(cmd)} okText={t('env.delete')} cancelText={t('create.cancel')}>
                        <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </div>
                  </div>
                );
              })}

              {/* 新增指令表单 */}
              {editingCommand?.isNew && (
                <div className="cmd-edit-card new" style={{ background: token.colorBgElevated }}>
                  <CmdInput value={commandText} onChange={(e) => setCommandText(e.target.value)} placeholder={t('commands.commandPlaceholder')} onPressEnter={handleSaveCommand} />
                  <CmdInput value={commandDesc} onChange={(e) => setCommandDesc(e.target.value)} placeholder={t('commands.descPlaceholder')} onPressEnter={handleSaveCommand} />
                  <CmdInput value={commandDescEn} onChange={(e) => setCommandDescEn(e.target.value)} placeholder="English description" onPressEnter={handleSaveCommand} />
                  <Space>
                    <Button size="small" type="primary" onClick={handleSaveCommand}>{t('commands.save')}</Button>
                    <Button size="small" onClick={handleCancelCommandEdit}>{t('create.cancel')}</Button>
                  </Space>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
