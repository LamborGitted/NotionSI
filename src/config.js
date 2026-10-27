import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { getProvider, providerEnvKeys } from './providers/index.js';
import { readUserConfig, userConfigPath } from './user-config.js';

export const CONFIG_KEYS = Object.freeze(['NOTION_PATH', 'NOTIONSI_LOG_CONTENT', 'NOTIONSI_PROVIDER', 'NOTIONSI_TOOLS', 'NOTIONSI_SYSTEM_PROMPT_FILE', ...providerEnvKeys]);

function loadSystemPrompt(path) {
  if (!path?.trim()) return '';
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > 65536) throw new Error();
    const bytes = readFileSync(path);
    if (bytes.length > 65536) throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
    if (!text || text.includes('\0')) throw new Error();
    return text;
  } catch {
    throw new Error('NOTIONSI_SYSTEM_PROMPT_FILE must reference a readable, non-empty UTF-8 file of at most 64 KiB.');
  }
}
export function readProjectEnv(path = '.env.local') {
  if (!existsSync(path)) return {};
  if (statSync(path).size > 65536) throw new Error('.env.local exceeds 64 KiB.');
  const text = readFileSync(path, 'utf8');
  if (text.length > 65536) throw new Error('.env.local exceeds 64 KiB.');
  const parsed = parseEnv(text);
  return Object.fromEntries(CONFIG_KEYS.filter(key => parsed[key] !== undefined).map(key => [key, parsed[key]]));
}
export function loadLocalEnv({ env = process.env, path = '.env.local', userPath = userConfigPath({ env }) } = {}) {
  const local = readProjectEnv(path), saved = userPath === null ? {} : readUserConfig({ path: userPath }).values;
  for (const key of CONFIG_KEYS) if (env[key] === undefined && (saved[key] !== undefined || local[key] !== undefined)) env[key] = saved[key] ?? local[key];
  return env;
}

export function providerConfig({ env = process.env, provider = env.NOTIONSI_PROVIDER ?? 'mock', model, apiProfile } = {}) {
  const adapter = getProvider(provider);
  const settings = adapter.configure({ env, model, apiProfile });
  const contentSetting = (env.NOTIONSI_LOG_CONTENT ?? '1').toLowerCase();
  if (!['1', 'true', '0', 'false'].includes(contentSetting)) throw new Error('NOTIONSI_LOG_CONTENT must be 1/true or 0/false.');
  const logContent = ['1', 'true'].includes(contentSetting);
  const tools = env.NOTIONSI_TOOLS ?? 'off';
  if (!['off', 'native'].includes(tools)) throw new Error('NOTIONSI_TOOLS must be off or native.');
  return { ...settings, provider, tools, logContent,
    systemPrompt: provider === 'mock' ? '' : loadSystemPrompt(env.NOTIONSI_SYSTEM_PROMPT_FILE) };
}

export function createProvider(config) {
  return getProvider(config.provider).create(config);
}

export function publicConfig(config) {
  return { provider: config.provider, logContent: config.logContent, tools: config.tools,
    ...getProvider(config.provider).publicConfig(config),
    systemPromptConfigured: Boolean(config.systemPrompt), systemPromptBytes: Buffer.byteLength(config.systemPrompt || '', 'utf8') };
}
