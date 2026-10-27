import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Explicit configuration must never silently select a different installation.
export function resolveNotionPath({ path, env = process.env, home = homedir(), stat = statSync } = {}) {
  function executableAt(candidate) {
    try {
      if (stat(candidate).isDirectory()) candidate = join(candidate, 'Notion.exe');
      return stat(candidate).isFile() ? resolve(candidate) : undefined;
    } catch { return undefined; }
  }
  const explicit = path ?? env.NOTION_PATH;
  if (explicit?.trim()) {
    const executable = executableAt(explicit.trim());
    if (!executable) throw new Error('Notion 路径无效。请检查 --notion 或 NOTION_PATH，指定 Notion.exe 文件或其所在目录。');
    return executable;
  }
  const candidates = [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Notion', 'Notion.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Notion', 'Notion.exe'),
    env.ProgramFiles && join(env.ProgramFiles, 'Notion', 'Notion.exe'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Notion', 'Notion.exe'),
    join(env.SCOOP || join(home, 'scoop'), 'apps', 'notion', 'current', 'Notion.exe'),
    env.SCOOP_GLOBAL && join(env.SCOOP_GLOBAL, 'apps', 'notion', 'current', 'Notion.exe'),
    env.ProgramData && join(env.ProgramData, 'scoop', 'apps', 'notion', 'current', 'Notion.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const executable = executableAt(candidate);
    if (executable) return executable;
  }
  return undefined;
}
