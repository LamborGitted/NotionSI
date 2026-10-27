import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { runConfigTui } from '../src/config-tui.js';
import { readUserConfig, saveUserConfig } from '../src/user-config.js';
import { TerminalUi, UiCanceled } from '../src/terminal-ui.js';
import { listProviderModels } from '../src/providers/model-list.js';

const effortModel = id => ({ id, reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }] });
function setup(t, sequence) {
  const root = mkdtempSync(join(tmpdir(), 'notionsi-tui-')); t.after(() => rmSync(root, { recursive: true }));
  const path = join(root, 'config.json'), projectPath = join(root, '.env.local');
  const screens = [], messages = [], events = []; let closed = false;
  const ui = {
    choose: async (title, choices, options) => {
      screens.push({ title, choices, options }); events.push(title); const next = sequence.shift();
      if (next instanceof Error) throw next;
      assert.ok(next === undefined || choices.some(c => c.value === next), `Unexpected choice ${next} at ${title}`); return next;
    },
    inputValue: async (title, options) => { screens.push(options); events.push(title); return sequence.shift(); },
    message: async (title, text) => { messages.push({ title, text }); },
    task: async (title, fn) => { events.push(title); return fn(new AbortController().signal); },
    external: async fn => fn(), close: () => { closed = true; },
  };
  return { root, path, projectPath, ui, screens, messages, events, isClosed: () => closed, env: { LOCALAPPDATA: root, XDG_CONFIG_HOME: root },
    catalogLoader: async () => ({}), listModels: async () => [effortModel('model-a')] };
}

test('configuration follows add → provider → credentials → remote models → model → reasoning → save', async t => {
  const data = setup(t, ['add', 'openai', 'key', 'private-key', 'model-a', 'high', 'save', 'exit']);
  saveUserConfig({ ANTHROPIC_API_KEY: 'other-secret', NOTIONSI_TOOLS: 'off' }, { path: data.path });
  let calls = 0;
  const result = await runConfigTui({ ...data, listModels: async (config, options) => {
    calls++; assert.equal(config.apiKey, 'private-key'); assert.equal(options.details, true); return [effortModel('model-a')];
  } });
  assert.equal(result.saved, true); assert.equal(data.isClosed(), true); assert.equal(calls, 1);
  const saved = readUserConfig({ path: data.path });
  assert.equal(saved.values.NOTIONSI_PROVIDER, 'openai'); assert.equal(saved.values.OPENAI_MODEL, 'model-a');
  assert.equal(saved.values.OPENAI_REASONING_EFFORT, 'high'); assert.equal(saved.values.OPENAI_API_KEY, 'private-key');
  assert.equal(saved.values.ANTHROPIC_API_KEY, 'other-secret'); assert.ok(saved.providers.includes('openai'));
  assert.equal(JSON.stringify(data.screens).includes('private-key'), false); assert.equal(JSON.stringify(data.messages).includes('private-key'), false);
  assert.equal(existsSync(data.projectPath), false);
  const key = data.events.indexOf('填写 API Key'), list = data.events.indexOf('3/5 · 从供应商获取模型列表');
  assert.ok(key < list && list < data.events.indexOf('4/5 · 选择模型') && data.events.indexOf('4/5 · 选择模型') < data.events.indexOf('5/5 · 选择思考强度'));
  assert.equal(data.screens[0].choices[0].value, 'add');
});

test('existing suppliers can reselect models without re-entering a key or losing other settings', async t => {
  const data = setup(t, ['configure', 'openai', 'keep', 'model-a', 'low', 'save', 'exit']);
  saveUserConfig({ NOTIONSI_PROVIDER: 'openai', OPENAI_API_KEY: 'old-key', OPENAI_MODEL: 'old-model', OPENAI_REASONING_EFFORT: 'high', ANTHROPIC_API_KEY: 'other-key' }, { path: data.path });
  await runConfigTui({ ...data, listModels: async config => { assert.equal(config.apiKey, 'old-key'); return [effortModel('model-a')]; } });
  const saved = readUserConfig({ path: data.path }).values;
  assert.equal(saved.OPENAI_API_KEY, 'old-key'); assert.equal(saved.OPENAI_MODEL, 'model-a'); assert.equal(saved.OPENAI_REASONING_EFFORT, 'low'); assert.equal(saved.ANTHROPIC_API_KEY, 'other-key');
  const select = data.screens.find(s => s.title === '1/5 · 选择已添加的供应商');
  assert.deepEqual(select.choices.map(c => c.value), ['openai', 'anthropic']);
  assert.equal(JSON.stringify(data.screens).includes('old-key'), false);
});

