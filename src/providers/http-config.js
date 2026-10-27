import { resolve } from 'node:path';
import { HttpProvider } from './http-provider.js';
import { CodexCredentials, CODEX_BASE_URL, readCodexAuth } from './codex-auth.js';
import { endpointBase } from './http-common.js';
import { codexAuthPath } from '../user-config.js';

// Roots, not full completion endpoints. Model names can always be overridden.
const catalog = {
  openai: ['OPENAI', 'responses', 'https://api.openai.com/v1', 'gpt-4.1'],
  anthropic: ['ANTHROPIC', 'anthropic', 'https://api.anthropic.com/v1', 'claude-sonnet-4-5'],
  gemini: ['GEMINI', 'gemini', 'https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-flash'],
  deepseek: ['DEEPSEEK', 'chat-completions', 'https://api.deepseek.com', 'deepseek-chat'],
  openrouter: ['OPENROUTER', 'chat-completions', 'https://openrouter.ai/api/v1', undefined],
  moonshot: ['MOONSHOT', 'chat-completions', 'https://api.moonshot.cn/v1', 'kimi-k2.5'],
  qwen: ['QWEN', 'chat-completions', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'],
  minimax: ['MINIMAX', 'chat-completions', 'https://api.minimax.io/v1', 'MiniMax-M2.5'],
  groq: ['GROQ', 'chat-completions', 'https://api.groq.com/openai/v1', undefined],
  mistral: ['MISTRAL', 'chat-completions', 'https://api.mistral.ai/v1', 'mistral-small-latest'],
  ollama: ['OLLAMA', 'chat-completions', 'http://127.0.0.1:11434/v1', undefined],
  'openai-compatible': ['OPENAI_COMPATIBLE', 'chat-completions', undefined, undefined],
};

export const httpAdapters = Object.fromEntries(Object.entries(catalog).map(([name, [prefix, protocol, baseUrl, defaultModel]]) => [name, {
  envKeys: ['API_KEY', 'BASE_URL', 'MODEL', 'MAX_TOKENS', 'TIMEOUT_MS', 'REASONING_EFFORT', ...(['anthropic', 'gemini'].includes(protocol) ? ['THINKING_BUDGET'] : [])].map(key => `${prefix}_${key}`),
  configure({ env, model = env[`${prefix}_MODEL`] || defaultModel, apiProfile }) {
    if (apiProfile !== undefined) throw new Error('--profile is supported only by zhipu.');
    return { name, protocol, model, baseUrl: endpointBase(env[`${prefix}_BASE_URL`] || baseUrl), apiKey: env[`${prefix}_API_KEY`],
      keyOptional: name === 'ollama' || name === 'openai-compatible',
      maxTokens: Number(env[`${prefix}_MAX_TOKENS`] ?? 4096), timeoutMs: Number(env[`${prefix}_TIMEOUT_MS`] ?? 180000),
      reasoningEffort: env[`${prefix}_REASONING_EFFORT`] || undefined,
      thinkingBudget: ['anthropic', 'gemini'].includes(protocol) && env[`${prefix}_THINKING_BUDGET`] ? Number(env[`${prefix}_THINKING_BUDGET`]) : undefined };
  },
  create: config => new HttpProvider(config),
  publicConfig: config => ({ model: config.model, protocol: config.protocol, endpoint: config.baseUrl, apiKeyConfigured: Boolean(config.apiKey?.trim()),
    maxTokens: config.maxTokens, timeoutMs: config.timeoutMs, reasoningEffort: config.reasoningEffort, thinkingBudget: config.thinkingBudget }),
}]));

export const codexAdapter = {
  envKeys: ['OPENAI_CODEX_MODEL', 'OPENAI_CODEX_AUTH_FILE', 'OPENAI_CODEX_CLI', 'OPENAI_CODEX_TIMEOUT_MS', 'OPENAI_CODEX_REASONING_EFFORT'],
  configure({ env, model = env.OPENAI_CODEX_MODEL || 'gpt-5.2-codex', apiProfile }) {
    if (apiProfile !== undefined) throw new Error('--profile is supported only by zhipu.');
    return { name: 'openai-codex', protocol: 'responses', subscription: true, baseUrl: CODEX_BASE_URL, model,
      authFile: resolve(env.OPENAI_CODEX_AUTH_FILE || codexAuthPath({ env })), codexCli: env.OPENAI_CODEX_CLI,
      timeoutMs: Number(env.OPENAI_CODEX_TIMEOUT_MS ?? 180000), reasoningEffort: env.OPENAI_CODEX_REASONING_EFFORT || undefined };
  },
  create: config => new HttpProvider({ ...config, credentials: new CodexCredentials(config) }),
  publicConfig: config => {
    let authConfigured = false; try { readCodexAuth(config.authFile); authConfigured = true; } catch {}
    return { model: config.model, protocol: config.protocol, endpoint: config.baseUrl, authMode: 'chatgpt-subscription', authConfigured,
      apiKeyConfigured: false, timeoutMs: config.timeoutMs, reasoningEffort: config.reasoningEffort };
  },
};
