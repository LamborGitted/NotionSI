# 多提供商与订阅登录

模型调用由本项目使用 Node.js 原生 `fetch`、SSE 和文件接口实现，不依赖 Pi、OpenAI SDK 或其他模型 SDK。Notion 的聊天、编辑器、历史与原生工具继续走原有路由。

## 通用配置

运行 `npm run config`（或 `node index.js config`；exe 为 `.\NotionSI.exe config`），使用 ↑↓ 选择、Enter 确认、Esc 返回、Ctrl+C 退出。首页提供“添加供应商”和“重新选择供应商并配置模型”，统一按以下步骤操作：

1. 选择要添加或重新配置的提供商。智谱另选标准 API / Coding Plan CN；自定义接口填写根地址。
2. 填写隐藏的 API Key、使用已有 Key，或完成 ChatGPT/Codex OAuth。无鉴权的本机接口可以选择无需 Key。
3. 凭据就绪后自动向该供应商获取模型列表；订阅通道也在 OAuth 后读取自己的模型接口。
4. 从返回的列表选择模型。
5. 选择该模型支持的思考强度、思考开关或 token 预算，然后确认保存并启用。没有已确认可调参数的模型仅显示使用默认设置。

其他配置集中在单独菜单，包括输出上限、超时、Notion 工具、系统提示词与安装路径。模型推理只在“测试当前模型连接”或正常使用时发生。`tui` 保留为兼容别名；静态脱敏输出改用 `npm run config:show` 或 `node index.js config --show --attach`。

