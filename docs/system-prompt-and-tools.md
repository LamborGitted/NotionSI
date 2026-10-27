# 系统提示词与 Notion 工具

参考来源：[SleepingBag945/notion_manager 的社区提示词](https://github.com/SleepingBag945/notion_manager/blob/master/docs/notion_system_prompt.md)，核对日期 2026-10-27。此文件为第三方整理，不能据此确认它与当前安装版本、账号或线上服务的完整提示词一致。

该文档描述回答格式、工作区概念、压缩 URL 和工具使用规则，并列出 11 个工具，例如 `search`、`view`、`create-pages`、`update-page-v2`。它没有提供这些工具完整的 JSON 参数 schema、可调用端点、鉴权过程或执行实现。因此可以作为行为与格式参考，不能独立构成兼容的工具客户端。

当前 NotionSI 的替换边界是 AI 请求和 transcript。启用 `NOTIONSI_TOOLS=native` 后，GLM 接收真实工具 schema，执行器通过当前页面会话调用限定的 Notion 接口，再将结果作为 `role=tool` 消息回传。普通文字中描述的操作不会被执行。

`system-prompt.example.txt` 为本项目独立编写的文本模式提示词，没有照搬社区全文，也没有宣称当前存在搜索或编辑能力。用户可通过 `NOTIONSI_SYSTEM_PROMPT_FILE` 指向自己的提示词。直接使用依赖工具的完整提示词，可能导致模型输出无法执行的操作、内部语言标签或不存在的压缩链接。

现已实现工具定义 → GLM SSE `tool_calls` 分片组装 → 原生会话执行 → 结果回传 → 继续生成的闭环，以及取消、错误、调用次数上限和 transcript 工具状态。具体支持的 9 项工具与边界见 [README](../README.md#notion-工具调用)。

可选执行器是 Notion 官方 API 或 MCP，也可继续研究原生内部接口。官方执行器与这份提示词的工具名称和参数不会自动一一对应，需要显式适配。桌面 `clientMcpHost` 中观察到的文件工具通道，不能作为工作区搜索和页面编辑接口的证据，详见 [协议概览](protocol-overview.md)。

本地验证曾使用 `system-prompt.notion.local.txt` 保存社区原文；该文件属于忽略文件，不随项目分发，加载时追加的执行器说明与原文分开维护。社区原文的真实性、版本匹配和权利归属不能仅凭来源仓库声明确认。仓库提供独立编写的 `system-prompt.example.txt`，不要求用户获取社区全文。
