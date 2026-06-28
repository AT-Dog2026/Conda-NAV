import React, { useState, useEffect } from 'react';
import { Modal, Button, Space, Typography, Input, message, Divider, Popconfirm, theme } from 'antd';
import { CodeOutlined, PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import { useI18n } from '../i18n/context';
import api from '../api';

const { Text, Title } = Typography;

export default function CommandsModal({ open, onClose }) {
  const { t, locale } = useI18n();
  const { token } = theme.useToken();
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);

  const [editingCategory, setEditingCategory] = useState(null);
  const [categoryName, setCategoryName] = useState('');
  const [categoryNameEn, setCategoryNameEn] = useState('');

  const [editingCommand, setEditingCommand] = useState(null);
  const [commandText, setCommandText] = useState('');
  const [commandDesc, setCommandDesc] = useState('');
  const [commandDescEn, setCommandDescEn] = useState('');

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

  const handleAddCategory = async () => {
    if (!categoryName.trim()) {
      message.warning(t('commands.categoryNameRequired'));
      return;
    }
    try {
      await api.addCategory({ name: categoryName.trim(), nameEn: categoryNameEn.trim() || categoryName.trim() });
      message.success(t('commands.categoryAdded'));
      setCategoryName('');
      setCategoryNameEn('');
      loadCommands();
    } catch {
      message.error(t('commands.categoryAddFail'));
    }
  };

  const handleEditCategory = (category) => {
    setEditingCategory(category);
    setCategoryName(category.name);
    setCategoryNameEn(category.nameEn);
  };

  const handleSaveCategory = async () => {
    if (!editingCategory) return;
    if (!categoryName.trim()) {
      message.warning(t('commands.categoryNameRequired'));
      return;
    }
    try {
      await api.updateCategory({ id: editingCategory.id, name: categoryName.trim(), nameEn: categoryNameEn.trim() || categoryName.trim() });
      message.success(t('commands.categoryUpdated'));
      setEditingCategory(null);
      setCategoryName('');
      setCategoryNameEn('');
      loadCommands();
    } catch {
      message.error(t('commands.categoryUpdateFail'));
    }
  };

  const handleCancelCategoryEdit = () => {
    setEditingCategory(null);
    setCategoryName('');
    setCategoryNameEn('');
  };

  const handleDeleteCategory = async (id) => {
    try {
      await api.deleteCategory({ id });
      message.success(t('commands.categoryDeleted'));
      loadCommands();
    } catch {
      message.error(t('commands.categoryDeleteFail'));
    }
  };

  const handleAddCommand = (categoryId) => {
    setEditingCommand({ categoryId, isNew: true });
    setCommandText('');
    setCommandDesc('');
    setCommandDescEn('');
  };

  const handleEditCommand = (categoryId, command) => {
    setEditingCommand({ categoryId, command, isNew: false });
    setCommandText(command.command);
    setCommandDesc(command.description);
    setCommandDescEn(command.descriptionEn);
  };

  const handleSaveCommand = async () => {
    if (!editingCommand) return;
    if (!commandText.trim()) {
      message.warning(t('commands.commandRequired'));
      return;
    }
    try {
      if (editingCommand.isNew) {
        await api.addCommand({
          categoryId: editingCommand.categoryId,
          command: commandText.trim(),
          description: commandDesc.trim(),
          descriptionEn: commandDescEn.trim() || commandDesc.trim(),
        });
        message.success(t('commands.commandAdded'));
      } else {
        await api.updateCommand({
          categoryId: editingCommand.categoryId,
          commandId: editingCommand.command.id,
          command: commandText.trim(),
          description: commandDesc.trim(),
          descriptionEn: commandDescEn.trim() || commandDesc.trim(),
        });
        message.success(t('commands.commandUpdated'));
      }
      setEditingCommand(null);
      setCommandText('');
      setCommandDesc('');
      setCommandDescEn('');
      loadCommands();
    } catch {
      message.error(editingCommand.isNew ? t('commands.commandAddFail') : t('commands.commandUpdateFail'));
    }
  };

  const handleCancelCommandEdit = () => {
    setEditingCommand(null);
    setCommandText('');
    setCommandDesc('');
    setCommandDescEn('');
  };

  const handleDeleteCommand = async (categoryId, commandId) => {
    try {
      await api.deleteCommand({ categoryId, commandId });
      message.success(t('commands.commandDeleted'));
      loadCommands();
    } catch {
      message.error(t('commands.commandDeleteFail'));
    }
  };

  const handleReset = async () => {
    try {
      await api.resetCommands();
      message.success(t('commands.resetSuccess'));
      loadCommands();
    } catch {
      message.error(t('commands.resetFail'));
    }
  };

  return (
    <Modal
      title={<Space><CodeOutlined />{t('app.quickCommands')}</Space>}
      open={open}
      onCancel={() => {
        onClose();
        setEditingCategory(null);
        setEditingCommand(null);
      }}
      footer={null}
      width={700}
      destroyOnHidden
      confirmLoading={loading}
    >
      <div style={{ maxHeight: 500, overflowY: 'auto', paddingRight: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Text type="secondary">{t('commands.description')}</Text>
          <Button icon={<ReloadOutlined />} onClick={handleReset} size="small">
            {t('commands.reset')}
          </Button>
        </div>

        {categories.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: token.colorTextSecondary }}>
            <CodeOutlined style={{ fontSize: 48, marginBottom: 12, display: 'block' }} />
            <div>{t('commands.noCategories')}</div>
          </div>
        ) : (
          categories.map((category) => (
            <div key={category.id} style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ flex: 1 }}>
                  {editingCategory?.id === category.id ? (
                    <Space.Compact>
                      <Input
                        value={categoryName}
                        onChange={(e) => setCategoryName(e.target.value)}
                        style={{ width: 120 }}
                        placeholder={t('commands.categoryName')}
                      />
                      <Input
                        value={categoryNameEn}
                        onChange={(e) => setCategoryNameEn(e.target.value)}
                        style={{ width: 120 }}
                        placeholder="English"
                      />
                    </Space.Compact>
                  ) : (
                    <Space>
                      <Title level={5} style={{ margin: 0 }}>
                        {locale === 'zh-CN' ? category.name : category.nameEn}
                      </Title>
                      {locale === 'zh-CN' && category.nameEn && (
                        <Text type="secondary" style={{ fontSize: 12 }}>({category.nameEn})</Text>
                      )}
                    </Space>
                  )}
                </div>
                {editingCategory?.id === category.id ? (
                  <Space>
                    <Button size="small" onClick={handleSaveCategory}>{t('commands.save')}</Button>
                    <Button size="small" onClick={handleCancelCategoryEdit}>{t('create.cancel')}</Button>
                  </Space>
                ) : (
                  <Space>
                    <Button size="small" icon={<PlusOutlined />} onClick={() => handleAddCommand(category.id)}>
                      {t('commands.addCmd')}
                    </Button>
                    <Button size="small" icon={<EditOutlined />} onClick={() => handleEditCategory(category)}>
                      {t('commands.edit')}
                    </Button>
                    <Popconfirm
                      title={t('commands.deleteCategoryConfirm')}
                      onConfirm={() => handleDeleteCategory(category.id)}
                      okText={t('env.delete')}
                      cancelText={t('create.cancel')}
                    >
                      <Button size="small" icon={<DeleteOutlined />} danger>
                        {t('env.delete')}
                      </Button>
                    </Popconfirm>
                  </Space>
                )}
              </div>

              {category.commands.length === 0 ? (
                <Text type="secondary" style={{ fontSize: 12 }}>{t('commands.noCommands')}</Text>
              ) : (
                category.commands.map((cmd) => {
                  if (editingCommand?.categoryId === category.id && editingCommand?.command?.id === cmd.id) {
                    return (
                      <div key={cmd.id} style={{ marginBottom: 8, padding: 8, background: token.colorBgContainer, borderRadius: 4 }}>
                        <Input
                          value={commandText}
                          onChange={(e) => setCommandText(e.target.value)}
                          placeholder={t('commands.commandPlaceholder')}
                          style={{ marginBottom: 8 }}
                        />
                        <Input
                          value={commandDesc}
                          onChange={(e) => setCommandDesc(e.target.value)}
                          placeholder={t('commands.descPlaceholder')}
                          style={{ marginBottom: 4 }}
                        />
                        <Input
                          value={commandDescEn}
                          onChange={(e) => setCommandDescEn(e.target.value)}
                          placeholder="English description"
                          style={{ marginBottom: 8 }}
                        />
                        <Space>
                          <Button size="small" onClick={handleSaveCommand}>{t('commands.save')}</Button>
                          <Button size="small" onClick={handleCancelCommandEdit}>{t('create.cancel')}</Button>
                        </Space>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={cmd.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        padding: '8px 12px',
                        background: token.colorBgElevated,
                        borderRadius: 4,
                        marginBottom: 6,
                        gap: 12,
                      }}
                    >
                      <button
                        onClick={() => copyCommand(cmd.command)}
                        style={{
                          padding: '4px 12px',
                          background: token.colorBgContainer,
                          border: `1px solid ${token.colorBorder}`,
                          borderRadius: 4,
                          fontFamily: 'monospace',
                          fontSize: 13,
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                          color: token.colorText,
                        }}
                      >
                        {cmd.command}
                      </button>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, color: token.colorText }}>{locale === 'zh-CN' ? cmd.description : cmd.descriptionEn}</div>
                        {locale === 'zh-CN' && cmd.descriptionEn && (
                          <div style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 2 }}>{cmd.descriptionEn}</div>
                        )}
                      </div>
                      <Space>
                        <Button size="small" type="link" onClick={() => copyCommand(cmd.command)}>
                          {t('app.copy')}
                        </Button>
                        <Button size="small" icon={<EditOutlined />} onClick={() => handleEditCommand(category.id, cmd)} />
                        <Popconfirm
                          title={t('commands.deleteCmdConfirm')}
                          onConfirm={() => handleDeleteCommand(category.id, cmd.id)}
                          okText={t('env.delete')}
                          cancelText={t('create.cancel')}
                        >
                          <Button size="small" icon={<DeleteOutlined />} danger />
                        </Popconfirm>
                      </Space>
                    </div>
                  );
                })
              )}

              {editingCommand?.categoryId === category.id && editingCommand?.isNew && (
                <div style={{ marginBottom: 8, padding: 8, background: token.colorBgContainer, borderRadius: 4 }}>
                  <Input
                    value={commandText}
                    onChange={(e) => setCommandText(e.target.value)}
                    placeholder={t('commands.commandPlaceholder')}
                    style={{ marginBottom: 8 }}
                  />
                  <Input
                    value={commandDesc}
                    onChange={(e) => setCommandDesc(e.target.value)}
                    placeholder={t('commands.descPlaceholder')}
                    style={{ marginBottom: 4 }}
                  />
                  <Input
                    value={commandDescEn}
                    onChange={(e) => setCommandDescEn(e.target.value)}
                    placeholder="English description"
                    style={{ marginBottom: 8 }}
                  />
                  <Space>
                    <Button size="small" onClick={handleSaveCommand}>{t('commands.save')}</Button>
                    <Button size="small" onClick={handleCancelCommandEdit}>{t('create.cancel')}</Button>
                  </Space>
                </div>
              )}
            </div>
          ))
        )}

        <Divider style={{ margin: '20px 0' }} />

        <div style={{ display: 'flex', gap: 12 }}>
          <Input
            value={categoryName}
            onChange={(e) => setCategoryName(e.target.value)}
            placeholder={t('commands.categoryName')}
            style={{ width: 150 }}
          />
          <Input
            value={categoryNameEn}
            onChange={(e) => setCategoryNameEn(e.target.value)}
            placeholder="English name"
            style={{ width: 150 }}
          />
          <Button icon={<PlusOutlined />} onClick={handleAddCategory}>
            {t('commands.addCategory')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
