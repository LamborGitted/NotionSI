import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { ZhipuProvider, DEFAULT_ZHIPU_MODEL, ZHIPU_ENDPOINTS } from './providers/zhipu.mjs';

const KEYS = ['NOTIONSI_LOG_CONTENT', 'NOTIONSI_PROVIDER', 'NOTIONSI_TOOLS', 'NOTIONSI_SYSTEM_PROMPT_FILE', 'ZHIPU_API_PROFILE', 'ZHIPU_API_KEY', 'ZHIPU_MODEL', 'ZHIPU_MAX_TOKENS', 'ZHIPU_TIMEOUT_MS', 'ZHIPU_THINKING', 'ZHIPU_REASONING_EFFORT'];

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
export function loadLocalEnv({ env = process.env, path = '.env.local' } = {}) {
  if (!existsSync(path)) return env;
  const text = readFileSync(path, 'utf8');
  if (text.length > 65536) throw new Error('.env.local exceeds 64 KiB.');
  const local = parseEnv(text);
  for (const key of KEYS) if (env[key] === undefined && local[key] !== undefined) env[key] = local[key];
  return env;
}

export function providerConfig({ env = process.env, provider = env.NOTIONSI_PROVIDER ?? 'mock', model = env.ZHIPU_MODEL, apiProfile = env.ZHIPU_API_PROFILE ?? 'standard' } = {}) {
  if (!['mock', 'zhipu'].includes(provider)) throw new Error('provider must be mock or zhipu. Select the endpoint with ZHIPU_API_PROFILE.');
  if (!Object.hasOwn(ZHIPU_ENDPOINTS, apiProfile)) throw new Error('ZHIPU_API_PROFILE must be standard or coding-cn.');
  const contentSetting = (env.NOTIONSI_LOG_CONTENT ?? '1').toLowerCase();
  if (!['1', 'true', '0', 'false'].includes(contentSetting)) throw new Error('NOTIONSI_LOG_CONTENT must be 1/true or 0/false.');
  const logContent = ['1', 'true'].includes(contentSetting);
  const tools = env.NOTIONSI_TOOLS ?? 'off';
  if (!['off', 'native'].includes(tools)) throw new Error('NOTIONSI_TOOLS must be off or native.');
  const forcedThinking = /^glm-5\.3(?:-|$)/i.test(model || DEFAULT_ZHIPU_MODEL);
  return { provider, apiProfile, tools, logContent, apiKey: env.ZHIPU_API_KEY, model: model || DEFAULT_ZHIPU_MODEL,
    systemPrompt: provider === 'zhipu' ? loadSystemPrompt(env.NOTIONSI_SYSTEM_PROMPT_FILE) : '',
    maxTokens: Number(env.ZHIPU_MAX_TOKENS ?? 2048), timeoutMs: Number(env.ZHIPU_TIMEOUT_MS ?? 180000),
    thinking: forcedThinking ? 'enabled' : env.ZHIPU_THINKING ?? 'disabled',
    reasoningEffort: env.ZHIPU_REASONING_EFFORT || (forcedThinking ? 'low' : undefined) };
}

export function createProvider(config) {
  return config.provider === 'mock' ? null : new ZhipuProvider(config);
}

export function publicConfig(config) {
  return { provider: config.provider, logContent: config.logContent, tools: config.tools, apiProfile: config.apiProfile, model: config.model, apiKeyConfigured: Boolean(config.apiKey?.trim()),
    systemPromptConfigured: Boolean(config.systemPrompt), systemPromptBytes: Buffer.byteLength(config.systemPrompt || '', 'utf8'),
    endpoint: config.provider === 'zhipu' ? ZHIPU_ENDPOINTS[config.apiProfile] : null,
    maxTokens: config.maxTokens, timeoutMs: config.timeoutMs, thinking: config.thinking, reasoningEffort: config.reasoningEffort };
}
