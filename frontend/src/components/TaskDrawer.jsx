import React, { useEffect } from 'react';
import { Drawer, Progress, Tag, Typography, Space, Empty, Divider, Button, Popconfirm } from 'antd';
import {
  LoadingOutlined, CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined,
  ClearOutlined, StopOutlined, FolderOpenOutlined,
} from '@ant-design/icons';
import { useI18n } from '../i18n/context';
import api from '../api';

const { Text } = Typography;

const TASK_TYPE_KEYS = {
  create: 'task.create', clone: 'task.clone', delete: 'task.delete',
  install: 'pkg.install', uninstall: 'pkg.uninstall', upgrade: 'pkg.upgrade',
  import: 'task.import', 'clean-invalid': 'env.clean',
  'install-req-to-env': 'pkg.installReq',
};

export default function TaskDrawer({ open, taskIds, tasks, onClose, onTaskUpdate, onClear, onCancel, onNewTask }) {
  const { t } = useI18n();

  // IPC 监听任务更新
  useEffect(() => {
    const unsub = api.onTaskUpdate((task) => {
      onTaskUpdate?.(task.task_id, task);
    });
    return unsub;
  }, [onTaskUpdate]);

  // 初始化任务列表中的 pending 状态
  useEffect(() => {
    taskIds.forEach((id) => {
      if (!tasks[id]) {
        onTaskUpdate?.(id, {
          task_id: id, task_type: '', status: 'pending', progress: 0, message: t('task.pending'),
        });
      }
    });
  }, [taskIds]);

  const remaining = taskIds.filter((id) => {
    const tk = tasks[id];
    return tk && tk.status !== 'completed' && tk.status !== 'failed';
  });

  const completed = taskIds.filter((id) => {
    const tk = tasks[id];
    return tk && (tk.status === 'completed' || tk.status === 'failed' || tk.status === 'cancelled');
  });

  return (
    <Drawer
      title={
        <Space>
          {t('task.title')}
          {remaining.length > 0 && <Tag color="processing">{t('task.inProgress', { n: remaining.length })}</Tag>}
        </Space>
      }
      placement="right"
      open={open}
      onClose={onClose}
      width={420}
      extra={completed.length > 0 && (
        <Button type="text" size="small" icon={<ClearOutlined />} onClick={onClear}>
          {t('task.clearCompleted')}
        </Button>
      )}
    >
      {taskIds.length === 0 ? (
        <Empty description={t('task.empty')} />
      ) : (
        taskIds.map((id) => {
          const tk = tasks[id];
          if (!tk) return null;
          return <TaskItem key={id} task={tk} onCancel={() => onCancel(id)} />;
        })
      )}
      {/* 固定在底部的清除按钮 */}
      {completed.length > 0 && (
        <div className="task-clear-footer">
          <Button block icon={<ClearOutlined />} onClick={onClear}>
            {t('task.clearCompleted')} ({completed.length})
          </Button>
        </div>
      )}
    </Drawer>
  );
}

function TaskItem({ task, onCancel }) {
  const { t } = useI18n();
  const { task_type, status, progress, message: msg, task_id, extra, envName } = task;
  const canForceDelete = extra?.canForceDelete === true;

  const cfg = {
    pending:  { icon: <ClockCircleOutlined />, color: 'default',    text: t('task.pending') },
    running:  { icon: <LoadingOutlined spin />, color: 'processing', text: t('task.running') },
    completed:{ icon: <CheckCircleOutlined />,   color: 'success',   text: t('task.completed') },
    failed:   { icon: <CloseCircleOutlined />,   color: 'error',     text: t('task.failed') },
  };

  const c = cfg[status] || cfg.pending;

  const handleOpenDir = async () => {
    try {
      await api.openPath(extra.envPath);
    } catch (err) {
      console.error('打开目录失败:', err);
    }
  };

  return (
    <div className="task-item">
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <Space>
          <Tag icon={c.icon} color={c.color}>{c.text}</Tag>
          <Text strong>
            {t(TASK_TYPE_KEYS[task_type] || task_type)}
            {envName && <Text type="secondary" style={{ fontWeight: 'normal', marginLeft: 4 }}>- {envName}</Text>}
          </Text>
        </Space>
        <Progress
          percent={progress}
          status={status === 'failed' ? 'exception' : status === 'completed' ? 'success' : 'active'}
          size="small"
          strokeColor={status === 'failed' ? 'var(--color-error)' : 'var(--color-primary)'}
        />
        <Space>
          <Text type="secondary" style={{ fontSize: 13, wordBreak: 'break-all' }}>{msg}</Text>
          {(status === 'running' || status === 'pending') && (
            <Popconfirm
              title={t('task.cancelConfirm')}
              onConfirm={onCancel}
              okText={t('task.cancelBtn')}
              cancelText={t('create.cancel')}
            >
              <Button size="small" icon={<StopOutlined />} danger type="text">
                {t('task.cancel')}
              </Button>
            </Popconfirm>
          )}
          {status === 'failed' && canForceDelete && (
            <Button size="small" icon={<FolderOpenOutlined />} type="text" onClick={handleOpenDir}>
              {t('task.openDir')}
            </Button>
          )}
        </Space>
        {/* 终端输出 */}
        {task._stdout && (
          <div style={{
            maxHeight: 160, overflowY: 'auto', marginTop: 4, padding: '6px 8px',
            background: 'rgba(0,0,0,0.04)', borderRadius: 4, fontSize: 11,
            fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", "SF Mono", "Consolas", monospace',
            whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.4,
          }}>
            {task._stdout.trim()}
          </div>
        )}
      </Space>
      <Divider style={{ margin: '8px 0 0' }} />
    </div>
  );
}
