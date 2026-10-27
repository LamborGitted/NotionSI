# 聊天图片输入

选择支持图片输入的模型，重启 NotionSI 接管进程，在 Notion 新建普通 AI 聊天，通过聊天输入框的附件入口上传图片，再发送问题。也可只发送图片。无需开启 `native` 页面工具。

新版 personal Agent 和经典 `runInferenceTranscript` 都可读取聊天图片；文本仍使用原来的纯文本请求，带图消息会转换为对应模型的多模态输入。兼容 API、本机模型和 Codex 订阅也使用各自已有协议，是否接受图片取决于所选模型与服务；不会自动切换模型。mock 仍只返回固定回答，不能验证视觉识别能力。

支持 PNG、JPEG、WebP、GIF，读取时检查文件头。单张最多 5 MiB；一条消息最多 10 张，当前保留的会话历史中也最多 10 张、合计 10 MiB。模型自身可能有更严格的尺寸、张数或动画限制。图片和文字分别计算大小，图片 Base64 不占用原有文字长度上限。PDF、文档、视频、HEIC 和 SVG 尚不支持；包含非图片附件的消息会失败，不会丢弃附件后继续回答。

图片字节只存在当前进程的会话历史中，多轮追问和工具循环会保留图片，受已有历史裁剪与上述限制约束；重启后不能恢复。原生聊天 transcript 保留附件引用，不放入 Base64。选区中的图片、页面图片读取及生成图片输出不属于这次支持范围。

## 读取与转换

新版聊天的内容块为 `{type: "file", file_id: "…"}`。适配器在后台生成阶段，用当前页面登录会话调用 `getFileContentURLForAgentThread`，传入当前 `spaceId`、`threadId`、`fileId` 和 `includeFileMetadata: true`，从结果的 `url` 下载图片。经典聊天读取当前轮的 `attachment` / `computer-file` step，以其 `fileUrl` 和 `permissionRecord` 调用 `getSignedFileUrls`。原生上传流程继续由 Notion 处理。

签名操作经页面内的固定 API 白名单执行；图片下载在 Node 侧进行，仅允许 Notion 和其 S3 域名的 HTTPS 地址，逐跳检查至多三次重定向，不携带 Notion Cookie、认证头或 Referer。签名地址不进入模型消息。读取失败、超限或取消会结束本轮；尚未读完的图片不写入历史，模型不会收到不完整的图文消息。

内部图片格式为 `{type: "image", mediaType, data}`，其中 `data` 是 Base64。仅用户消息可包含图片。

| 协议 | 发给模型的图片内容 |
| --- | --- |
| Chat Completions，包括智谱与兼容接口 | `image_url: {url: "data:image/…;base64,…"}` |
| OpenAI Responses，包括 Codex 订阅 | `type: "input_image"` 与字符串 `image_url` |
| Anthropic Messages | `type: "image"` 与 `source: {type: "base64", media_type, data}` |
| Gemini | `inlineData: {mimeType, data}` |

协议字段参考 [OpenAI 图片文档](https://developers.openai.com/api/docs/guides/images-vision)、[Anthropic 视觉文档](https://platform.claude.com/docs/en/build-with-claude/vision)、[Gemini 图片文档](https://ai.google.dev/gemini-api/docs/image-understanding) 与 [智谱官方 GLM-V 实现](https://github.com/zai-org/GLM-V/blob/main/skills/glmv-caption/scripts/glmv_caption.py)。部分较旧智谱视觉模型不接受 Base64，应选择支持该输入方式的型号。

## 验证范围

`npm test` 覆盖纯图片与图文混合、经典附件签名、新版附件读取、页面桥接白名单、四种协议、智谱和订阅请求、跨轮历史与工具调用、重复请求、超限、非法地址、重定向及中止读取。测试使用本地 PNG 和模拟服务，不向模型或 Notion 上传测试内容。

Notion 字段依据本机缓存客户端代码及 2026-10-27 当前页面加载的模块核实：模块 `755576` 构造文件内容块，`902936` 调用文件读取接口，`296328` 构造经典附件，`292134` 读取附件引用及元数据。它们证明客户端结构，不代表已完成真实上传到视觉模型的桌面集成测试；其他网页构建仍需实测。
