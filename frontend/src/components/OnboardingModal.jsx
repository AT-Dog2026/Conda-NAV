import React, { useState, useEffect } from 'react';
import {
  Modal, Steps, Button, Space, Input, Alert, Typography, message, Switch, theme,
} from 'antd';
import {
  RocketOutlined, SearchOutlined, CheckCircleOutlined,
  FolderOpenOutlined, CloseCircleOutlined,
} from '@ant-design/icons';
import { useI18n } from '../i18n/context';
import api from '../api';

const { Text, Paragraph } = Typography;

export default function OnboardingModal({ open, onComplete, onSkip }) {
  const { t } = useI18n();
  const { token } = theme.useToken();
  const [step, setStep] = useState(0);
  const [condaPath, setCondaPath] = useState('');
  const [mambaPath, setMambaPath] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState(null);
  const [testInfo, setTestInfo] = useState('');
  const [saving, setSaving] = useState(false);
  const [calcEnvSize, setCalcEnvSize] = useState(false);

  useEffect(() => {
    if (open) {
      setStep(0);
      setTestOk(null);
      setTestInfo('');
      setCalcEnvSize(false);
      api.checkCondaStatus()
        .then((res) => {
          const d = res.data;
          if (d.conda_path) setCondaPath(d.conda_path);
          if (d.mamba_path) setMambaPath(d.mamba_path);
          if (d.conda_ok) {
            setTestOk(true);
            setTestInfo(d.conda_info);
          }
        })
        .catch(() => {});
    }
  }, [open]);

  const handleAutoDetect = async () => {
    setDetecting(true);
    setTestOk(null);
    try {
      const res = await api.autoDetect();
      setCondaPath(res.data.conda_path || '');
      setMambaPath(res.data.mamba_path || '');
      message.info(t('onboarding.autoDetected'));
    } catch {
      message.error(t('settings.autoDetectFail'));
    } finally {
      setDetecting(false);
    }
  };

  const handleBrowse = async (type) => {
    if (!window.electron?.openFileDialog) {
      message.info(t('settings.browseManual'));
      return;
    }
    try {
      const filePath = await window.electron.openFileDialog({
        title: type === 'conda' ? t('settings.condaPath') : t('settings.mambaPath'),
        filters: [{ name: 'Executables', extensions: ['exe', 'bat'] }],
      });
      if (filePath) {
        if (type === 'conda') setCondaPath(filePath);
        else setMambaPath(filePath);
        setTestOk(null);
      }
    } catch {
      message.error(t('settings.browseFail'));
    }
  };

  const handleTest = async () => {
    if (!condaPath) {
      message.warning(t('settings.pathRequired'));
      return false;
    }
    setTesting(true);
    setTestOk(null);
    try {
      const res = await api.testConda({ path: condaPath });
      setTestOk(res.data.ok);
      setTestInfo(res.data.info);
      res.data.ok ? message.success(res.data.info) : message.error(res.data.info);
      return res.data.ok;
    } catch (err) {
      setTestOk(false);
      setTestInfo(err.message);
      return false;
    } finally {
      setTesting(false);
    }
  };

  const handleNextToConfirm = async () => {
    if (!condaPath) {
      message.warning(t('settings.pathRequired'));
      return;
    }
    if (testOk === null) await handleTest();
    setStep(2);
  };

  const handleFinish = async () => {
    if (!condaPath) {
      message.warning(t('settings.pathRequired'));
      return;
    }
    setSaving(true);
    try {
      await api.completeOnboarding({ conda_path: condaPath, mamba_path: mambaPath, calc_env_size: calcEnvSize });
      message.success(t('onboarding.done'));
      onComplete?.();
    } catch {
      message.error(t('settings.saveFail'));
    } finally {
      setSaving(false);
    }
  };

  const steps = [
    { title: t('onboarding.stepWelcome') },
    { title: t('onboarding.stepConfig') },
    { title: t('onboarding.stepDone') },
  ];

  return (
    <Modal
      title={
        <Space>
          <RocketOutlined style={{ color: 'var(--color-primary)' }} />
          {t('onboarding.title')}
        </Space>
      }
      open={open}
      closable={false}
      maskClosable={false}
      footer={null}
      width={620}
      destroyOnClose
    >
      <Steps current={step} items={steps} size="small" style={{ marginBottom: 24 }} />

      {step === 0 && (
        <>
          <Alert
            type="info"
            showIcon
            message={t('onboarding.welcomeTitle')}
            description={t('onboarding.welcomeDesc')}
            style={{ marginBottom: 16 }}
          />
          <Paragraph type="secondary">{t('onboarding.requirements')}</Paragraph>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
            <Button onClick={onSkip} style={{ color: token.colorText, borderColor: token.colorBorder }}>{t('onboarding.skip')}</Button>
            <Button type="primary" onClick={() => setStep(1)}>{t('onboarding.next')}</Button>
          </div>
        </>
      )}

      {step === 1 && (
        <>
          <div style={{ marginBottom: 12, textAlign: 'right' }}>
            <Button icon={<SearchOutlined />} onClick={handleAutoDetect} loading={detecting} size="small" style={{ color: token.colorText, borderColor: token.colorBorder }}>
              {t('settings.autoDetect')}
            </Button>
          </div>

          <div style={{ marginBottom: 16 }}>
            <Text strong>{t('settings.condaPath')}</Text>
            <Space.Compact style={{ width: '100%', marginTop: 4 }}>
              <Input
                value={condaPath}
                onChange={(e) => { setCondaPath(e.target.value); setTestOk(null); }}
                placeholder={t('settings.condaPlaceholder')}
              />
              <Button icon={<FolderOpenOutlined />} onClick={() => handleBrowse('conda')} style={{ color: token.colorText, borderColor: token.colorBorder }}>
                {t('settings.browse')}
              </Button>
            </Space.Compact>
          </div>

          <div style={{ marginBottom: 16 }}>
            <Text strong>{t('settings.mambaPath')} <Text type="secondary">({t('settings.mambaOptional')})</Text></Text>
            <Space.Compact style={{ width: '100%', marginTop: 4 }}>
              <Input
                value={mambaPath}
                onChange={(e) => setMambaPath(e.target.value)}
                placeholder={t('settings.mambaPlaceholder')}
              />
              <Button icon={<FolderOpenOutlined />} onClick={() => handleBrowse('mamba')} style={{ color: token.colorText, borderColor: token.colorBorder }}>
                {t('settings.browse')}
              </Button>
            </Space.Compact>
          </div>

          <Space>
            <Button onClick={handleTest} loading={testing} style={{ color: token.colorText, borderColor: token.colorBorder }}>{t('settings.test')}</Button>
            {testOk === true && <Text type="success"><CheckCircleOutlined /> {testInfo}</Text>}
            {testOk === false && <Text type="danger"><CloseCircleOutlined /> {testInfo}</Text>}
          </Space>

          {/* 可选：开启环境磁盘占用计算 */}
          <div style={{ marginTop: 16, padding: '8px 12px', background: token.colorFillQuaternary, borderRadius: 6 }}>
            <Space>
              <Switch size="small" checked={calcEnvSize} onChange={(v) => setCalcEnvSize(v)} />
              <Text style={{ fontSize: 13 }}>{t('onboarding.calcEnvSizeOption')}</Text>
            </Space>
            <div style={{ marginTop: 4 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('onboarding.calcEnvSizeHint')}</Text>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
            <Button onClick={() => setStep(0)} style={{ color: token.colorText, borderColor: token.colorBorder }}>{t('onboarding.back')}</Button>
            <Space>
              <Button onClick={onSkip} style={{ color: token.colorText, borderColor: token.colorBorder }}>{t('onboarding.skip')}</Button>
              <Button type="primary" disabled={!condaPath} onClick={handleNextToConfirm}>
                {t('onboarding.next')}
              </Button>
            </Space>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <Alert
            type={testOk ? 'success' : 'warning'}
            showIcon
            message={testOk ? t('onboarding.readyTitle') : t('onboarding.notReadyTitle')}
            description={testOk ? t('onboarding.readyDesc') : t('onboarding.notReadyDesc')}
            style={{ marginBottom: 16 }}
          />
          {condaPath && (
            <Paragraph>
              <Text type="secondary">{t('settings.condaPath')}：</Text>
              <Text code>{condaPath}</Text>
            </Paragraph>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
            <Button onClick={() => setStep(1)} style={{ color: token.colorText, borderColor: token.colorBorder }}>{t('onboarding.back')}</Button>
            <Button type="primary" loading={saving} onClick={handleFinish}>
              {t('onboarding.start')}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
