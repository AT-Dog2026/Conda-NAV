# Conda NAV

轻量级 Conda 环境管理桌面应用 —— Anaconda Navigator 的轻量替代。

## Download下载
https://github.com/AT-Dog2026/Conda-NAV/releases
## 功能

| 模块 | 功能 |
|------|------|
| 环境列表 | 卡片式展示，显示名称、路径、Python 版本、包数量、磁盘占用 |
| 搜索 / 分页 | 前端实时搜索 + 分页浏览，大量环境流畅操作 |
| 创建 / 克隆 / 删除 | 后台异步任务执行，IPC 实时推送进度 |
| 包管理 | 查看已安装包、安装 / 卸载 / 升级，区分 conda 与 pip 来源 |
| 激活与终端 | 一键激活环境，支持 CMD / Windows Terminal 打开 |
| 项目目录 | 绑定项目目录，终端打开时自动 cd 到指定位置 |
| 导出 / 导入 | 导出 `environment.yml`；导入 yml / requirements.txt 均打开终端执行 |
| 磁盘占用 | 可选后台计算每个环境的磁盘大小，超时自动降级 |
| 清理无效环境 | 检测并一键清理无 `conda-meta` 的损坏环境 |
| 托盘菜单 | 系统托盘常驻，右键切换环境 / 新建 / 打开终端 |
| 全局快捷键 | `Ctrl+Shift+C` 唤醒主窗口 |
| 主题 / 语言 | 深色 / 浅色 / 跟随系统，中英文切换 |
| 保留名保护 | `base` / `root` 环境禁止删除 |

## 技术栈

| 层 | 方案 |
|:---|:---|
| 桌面框架 | Electron 42 |
| 前端 | React 18 + Ant Design 5 + Vite 5 |
| 前后端通信 | IPC（优先） + HTTP API（浏览器模式兜底） |
| Conda 调用 | `child_process` 子进程，自动兼容 mamba |
| 任务队列 | 内存 Map + FIFO 串行执行，支持取消 |
| 打包 | electron-builder → NSIS 安装包 + 绿色便携版 |
| 国际化 | 自定义 Context，简体中文 / English |

## 快速开始

### 一键启动（推荐）

```bash
# 安装所有依赖
npm run install:all

# 启动开发模式（Vite + Electron 同时运行）
npm run dev
```

### 分步启动

**终端 1 — 前端开发服务器：**
```bash
cd frontend && npm install && npm run dev
```

**终端 2 — Electron：**
```bash
npm install && npm run dev:electron
```

## 打包分发

```bash
npm run build
```

`release/` 目录产出：

| 文件 | 说明 |
|:---|:---|
| `Conda NAV Setup x.x.x.exe` | NSIS 安装版（推荐分发） |
| `Conda NAV x.x.x.exe` | 绿色便携版 |

### 运行环境

