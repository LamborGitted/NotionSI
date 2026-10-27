# 默认系统提示词

`notion-system-prompt.txt` 保存此前源码版通过 `system-prompt.notion.local.txt` 使用的完整参考提示词，来源记录见 [系统提示词与工具](../docs/system-prompt-and-tools.md)。保留完整内容，并在运行时单独追加 NotionSI 的实际能力说明，不将参考文本中的工具描述当作已实现功能。

源码版直接读取此受版本管理的文件；Windows 可执行程序将同一文件作为 SEA 资源内嵌，不依赖启动目录或开发机器的本地文件。自定义 `NOTIONSI_SYSTEM_PROMPT_FILE` 继续优先覆盖内置提示词。
