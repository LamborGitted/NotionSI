import { readFileSync, statSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { userConfigDirectory } from '../user-config.js';

const URL = 'https://models.dev/api.json';
const LIMIT = 32 * 1024 * 1024;
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const aliases = { gemini: 'google', moonshot: 'moonshotai-cn', qwen: 'alibaba-cn', 'openai-codex': 'openai' };

export async function loadModelCatalog({ env = process.env, cacheFile = join(userConfigDirectory({ env }), 'cache', 'models.dev.json'),
  fetchImpl = fetch, signal, now = Date.now() } = {}) {
  let stale;
  try {
    if (statSync(cacheFile).size <= LIMIT) {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (cached.data && typeof cached.data === 'object' && !Array.isArray(cached.data)) {
        stale = cached.data;
        if (Number.isFinite(cached.fetchedAt) && now - cached.fetchedAt >= 0 && now - cached.fetchedAt < 86400000) return stale;
      }
    }
  } catch {}
  try {
    const response = await fetchImpl(URL, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error' });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(); }
    const reader = response.body?.getReader(); if (!reader) throw new Error();
    let bytes = 0; const chunks = [];
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > LIMIT) throw new Error(); chunks.push(value); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    // Cache is optional; it contains public model metadata, never user settings or credentials.
    const temporary = `${cacheFile}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify({ fetchedAt: now, data }), { flag: 'wx', mode: 0o600 }); renameSync(temporary, cacheFile);
    } catch {} finally { try { unlinkSync(temporary); } catch {} }
    return data;
  } catch { if (signal?.aborted) throw signal.reason; return stale ?? {}; }
}

export function catalogModels(catalog, provider, config = {}) {
  const name = provider === 'zhipu' ? config.apiProfile === 'coding-cn' ? 'zhipuai-coding-plan' : 'zhipuai' : aliases[provider] ?? provider;
  const models = catalog[name]?.models;
  if (!models || typeof models !== 'object') return [];
  return Object.values(models).filter(m => m && typeof m.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._/:+\-]{0,199}$/.test(m.id) &&
    (!m.type || m.type === 'chat') && (!m.modalities?.output || Array.isArray(m.modalities.output) && m.modalities.output.includes('text')) && m.status !== 'deprecated').map(m => ({
      id: m.id, name: typeof m.name === 'string' ? m.name : m.id, reasoning: m.reasoning === true,
      reasoningOptions: Array.isArray(m.reasoning_options) ? m.reasoning_options : [], toolCall: m.tool_call,
      source: 'models.dev',
    }));
}

export function enrichModels(models, catalog, provider, config) {
  const reference = new Map(catalogModels(catalog, provider, config).map(m => [m.id, m]));
  return models.map(m => {
    const live = typeof m === 'string' ? { id: m } : m;
    const known = reference.get(live.id);
    return { ...known, ...live, name: live.name || known?.name || live.id,
      reasoningOptions: live.reasoningOptions?.length ? live.reasoningOptions : known?.reasoningOptions ?? [], source: live.source ?? 'provider' };
  });
}

export function reasoningChoices(provider, model) {
  const choices = [{ value: '', label: '使用模型默认思考设置' }];
  const options = model.reasoningOptions ?? [];
  const effort = options.find(o => o?.type === 'effort');
  if (Array.isArray(effort?.values)) for (const level of [...new Set(effort.values)]) {
    if (EFFORTS.includes(level) && (provider !== 'zhipu' || ['low', 'high', 'max'].includes(level)) &&
        (provider !== 'gemini' || ['minimal', 'low', 'medium', 'high'].includes(level))) choices.push({ value: level, label: level });
  }
  if (choices.length === 1 && provider === 'zhipu' && /^glm-5\.3(?:-|$)/i.test(model.id)) {
    for (const level of ['low', 'high', 'max']) choices.push({ value: level, label: level });
  }
  const budget = options.find(o => o?.type === 'budget_tokens');
  if (budget && ['anthropic', 'gemini'].includes(provider)) {
    if (provider === 'gemini' && (budget.min ?? 0) === 0 && options.some(o => o?.type === 'toggle')) choices.push({ value: 'budget:0', label: '关闭思考（预算 0 tokens）' });
    for (const [level, tokens] of [['低', 1024], ['中', 4096], ['高', 8192]]) {
      if (tokens >= (budget.min ?? 0) && tokens <= (budget.max ?? 131071)) choices.push({ value: `budget:${tokens}`, label: `${level}（思考预算 ${tokens} tokens）` });
    }
  }
  if (options.some(o => o?.type === 'toggle') && provider === 'zhipu' && !/^glm-5\.3(?:-|$)/i.test(model.id)) {
    choices.push({ value: 'toggle:enabled', label: '开启思考' }, { value: 'toggle:disabled', label: '关闭思考' });
  }
  return choices;
}
