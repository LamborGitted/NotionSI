# 编辑器内 AI 适配

2026-10-27 在 Scoop Notion 7.40.1 的当前网页构建中验证。模型为本机配置的 GLM Coding Plan CN / GLM-5.3，沿用已加载的全量系统提示词，并在该请求中附加选区编辑约束。

## 使用

安装依赖后运行 `npm run start:coding-cn`。在页面中选择文本，点击原生的“重新格式化”，或“使用 AI 编辑”并输入要求，例如“整理成时间、事项、负责人三列表格”。结果通过 Notion 自己的 Writer 界面展示，可点击“接受”或“撤销”。

内置指令映射为 `reformat`、`improve_writing`、`fix_spelling_grammar`、`make_shorter`、`make_longer`、`add_summary`、`continue_writing`、`explain_this`。前五项替换选区，摘要和续写保留原文并追加，解释不改文档。无 `prebuiltPromptType` 的自定义文字要求也支持，包括翻译、结构化与语气调整；未知技能不会猜测执行。

## 原生协议

内联 Writer 使用 `POST /api/v3/runWriter`，响应为 JSON。它和侧栏 Agent 的 transcript 流是不同入口，只拦截聊天端点不能覆盖编辑器。

主要请求结构（标识符为占位符）：

```json
{
  "type": "personal_agent",
  "spaceId": "<workspace UUID>",
  "threadId": "<thread UUID>",
  "clientMessageId": "<message UUID>",
  "content": [{"type": "text", "text": [["重新格式化"]]}],
  "prebuiltPromptType": "reformat",
  "surface": "rich_text_menu",
  "threadContext": {
    "currentBlockId": "<page UUID>",
    "selectionPageId": "<page UUID>",
    "selection": {
      "type": "text",
      "value": {
        "start": {"pointer": {"table": "block", "id": "<block UUID>", "spaceId": "<workspace UUID>"}, "index": 0},
        "end": {"pointer": {"table": "block", "id": "<block UUID>", "spaceId": "<workspace UUID>"}, "index": 8}
      },
      "text": "<selected text>"
    }
  }
}
```

区块选区为 `selection.type="blocks"`、`selection.value=[blockPointer,...]`。客户端预览可能截断，执行器重新读取真实区块，不以预览代替正文。索引使用 JavaScript UTF-16 单位，禁止切开代理字符对。

执行过程：

1. 读取选区、父级及祖先，核对页面、工作区、连续顺序、原始文字和版本。只把所选文字与用户要求交给模型。
2. 将 Markdown 转为原生区块，保存选区外的前后缀及行内标注。提交前再次核对版本与父级顺序。
3. 经当前页面的原始 `fetch` 提交 `saveTransactionsFanout`。Cookie 留在页面内。原区块属性使用 `updateBlockPropertyValue`，新块使用 `set`，父级顺序使用 `listAfter` / `listRemove`。
4. 回读并比较原生内容。Notion 会省略空属性、空表格单元格或合并相邻富文本段，因此比较规范化后的语义。
5. 返回原生 `status="edited"`、`acknowledgment`、`undoReady`、`sessionIdleEventId`、`turnId`、`blockDiffs` 和 v3 `recordMap`。更新差异使用 `titleDiff` 的 `[-]` / `[+]` 富文本注解；新建/删除差异带对应区块指针。

原生服务也是先写入，再返回预览。“接受”关闭预览；“撤销”请求 `POST /api/v3/undoAgentServiceTurn`。仅 `sessionIdleEventId` 以 `notionsi_writer_` 开头的请求进入本地撤销，其余撤销请求走原路径。相同请求标识的重试复用结果，避免重复写入。

写入已提交但回读异常时返回 `partial`，保留撤销计划并提示先检查或撤销。自动恢复前检查已写入版本，或在缺失回读时核对预期内容；无法确认时拒绝覆盖。不能保证取消一笔已被服务器接受的事务。

## 文件与范围

- `src/writer-adapter.mjs`：Writer 请求、模型生成、原生响应、重复请求与撤销状态。
- `src/editor-selection.mjs`：选区解析、读取与边界校验、事务、回读及恢复。
- `src/editor-markdown.mjs`：锁定版本 `marked` 的 AST 转换；标题、段落、嵌套列表、待办、引用、代码、分隔线、表格及粗体/斜体/删除线/代码/链接。
- `src/router.mjs`：路由入口，及侧栏聊天选区正文注入、作用域限定的 `update-selection` 工具。
- `src/page-hook.mjs`：Writer 拦截和本地撤销标识分流。

原始选区支持同一父级下连续的、没有子内容的文本类区块。输出可带嵌套列表和表格；原选区中的嵌套块、图片、数据库、同步引用和空光标写整页尚未适配。一次最多读取 100 个选区块、50000 字符；输出最多 200 块、8 层嵌套、表格 12 列和 50 个正文行。HTML/XML 和图片输出在写入前拒绝。

撤销只恢复这次选区及其新建块，不覆盖选区之外的内容。后续修改或顺序变化可能导致撤销被拒绝，需要人工恢复。本地会话与撤销快照只存在进程内存中，重启路由会丢失；生成期间不要重启。侧栏 `update-selection` 是另一条工具路径，目前没有内联 Writer 的接受/撤销按钮，使用时按直接编辑理解。

普通侧栏聊天的页面工具仍使用原有基础 Markdown 子集；本次增强针对编辑器和 `update-selection`，没有扩大整页替换的格式范围。

## 验证与证据

自动测试覆盖选区边界、部分富文本、连续多块、截断预览补全、摘要追加、原生 JSON、请求与撤销幂等、过期写入拒绝、解释/失败/取消不写入、侧栏选区上下文与工具限制、空表格属性规范化、提交后断线恢复及嵌套子块撤销。

已在独立的“NotionSI 编辑器 AI 验证”页面实测：

- 内置重新格式化 → GLM 标题/列表 → 原生预览和按钮正常 → 原生撤销恢复源文本。
- 自定义整理表格 → GLM 表格 → 原生预览正常 → 接受关闭弹窗 → 服务器回读确认表格保存。
- 两项均未改变选区之外的保留区块，没有出现渲染器错误页。

测试脚本 `scripts/verify-editor.mjs` 需要明确传 `--run`；只用于已准备的独立测试页。`.local/editor-sandbox.json` 配置形如 `{ "id": "<page UUID>", "spaceId": "<workspace UUID>", "targetId": "<CDP page target ID>" }`，测试页标题须以 `NotionSI` 开头，至少有一个保留文本区块，以及一个以“待整理内容”开头的原始文本区块。脚本会真实调用模型、编辑测试页，并记录到忽略目录 `.local/`，不应提交其中的用户内容。

```powershell
npm run verify:editor -- --run
npm run verify:editor -- --run --table --accept
```

测试使用该构建的原生文本选区和 `toggleInitialPrompt` 动作，点击原生接受/撤销按钮；未替换编辑器 UI。验证脚本中的模块 ID 依赖此构建，生产路由按请求字段工作，不依赖这些 ID。

REA 当前目标发现证据为 `ev_9d37b8ac85dd6540807d4f83cabc7df3aa6695f296f545414b183c60c9f4fb67`；编辑器运行时只读观察证据为 `ev_21dc1170520104c2c18ca4cc6358f91bd0f060ff158d2d6224a6f91e7e371fef`。Writer 具体字段另由运行中自建测试页的请求/响应、原生消费者模块及上述集成结果交叉确认。它们不代表其他 Notion 网页构建也已验证；原始静态研究报告保持原有范围。
