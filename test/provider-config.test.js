import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv, providerConfig, createProvider, publicConfig } from '../src/config.js';
import { providerNames, getProvider } from '../src/providers/index.js';

test('every API provider config supports env/CLI priority and hides credentials', () => {
  for (const name of providerNames.filter(n => !['mock', 'zhipu', 'openai-codex'].includes(n))) {
    const prefix = name.replaceAll('-', '_').toUpperCase();
    const env = { [`${prefix}_API_KEY`]: 'private-key', [`${prefix}_MODEL`]: 'file-model', [`${prefix}_BASE_URL`]: 'https://fixture.test/v1' };
    const config = providerConfig({ env, provider: name, model: 'cli-model' });
    const instance = createProvider(config);
    assert.equal(instance.model, 'cli-model'); assert.equal(instance.name, name); assert.equal(instance.baseUrl, 'https://fixture.test/v1');
    assert.equal(publicConfig(config).apiKeyConfigured, true);
    assert.equal(JSON.stringify(publicConfig(config)).includes('private-key'), false);
    assert.equal(JSON.stringify(instance).includes('private-key'), false);
    assert.throws(() => providerConfig({ env, provider: name, apiProfile: 'coding-cn' }), /profile/);
  }
});

test('new .env keys are allowlisted, real environment wins and arbitrary code settings remain excluded', t => {
  const root = mkdtempSync(join(tmpdir(), 'notionsi-provider-config-')); t.after(() => rmSync(root, { recursive: true }));
  const path = join(root, '.env.local');
  writeFileSync(path, 'NOTIONSI_PROVIDER=openai\nOPENAI_API_KEY=private-key\nOPENAI_MODEL=file-model\nOPENAI_BASE_URL=https://fixture.test/v1\nANTHROPIC_API_KEY=anthropic-test\nGEMINI_API_KEY=gemini-test\nOPENAI_CODEX_AUTH_FILE=.local/test/auth.json\nNODE_OPTIONS=evil\nPATH=evil\nCODEX_HOME=evil\n');
  const env = { OPENAI_MODEL: 'env-model' }; loadLocalEnv({ env, path, userPath: null });
  assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.PATH, undefined); assert.equal(env.CODEX_HOME, undefined);
  assert.equal(env.OPENAI_MODEL, 'env-model'); assert.equal(env.ANTHROPIC_API_KEY, 'anthropic-test'); assert.equal(env.GEMINI_API_KEY, 'gemini-test');
  assert.equal(createProvider(providerConfig({ env })).model, 'env-model');
});

test('subscription provider never accepts an API key or allows endpoint override', () => {
  const config = providerConfig({ provider: 'openai-codex', env: { OPENAI_API_KEY: 'private-key', OPENAI_CODEX_BASE_URL: 'https://evil.test', OPENAI_CODEX_AUTH_FILE: 'missing-auth-file.json' } });
  assert.equal(config.baseUrl, 'https://chatgpt.com/backend-api/codex');
  assert.equal(publicConfig(config).authMode, 'chatgpt-subscription'); assert.equal(publicConfig(config).authConfigured, false);
  assert.equal(publicConfig(config).apiKeyConfigured, false);
  assert.throws(() => createProvider(config), /login/);
});

test('custom/local providers require explicit model; custom provider also requires a base URL', () => {
  assert.throws(() => providerConfig({ provider: 'openai-compatible', env: {} }), /base URL/);
  assert.throws(() => createProvider(providerConfig({ provider: 'ollama', env: {} })), /model/);
  assert.equal(createProvider(providerConfig({ provider: 'ollama', env: { OLLAMA_MODEL: 'qwen3:8b' } })).baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(getProvider('openai').configure({ env: {} }).protocol, 'responses');
  assert.equal(getProvider('anthropic').configure({ env: {} }).protocol, 'anthropic');
  assert.equal(getProvider('gemini').configure({ env: {} }).protocol, 'gemini');
});

test('CLI lists all providers, checks config offline and rejects unsupported login without launching Notion', t => {
  const root = mkdtempSync(join(tmpdir(), 'notionsi-provider-cli-')); t.after(() => rmSync(root, { recursive: true }));
  const entry = fileURLToPath(new URL('../index.js', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NOTION|ZHIPU|OPENAI|ANTHROPIC|GEMINI)/i.test(key)));
  const run = args => spawnSync(process.execPath, [entry, ...args], { cwd: root, env: { ...env, LOCALAPPDATA: root, XDG_CONFIG_HOME: root }, encoding: 'utf8', timeout: 10000 });
  const help = run(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /openai-codex/); assert.match(help.stdout, /gemini/); assert.match(help.stdout, /login/);
  writeFileSync(join(root, '.env.local'), 'OPENAI_API_KEY=private-test-key\nOPENAI_MODEL=gpt-test\n');
  const config = run(['config', '--show', '--attach', '--provider', 'openai']); assert.equal(config.status, 0, config.stderr);
  assert.equal(JSON.parse(config.stdout).protocol, 'responses'); assert.equal(config.stdout.includes('private-test-key'), false);
  const login = run(['login', '--provider', 'openai']); assert.equal(login.status, 1); assert.match(login.stderr, /openai-codex only/);
  const subscription = run(['config', '--show', '--attach', '--provider', 'openai-codex']); assert.equal(subscription.status, 0, subscription.stderr); assert.equal(JSON.parse(subscription.stdout).authConfigured, false);
  const missing = run(['check', '--provider', 'openai-codex']); assert.equal(missing.status, 1); assert.match(missing.stderr, /login/);
  const tui = run(['tui']); assert.equal(tui.status, 1); assert.match(tui.stderr, /真实终端/);
  const interactive = run(['config']); assert.equal(interactive.status, 1); assert.match(interactive.stderr, /真实终端/);
});
