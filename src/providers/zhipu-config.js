import { ZhipuProvider, DEFAULT_ZHIPU_MODEL, ZHIPU_ENDPOINTS } from './zhipu.js';

export const zhipuAdapter = {
  envKeys: ['ZHIPU_API_PROFILE', 'ZHIPU_API_KEY', 'ZHIPU_MODEL', 'ZHIPU_MAX_TOKENS', 'ZHIPU_TIMEOUT_MS', 'ZHIPU_THINKING', 'ZHIPU_REASONING_EFFORT'],
  configure({ env, model = env.ZHIPU_MODEL || DEFAULT_ZHIPU_MODEL, apiProfile = env.ZHIPU_API_PROFILE ?? 'standard' }) {
    if (!Object.hasOwn(ZHIPU_ENDPOINTS, apiProfile)) throw new Error('ZHIPU_API_PROFILE must be standard or coding-cn.');
    const forcedThinking = /^glm-5\.3(?:-|$)/i.test(model);
    return { apiProfile, apiKey: env.ZHIPU_API_KEY, model,
      maxTokens: Number(env.ZHIPU_MAX_TOKENS ?? 2048), timeoutMs: Number(env.ZHIPU_TIMEOUT_MS ?? 180000),
      thinking: forcedThinking ? 'enabled' : env.ZHIPU_THINKING ?? 'disabled',
      reasoningEffort: env.ZHIPU_REASONING_EFFORT || (forcedThinking ? 'low' : undefined) };
  },
  create: config => new ZhipuProvider(config),
  publicConfig: config => ({ apiProfile: config.apiProfile, model: config.model,
    apiKeyConfigured: Boolean(config.apiKey?.trim()), endpoint: ZHIPU_ENDPOINTS[config.apiProfile],
    maxTokens: config.maxTokens, timeoutMs: config.timeoutMs, thinking: config.thinking, reasoningEffort: config.reasoningEffort }),
};
