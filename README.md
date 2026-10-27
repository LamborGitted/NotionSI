# NotionSI

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-24%2B-green)
![Status](https://img.shields.io/badge/status-experimental-orange)

将 Notion 桌面端的 AI 请求路由到你选择的模型服务，在原生聊天与编辑器中使用自己的 API。

NotionSI 通过本机 Chrome DevTools Protocol（CDP）临时注入请求钩子，无需修改 ASAR 或安装证书。模型层使用自行实现的 HTTP/SSE 适配，支持 OpenAI、Anthropic、Gemini、智谱及多种兼容服务，并提供实验性的 **ChatGPT/Codex 订阅接入**；不依赖 Pi 或模型 SDK。

> 当前版本为 **0.3.1，实验性原型**。实机验证环境：Windows / Scoop Notion 7.40.1。启动器支持普通 Windows 安装与自定义目录，其他安装版本仍需验证；Notion 更新可能导致协议适配失效。本项目为独立社区项目。

## 功能

- **原生 AI 聊天**：流式回复、多轮对话、停止生成、错误状态。
- **页面与数据库工具**：搜索、读取、创建、基础 Markdown 更新、回收站操作，以及基础数据库查询与修改。
- **编辑器 AI**：选区改写、翻译、摘要、续写、自定义要求，支持原生预览、接受和当前进程内撤销。
- **本地配置**：Notion 安装路径、模型、系统提示词、工具开关、终端正文输出。
- **多模型接入**：OpenAI Responses、Chat Completions、Anthropic Messages、Gemini 四类协议，以及独立的 ChatGPT/Codex 订阅鉴权。

## 快速开始

准备 **Node.js 24+**、npm，以及已登录的 Windows Notion 桌面端。下载或克隆本仓库，进入项目目录：

```powershell
npm ci
npm run config
```

在终端中用 **↑↓ / Enter** 操作：**添加供应商 → 选择提供商 → 填 API Key 或 OAuth 登录 → 自动获取供应商模型列表 → 选择模型 → 选择思考强度 → 保存并启用**。以后可选“重新选择供应商并配置模型”。Key 隐藏输入，配置保存到 **`%LOCALAPPDATA%\NotionSI\config.json`**，源码版和 exe 共用；OpenAI 订阅登录凭据位于同目录的 `auth\openai-codex\auth.json`。思考能力由供应商信息和 [models.dev](https://models.dev/) 补充，按模型显示可用选项；“测试当前模型连接”才会调用模型生成。

已有 `.env.local` 继续兼容读取，保存交互配置时会将当前提供商的已有设置带入用户配置，不改写原文件。也可手动复制 `.env.example` 并填写项目级后备配置，例如智谱标准 API：

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
npm run config:show
npm start
```

看到 `Router ready` 后，在 Notion **新建普通 AI 对话**。如果 Notion 已在后台运行且没有调试端口，按终端提示从菜单或托盘完全退出，启动器会等待并重新启动它。

按 **Ctrl+C** 或输入 **q** 回车撤下钩子，Notion 窗口保留。正常重启 Notion 可关闭调试端口。

无 API Key 时可用本地固定回答检查接管效果：

```powershell
npm start -- --provider mock
```

## Windows 可执行程序与自动发布

直接前往 [Releases](https://github.com/LamborGitted/NotionSI/releases) 下载 **NotionSI-win-x64.zip** 和可选的 `.sha256` 校验文件。GitHub 自动附带的 **Source code** 是源码，里面没有 EXE。

仓库提供 `.github/workflows/build-executable.yml`：

- **推送版本标签**（例如 `v0.3.0`）：校验版本信息，运行全部自动测试，构建 Windows x64 EXE 并完成独立运行检查，生成 ZIP 和 SHA-256 文件，然后自动创建 Release 并上传这两个下载文件。发布说明来自 CHANGELOG 对应版本。
- **手动构建分支**：在 **Actions → Build and release Windows executable → Run workflow** 选择 `main`，只生成 Actions 附件，不发布 Release。附件保留 30 天。
- **普通分支推送和 PR**：继续由 CI 执行测试，不创建 Release。

版本标签必须与 `package.json`、锁文件和 CHANGELOG 一致。以下为当前版本的标签示例，已存在的标签无需重复创建：

```powershell
git tag -a v0.3.1 -m "NotionSI v0.3.1"
git push origin v0.3.1
```

以后发布新版本的完整操作、预发布标签、失败排查与校验方法见 [版本发布指南](docs/releases.md)。自动发布使用 GitHub 自带的 `GITHUB_TOKEN`，无需添加个人 Token。

解压 `NotionSI-win-x64.zip`，在包含 `NotionSI.exe` 的目录打开 PowerShell：

```powershell
.\NotionSI.exe config
# 选择提供商、模型和凭据，保存到 LocalAppData
.\NotionSI.exe config --show --attach
.\NotionSI.exe start
```

运行 API Key 提供商无需安装 Node.js 或 npm，仍需安装并登录 Windows Notion；订阅登录另需官方 Codex CLI，原生 `codex.exe` 不依赖 Node，npm 安装的 CLI 需要 Node。其他命令同样可以将 `node index.js` 替换为 `.\NotionSI.exe`。用户配置始终从 LocalAppData 读取；兼容的 `.env.local`、相对 Notion 路径与自定义提示词路径仍相对于终端的当前工作目录。

本地构建需要 Windows x64、x64 版 Node.js 24：

```powershell
npm ci
npm run build:exe
npm run test:exe
```

输出目录为 `dist/NotionSI-win-x64/`。构建使用 esbuild 汇总 ESM 源码，再通过 Node.js SEA 与 postject 将代码和完整默认提示词嵌入当前 Node.js 运行时；附带配置示例、公开文档与参考提示词，不复制开发目录中的 `.env.local`。当前可执行文件未做代码签名。

## 统一入口

所有运行与诊断命令通过根目录 `index.js` 进入。直接运行 `npm start` 等同于 `node index.js start`。

| 命令 | 用途 |
| --- | --- |
| `node index.js start` | 启动或连接 Notion 并安装钩子 |
| `node index.js attach` | 仅连接已有调试端口 |
| `node index.js config` / `npm run config` | 交互添加供应商、鉴权、获取模型、选择模型与思考强度 |
| `node index.js config --show --attach` / `npm run config:show` | 显示脱敏配置，不发请求；省略 `--attach` 可解析 Notion 安装路径 |
| `node index.js check` | 向当前提供商发送固定连通测试提示，不读取 Notion |
| `node index.js login --provider openai-codex` | 使用设备码登录 ChatGPT/Codex 订阅 |
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

配置优先级：**CLI 参数 > 进程环境变量 > 用户配置 > `.env.local` > 默认值**。Windows 用户配置路径为 `%LOCALAPPDATA%\NotionSI\config.json`，通常是 `C:\Users\<用户名>\AppData\Local\NotionSI\config.json`。使用 `npm run config` 编辑；配置在启动时读取，修改后重启路由。Linux 测试/源码环境使用 `$XDG_CONFIG_HOME/NotionSI` 或 `~/.config/NotionSI`。

| 配置项 | 用途 |
| --- | --- |
| `NOTIONSI_PROVIDER` | 下表中的提供商名称；未配置时为 `mock` |
| `NOTION_PATH` | Notion.exe 或安装目录，可由 `--notion` 覆盖 |
| `NOTIONSI_TOOLS` | `off`（默认）或 `native`；开启页面与数据库工具 |
| `NOTIONSI_SYSTEM_PROMPT_FILE` | 可选自定义 UTF-8 系统提示词文件，最多 64 KiB；留空使用内置完整 Notion 参考提示词 |
| `NOTIONSI_LOG_CONTENT` | `1`（默认）显示回复正文；`0` 仅显示进度 |

Notion 自动查找覆盖 `%LOCALAPPDATA%/Programs/Notion`、`%LOCALAPPDATA%/Notion`、Program Files 和用户/全局 Scoop 目录。显式路径无效时直接报错。路径相对于启动工作目录，不展开 `~`、`%LOCALAPPDATA%` 等变量；`attach` 无需安装路径。

源码版与 EXE 默认使用相同的完整参考提示词，EXE 中已内嵌，无需复制 `.env.local` 或本地提示词。运行 `.\NotionSI.exe config --show --attach` 可查看 `systemPromptSource`：`builtin` 为内置，`file` 为自定义文件，`none` 为 mock。自定义路径优先覆盖；清空“其他配置 → 系统提示词文件”并保存可恢复内置默认值。实际工具能力仍取决于工具开关与当前请求的 schema，详见 [提示词说明](docs/system-prompt-and-tools.md)。

### 模型提供商

| 提供商 | 配置 | 状态 |
| --- | --- | --- |
| `mock` | 无需密钥，`--answer` 自定义固定回复 | 已实现，用于本地测试 |
| `zhipu` | `ZHIPU_API_KEY`、`ZHIPU_MODEL`、`ZHIPU_API_PROFILE` | 已实现，支持标准 API 与 Coding Plan CN |
| `openai` | `OPENAI_API_KEY`、`OPENAI_MODEL` | Responses API，独立 API 计费 |
| `openai-codex` | `OPENAI_CODEX_MODEL`、设备码登录 | ChatGPT/Codex 订阅通道，实验性 |
| `anthropic` | `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL` | 原生 Messages API |
| `gemini` | `GEMINI_API_KEY`、`GEMINI_MODEL` | 原生 Gemini API |
| `deepseek`、`openrouter`、`moonshot`、`qwen`、`minimax`、`groq`、`mistral` | 对应大写前缀的 `_API_KEY`、`_MODEL` | Chat Completions 兼容协议 |
| `ollama` | `OLLAMA_MODEL`，可选 `OLLAMA_BASE_URL` | 本机模型，默认无需 Key |
| `openai-compatible` | `OPENAI_COMPATIBLE_BASE_URL`、`OPENAI_COMPATIBLE_MODEL`，Key 可选 | 自定义接口、LM Studio、vLLM |

智谱默认 profile 为 `standard`；`.env.example` 提供 Coding Plan CN 示例。两种 profile 显式选择，不自动切换，使用对应产品的 Key。连通测试 `npm run check` 会真实调用配置的模型。具体参数与套餐说明见 [使用指南](docs/usage.md#智谱接入)。

其他 API 的配置示例、地址覆盖与完整限制见 [多提供商使用指南](docs/model-providers.md)。四种新协议已通过本地模拟服务测试；各供应商及订阅通道仍需使用自己的账号完成连通和 Notion 实机验证，模型权限以账号为准。

使用 OpenAI 订阅：先安装官方 Codex CLI（`npm i -g @openai/codex`），再运行：

```powershell
node index.js login --provider openai-codex
node index.js check --provider openai-codex
node index.js start --provider openai-codex
```

登录使用官方 CLI 的设备码流程；模型请求、流式解析与工具循环由本项目实现。默认凭据目录为 `%LOCALAPPDATA%\NotionSI\auth\openai-codex\`，不会自动读取或修改桌面 Codex 的登录。`openai-codex` 使用 Codex 订阅通道及其可用模型，不等于 ChatGPT 网页的全部模型；它与 `openai` 的 API Key 通道独立，不自动切换。订阅传输接口尚非稳定公共 API，实际可用性待账号实测。

## 数据与使用边界

- 模型会收到当前聊天文本、上传的图片、进程内历史，以及请求涉及的选区或工具读取结果。Notion Cookie 留在页面中，不转发给模型。
- 开启 `native` 工具后可通过当前登录会话执行写入；停止生成不保证撤销已经提交的操作。
- 终端默认显示模型正文，可能包含页面内容；共享终端时可用 `--no-content-log` 关闭。密钥、原始请求和工具返回值不作为日志输出。
- 调试端口仅用于本机，其他本地程序也可通过它访问该会话。
- `.env.local`、本地提示词和 `.local/` 已被忽略，请勿提交密钥或个人页面数据。

聊天支持 PNG、JPEG、WebP、GIF 图片附件，需选择支持视觉的模型；单张最多 5 MiB，当前会话历史最多 10 张、总计 10 MiB。支持纯图片和图文混合、多轮追问，详见 [图片输入](docs/image-input.md)。

当前会话与撤销记录保存在进程内，重启后不能恢复。尚不支持非图片附件、第三方连接器搜索、部分 Agent 模式、空光标写整页或包含复杂嵌套内容的选区。匹配的 AI 请求失败会返回本地错误，不自动回退其他模型或官方 AI。完整限制见 [开发状态](docs/project-status.md) 与 [编辑器说明](docs/editor-ai.md)。

## 开发与贡献

```powershell
npm ci
npm test
```

项目使用原生 JavaScript ES Modules（`package.json` 中的 `type: module`），源码运行无需构建步骤。CI 在 Node.js 24 的 Windows 与 Ubuntu 上运行自动测试；Windows 可执行程序由独立打包流程生成，桌面集成仍需单独验证。

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
- [多提供商与订阅登录](docs/model-providers.md)
- [开发状态与路线图](docs/project-status.md)
- [协议概览](docs/protocol-overview.md)
- [编辑器 AI](docs/editor-ai.md)
- [系统提示词与工具](docs/system-prompt-and-tools.md)
- [更新记录](CHANGELOG.md)
- [版本发布与下载指南](docs/releases.md)

## 许可证

[MIT](LICENSE) © 2026 NotionSI contributors
