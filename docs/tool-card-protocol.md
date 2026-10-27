# 原生工具卡片的富文本协议

`kind: "tool"` 且 `presentation_kind: "generic"` 的状态文字是 Notion `TextToken[]`，例如：

```json
{
  "text": {
    "running": [["Notion · search"]],
    "finished": [["Notion · search"]],
    "errored": [["Notion · search"]],
    "canceled": [["Notion · search"]]
  }
}
```

这与 `assistant_message.content[0].text` 不同：助手回答的该字段是普通字符串。两种格式不能混用。

2026-10-27，Notion 7.40.1 原生客户端的 `43815-65fdbe53c1742320.js`、模块 890820 在 `td` 中遍历 `textValue.value.entries()`，随后逐项解释富文本 token。此前适配器将工具状态文字传为字符串，触发 `TypeError: r.value.entries is not a function or its return value is not iterable`，进入整个视图的错误边界。修复为所有状态均发送富文本数组。

客户端错误堆栈与运行时读取的模块保存在本机 `.local/native-tool-crash-errors.json`、`.local/tool-text-renderer-modules.json`。`test/tool-loop.test.js` 覆盖运行中及成功、错误、取消后的序列化格式；`scripts/verify-tool-ui.js` 用真实客户端检查搜索/读取卡片、最终回答与 idle/end_turn，结果保存为 `.local/tool-ui-verification.json`。

同时为路由添加默认执行上下文创建后的钩子恢复，并启用 Page 域事件，覆盖刷新或导航后初始文档注入未生效的情况。恢复范围仍限于已连接的 Notion 页面及允许的 origin。

原生验证读取 API transcript 时，需要将 URL 中紧凑的 32 位 thread ID 恢复为带连字符的 UUID。验证脚本的 `--inspect --target TARGET_ID` 只检查现有验证对话，不再次发起模型请求。结束后的独立工具标签可能不在最终 DOM 中，检查以真实工具结果、最终回答可见、没有渲染异常、停止按钮消失与提交按钮恢复为准，标签可见性另外记录。
