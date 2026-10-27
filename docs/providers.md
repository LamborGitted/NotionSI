# 模型提供商开发指南

NotionSI 的入口与 Notion 适配层不依赖具体供应商。当前内置 `mock`、`zhipu`、多家 HTTP API 与实验性的 `openai-codex` 订阅适配，配置示例见 [多提供商使用指南](model-providers.md)。

`http-provider.js` 负责公共请求、超时、工具循环和历史回写；`wire-protocols.js` 实现 Responses、Chat Completions、Anthropic 与 Gemini 转换和流解析；`http-config.js` 注册供应商根地址与环境变量。增加兼容服务通常只需扩展该注册表。`codex-auth.js` 独立管理订阅文件、官方 CLI 设备码登录和令牌刷新；不从普通 API Key 推断订阅身份。

## 注册与配置

在 `src/providers/` 增加实现与配置适配器，并在 `src/providers/index.js` 的注册表中加入名称。适配器包含：

- `envKeys`：允许从 `.env.local` 读取的供应商字段；不得引入任意进程环境配置。
- `configure({ env, model, apiProfile })`：解析配置，CLI 传入值优先于环境字段。
- `create(config)`：验证配置并构造模型实例；密钥验证必须在接管页面前完成。
- `publicConfig(config)`：用于配置检查的脱敏信息，不输出 Key、系统提示词正文等内容。

公共配置、系统提示词文件和工具开关由 `src/config.js` 管理。配置检查不构造模型实例、不发送请求；`node index.js check --provider NAME` 使用相同工厂执行固定提示的真实请求。

## 运行接口

模型实例提供 `name`、`model` 和异步生成器：

```js
async *stream({ messages, signal, tools, onToolEvent, onHistory }) {
  // Yield visible text chunks; throw on failure or incomplete completion.
}
```

`messages` 使用聊天消息结构；取消必须传播到上游请求。推理内容不得作为最终回答显示。未收到正常结束标记时不能把断流当成成功。

当路由开启原生工具时，`tools` 提供 `definitions`、`instructions` 和 `execute(name, args, { signal })`。适配器负责模型工具调用、执行结果回传、轮数限制、取消以及通过 `onToolEvent` 报告状态；更新历史通过 `onHistory(messages)` 回传。现有完整实现见 `src/providers/zhipu.js`。提供商若未适配工具，应明确拒绝启用该能力。

对可安全显示的错误抛出 `ProviderError`（`src/providers/errors.js`）或其子类。仅包含已清理的用户提示，不直接透传供应商错误正文，以免泄露密钥或回显的请求内容。

## 验证

新增适配器至少覆盖脱敏配置、CLI 覆盖、流式响应、错误与断流、取消，以及已宣称支持的工具行为。使用本地 HTTP fixture 或模拟 fetch；默认测试不得调用真实收费 API。再使用独立测试页验证 Notion 聊天与编辑器行为。
