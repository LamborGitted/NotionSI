# NotionSI

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-24%2B-green)
![Status](https://img.shields.io/badge/status-experimental-orange)

将 Notion 桌面端的 AI 请求路由到你选择的模型服务，在原生聊天与编辑器中使用自己的 API。

NotionSI 通过本机 Chrome DevTools Protocol（CDP）临时注入请求钩子，无需修改 ASAR 或安装证书。项目以可扩展的模型适配器组织，目前已实现 **智谱 API** 和 **本地 mock**。

> 当前版本为 **0.2.0，实验性原型**。实机验证环境：Windows / Scoop Notion 7.40.1。启动器支持普通 Windows 安装与自定义目录，其他安装版本仍需验证；Notion 更新可能导致协议适配失效。本项目为独立社区项目。

## 功能

- **原生 AI 聊天**：流式回复、多轮对话、停止生成、错误状态。
- **页面与数据库工具**：搜索、读取、创建、基础 Markdown 更新、回收站操作，以及基础数据库查询与修改。
- **编辑器 AI**：选区改写、翻译、摘要、续写、自定义要求，支持原生预览、接受和当前进程内撤销。
- **本地配置**：Notion 安装路径、模型、系统提示词、工具开关、终端正文输出。
- **模型适配层**：提供商独立配置与工厂入口，便于继续接入其他 API。

## 快速开始

准备 **Node.js 24+**、npm，以及已登录的 Windows Notion 桌面端。下载或克隆本仓库，进入项目目录：

```powershell
npm ci
Copy-Item .env.example .env.local
```

已有 `.env.local` 时保留原文件。在本机编辑配置，例如使用智谱标准 API：

```dotenv
NOTIONSI_PROVIDER=zhipu
ZHIPU_API_PROFILE=standard
ZHIPU_API_KEY=你的API密钥
ZHIPU_MODEL=glm-5.3

# 可选：Notion.exe 或其所在目录；留空则自动查找
NOTION_PATH="D:/Apps/Notion"
```

检查配置并启动：

```powershell
npm run config
npm start
```

看到 `Router ready` 后，在 Notion **新建普通 AI 对话**。如果 Notion 已在后台运行且没有调试端口，按终端提示从菜单或托盘完全退出，启动器会等待并重新启动它。

按 **Ctrl+C** 或输入 **q** 回车撤下钩子，Notion 窗口保留。正常重启 Notion 可关闭调试端口。

无 API Key 时可用本地固定回答检查接管效果：

```powershell
npm start -- --provider mock
```

## 统一入口

所有运行与诊断命令通过根目录 `index.js` 进入。直接运行 `npm start` 等同于 `node index.js start`。

| 命令 | 用途 |
| --- | --- |
| `node index.js start` | 启动或连接 Notion 并安装钩子 |
| `node index.js attach` | 仅连接已有调试端口 |
| `node index.js config` | 显示脱敏配置与解析后的 Notion 路径，不发请求 |
| `node index.js check` | 向当前提供商发送固定连通测试提示，不读取 Notion |
| `node index.js verify` | 只读检查当前 Notion AI 页面 |
| `node index.js --help` | 查看选项与其他诊断命令 |

常用选项：

```powershell
node index.js start --notion "D:/Apps/Notion/Notion.exe"
node index.js attach --endpoint http://127.0.0.1:9222
node index.js start --provider zhipu --profile standard --model glm-5.3
node index.js start --no-content-log
```

保留 `npm run attach`、`npm run config`、`npm run check`、`npm run verify` 等快捷命令，以及原有智谱命令别名。

## 配置

配置优先级：**CLI 参数 > 进程环境变量 > `.env.local` > 默认值**。配置在启动时读取，修改后重启路由。

| 配置项 | 用途 |
| --- | --- |
| `NOTIONSI_PROVIDER` | `mock` 或 `zhipu`；未配置时为 `mock` |
| `NOTION_PATH` | Notion.exe 或安装目录，可由 `--notion` 覆盖 |
| `NOTIONSI_TOOLS` | `off`（默认）或 `native`；开启页面与数据库工具 |
| `NOTIONSI_SYSTEM_PROMPT_FILE` | 自定义 UTF-8 系统提示词文件，最多 64 KiB |
| `NOTIONSI_LOG_CONTENT` | `1`（默认）显示回复正文；`0` 仅显示进度 |

Notion 自动查找覆盖 `%LOCALAPPDATA%/Programs/Notion`、`%LOCALAPPDATA%/Notion`、Program Files 和用户/全局 Scoop 目录。显式路径无效时直接报错。路径相对于启动工作目录，不展开 `~`、`%LOCALAPPDATA%` 等变量；`attach` 无需安装路径。

### 模型提供商

| 提供商 | 配置 | 状态 |
| --- | --- | --- |
| `mock` | 无需密钥，`--answer` 自定义固定回复 | 已实现，用于本地测试 |
| `zhipu` | `ZHIPU_API_KEY`、`ZHIPU_MODEL`、`ZHIPU_API_PROFILE` | 已实现，支持标准 API 与 Coding Plan CN |
| 其他 API | 通过 provider 适配器扩展 | 尚未实现，欢迎贡献 |

智谱默认 profile 为 `standard`；`.env.example` 提供 Coding Plan CN 示例。两种 profile 显式选择，不自动切换，使用对应产品的 Key。连通测试 `npm run check` 会真实调用配置的模型。具体参数与套餐说明见 [使用指南](docs/usage.md#智谱接入)。

## 数据与使用边界

- 模型会收到当前聊天文本、进程内历史，以及请求涉及的选区或工具读取结果。Notion Cookie 留在页面中，不转发给模型。
- 开启 `native` 工具后可通过当前登录会话执行写入；停止生成不保证撤销已经提交的操作。
- 终端默认显示模型正文，可能包含页面内容；共享终端时可用 `--no-content-log` 关闭。密钥、原始请求和工具返回值不作为日志输出。
- 调试端口仅用于本机，其他本地程序也可通过它访问该会话。
- `.env.local`、本地提示词和 `.local/` 已被忽略，请勿提交密钥或个人页面数据。

当前会话与撤销记录保存在进程内，重启后不能恢复。尚不支持附件、第三方连接器搜索、部分 Agent 模式、空光标写整页或包含复杂嵌套内容的选区。匹配的 AI 请求失败会返回本地错误，不自动回退其他模型或官方 AI。完整限制见 [开发状态](docs/project-status.md) 与 [编辑器说明](docs/editor-ai.md)。

## 开发与贡献

```powershell
npm ci
npm test
```

项目使用原生 JavaScript ES Modules（`package.json` 中的 `type: module`），无需构建步骤。CI 在 Node.js 24 的 Windows 与 Ubuntu 上运行自动测试，桌面集成仍需单独验证。

```text
index.js           统一 CLI 入口
src/providers/     模型实现、配置适配器与公共错误类型
src/               CDP、请求路由、聊天与编辑器适配
scripts/           实机诊断与验证脚本
test/              自动测试
docs/              使用指南、协议与兼容说明
```

新增模型服务时，参考 [提供商开发指南](docs/providers.md)。提交修复请附复现步骤、Node.js / Notion 版本、安装方式与脱敏错误；涉及真实页面的集成验证请使用独立测试页。

## 文档

- [使用与验证指南](docs/usage.md)
- [开发状态与路线图](docs/project-status.md)
- [协议概览](docs/protocol-overview.md)
- [编辑器 AI](docs/editor-ai.md)
- [系统提示词与工具](docs/system-prompt-and-tools.md)
- [更新记录](CHANGELOG.md)

## 许可证

[MIT](LICENSE) © 2026 NotionSI contributors
