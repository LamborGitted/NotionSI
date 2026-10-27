# NotionSI：Notion AI 路由与智谱国内 API

在 Scoop 安装的 Notion 原生界面接管 AI 请求，可选择智谱国内 Coding Plan CN 或标准 API，也可使用本地固定回答测试。通过 CDP 临时注入 `fetch` 钩子，不改 ASAR、不安装证书。

当前版本：**0.2.0，实验性原型**。已验证的目标是 Windows / Scoop Notion 7.40.1；Notion 网页构建升级后可能需要重新适配。当前自动测试为 75 项，通过记录、已完成功能与后续计划见 [开发状态](docs/project-status.md)，版本变化见 [CHANGELOG](CHANGELOG.md)。

## 快速开始

准备 Node.js 24 或更新版本，以及已登录的 Notion 桌面端。在项目目录运行：

```powershell
npm ci
Copy-Item .env.example .env.local
```

已有 `.env.local` 时请保留原文件。在本机填写其中的 `ZHIPU_API_KEY`，然后运行：

```powershell
npm run config
npm run start:coding-cn
```

看到 `Router ready` 后，在 Notion 新建普通 AI 对话。需要搜索或编辑页面时，将 `.env.local` 中的 `NOTIONSI_TOOLS=off` 改为 `native` 后重启。只想检查本地接管而不调用模型时，运行 `npm run start:mock`。详细配置、运行与验证方法见下文。

## 智谱接入