- Windows 10 / 11 64 位
- 已安装 [Anaconda](https://www.anaconda.com/) / [Miniconda](https://docs.conda.io/en/latest/miniconda.html) / [Miniforge](https://github.com/conda-forge/miniforge)
- 首次启动自动弹出配置向导，可自动探测或手动指定 conda 路径

### 代码签名（可选）

```powershell
$env:CSC_LINK="C:\path\to\cert.pfx"
$env:CSC_KEY_PASSWORD="your-password"
npm run build
```

并在 `package.json` → `build.win` 中设置 `"signAndEditExecutable": true`。

## 目录结构

```
Conda NAV/
├── electron/
│   ├── main.js               # Electron 主进程入口 + IPC 注册
│   ├── preload.js             # contextBridge 安全桥接
│   └── services/
│       ├── conda.js           # Conda 子进程调用、环境发现、磁盘占用
│       ├── condarc.js         # .condarc 解析
│       ├── handlers.js        # 统一业务逻辑层
│       ├── tasks.js           # 串行任务队列 + 进度推送
│       ├── settings.js        # 设置持久化 + 自动探测
│       ├── http-api.js        # 本地 HTTP API（浏览器调试用）
│       ├── state.js           # 进程内共享状态
│       └── auth.js            # HTTP API 鉴权 token
├── frontend/
│   ├── src/
│   │   ├── App.jsx            # 主布局 + 全局状态
│   │   ├── main.jsx           # React 入口
│   │   ├── api.js             # IPC / HTTP 双模式 API 封装
│   │   ├── utils/             # 工具函数
│   │   ├── i18n/              # 中 / 英 国际化
│   │   └── components/
│   │       ├── EnvList.jsx      # 环境卡片列表 + 分页
│   │       ├── CreateModal.jsx  # 新建 / 克隆 / 导入弹窗
│   │       ├── PackageModal.jsx # 包管理面板
│   │       ├── TaskDrawer.jsx   # 任务进度侧栏
│   │       ├── SettingsModal.jsx# 设置面板
│   │       ├── OnboardingModal.jsx # 首次配置向导
│   │       └── TerminalDrawer.jsx  # 内置日志终端
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── build/
│   └── icon.png               # 应用图标源文件
├── icon.ico                   # Windows 图标
├── package.json               # 根（Electron + 打包配置）
└── README.md
```

## npm 脚本

| 脚本 | 说明 |
|:---|:---|
| `npm run install:all` | 安装前端 + Electron 全部依赖 |
| `npm run dev` | 同时启动 Vite + Electron（开发） |
| `npm run dev:fe` | 仅启动 Vite 前端 |
| `npm run dev:electron` | 仅启动 Electron |
| `npm run build` | 构建前端 + 打包安装包 |
| `npm run build:fe` | 仅构建前端 |
| `npm run build:electron` | 仅打包 Electron |
| `npm run start` | 启动已打包/构建后的应用 |

## HTTP API 参考

IPC 模式优先，以下接口在 `127.0.0.1` 上提供，用于浏览器模式或调试：

### 环境

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| GET | `/api/environments` | 环境列表 |
| POST | `/api/environments/create` | 新建环境 → 返回 `task_id` |
| POST | `/api/environments/clone` | 克隆环境 |
| POST | `/api/environments/delete` | 删除环境 |
| POST | `/api/environments/clean-invalid` | 清理无效环境 |
| GET | `/api/environments/activated` | 当前激活环境 |
| POST | `/api/environments/:name/activate` | 激活环境 |
| POST | `/api/environments/:name/terminal` | 用终端打开 |
| GET | `/api/environments/:name/export` | 导出 environment.yml |
| GET | `/api/environments/:name/size` | 磁盘占用 |
| GET | `/api/environments/calc-settings` | 计算大小策略设置 |

### 包管理

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| GET | `/api/environments/:name/packages-list` | 已安装包列表 |
| POST | `/api/environments/install` | 安装包 |
| POST | `/api/environments/uninstall` | 卸载包 |
| POST | `/api/environments/upgrade` | 升级包 |

### 任务 / 设置 / 系统

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| GET | `/api/tasks` | 活跃及近期已完成任务 |
| GET | `/api/tasks/:taskId` | 任务状态 |
| POST | `/api/tasks/:taskId/cancel` | 取消任务 |
| GET | `/api/settings` | 获取设置 |
| POST | `/api/settings` | 保存设置 |
| POST | `/api/settings/auto-detect` | 自动探测 conda/mamba |
| GET | `/api/settings/conda-status` | conda 可用性检测 |
| POST | `/api/settings/complete-onboarding` | 完成首次配置 |
| GET | `/api/settings/path` | 配置文件路径 |
| POST | `/api/settings/open-dir` | 打开配置目录 |
| POST | `/api/system/open-path` | 在资源管理器打开 |
| GET/POST | `/api/project-dir` | 项目目录 |
| POST | `/api/project/terminal` | 在项目目录打开终端 |
| GET | `/api/health` | 健康检查 |

## 配置

设置文件位置：

- **Windows**：`%APPDATA%\CondaNAV\settings.json`
- **Linux / macOS**：`~/.conda-nav/settings.json`

```json
{
  "conda_path":         "D:\\miniconda3\\Scripts\\conda.exe",
  "mamba_path":         "",
  "onboarding_completed": true,
  "project_dir":        "",
  "calc_env_size":      false,
  "calc_timeout_sec":   30
}
```

## 常见问题

| 问题 | 解决 |
|:---|:---|
| SmartScreen 拦截 | 点击「更多信息」→「仍要运行」 |
| 找不到 conda | 设置 → 自动探测 或 手动指定 conda.exe → 测试 |
| conda 位于非标准路径 | 支持读取 `.condarc` 的 `root_prefix` / `envs_dirs` |
| 环境列表为空 | 确认 conda 已安装并正确配置路径 |
| mamba 自动使用 | 检测到 `mamba.exe` 时优先使用，也可手动配置 |

## License

MIT
