import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function prepareRelease({ tag, version, changelog, repository = 'LamborGitted/NotionSI' }) {
  if (tag !== `v${version}` || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`Release tag must match package.json version: expected v${version}, received ${tag || '(missing)'}.`);
  }
  const sections = changelog.replace(/\r\n/g, '\n').split(/^## /m);
  const section = sections.slice(1).find(text => {
    const heading = text.split('\n', 1)[0];
    return heading === version || heading.startsWith(`${version} — `);
  });
  if (!section) throw new Error(`CHANGELOG.md is missing a release section for ${version}.`);
  const body = section.slice(section.indexOf('\n') + 1).trim();
  if (!body) throw new Error(`CHANGELOG.md release section for ${version} is empty.`);
  // Release pages do not resolve repository-relative Markdown links like files do.
  const linkedBody = body.replace(/\]\((?![a-z][a-z0-9+.-]*:|#|\/)([^)\s]+)\)/gi,
    (_, target) => `](https://github.com/${repository}/blob/${encodeURIComponent(tag)}/${target})`);
  return {
    prerelease: version.includes('-'),
    notes: `# NotionSI ${tag}\n\n${linkedBody}\n\n## 下载与使用\n\n` +
      '- Windows x64：下载下方的 **NotionSI-win-x64.zip**，解压后运行 `NotionSI.exe config`，再运行 `NotionSI.exe start`。\n' +
      '- API Key 接入无需安装 Node.js；ChatGPT/Codex 订阅登录仍需官方 Codex CLI。\n' +
      '- `NotionSI-win-x64.zip.sha256` 用于校验 ZIP；GitHub 自动生成的 Source code 为源码，不包含 EXE。\n' +
      '- 项目仍为实验性原型，需要已安装并登录的 Windows Notion。兼容情况与限制见压缩包内的 README 和 docs。\n',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, output] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node scripts/prepare-release.js <tag> <notes-file>');
  const root = new URL('../', import.meta.url);
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    throw new Error('package-lock.json version must match package.json. Run npm version before releasing.');
  }
  const release = prepareRelease({ tag, version: pkg.version, changelog: await readFile(new URL('CHANGELOG.md', root), 'utf8'), repository: process.env.GITHUB_REPOSITORY });
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, release.notes);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `prerelease=${release.prerelease}\n`);
  }
  console.log(`Prepared ${tag} (${release.prerelease ? 'pre-release' : 'release'}): ${output}`);
}
