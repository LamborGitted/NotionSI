import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadLocalEnv, providerConfig, createProvider, publicConfig } from '../src/config.js';
import { NOTION_SYSTEM_PROMPT } from '../src/system-prompt.js';

test('full Notion prompt is the default without local configuration and respects available tools', () => {
  const reference = readFileSync(new URL('../prompts/notion-system-prompt.txt', import.meta.url), 'utf8').trim();
  assert.equal(NOTION_SYSTEM_PROMPT, reference);
  const config = providerConfig({ env: {}, provider: 'zhipu' });
  assert.ok(config.systemPrompt.startsWith(reference));
  assert.match(config.systemPrompt, /No Notion tools are enabled/);
  assert.equal(publicConfig(config).systemPromptSource, 'builtin');
  assert.equal(publicConfig(config).systemPromptConfigured, true);
  assert.equal(publicConfig(config).systemPromptBytes, Buffer.byteLength(config.systemPrompt));
  assert.equal(JSON.stringify(publicConfig(config)).includes(reference), false);
  const native = providerConfig({ env: { NOTIONSI_TOOLS: 'native' }, provider: 'zhipu' });
  assert.ok(native.systemPrompt.startsWith(reference));
  assert.match(native.systemPrompt, /Only tools supplied in the current request are available/);
  assert.doesNotMatch(native.systemPrompt.slice(reference.length), /No Notion tools are enabled/);
  assert.equal(providerConfig({ env: { NOTIONSI_SYSTEM_PROMPT_FILE: '' }, provider: 'zhipu' }).systemPrompt, config.systemPrompt);
});

test('local config respects environment overrides and never imports unrelated environment keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'notionsi-config-'));
  try {
    const path = join(root, '.env.local');
    writeFileSync(path, 'ZHIPU_API_KEY="private-test-key"\nNOTIONSI_PROVIDER=zhipu\nZHIPU_MODEL=glm-4.7-flash\nNODE_OPTIONS=bad\n');
    const env = { ZHIPU_MODEL: 'glm-5.3' }; loadLocalEnv({ env, path, userPath: null });
    assert.equal(env.ZHIPU_MODEL, 'glm-5.3'); assert.equal(env.NODE_OPTIONS, undefined);
    const config = providerConfig({ env });
    assert.equal(JSON.stringify(publicConfig(config)).includes('private-test-key'), false);
    assert.equal(publicConfig(config).apiKeyConfigured, true);
    assert.equal(createProvider(config).model, 'glm-5.3');
  } finally { rmSync(root, { recursive: true }); }
});

test('missing credentials fail before instrumentation and Coding Plan is not silently selected', () => {
  assert.throws(() => createProvider(providerConfig({ env: {}, provider: 'zhipu' })), /ZHIPU_API_KEY/);
  assert.equal(createProvider(providerConfig({ env: {}, provider: 'mock' })), null);
  assert.throws(() => providerConfig({ env: {}, provider: 'coding' }), /Unknown provider/);
});

test('CN Coding Plan profile uses the official CN coding endpoint and keeps secrets private', () => {
  const config = providerConfig({ env: { NOTIONSI_PROVIDER: 'zhipu', ZHIPU_API_PROFILE: 'coding-cn', ZHIPU_API_KEY: 'test-coding-key' } });
  assert.equal(createProvider(config).endpoint, 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions');
  assert.equal(publicConfig(config).apiProfile, 'coding-cn');
  assert.equal(JSON.stringify(publicConfig(config)).includes('test-coding-key'), false);
  assert.throws(() => providerConfig({ env: { NOTIONSI_PROVIDER: 'zhipu', ZHIPU_API_PROFILE: 'unknown' } }), /ZHIPU_API_PROFILE/);
});

test('GLM-5.3 enforces thinking with low effort even after a legacy disabled setting', () => {
  const config = providerConfig({ env: { ZHIPU_THINKING: 'disabled', ZHIPU_API_KEY: 'test-only' }, provider: 'zhipu' });
  assert.equal(config.model, 'glm-5.3');
  assert.equal(config.thinking, 'enabled');
  assert.equal(config.reasoningEffort, 'low');
  assert.equal(createProvider(config).thinking, 'enabled');
  assert.equal(config.logContent,true);
  assert.equal(providerConfig({env:{NOTIONSI_LOG_CONTENT:'0'}}).logContent,false);
  assert.throws(()=>providerConfig({env:{NOTIONSI_LOG_CONTENT:'invalid'}}),/NOTIONSI_LOG_CONTENT/);
});

test('local system prompt is loaded from UTF-8 file, kept out of public configuration and ignored by mock', () => {
  const root = mkdtempSync(join(tmpdir(), 'notionsi-prompt-'));
  try {
    const path = join(root, 'prompt.local.txt');
    const envPath = join(root, '.env.local');
    writeFileSync(path, '\uFEFF仅回复测试内容。\n');
    writeFileSync(envPath, `NOTIONSI_SYSTEM_PROMPT_FILE="${path.replaceAll('\\', '/')}"\n`);
    const env = { NOTIONSI_PROVIDER: 'zhipu', ZHIPU_API_KEY: 'test-only' };
    loadLocalEnv({ env, path: envPath, userPath: null });
    const config = providerConfig({ env });
    assert.equal(config.systemPrompt, '仅回复测试内容。');
    assert.equal(publicConfig(config).systemPromptConfigured, true);
    assert.equal(publicConfig(config).systemPromptSource, 'file');
    assert.equal(publicConfig(config).systemPromptBytes, Buffer.byteLength(config.systemPrompt));
    assert.equal(JSON.stringify(publicConfig(config)).includes('仅回复'), false);
    assert.equal(JSON.stringify(createProvider(config)).includes('仅回复'), false);
    assert.equal(providerConfig({ env, provider: 'mock' }).systemPrompt, '');
    for (const content of ['', ' \n', Buffer.alloc(65537, 97), Buffer.from([0xff]), 'text\0tail']) {
      writeFileSync(path, content);
      assert.throws(() => providerConfig({ env }), /NOTIONSI_SYSTEM_PROMPT_FILE/);
    }
    env.NOTIONSI_SYSTEM_PROMPT_FILE = join(root, 'missing');
    assert.throws(() => providerConfig({ env }), /NOTIONSI_SYSTEM_PROMPT_FILE/);
    env.NOTIONSI_SYSTEM_PROMPT_FILE = root;
    assert.throws(() => providerConfig({ env }), /NOTIONSI_SYSTEM_PROMPT_FILE/);
  } finally { rmSync(root, { recursive: true }); }
});