当前配置是 **GLM Coding Plan CN + GLM-5.3**。通过 `ZHIPU_API_PROFILE` 显式选择端点，不自动回退其他端点、不伪装成其他客户端。智谱官方的指定工具列表不含此自建代理；技术联通不等于官方支持或套餐使用资格，实际计费还由 Key 类型决定。[接入说明](https://docs.bigmodel.cn/cn/coding-plan/tool/others)、[Key 分类](https://docs.bigmodel.cn/cn/coding-plan/notice/api-key-management)

复制 `.env.example` 为 `.env.local`（已有文件时保留原文件），然后在本机填写：

```dotenv
NOTIONSI_PROVIDER=zhipu
ZHIPU_API_PROFILE=coding-cn
ZHIPU_API_KEY=你的智谱对应产品API密钥
ZHIPU_MODEL=glm-5.3
ZHIPU_MAX_TOKENS=2048
ZHIPU_TIMEOUT_MS=180000
ZHIPU_THINKING=enabled
ZHIPU_REASONING_EFFORT=low
```

`.env.local` 已加入忽略规则。不要把 Key 粘贴到聊天、命令参数或提交到版本库。进程环境变量优先于文件配置；配置只加载上述允许字段。

```powershell
npm run config
npm run check:coding-cn
npm run start:coding-cn
```

- `config` 只显示配置状态，不显示密钥、不发请求。
- `check:coding-cn` 通过国内 Coding Plan 端点真实发送固定连通测试提示，不包含 Notion 内容。
- `start:coding-cn` 启动/连接 Notion 后使用真实模型；已有调试端口可用 `npm run attach:coding-cn`。
- Coding Plan CN 接口是 `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions`。
- `ZHIPU_API_PROFILE=standard` 则选择 `https://open.bigmodel.cn/api/paas/v4/chat/completions`。`start:zhipu` / `attach:zhipu` / `check:zhipu` 沿用配置文件选择的 profile；CLI 的 `--profile` 可显式覆盖。
- 两种端点均使用 Bearer Key 和 SSE，任何错误都不会切换到另一个端点。模型可通过 `ZHIPU_MODEL` 或 `--model` 修改。[接口文档](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)

默认模型为 `glm-5.3`。真实请求的 `HTTP 429` 需要进一步看业务码：`1113` 表示余额不足（套餐 profile 还应核对 Key 类型），`1302` 表示账户速率限制，`1305` 表示模型当前访问量过大；不能全部当成请求频率问题。[官方错误码](https://docs.bigmodel.cn/cn/api/api-code)

GLM-5.3 强制开启思考，配置会自动规范为 `thinking=enabled`，默认使用 `reasoning_effort=low`。可改为 `high` 或 `max`；思考内容不显示为最终回答。[GLM-5.3 参数说明](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)

新版 Agent 可发送当前聊天的纯文本和本进程内的历史（最多最近 40 条）。不会转发 Notion Cookie 或请求头；页面内容与写入可通过下文的 native 工具获取或执行。带编辑器选区的聊天会读取并提供选区正文与页面链接，其余聊天不自动读取整页；不支持联网或第三方连接器搜索。思考过程不作为最终回答输出。停止会取消上游请求；鉴权、限流、断流和 Token 上限错误会进入错误终态，不伪装成正常完成，不自动回退官方 AI 或其他计费接口。

## 系统提示词

将 `system-prompt.example.txt` 复制为 `system-prompt.local.txt`，编辑内容，并在 `.env.local` 中增加：

```dotenv
NOTIONSI_SYSTEM_PROMPT_FILE=system-prompt.local.txt
```

路径相对于启动时的工作目录。文件必须为非空 UTF-8 文本，最多 64 KiB。启动时读取，修改后需要退出路由进程并重新启动；重启会清除本进程保存的会话历史。未配置此项时不注入系统提示词，mock 模式忽略此项。

每次请求会在聊天历史前添加一条 `system` 消息，不写入 Notion transcript，也不受最近 40 条历史裁剪影响。`npm run config` 只显示是否配置及字节数，不输出提示词正文。`*.local.txt` 已被忽略。连通测试也会使用此提示词，因此强制固定回复的提示词可能改变测试输出。

示例是为当前文本能力编写的简短提示词。社区提取的原始提示词与工具适配边界见 [说明](docs/system-prompt-and-tools.md)。描述工具的提示词不会创建工具；`NOTIONSI_TOOLS=native` 时会发送实际工具 schema，并执行调用与回传结果。未启用时只提供文本对话。

## Notion 工具调用

在 `.env.local` 设置 `NOTIONSI_TOOLS=native`，重新启动路由后启用。示例配置默认关闭这些工具；无需社区全量提示词即可使用，执行器会附加实际能力与参数约定。

已接入 `search`、`view`、`create-pages`、`update-page-v2`、`delete-pages`、`query-data-sources`、`create-database`、`update-database`、`update-todos`。页面与数据库操作通过当前 Notion 登录会话执行，不需新增 Integration Key。Cookie 留在页面内，工具读取的页面内容和结果会发给所选 GLM 模型。

搜索目前是工作区标题搜索。内容编辑支持基础 Markdown；包含未知或嵌套块的页面拒绝整体替换。数据库支持基础列、建行与视图查询，不支持 SQL。任务清单保存在当前本地聊天中。尚未接入 `view-version-history` 和 `exit-setup-mode`。工具 description/schema 优先描述实际可用能力。

每轮最多 8 次模型请求、24 次工具调用。工具结果以 `role=tool` 回传，思考内容保留给后续模型请求但不显示。停止会取消后续调用；已经被服务器接受的写入不保证撤销。工具卡片的状态文字必须使用 Notion 富文本数组，详见 [格式与崩溃修复](docs/tool-card-protocol.md)。

`node scripts/check-tools.mjs` 只测试搜索与读取。`--write` 会创建工具测试页并读写其中的数据，保留测试页以供界面验证；`--resume` 复用 `.local/tools-sandbox.json`。`node scripts/verify-tool-ui.mjs --run --target TARGET_ID` 会恢复指定 AI 标签页，并提交一次搜索/读取请求，检查原生卡片、最终回答与结束状态。

## 编辑器内的 AI

选中文字后，使用 Notion 原生菜单的 **重新格式化** 或 **使用 AI 编辑**，即可让当前配置的 GLM 处理选区。可输入“整理成表格”“改成待办列表”“翻译成英文”等要求。生成结果支持原生差异预览、接受和撤销。

已适配编辑器独立的 `runWriter` 请求，以及本地编辑对应的 `undoAgentServiceTurn`。支持改写、拼写语法修正、缩短、扩写、摘要、续写、解释和自定义文字要求；摘要与续写保留原文后追加，解释只返回说明。输出支持标题、列表、待办、引用、代码块、普通表格与基础行内格式。

支持单个文本选区、同一父级下连续的文本区块；选区外文字及富文本格式保留。带选区的侧栏聊天会提供完整选区，并仅开放 `update-selection` 修改该选区。当前不支持空光标直接写整页，或原选区中包含嵌套内容、图片、数据库、引用区块；未知自定义技能返回本地错误，可改用“使用 AI 编辑”输入要求。

与原生 Writer 一样，内容在预览出现前已写入服务器；“接受”关闭预览，“撤销”恢复本次修改。撤销记录保存在当前路由进程中，重启路由后旧记录失效。生成期间选区发生变化时拒绝覆盖。协议、验证记录与限制见 [编辑器适配说明](docs/editor-ai.md)。

## 运行

终端默认显示模型回复的流式正文、工具名称和开始/完成/失败/取消状态，并为每次生成分配本地编号，例如：

```text
[AI #1] 开始生成 · glm-5.3
[工具 #1] search · 开始
[工具 #1] search · 完成
[回复 #1] 已找到相关内容。
[AI #1] 完成 · 8 字符
```

不输出原始请求、系统提示词、工具参数/返回值、Key 或 Cookie；模型回复本身可能包含其引用的页面内容。`npm start -- --no-content-log` 或 `.env.local` 中设置 `NOTIONSI_LOG_CONTENT=0` 可只保留进度，不打印回复正文。默认值为 `1`。不自动保存到日志文件，重新启动路由进程后配置生效。

需要 Node.js 24 或更新版本。首次运行或更新依赖后安装锁定版本（编辑器 Markdown 使用 `marked`），配置好 `.env.local` 后启动：

```powershell
npm ci
npm start
```

启动器会查找 `~/scoop/apps/notion/current/Notion.exe`，以本机调试端口启动；也可指定 `--notion "C:\path\Notion.exe"`。若 Notion 已在后台运行但没有调试端口，启动器会提示并等待最多 120 秒：从 Notion 菜单或系统托盘选择“退出”后，会自动以调试模式重新启动。只关闭窗口可能仍留在后台；工具不会强制结束应用。首次启动会等待调试端口最多 45 秒，超过旧版约 10 秒的启动预算。若已有调试端口，则直接连接；端口不同时会提示正确的 `--endpoint` 参数。

Notion 已通过调试端口运行时：

```powershell
npm run attach
```

看到 `Router ready` 后，在 Notion 中新建普通 AI 对话、输入一条测试提示。智谱模式会返回模型生成的回答。需要回到固定回答模式时，运行 `npm run start:mock`，预期逐段显示：

> 这是 NotionSI 的本地固定回答。请求已被接管，生成现已完成。

可自定义文本和分块间隔：

```powershell
npm run start:mock -- --answer "你好，这是本地回答。" --delay-ms 100
```

按 Ctrl+C 或输入 `q` 回车，会撤下钩子并保留 Notion 窗口。正常重启 Notion 可关闭调试端口。调试端口仅用于本机，其他本地程序也可通过它访问此会话。

## 范围

- 已实现经典 `runInferenceTranscript` 的固定 NDJSON step/patch 响应；智谱模式支持能识别用户文本的经典请求，空的服务端历史引用不能恢复，请使用新建普通对话。
- 新版 Agent 支持 `personal_agent` 创建、富文本输入、发送、transcript 分页/订阅与停止。
- 编辑器支持带选区的 `runWriter`、原生预览/接受和当前进程内的撤销；范围见上文。
- 正常结束使用 `turn_completed.stop_reason = "end_turn"` 与 idle session；Agent 订阅保持连接不代表仍在生成。
- 日历 Agent、自定义 Agent、附件和聊天消息编辑/撤回不在此原型范围，返回明确的本地错误。
- 会话只保存在工具进程内存中，重启工具或刷新后的历史恢复未实现。开启时 transcript 接口使用本地模拟数据，适合新建测试对话。
- 匹配的 AI 请求失败不会自动回退官方 AI。普通 Notion 请求保持原样；工具日志只输出端点与状态，不输出提示词、Cookie 或认证头。

## 验证

```powershell
npm test
npm run verify
```

`verify` 只读取当前 AI 页面的可访问性树和钩子计数，不提交请求。它默认检查固定回答可见、停止按钮消失、提交按钮恢复，以及没有发送错误或版本警告。需要先完成一次原生界面测试。智谱模式可传 `--answer "实际回答中的一段文本"` 来核对实际输出。

```powershell
npm run verify -- --output .local/verification.json
```

编辑器集成验证使用独立测试页和本机 `.local/editor-sandbox.json` 配置：`npm run verify:editor -- --run` 验证重新格式化与原生撤销；增加 `--table --accept` 验证自定义表格与原生接受。这两项会真实调用所配置模型并编辑测试页，不能对个人笔记运行。脚本依赖本次验证的 Notion 网页构建模块，升级后需重新核对。

协议边界与研究范围见 [协议概览](docs/protocol-overview.md)。本地 `research/` 保存静态研究报告、原始证据与提取文件，不纳入 Git 提交；`.local/` 的运行验证数据、`.env.local` 及 `*.local.txt` 也仅保留在本机。
