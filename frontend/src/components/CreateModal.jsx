import React, { useEffect, useState } from 'react';
import { Modal, Form, Input, Select, Alert, Space, Radio, message } from 'antd';
import { BranchesOutlined, PlusOutlined, ImportOutlined } from '@ant-design/icons';
import { useI18n } from '../i18n/context';
import { envNameFormRules } from '../utils/envName';

/**
 * 新建 / 克隆 / 从 yml 或 requirements.txt 导入 弹窗
 * mode: 'create' | 'clone' | 'import'
 * importFilePath: 仅 import 模式，文件路径
 * importType: 'yml' | 'req'（requirements.txt）
 * environments: 环境列表（仅 import-req 模式用于选择现有环境）
 */
export default function CreateModal({ open, mode, cloneSource, importFilePath, importType, environments, onCancel, onSubmit }) {
  const { t } = useI18n();
  const [form] = Form.useForm();
  const isClone = mode === 'clone';
  const isImport = mode === 'import';
  const isImportReq = isImport && importType === 'req';
  const [targetMode, setTargetMode] = useState('new'); // 'new' | 'existing'

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({ name: '', python_version: '3.12', target_mode: 'new', existing_env: '' });
      setTargetMode('new');
    }
  }, [open, mode, cloneSource, importFilePath, importType, form]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      // 如果选择导入到现有环境，只传 name 字段
      if (isImportReq && targetMode === 'existing') {
        onSubmit({ name: values.existing_env, is_existing: true });
      } else {
        onSubmit({ ...values, is_existing: false });
      }
    } catch { /* 校验未通过 */ }
  };

  const getTitleIcon = () => {
    if (isImport) return <ImportOutlined style={{ color: 'var(--color-primary)' }} />;
    if (isClone) return <BranchesOutlined style={{ color: 'var(--color-primary)' }} />;
    return <PlusOutlined style={{ color: 'var(--color-primary)' }} />;
  };

  const getTitleText = () => {
    if (isImportReq) return t('create.titleImportReq');
    if (isImport) return t('create.titleImport');
    if (isClone) return t('create.titleClone');
    return t('create.titleNew');
  };

  const getOkText = () => {
    if (isImport) return t('create.importBtn');
    if (isClone) return t('create.cloneBtn');
    return t('create.createBtn');
  };

  const showPythonSelect = (!isClone && !isImport) || (isImportReq && targetMode === 'new');
  const showNameInput = !isImport || (isImport && importType !== 'req') || (isImportReq && targetMode === 'new');

  const handleTargetModeChange = (e) => {
    setTargetMode(e.target.value);
    if (e.target.value === 'existing' && environments && environments.length > 0) {
      form.setFieldsValue({ existing_env: environments[0].name });
    }
  };

  return (
    <Modal
      title={<Space>{getTitleIcon()}{getTitleText()}</Space>}
      open={open}
      onOk={handleOk}
      onCancel={onCancel}
      okText={getOkText()}
      cancelText={t('create.cancel')}
      destroyOnClose
    >
      {isImport && importFilePath && (
        <Alert
          message={isImportReq
            ? t('create.importFromReq', { file: importFilePath })
            : t('create.importFrom', { file: importFilePath })}
          type="info" showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      {isClone && cloneSource && (
        <Alert
          message={t('create.cloneFrom', { name: cloneSource.name, ver: cloneSource.python_version || t('env.unknown') })}
          type="info" showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      {/* requirements.txt 导入时显示目标环境选择（放在 Form 外面避免绑定问题） */}
      {isImportReq && environments && environments.length > 0 && (
        <Form.Item label={t('create.importTarget')}>
          <Radio.Group value={targetMode} onChange={handleTargetModeChange}>
            <Radio value="new">{t('create.importToNew')}</Radio>
            <Radio value="existing">{t('create.importToExisting')}</Radio>
          </Radio.Group>
        </Form.Item>
      )}

      <Form form={form} layout="vertical">
        {/* 导入到现有环境时显示下拉框 */}
        {isImportReq && targetMode === 'existing' && (
          <Form.Item
            name="existing_env"
            label={t('create.selectEnv')}
            rules={[{ required: true, message: t('create.envRequired') }]}
          >
            <Select
              placeholder={t('create.selectEnvPlaceholder')}
              options={environments.map(e => ({ label: e.name, value: e.name }))}
            />
          </Form.Item>
        )}

        {/* 新建环境时显示名称输入框 */}
        {showNameInput && (
          <Form.Item
            name="name"
            label={t('create.name')}
            rules={envNameFormRules(t)}
          >
            <Input placeholder={t('create.namePlaceholder')} maxLength={32} />
          </Form.Item>
        )}

        {/* Python 版本选择（新建环境时显示） */}
        {showPythonSelect && (
          <Form.Item
            name="python_version"
            label={t('create.pythonVer')}
            rules={[{ required: true, message: t('create.pythonRequired') }]}
          >
            <Select
              placeholder={t('create.pythonPlaceholder')}
              options={[
                { label: 'Python 3.12', value: '3.12' },
                { label: 'Python 3.11', value: '3.11' },
                { label: 'Python 3.10', value: '3.10' },
                { label: 'Python 3.9', value: '3.9' },
                { label: 'Python 3.8', value: '3.8' },
              ]}
            />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}