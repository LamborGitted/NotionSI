import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function userConfigDirectory({ env = process.env, platform = process.platform } = {}) {
  const root = platform === 'win32'
    ? env.LOCALAPPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Local')
    : env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(root, 'NotionSI');
}
export const userConfigPath = options => join(userConfigDirectory(options), 'config.json');
export const codexAuthPath = options => join(userConfigDirectory(options), 'auth', 'openai-codex', 'auth.json');

export function readUserConfig({ path = userConfigPath() } = {}) {
  if (!existsSync(path)) return { path, values: {}, providers: [], source: undefined };
  try {
    if (!statSync(path).isFile() || statSync(path).size > 65536) throw new Error();
    const source = readFileSync(path, 'utf8');
    const record = JSON.parse(source);
    if (record.version !== 1 || !record.values || typeof record.values !== 'object' || Array.isArray(record.values) ||
        Object.values(record.values).some(value => typeof value !== 'string') ||
        (record.providers !== undefined && (!Array.isArray(record.providers) || record.providers.some(p => typeof p !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(p))))) throw new Error();
    return { path, values: record.values, providers: [...new Set(record.providers ?? [])], source };
  } catch { throw new Error(`无法读取用户配置 ${path}：需要 version=1、values 为字符串映射的 JSON 文件，最大 64 KiB。`); }
}

export function saveUserConfig(values, { path = userConfigPath(), expectedSource, providers } = {}) {
  const current = readUserConfig({ path });
  if (current.source !== expectedSource) throw new Error('用户配置已被其他进程修改，请重新打开交互配置后再保存。');
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.entries(values).some(([key, value]) =>
    !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value))) throw new Error('用户配置包含无效字段或换行。');
  providers = providers ?? current.providers;
  if (!Array.isArray(providers) || providers.some(p => typeof p !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(p))) throw new Error('供应商列表无效。');
  const source = JSON.stringify({ version: 1, values, providers: [...new Set(providers)] }, null, 2) + '\n';
  if (Buffer.byteLength(source) > 65536) throw new Error('用户配置不能超过 64 KiB。');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, source, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch {} }
  return { path, values: { ...values }, providers: [...new Set(providers)], source };
}
