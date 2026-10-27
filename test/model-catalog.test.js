import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadModelCatalog, catalogModels, enrichModels, reasoningChoices } from '../src/providers/model-catalog.js';
import { protocols } from '../src/providers/wire-protocols.js';
import { HttpProvider } from '../src/providers/http-provider.js';

test('models.dev retrieval sends no credentials, caches public data and reuses a fresh cache offline', async t => {
  const root = mkdtempSync(join(tmpdir(), 'notionsi-models-')); t.after(() => rmSync(root, { recursive: true })); const cacheFile = join(root, 'models.json');
  let calls = 0;
  const data = await loadModelCatalog({ cacheFile, env: { OPENAI_API_KEY: 'private-key' }, now: 1000,
    fetchImpl: async (url, options) => {
      calls++; assert.equal(url, 'https://models.dev/api.json'); assert.deepEqual(options.headers, { Accept: 'application/json' });
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); return Response.json({ openai: { models: {} } });
    },
  });
  const cached = await loadModelCatalog({ cacheFile, now: 2000, fetchImpl: async () => { throw new Error('must use cache'); } });
  assert.deepEqual(cached, data); assert.equal(calls, 1); assert.equal(readFileSync(cacheFile, 'utf8').includes('private-key'), false);
});

test('an unavailable or malformed catalog falls back to stale public data without blocking setup', async t => {
  const root = mkdtempSync(join(tmpdir(), 'notionsi-models-stale-')); t.after(() => rmSync(root, { recursive: true })); const cacheFile = join(root, 'models.json');
  writeFileSync(cacheFile, JSON.stringify({ fetchedAt: 0, data: { old: { models: {} } } }));
  const failed = await loadModelCatalog({ cacheFile, now: 86400001, fetchImpl: async () => new Response('upstream error', { status: 500 }) });
  assert.deepEqual(failed, { old: { models: {} } });
  const invalid = await loadModelCatalog({ cacheFile: join(root, 'missing.json'), fetchImpl: async () => Response.json([]) }); assert.deepEqual(invalid, {});
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadModelCatalog({ cacheFile: join(root, 'missing.json'), signal: controller.signal, fetchImpl: async () => { throw controller.signal.reason; } }), { name: 'AbortError' });
});

test('catalog aliases distinguish Zhipu profiles, exclude non-text models and preserve live capability precedence', () => {
  const catalog = { 'zhipuai-coding-plan': { models: {
    chat: { id: 'glm-chat', reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] },
    image: { id: 'image-only', modalities: { output: ['image'] } }, embed: { id: 'embed', type: 'embedding' },
  } } };
  assert.deepEqual(catalogModels(catalog, 'zhipu', { apiProfile: 'coding-cn' }).map(m => m.id), ['glm-chat']);
  assert.deepEqual(catalogModels(catalog, 'zhipu', { apiProfile: 'standard' }), []);
  const [model] = enrichModels([{ id: 'glm-chat', reasoningOptions: [{ type: 'effort', values: ['low'] }] }], catalog, 'zhipu', { apiProfile: 'coding-cn' });
  assert.deepEqual(reasoningChoices('zhipu', model).map(c => c.value), ['', 'low']);
});

test('reasoning menus use per-model effort, budget or toggle metadata instead of a universal list', () => {
  assert.deepEqual(reasoningChoices('openai', { id: 'gpt-4.1', reasoning: false }).map(c => c.value), ['']);
  assert.deepEqual(reasoningChoices('openai-codex', { id: 'model', reasoningOptions: [{ type: 'effort', values: ['low', 'max', 'unknown', 'low'] }] }).map(c => c.value), ['', 'low', 'max']);
  assert.deepEqual(reasoningChoices('gemini', { id: 'gemini', reasoningOptions: [{ type: 'budget_tokens', min: 2048, max: 5000 }] }).map(c => c.value), ['', 'budget:4096']);
  assert.ok(reasoningChoices('gemini', { id: 'gemini', reasoningOptions: [{ type: 'toggle' }, { type: 'budget_tokens', min: 0, max: 5000 }] }).some(c => c.value === 'budget:0'));
  assert.deepEqual(reasoningChoices('zhipu', { id: 'glm-4.7', reasoningOptions: [{ type: 'toggle' }] }).map(c => c.value), ['', 'toggle:enabled', 'toggle:disabled']);
});

test('Anthropic and Gemini settings serialize into their native effort and thinking-budget fields', () => {
  const messages = [{ role: 'user', content: 'Question' }];
  const common = { name: 'fixture', model: 'fixture-model', apiKey: 'key', baseUrl: 'https://fixture.test/v1' };
  const anthropic = new HttpProvider({ ...common, protocol: 'anthropic', reasoningEffort: 'max' });
  assert.deepEqual(protocols.anthropic.request(anthropic, messages).body.output_config, { effort: 'max' });
  const budget = new HttpProvider({ ...common, protocol: 'anthropic', thinkingBudget: 1024 });
  assert.deepEqual(protocols.anthropic.request(budget, messages).body.thinking, { type: 'enabled', budget_tokens: 1024 });
  const gemini = new HttpProvider({ ...common, protocol: 'gemini', reasoningEffort: 'low' });
  assert.deepEqual(protocols.gemini.request(gemini, messages).body.generationConfig.thinkingConfig, { thinkingLevel: 'LOW' });
  const geminiBudget = new HttpProvider({ ...common, protocol: 'gemini', thinkingBudget: 1024 });
  assert.deepEqual(protocols.gemini.request(geminiBudget, messages).body.generationConfig.thinkingConfig, { thinkingBudget: 1024 });
  assert.throws(() => new HttpProvider({ ...common, protocol: 'gemini', thinkingBudget: 4096 }), /THINKING_BUDGET/);
  assert.throws(() => new HttpProvider({ ...common, protocol: 'anthropic', thinkingBudget: 1024, reasoningEffort: 'low' }), /not both/);
});
