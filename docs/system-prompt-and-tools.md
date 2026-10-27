# 系统提示词与 Notion 工具

参考来源：[SleepingBag945/notion_manager 的社区提示词](https://github.com/SleepingBag945/notion_manager/blob/master/docs/notion_system_prompt.md)，核对日期 2026-10-27。此文件为第三方整理，不能据此确认它与当前安装版本、账号或线上服务的完整提示词一致。

该文档描述回答格式、工作区概念、压缩 URL 和工具使用规则，并列出 11 个工具，例如 `search`、`view`、`create-pages`、`update-page-v2`。它没有提供这些工具完整的 JSON 参数 schema、可调用端点、鉴权过程或执行实现。因此可以作为行为与格式参考，不能独立构成兼容的工具客户端。

当前 NotionSI 的替换边界是 AI 请求和 transcript。启用 `NOTIONSI_TOOLS=native` 后，GLM 接收真实工具 schema，执行器通过当前页面会话调用限定的 Notion 接口，再将结果作为 `role=tool` 消息回传。普通文字中描述的操作不会被执行。

聊天还会在模型生成前只读加载当前笔记：优先采用本轮 `threadContext.currentBlockId`，缺失时采用页面钩子在请求发送时捕获的 URL，排除聊天和 Agent 路由。富文本中的 `a` 链接、`lm` 链接提及和 `p` 页面引用转换为带真实目标的 Markdown，原生 transcript 的富文本保持原样。经典聊天也转发本轮页面上下文。

当前页与本轮显式引用的 Notion 页面去重后合计最多读取 5 个，标题与正文合计最多提供 40000 字符，总读取限时 15 秒。上下文以独立数据消息和使用约束注入；失败和截断均有明确状态，不把失败当成空白页面。模型工具循环返回历史时移除这两条临时消息，下轮重新读取；工具关闭时仅提供定位信息和未读取原因。带选区聊天继续只注入选区，沿用原有选区编辑边界，不自动扩大读取范围。外部链接只保留 URL，没有新增联网抓取工具。

协议字段已与 Notion 7.40.1 当前加载的客户端模块核对：542514 构造 `currentBlockId`，410139 声明 `threadContext` schema，623879/247438 定义富文本引用注解。2026-10-27 通过当前登录会话完成当前页与页面引用的真实只读加载，并使用本机配置的 GLM 对“这篇文章说了什么”完成实际总结；验证未写入 Notion 页面。离线回归另覆盖页面切换、经典聊天、权限失败、截断、工具关闭、图片与工具循环历史。

从 0.3.1 起，源码版默认读取 [`prompts/notion-system-prompt.txt`](../prompts/notion-system-prompt.txt)，这是此前源码版通过本地文件使用的完整社区参考文本。Windows EXE 将同一文件作为 SEA 资源内嵌，启动目录变化也不会丢失默认提示词；ZIP 同时附带可阅读的正文与来源说明。

完整正文保留原样，运行时另行追加 NotionSI 的实际能力约束：不输出 XML 语言标签，不伪造压缩链接，仅能使用当前请求中真正声明的工具。工具关闭时明确没有页面和工作区访问能力。参考文本中描述的 11 项工具、连接器搜索或 SQL 并不表示这些能力已经实现。

`system-prompt.example.txt` 继续作为独立编写的精简文本模式示例。用户可通过 `NOTIONSI_SYSTEM_PROMPT_FILE` 指向自己的提示词，优先替换内置完整提示词；留空恢复内置默认值。`config --show --attach` 中的 `systemPromptSource` 为 `builtin`、`file` 或 `none`（mock），只显示来源与字节数，不输出正文。

现已实现工具定义 → GLM SSE `tool_calls` 分片组装 → 原生会话执行 → 结果回传 → 继续生成的闭环，以及取消、错误、调用次数上限和 transcript 工具状态。具体支持的 9 项工具与边界见 [README](../README.md#notion-工具调用)。

可选执行器是 Notion 官方 API 或 MCP，也可继续研究原生内部接口。官方执行器与这份提示词的工具名称和参数不会自动一一对应，需要显式适配。桌面 `clientMcpHost` 中观察到的文件工具通道，不能作为工作区搜索和页面编辑接口的证据，详见 [协议概览](protocol-overview.md)。

本地验证曾使用 `system-prompt.notion.local.txt` 保存社区原文；该本地文件仍被忽略，发布所用的完整文本已单独纳入 `prompts/` 版本管理。加载时追加的运行能力及执行器说明与原文分开维护。此参考来源不等于当前 Notion 安装版本或线上服务的完整提示词。