test('failed supplier discovery offers an explicit models.dev reference fallback and preserves legacy env', async t => {
  const data = setup(t, ['configure', 'zhipu', 'coding-cn', 'keep', 'catalog', 'glm-5.3', 'max', 'save', 'exit']);
  const project = 'NOTIONSI_PROVIDER=zhipu\nZHIPU_API_KEY=legacy-secret\nZHIPU_MODEL=glm-5.3\n# keep\n'; writeFileSync(data.projectPath, project);
  await runConfigTui({ ...data, listModels: async () => { throw new Error('models endpoint unavailable'); },
    catalogLoader: async () => ({ 'zhipuai-coding-plan': { models: { 'glm-5.3': { id: 'glm-5.3', reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] } } } }) });
  const saved = readUserConfig({ path: data.path }).values;
  assert.equal(saved.ZHIPU_API_KEY, 'legacy-secret'); assert.equal(saved.ZHIPU_REASONING_EFFORT, 'max'); assert.equal(saved.ZHIPU_THINKING, 'enabled');
  assert.equal(readFileSync(data.projectPath, 'utf8'), project);
  assert.match(data.screens.find(s => s.title === '4/5 · 选择模型').options.note, /参考目录/);
});

test('models.dev enriches only returned supplier models and cannot add models to the live selection', async t => {
  const data = setup(t, ['add', 'openai', 'key', 'key', 'model-a', 'high', 'save', 'exit']);
  await runConfigTui({ ...data, listModels: async () => ['model-a'], catalogLoader: async () => ({ openai: { models: {
    a: { id: 'model-a', reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
    b: { id: 'not-in-account', reasoning: true, reasoning_options: [{ type: 'effort', values: ['max'] }] },
  } } }) });
  const models = data.screens.find(s => s.title === '4/5 · 选择模型'); assert.deepEqual(models.choices.map(c => c.value), ['model-a']);
  assert.equal(readUserConfig({ path: data.path }).values.OPENAI_REASONING_EFFORT, 'high');
});

test('OAuth completes before subscription model discovery and exposes subscription reasoning metadata', async t => {
  const data = setup(t, ['add', 'openai-codex', 'oauth', 'codex-model', 'high', 'save', 'exit']); let authenticated = false;
  await runConfigTui({ ...data, login: async config => {
    assert.match(config.authFile, /NotionSI[\\/]auth[\\/]openai-codex[\\/]auth.json$/); assert.ok(config.authFile.startsWith(data.root)); authenticated = true;
  }, listModels: async config => { assert.equal(authenticated, true); assert.equal(config.subscription, true); return [effortModel('codex-model')]; } });
  assert.equal(readUserConfig({ path: data.path }).values.OPENAI_CODEX_MODEL, 'codex-model');
});

test('canceling at credentials, model, reasoning or confirmation leaves settings unchanged', async t => {
  for (const tail of [ ['cancel'], ['key', 'new-key', undefined], ['key', 'new-key', 'model-a', undefined, undefined],
    ['key', 'new-key', 'model-a', 'high', 'cancel'], [new UiCanceled()] ]) {
    const data = setup(t, ['add', 'openai', ...tail, 'exit']);
    assert.equal((await runConfigTui(data)).saved, false); assert.equal(existsSync(data.path), false); assert.equal(data.isClosed(), true);
  }
});

test('a local custom provider selects an endpoint and optional authentication before fetching models', async t => {
  const data = setup(t, ['add', 'openai-compatible', 'http://127.0.0.1:1234/v1', 'no-key', 'model-a', '', 'save', 'exit']);
  await runConfigTui({ ...data, listModels: async config => { assert.equal(config.baseUrl, 'http://127.0.0.1:1234/v1'); assert.equal(config.apiKey, ''); return ['model-a']; } });
  assert.equal(readUserConfig({ path: data.path }).values.OPENAI_COMPATIBLE_MODEL, 'model-a');
});

test('selecting a thinking token budget sets native config and reserves enough output tokens', async t => {
  const data = setup(t, ['add', 'gemini', 'key', 'key', 'gemini-2.5-flash', 'budget:4096', 'save', 'exit']);
  await runConfigTui({ ...data, listModels: async () => [{ id: 'gemini-2.5-flash', reasoningOptions: [{ type: 'budget_tokens', min: 0, max: 24576 }] }] });
  const saved = readUserConfig({ path: data.path }).values;
  assert.equal(saved.GEMINI_THINKING_BUDGET, '4096'); assert.equal(saved.GEMINI_REASONING_EFFORT, ''); assert.equal(saved.GEMINI_MAX_TOKENS, '8192');
});

test('save does not test model inference and an explicit connection test hides returned content', async t => {
  const data = setup(t, ['add', 'openai', 'key', 'key', 'model-a', 'high', 'save', 'test', 'exit']); let calls = 0;
  await runConfigTui({ ...data, checkProvider: config => { calls++; assert.equal(config.model, 'model-a'); return { async *stream() { yield 'private answer'; } }; } });
  assert.equal(calls, 1); assert.equal(data.messages.some(m => m.title === '连接成功'), true); assert.equal(JSON.stringify(data.messages).includes('private answer'), false);
});

test('terminal buffers pasted characters, masks keys and restores raw mode after cancellation', async () => {
  const input = new EventEmitter(); input.isTTY = true; input.isRaw = false; let paused = false; input.readableFlowing = null;
  input.setRawMode = value => { input.isRaw = value; }; input.resume = () => {}; input.pause = () => { paused = true; };
  const output = { isTTY: true, columns: 80, rows: 24, text: '', write(value) { this.text += value; } };
  const ui = new TerminalUi({ input, output }), answer = ui.inputValue('API Key', { secret: true });
  for (const ch of 'pasted-secret') input.emit('keypress', ch, { name: ch }); input.emit('keypress', '\r', { name: 'return' });
  assert.equal(await answer, 'pasted-secret'); assert.equal(output.text.includes('pasted-secret'), false);
  const next = ui.choose('Select', [{ value: 'one', label: 'one' }]); input.emit('keypress', '\x03', { name: 'c', ctrl: true }); await assert.rejects(next, UiCanceled);
  ui.close(); assert.equal(input.isRaw, false); assert.equal(input.listenerCount('keypress'), 0); assert.equal(paused, true);
});

test('catalog requests paginate Gemini, filter generation models and never follow supplied links', async () => {
  const seen = [];
  const ids = await listProviderModels({ name: 'gemini', protocol: 'gemini', baseUrl: 'https://fixture.test/v1beta', apiKey: 'secret' }, {
    fetchImpl: async (url, options) => {
      seen.push(url); assert.equal(options.headers['x-goog-api-key'], 'secret'); assert.equal(options.redirect, 'error');
      return Response.json(seen.length === 1 ? { models: [{ name: 'models/a', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'token?=x', next: 'https://evil.test' } : { models: [{ name: 'models/b' }] });
    },
  });
  assert.deepEqual(ids, ['a', 'b']); assert.equal(seen[1], 'https://fixture.test/v1beta/models?pageToken=token%3F%3Dx');
  await assert.rejects(listProviderModels({ name: 'openai', baseUrl: 'https://fixture.test' }), /API Key/);
});

test('subscription model discovery uses OAuth account auth and preserves supported reasoning levels', async () => {
  const models = await listProviderModels({ name: 'openai-codex', subscription: true, baseUrl: 'https://evil.test' }, { details: true,
    credentials: { get: async () => ({ apiKey: 'subscription-token', accountId: 'account' }) },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/models?client_version=0.116.0');
      assert.equal(options.headers.Authorization, 'Bearer subscription-token'); assert.equal(options.headers['ChatGPT-Account-Id'], 'account');
      return Response.json({ models: [{ slug: 'codex-model', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }, { slug: 'hidden-model', visibility: 'hide' }] });
    },
  });
  assert.equal(models.length, 1); assert.deepEqual(models[0].reasoningOptions[0].values, ['low', 'high']);
});
