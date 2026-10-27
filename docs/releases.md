# 版本发布与下载指南

NotionSI 使用 GitHub Actions 将版本标签对应的代码打包为 Windows x64 便携程序，再自动上传到 GitHub Release。日常提交只触发 CI 测试；准备发布时才推送版本标签。

## 下载和运行

1. 打开仓库的 [Releases 页面](https://github.com/LamborGitted/NotionSI/releases)。
2. 在对应版本的 **Assets** 中下载 **NotionSI-win-x64.zip**。`Source code (zip)` 和 `Source code (tar.gz)` 是 GitHub 生成的源码包，不包含可执行程序。
3. 解压 ZIP，在包含 `NotionSI.exe` 的目录打开 PowerShell，运行：

```powershell
.\NotionSI.exe config
.\NotionSI.exe start
```

需要已经安装并登录的 Windows Notion。API Key 接入不需要额外安装 Node.js；ChatGPT/Codex 订阅登录仍需官方 Codex CLI，详见 [多提供商使用指南](model-providers.md)。目前的程序为实验性原型且没有代码签名。

升级时先用 `q` 回车或 Ctrl+C 退出旧路由，将新包解压到新目录再启动。配置与默认订阅凭据保存在 `%LOCALAPPDATA%\NotionSI`，无需复制旧程序目录。项目级 `.env.local`、自定义提示词及相对路径以当前工作目录为准，需要自行保留。重启会清空进程内的聊天历史和撤销记录。

## 校验下载文件

将 `NotionSI-win-x64.zip.sha256` 下载到 ZIP 的同一个目录，运行：

```powershell
$expectedHash = ((Get-Content -LiteralPath .\NotionSI-win-x64.zip.sha256 -Raw).Trim() -split '\s+')[0]
$actualHash = (Get-FileHash -LiteralPath .\NotionSI-win-x64.zip -Algorithm SHA256).Hash
if ($actualHash -ine $expectedHash) { throw '下载文件校验失败，请重新下载。' }
'SHA-256 校验通过'
```

## 自动发布做了什么

工作流文件： [`.github/workflows/build-executable.yml`](../.github/workflows/build-executable.yml)，Actions 名称为 **Build and release Windows executable**。

| 操作 | 结果 |
| --- | --- |
| 推送 `v0.3.0` 这样的版本标签 | 校验版本、测试、构建、独立运行检查，成功后自动发布 Release |
| 推送 `v0.4.0-rc.1` 这样的预发布标签 | 同上，Release 自动标为 Pre-release，且不设为 Latest |
| 手动 Run workflow，选择 `main` 等分支 | 仅构建，可在该次运行的 Artifacts 下载，不创建 Release |
| 手动在已有版本标签上运行流程 | 与标签推送相同，会尝试发布对应 Release |
| 普通提交、分支推送、PR | 由 CI 运行测试，不发布 Release |

标签构建首先检查：标签为 `v` 加包版本、`package-lock.json` 两处根版本与包版本一致，且 CHANGELOG 中有非空的对应版本节。比如 `v0.3.0` 必须对应包版本 `0.3.0` 和 `## 0.3.0 — 日期`。

Windows 构建任务执行 `npm ci`、`npm test`、`npm run build:exe` 和 `npm run test:exe`。通过后生成 ZIP 与 SHA-256；独立的发布任务再次校验 ZIP，使用 CHANGELOG 对应版本节作为发布说明，上传以下文件：

- `NotionSI-win-x64.zip`
- `NotionSI-win-x64.zip.sha256`

Actions 附件还包含生成的 `release-notes.md`，保留 30 天；Release 下载文件不受这个附件保留期限影响。构建通过不等于所有 Notion 版本或所有模型通道均已实机验证，具体限制保留在版本说明中。

## 首次启用

将工作流、发布脚本、版本信息和文档一起提交到 GitHub，且创建标签的提交必须包含这些文件。仓库需要允许 GitHub Actions 运行。

发布任务单独声明 `contents: write`，通过 GitHub 自带的 `GITHUB_TOKEN` 创建 Release；构建任务只保留读取权限。不需要添加个人访问令牌，也不需要上传任何模型密钥或本地配置。组织或仓库策略若禁止该权限，需要管理员允许工作流创建 Release。

当前版本 `0.3.0` 的版本信息和 CHANGELOG 已整理；代码提交并推送后，只需在那个提交上创建和推送 `v0.3.0`，即可发布当前代码。

## 以后如何发布新版本

以下以将来发布 `0.3.1` 为例；只有打算发布时才执行最后的标签推送。

1. 在干净工作区更新代码，使用 npm 同步修改包版本及锁文件，但暂不创建标签：

```powershell
npm version 0.3.1 --no-git-tag-version
```

2. 将 CHANGELOG 的“未发布”内容移入 `## 0.3.1 — YYYY-MM-DD`，填写真实日期、更新内容、升级方法和限制；同步 README 与开发状态中的当前版本。
3. 本地验证，并预览将来发布到 GitHub 的正文：

```powershell
npm test
node scripts/prepare-release.js v0.3.1 .build/release-notes.md
Get-Content .build/release-notes.md
```

4. 提交并推送准备好的文件。下面的清单适用于仅修改这些版本文件的情况；若有功能代码，也要一并提交对应文件：

```powershell
git add package.json package-lock.json CHANGELOG.md README.md docs/project-status.md
git commit -m "Prepare NotionSI v0.3.1"
git push origin main
git tag -a v0.3.1 -m "NotionSI v0.3.1"
git push origin v0.3.1
```

5. 到 [Actions](https://github.com/LamborGitted/NotionSI/actions/workflows/build-executable.yml) 查看这次标签运行。`build` 和 `release` 都成功后，到 [Releases](https://github.com/LamborGitted/NotionSI/releases) 确认版本说明、ZIP 与校验文件。

预发布同理：包版本改为 `0.4.0-rc.1`，CHANGELOG 使用同样的版本号，标签为 `v0.4.0-rc.1`。普通 `v0.3.0` 标签创建普通 Release；项目仍然可以处于实验阶段，以发布说明为准。

## 失败时怎么处理

- **版本不一致 / 缺少更新记录**：查看 `Validate release version and prepare notes` 日志。修复版本文件和 CHANGELOG，提交后使用新的版本标签发布；已发布的版本不移动标签、不覆盖附件。
- **测试或 EXE 检查失败**：流程停止，不进入发布任务。根据日志修复代码后发布新的版本。若只是临时网络问题，可在同一次 Actions 运行中使用 **Re-run failed jobs**。
- **构建成功但没有 Release**：手动运行时若选择的是分支，只会打包；需推送版本标签。检查标签是否以 `v` 开头，以及发布任务是否执行。
- **403 / Resource not accessible by integration**：确认仓库 Actions 已启用，发布任务保留 `contents: write`，且仓库或组织策略没有禁止发布权限。
- **同名 Release 已存在**：流程不会覆盖已发布版本，`gh release create` 会报错。若下载附件完整，无需再次发布；若上次上传中断留下未发布草稿，可先检查草稿，删除该未发布草稿后重跑。不要删除已经公开发布的版本来替换程序。
- **发布成功但找不到 EXE**：下载 Assets 下的 `NotionSI-win-x64.zip`，不要下载 Source code；解压后进入 `NotionSI-win-x64` 文件夹。

相关官方说明：[GitHub Release](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)、[GITHUB_TOKEN 权限](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token)、[GitHub CLI 创建 Release](https://cli.github.com/manual/gh_release_create)。
