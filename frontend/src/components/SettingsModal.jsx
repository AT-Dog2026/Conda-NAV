import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Modal, Input, Button, Space, Select, Switch, InputNumber, Radio, message, Typography, Row, Col, Tooltip, theme, App } from 'antd';
import {
  SettingOutlined, SearchOutlined, CheckCircleOutlined,
  CloseCircleOutlined, FolderOpenOutlined, FileTextOutlined,
  ConsoleSqlOutlined, GlobalOutlined, SettingFilled,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { useI18n } from '../i18n/context';
import api from '../api';

const { Text } = Typography;
const { useToken } = theme;

export default function SettingsModal({ open, onClose, onSaved, onOpenTerminal, inline }) {
  const { t, locale, setLocale } = useI18n();
  const { token } = useToken();
  const { modal } = App.useApp();
  const [condaPath, setCondaPath] = useState('');
  const [mambaPath, setMambaPath] = useState('');
  const [testing, setTesting] = useState({ conda: false, mamba: false });
  const [testResult, setTestResult] = useState({ conda: null, mamba: null });
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [openingSettingsDir, setOpeningSettingsDir] = useState(false);
  const [calcEnvSize, setCalcEnvSize] = useState(false);
  const [calcTimeoutSec, setCalcTimeoutSec] = useState(30);
  const [autoStart, setAutoStart] = useState(false);
  const [silentStart, setSilentStart] = useState(false);
  const [basicOpMode, setBasicOpMode] = useState('terminal');
  const readyRef = useRef(false);
  const skipFirstRef = useRef(true);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  useEffect(() => {
    if (inline || open) {
      api.getSettings()
        .then((res) => {
          setCondaPath(res.data.conda_path || '');
          setMambaPath(res.data.mamba_path || '');
          setCalcEnvSize(!!res.data.calc_env_size);
          setCalcTimeoutSec(res.data.calc_timeout_sec ?? 30);
          setAutoStart(!!res.data.auto_start);
          setSilentStart(!!res.data.silent_start);
          setBasicOpMode(res.data.basic_op_mode || 'terminal');
          setTestResult({ conda: null, mamba: null });
          readyRef.current = true;
        })
        .catch(() => {});
    }
  }, [inline, open]);

  // 自动保存：设置项变化后立即保存
  const autoSave = useCallback(async () => {
    setSaving(true);
    try {
      await api.saveSettings({
        conda_path: condaPath,
        mamba_path: mambaPath,
        onboarding_completed: true,
        calc_env_size: calcEnvSize,
        calc_timeout_sec: calcTimeoutSec,
        auto_start: autoStart,
        silent_start: silentStart,
        basic_op_mode: basicOpMode,
      });
      await api.setAutoStart(autoStart);
      onSavedRef.current?.();
    } catch {
      // 自动保存静默失败，避免频繁提示
    } finally {
      setSaving(false);
    }
  }, [condaPath, mambaPath, calcEnvSize, calcTimeoutSec, autoStart, silentStart, basicOpMode]);

  useEffect(() => {
    if (!readyRef.current) return;
    // 跳过初始化加载后的首次触发，只在用户修改后保存
    if (skipFirstRef.current) {
      skipFirstRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      autoSave();
    }, 0);
    return () => clearTimeout(timer);
  }, [autoSave]);

  const handleBrowse = async (type) => {
    if (window.electron?.openFileDialog) {
      try {
        const filePath = await window.electron.openFileDialog({
          title: type === 'conda' ? t('settings.condaPath') : t('settings.mambaPath'),
          filters: [{ name: 'Executables', extensions: ['exe', 'bat'] }],
        });
        if (filePath) {
          if (type === 'conda') setCondaPath(filePath);
          else setMambaPath(filePath);
          setTestResult((prev) => ({ ...prev, [type]: null }));
        }
      } catch {
        message.error(t('settings.browseFail'));
      }
      return;
    }
    message.info(t('settings.browseManual'));
  };

  const handleTest = async (type) => {
    const path = type === 'conda' ? condaPath : mambaPath;
    if (!path) { message.warning(t('settings.pathRequired')); return; }
    setTesting((prev) => ({ ...prev, [type]: true }));
    setTestResult((prev) => ({ ...prev, [type]: null }));
    try {
      const res = await api.testConda({ path });
      setTestResult((prev) => ({ ...prev, [type]: { ok: res.data.ok, info: res.data.info } }));
      res.data.ok ? message.success(res.data.info) : message.error(res.data.info);
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [type]: { ok: false, info: err.message } }));
    } finally {
      setTesting((prev) => ({ ...prev, [type]: false }));
    }
  };

  const handleAutoDetect = async () => {
    setDetecting(true);
    try {
      const res = await api.autoDetect();
      setCondaPath(res.data.conda_path || '');
      setMambaPath(res.data.mamba_path || '');
      message.info(t('settings.autoDetected'));
    } catch {
      message.error(t('settings.autoDetectFail'));
    } finally {
      setDetecting(false);
    }
  };

  const handleOpenSettingsDir = async () => {
    setOpeningSettingsDir(true);
    try {
      await api.openSettingsDir();
      message.success(t('settings.openedDir'));
    } catch {
      message.error(t('settings.openDirFail'));
    } finally {
      setOpeningSettingsDir(false);
    }
  };

  const testIcon = (type) => {
    const r = testResult[type];
    if (r === null) return null;
    if (r.ok) return <CheckCircleOutlined style={{ color: '#52c41a' }} />;
    return <CloseCircleOutlined style={{ color: '#ff4d4f' }} />;
  };

  // 统一的分区卡片样式
  const sectionStyle = {
    background: 'var(--bg-card)',
    borderRadius: token.borderRadiusLG,
    padding: 16,
    marginBottom: 12,
    border: '1px solid var(--border-primary)',
  };

  const sectionTitleStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
    paddingBottom: 8,
    borderBottom: `1px solid ${token.colorBorderSecondary}`,
  };

  const settingRowStyle = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    padding: '6px 0',
  };

  const subSettingStyle = {
    marginTop: 12,
    marginLeft: 44,
    padding: '10px 12px',
    background: token.colorBgContainer,
    borderRadius: token.borderRadius,
    border: `1px dashed ${token.colorBorderSecondary}`,
  };

  // ── 共享的内容区域 ──
  const settingsContent = (
    <>
      {/* ── 首行：界面语言 + 系统工具 并排 ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: 12,
        marginBottom: 12,
      }}>
        {/* ── 界面设置 ── */}
        <div style={{ ...sectionStyle, marginBottom: 0 }}>
          <div style={sectionTitleStyle}>
            <GlobalOutlined style={{ color: token.colorPrimary, fontSize: 15 }} />
            <Text strong style={{ fontSize: 14 }}>{t('settings.language')}</Text>
          </div>
          <Select
            value={locale}
            onChange={setLocale}
            style={{ width: '100%' }}
            options={[
              { label: `${t('settings.zh')} (简体中文)`, value: 'zh-CN' },
              { label: `${t('settings.en')} (English)`, value: 'en-US' },
            ]}
          />
        </div>

        {/* ── 系统工具 ── */}
        <div style={{ ...sectionStyle, marginBottom: 0 }}>
          <div style={sectionTitleStyle}>
            <FileTextOutlined style={{ color: token.colorPrimary, fontSize: 15 }} />
            <Text strong style={{ fontSize: 14 }}>{t('settings.systemTools')}</Text>
          </div>
          <Space size={12} wrap>
            <Button icon={<FileTextOutlined />} onClick={handleOpenSettingsDir} loading={openingSettingsDir} size="small">
              {t('settings.openSettingsDir')}
            </Button>
            <Button icon={<ConsoleSqlOutlined />} onClick={onOpenTerminal} size="small">
              {t('app.terminal')}
            </Button>
          </Space>
        </div>
      </div>

      {/* ── 环境设置 ── */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <SettingFilled style={{ color: token.colorPrimary, fontSize: 15 }} />
          <Text strong style={{ fontSize: 14 }}>{t('settings.condaPath')}</Text>
          <Tooltip title={
            <div>
              <div style={{ fontWeight: 'bold', marginBottom: 4 }}>{t('settings.info')}</div>
              <div style={{ fontSize: 12 }}>{t('settings.infoDesc')}</div>
            </div>
          }>
            <QuestionCircleOutlined style={{ color: token.colorTextQuaternary, cursor: 'help', fontSize: 14 }} />
          </Tooltip>
          <div style={{ flex: 1 }} />
          <Button
            icon={<SearchOutlined />}
            onClick={handleAutoDetect}
            loading={detecting}
            size="small"
            type="default"
          >
            {t('settings.autoDetect')}
          </Button>
        </div>

        {/* Conda 路径 */}
        <div style={{ marginBottom: 14 }}>
          <Text type="secondary" style={{ fontSize: 12, marginBottom: 6, display: 'block' }}>
            Conda ({t('settings.condaPath')})
          </Text>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={condaPath}
              onChange={(e) => { setCondaPath(e.target.value); setTestResult((prev) => ({ ...prev, conda: null })); }}
              placeholder={t('settings.condaPlaceholder')}
              suffix={
                <Space size={0}>
                  {testIcon('conda')}
                  <Button size="small" onClick={() => handleTest('conda')} loading={testing.conda} type="link" style={{ padding: '0 8px' }}>{t('settings.test')}</Button>
                </Space>
              }
            />
            <Button icon={<FolderOpenOutlined />} onClick={() => handleBrowse('conda')}>{t('settings.browse')}</Button>
          </Space.Compact>
        </div>

        {/* Mamba 路径 */}
        <div>
          <Text type="secondary" style={{ fontSize: 12, marginBottom: 6, display: 'block' }}>
            Mamba <Text style={{ color: token.colorSuccess }}>({t('settings.mambaOptional')})</Text>
          </Text>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={mambaPath}
              onChange={(e) => { setMambaPath(e.target.value); setTestResult((prev) => ({ ...prev, mamba: null })); }}
              placeholder={t('settings.mambaPlaceholder')}
              suffix={
                <Space size={0}>
                  {testIcon('mamba')}
                  <Button size="small" onClick={() => handleTest('mamba')} loading={testing.mamba} type="link" style={{ padding: '0 8px' }}>{t('settings.test')}</Button>
                </Space>
              }
            />
            <Button icon={<FolderOpenOutlined />} onClick={() => handleBrowse('mamba')}>{t('settings.browse')}</Button>
          </Space.Compact>
        </div>
      </div>

      {/* ── 高级设置 ── */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>
          <SettingOutlined style={{ color: token.colorPrimary, fontSize: 15 }} />
          <Text strong style={{ fontSize: 14 }}>{t('settings.advanced')}</Text>
        </div>

        {/* 计算环境磁盘占用 */}
        <div style={settingRowStyle}>
          <Switch checked={calcEnvSize} onChange={(v) => setCalcEnvSize(v)} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div><Text>{t('settings.calcEnvSize')}</Text></div>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.calcEnvSizeDesc')}</Text>
          </div>
        </div>

        {calcEnvSize && (
          <div style={subSettingStyle}>
            <Row align="middle" gutter={[12, 0]}>
              <Col flex="none">
                <Text style={{ fontSize: 13 }}>{t('settings.calcTimeout')}</Text>
              </Col>
              <Col flex="none">
                <InputNumber
                  size="small"
                  min={5}
                  max={300}
                  value={calcTimeoutSec}
                  onChange={(v) => setCalcTimeoutSec(v || 30)}
                  style={{ width: 'auto', minWidth: 72 }}
                />
              </Col>
              <Col flex="none">
                <Text type="secondary" style={{ fontSize: 13 }}>{t('settings.calcTimeoutUnit')}</Text>
              </Col>
            </Row>
            <div style={{ marginTop: 4 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.calcTimeoutHint')}</Text>
            </div>
          </div>
        )}

        {/* 开机自启 */}
        <div style={settingRowStyle}>
          <Switch checked={autoStart} onChange={(v) => setAutoStart(v)} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div><Text>{t('settings.autoStart')}</Text></div>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.autoStartDesc')}</Text>
          </div>
        </div>

        {autoStart && (
          <div style={subSettingStyle}>
            <div style={{ ...settingRowStyle, padding: 0 }}>
              <Switch size="small" checked={silentStart} onChange={(v) => setSilentStart(v)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div><Text>{t('settings.silentStart')}</Text></div>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.silentStartDesc')}</Text>
              </div>
            </div>
          </div>
        )}

        {/* ── 基础操作方式 ── */}
        <div style={{ marginTop: 12, borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 12 }}>
          <div style={{ marginBottom: 8 }}>
            <Text>{t('settings.basicOpMode')}</Text>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.basicOpModeDesc')}</Text>
            </div>
          </div>
          <Radio.Group
            value={basicOpMode}
            onChange={(e) => {
              const newMode = e.target.value;
              if (newMode === 'queue' && basicOpMode !== 'queue') {
                modal.confirm({
                  title: t('settings.basicOpModeConfirmTitle'),
                  content: <div style={{ whiteSpace: 'pre-line', fontSize: 13, lineHeight: 1.7 }}>{t('settings.basicOpModeConfirmContent')}</div>,
                  okText: t('settings.basicOpModeQueue'),
                  cancelText: t('delete.cancel'),
                  width: 480,
                  onOk: () => setBasicOpMode('queue'),
                });
              } else {
                setBasicOpMode(newMode);
              }
            }}
            optionType="button"
            buttonStyle="solid"
            size="small"
          >
            <Radio.Button value="queue">{t('settings.basicOpModeQueue')}</Radio.Button>
            <Radio.Button value="terminal">{t('settings.basicOpModeTerminal')}</Radio.Button>
          </Radio.Group>
        </div>
      </div>

    </>
  );

  // ── 内联模式（嵌入在侧边栏内容区） ──
  if (inline) {
    return (
      <div style={{ width: '100%', maxWidth: 760, margin: '0 auto' }}>
        {/* 页面标题栏 */}
        <div style={{
          display: 'flex', alignItems: 'center',
          marginBottom: 16, paddingBottom: 12,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}>
          <Space>
            <SettingOutlined style={{ color: token.colorPrimary, fontSize: 18 }} />
            <Text strong style={{ fontSize: 16 }}>{t('settings.title')}</Text>
            {saving && <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.saving')}</Text>}
          </Space>
        </div>

        {settingsContent}
      </div>
    );
  }

  // ── 弹窗模式（原有行为） ──
  return (
    <Modal
      title={<Space><SettingOutlined />{t('settings.title')}</Space>}
      open={open}
      onCancel={onClose}
      footer={
        <Button onClick={onClose}>{t('create.cancel')}</Button>
      }
      width={720}
      destroyOnClose
      styles={{ body: { padding: '12px 24px' } }}
    >
      {settingsContent}
    </Modal>
  );
}