模型列表优先使用供应商返回的结果。项目在这一步并行读取 [models.dev 公共 API](https://models.dev/api.json)，补充模型名称、思考能力及 `reasoning_options`；不会向 models.dev 发送 Key、OAuth、账号信息、用户提示或工具内容。公开元数据缓存于 `%LOCALAPPDATA%\NotionSI\cache\models.dev.json`，24 小时内复用，网络异常可使用旧缓存。目录中的其他型号不会自动加入账号模型列表。供应商接口失败时，界面先提供重试或重配凭据，也允许用户明确选择 models.dev 参考目录或手填 ID；参考目录会标注不代表账号权限。

用户配置保存到 `%LOCALAPPDATA%\NotionSI\config.json`，通常是 `C:\Users\<用户名>\AppData\Local\NotionSI\config.json`；Key 保存在这个用户文件中，界面不显示。文件采用版本化 JSON 与原子写入，`providers` 保存已添加供应商，`values` 保存兼容的配置字段；旧版配置和 `.env.local` 中已有供应商可自动识别。保存时检查是否被另一进程修改，并保留其他提供商设置。中途取消不保存未确认的供应商/模型修改；已完成的 OAuth 登录凭据由登录流程即时保存。源码与 exe 共用该目录。非 Windows 环境使用 `$XDG_CONFIG_HOME/NotionSI` 或 `~/.config/NotionSI`。

优先级为 CLI > 进程环境 > 用户配置 > 项目 `.env.local` > 默认值。终端中的显式编辑和连接测试使用当前草稿，常规启动仍按上述优先级读取。保存时会将当前提供商的已有项目/环境设置带入用户配置，其他项目内容不迁移，原 `.env.local` 不改写。模型可用 `--model` 覆盖；现有智谱配置保持兼容，`--profile` 仅适用于智谱。下文变量名同样用于用户 JSON 的 `values` 字段；`.env.local` 示例继续作为手工配置的后备方式。

| 提供商 | 变量前缀 | 协议 | 默认 API 根地址 | 默认模型 |
| --- | --- | --- | --- | --- |
| `openai` | `OPENAI` | Responses | `https://api.openai.com/v1` | `gpt-4.1` |
| `anthropic` | `ANTHROPIC` | Messages | `https://api.anthropic.com/v1` | `claude-sonnet-4-5` |
| `gemini` | `GEMINI` | Gemini | `https://generativelanguage.googleapis.com/v1beta` | `gemini-2.5-flash` |
| `deepseek` | `DEEPSEEK` | Chat Completions | `https://api.deepseek.com` | `deepseek-chat` |
| `openrouter` | `OPENROUTER` | Chat Completions | `https://openrouter.ai/api/v1` | 必填 |
| `moonshot` | `MOONSHOT` | Chat Completions | `https://api.moonshot.cn/v1` | `kimi-k2.5` |
| `qwen` | `QWEN` | Chat Completions | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| `minimax` | `MINIMAX` | Chat Completions | `https://api.minimax.io/v1` | `MiniMax-M2.5` |
| `groq` | `GROQ` | Chat Completions | `https://api.groq.com/openai/v1` | 必填 |
| `mistral` | `MISTRAL` | Chat Completions | `https://api.mistral.ai/v1` | `mistral-small-latest` |
| `ollama` | `OLLAMA` | Chat Completions | `http://127.0.0.1:11434/v1` | 必填 |
| `openai-compatible` | `OPENAI_COMPATIBLE` | Chat Completions | 必填 | 必填 |

每个前缀支持 `_API_KEY`、`_MODEL`、`_BASE_URL`、`_MAX_TOKENS`、`_TIMEOUT_MS`。输出上限默认 4096，允许 1–131072；超时默认 180000 ms，允许 1000–900000 ms。各协议支持模型允许的 `_REASONING_EFFORT`；Anthropic 与 Gemini 还支持互斥的 `_THINKING_BUDGET`。界面按模型能力提供选项，预算模式自动为回复预留输出空间。Anthropic 强度对应 `output_config.effort`，预算对应 `thinking.budget_tokens`；Gemini 对应 `generationConfig.thinkingConfig` 的 `thinkingLevel` 或 `thinkingBudget`。型号与地址默认值可覆盖，模型权限以账号为准。

`_BASE_URL` 填 API 根地址；执行器追加 `/responses`、`/chat/completions`、`/messages`，或 Gemini 模型路径。只允许 HTTPS；本机回环地址允许 HTTP。地址中不允许用户名、密码、查询或 fragment。不同区域、套餐或网关需要显式覆盖根地址，不会自动尝试其他地址。

云服务需要对应 Key；`ollama` 和 `openai-compatible` 可省略 Key，填写时会发送 Bearer 鉴权。Anthropic 使用 `x-api-key`，Gemini 使用 `x-goog-api-key`，Key 不放在 URL 中。

例如 OpenAI API：

```dotenv
NOTIONSI_PROVIDER=openai
OPENAI_API_KEY=在本机填写
OPENAI_MODEL=gpt-4.1
```

例如 Claude 或 Gemini：

```dotenv
# 二选一设置 NOTIONSI_PROVIDER
NOTIONSI_PROVIDER=anthropic
ANTHROPIC_API_KEY=在本机填写
ANTHROPIC_MODEL=claude-sonnet-4-5

GEMINI_API_KEY=在本机填写
GEMINI_MODEL=gemini-2.5-flash
```

例如本机 Ollama（先自行拉取所选模型）：

```dotenv
NOTIONSI_PROVIDER=ollama
OLLAMA_MODEL=qwen3:8b
```

例如自定义兼容接口：

```dotenv
NOTIONSI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:1234/v1
OPENAI_COMPATIBLE_MODEL=本机已加载的模型ID
```

检查与启动：

```powershell
node index.js config --show --attach
node index.js check
node index.js start
```

`config --show --attach` 不需要 Notion 安装，不输出模型凭据正文、不发请求。`check` 会真实调用所选服务；API Key 通道可能产生费用。

## OpenAI 订阅

`openai-codex` 使用 ChatGPT 登录取得的 Codex 订阅访问权限，与 `openai` API Key 计费通道独立。订阅支持、组织策略、额度和可选模型由 OpenAI 账户决定，不代表可以调用 ChatGPT 网页中的所有模型。官方说明见 [Codex 鉴权](https://learn.chatgpt.com/docs/auth)。

1. 安装官方 Codex CLI：`npm i -g @openai/codex`。这是登录工具依赖，不是模型 SDK，也不会用 Codex agent 执行 Notion 任务。
2. 在 `npm run config` 中添加 `openai-codex`，先完成 OAuth，再从订阅接口返回的模型中选择型号和思考强度。也可以通过兼容的 `.env.local` 设置：

   ```dotenv
   NOTIONSI_PROVIDER=openai-codex
   OPENAI_CODEX_MODEL=gpt-5.2-codex
   # 可选；默认位于 LocalAppData。显式路径不展开 %LOCALAPPDATA%，需填写实际路径：
   # OPENAI_CODEX_AUTH_FILE=C:/Users/YourName/AppData/Local/NotionSI/auth/openai-codex/auth.json
   # 自动查找失败时，填写实际可执行文件或 npm 的 bin/codex.js：
   # OPENAI_CODEX_CLI=C:/path/to/codex.exe
   # OPENAI_CODEX_TIMEOUT_MS=180000
   # OPENAI_CODEX_REASONING_EFFORT=medium
   ```

3. 运行以下命令，按照官方 CLI 输出的链接和设备码在浏览器授权：

   ```powershell
   node index.js login --provider openai-codex
   node index.js config --show --attach --provider openai-codex
   node index.js check --provider openai-codex
   node index.js start --provider openai-codex
   ```

设备码登录可能需要先在 ChatGPT 安全设置或工作区权限中开启。登录命令将 `CODEX_HOME` 指向所配置文件的父目录，强制使用文件凭据存储，并在登录子进程中移除 `OPENAI_API_KEY`。Windows 下不通过 cmd/PowerShell 拼接命令；支持路径含空格的 `.exe` 或 `bin/codex.js`。登录目标文件名须为 `auth.json`。

默认读取的只有 `%LOCALAPPDATA%\NotionSI\auth\openai-codex\auth.json`，不会扫描系统 Codex 凭据或凭据管理器。若自行配置为已有 `auth.json`，则会读取并在刷新后更新这个明确指定的文件。文件包含账号令牌，默认放在仓库以外的用户目录；系统凭据管理器中的登录需重新完成这份独立的文件登录。

运行时由本项目读取访问令牌和账户 ID，并向固定的 `https://chatgpt.com/backend-api/codex/responses` 发送 SSE 请求。令牌过期前刷新；同一凭据实例的并发请求合并刷新，轮换后的令牌通过临时文件原子替换保存。取消一个等待刷新请求不会取消其他会话的刷新。只有明确的 HTTP 401 会刷新并重发一次；其他错误、工具调用和流中断均不自动重试。不会使用 `OPENAI_API_KEY` 回退普通 API，订阅根地址也不能通过环境变量改写。

此订阅传输适配为实验性：官方设备码登录和文件存储有文档，但直接订阅 Responses 传输不是稳定的公共 API。本次只完成模拟协议及鉴权测试，尚未以真实订阅账户完成连通与 Notion 实机验证；可用模型请按账号实际支持设置。若接口或凭据格式变化，明确返回错误。

## 历史与工具

四种协议均支持纯文本流、多轮历史、取消和现有原生 Notion 工具。历史仍按 `spaceId + threadId` 保存在进程内，并按用户消息边界裁剪；重启恢复、持久化和自动摘要仍未实现。内联 Writer 只使用本次选区和编辑指令。

工具 schema 从现有 `tools.definitions` 转换；工具执行仍经 `tools.execute()`，不会把供应商原生搜索、文件或终端工具开放给模型。一次最多 8 次模型请求、24 次工具调用，每次最多 16 个调用。只在正常结束并确认完整调用后执行工具；参数错误与未知工具返回工具错误，便于模型纠正。模型须支持 function calling；纯文本模型请关闭 `NOTIONSI_TOOLS`。

Responses 的 reasoning 项、Anthropic 的签名内容块、Gemini 的 thought signature 在后续工具轮次中保留，思考内容不作为最终回答输出。供应商错误正文不转发到界面或日志；停止生成会取消请求和正在执行的工具，但不能撤销已经提交的 Notion 写入。

## 验证范围与协议参考

自动测试使用本机 HTTP fixture 和模拟 fetch，不调用收费 API，也不读取个人凭据。覆盖 SSE UTF-8 拆包、四种协议工具循环及下一轮历史、签名回放、错误/断流/输出上限、取消、配置脱敏、订阅文件刷新与登录子进程。原有智谱和 Notion 编辑器测试继续运行。新供应商的实际额度、模型支持及桌面兼容性需要真实账户及独立测试页另行验证。

- [OpenAI 流式 Responses](https://platform.openai.com/docs/guides/streaming-responses)
- [Gemini generateContent / streamGenerateContent](https://ai.google.dev/api/generate-content)
- [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [models.dev](https://models.dev/)
- [DeepSeek Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion)
- [通义兼容接口](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)
