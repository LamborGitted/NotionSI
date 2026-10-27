import { ProviderError } from './errors.js';
import { httpFailure } from './http-common.js';
import { CodexCredentials, CODEX_BASE_URL } from './codex-auth.js';
import { ZHIPU_ENDPOINTS } from './zhipu.js';

export async function listProviderModels(config, { signal, fetchImpl = fetch, details = false, credentials } = {}) {
  const name = config.name ?? config.provider;
  const baseUrl = config.subscription ? CODEX_BASE_URL : name === 'zhipu'
    ? ZHIPU_ENDPOINTS[config.apiProfile]?.replace(/\/chat\/completions$/, '') : config.baseUrl;
  if (!baseUrl) throw new ProviderError('请先配置供应商的接口地址。');
  if (!config.subscription && !config.keyOptional && !config.apiKey?.trim()) throw new ProviderError('请先填写 API Key，再读取模型列表。');
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  const headers = { Accept: 'application/json' };
  if (config.subscription) {
    const auth = await (credentials ?? new CodexCredentials(config)).get(combined);
    headers.Authorization = `Bearer ${auth.apiKey}`; headers['ChatGPT-Account-Id'] = auth.accountId; headers.originator = 'notionsi';
  } else if (config.apiKey) {
    if (config.protocol === 'anthropic') { headers['x-api-key'] = config.apiKey; headers['anthropic-version'] = '2023-06-01'; }
    else if (config.protocol === 'gemini') headers['x-goog-api-key'] = config.apiKey;
    else headers.Authorization = `Bearer ${config.apiKey}`;
  }
  let url = `${baseUrl}/models${config.subscription ? '?client_version=0.116.0' : ''}`; const modelsById = new Map();
  try {
    // Bounded pagination for Gemini/Anthropic. Never follow a server-supplied URL.
    for (let page = 0; page < 10; page++) {
      const response = await fetchImpl(url, { headers, signal: combined, redirect: 'error', credentials: 'omit' });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw httpFailure(config.name, response.status); }
      const reader = response.body?.getReader(); if (!reader) throw new Error();
      let length = 0; const chunks = [];
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          length += value.byteLength; if (length > 2097152) throw new Error(); chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const models = config.protocol === 'gemini' || config.subscription ? result.models : result.data;
      if (!Array.isArray(models)) throw new Error();
      for (const model of models) {
        if (config.protocol === 'gemini' && model.supportedGenerationMethods && !model.supportedGenerationMethods.includes('generateContent')) continue;
        if (['hide', 'hidden'].includes(model.visibility)) continue;
        const id = config.protocol === 'gemini' ? model.name?.replace(/^models\//, '') : config.subscription ? model.slug ?? model.id : model.id;
        const levels = model.supported_reasoning_levels ?? model.supportedReasoningEfforts;
        const reasoningOptions = Array.isArray(levels) ? [{ type: 'effort', values: levels.map(v => typeof v === 'string' ? v : v?.effort).filter(v => typeof v === 'string') }] : [];
        if (typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/:+\-]{0,199}$/.test(id)) modelsById.set(id, { id,
          name: model.display_name || model.displayName || model.name || id, reasoningOptions, source: 'provider' });
        if (modelsById.size >= 2000) break;
      }
      if (modelsById.size >= 2000) break;
      if (config.protocol === 'gemini' && typeof result.nextPageToken === 'string' && result.nextPageToken) {
        url = `${baseUrl}/models?pageToken=${encodeURIComponent(result.nextPageToken)}`;
      } else if (config.protocol === 'anthropic' && result.has_more === true && typeof result.last_id === 'string' && result.last_id) {
        url = `${baseUrl}/models?after_id=${encodeURIComponent(result.last_id)}`;
      } else break;
    }
    if (!modelsById.size) throw new ProviderError('接口没有返回可选模型。');
    const models = [...modelsById.values()].sort((a, b) => a.id.localeCompare(b.id));
    return details ? models : models.map(m => m.id);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('读取模型列表失败，请检查接口配置，或手动填写模型 ID。');
  }
}
