import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userConfigDirectory, userConfigPath, codexAuthPath, readUserConfig, saveUserConfig } from '../src/user-config.js';
import { loadLocalEnv, providerConfig, publicConfig } from '../src/config.js';

const temporary = t => {
  const root = mkdtempSync(join(tmpdir(), 'notionsi-user-config-')); t.after(() => rmSync(root, { recursive: true })); return root;
};

test('Windows user configuration lives in LocalAppData, with a user-profile fallback and isolated auth', () => {
  const env = { LOCALAPPDATA: join('test-user', 'AppData', 'Local'), APPDATA: join('test-user', 'AppData', 'Roaming') };
  const options = { env, platform: 'win32' };
  assert.equal(userConfigDirectory(options), join(env.LOCALAPPDATA, 'NotionSI'));
  assert.equal(userConfigPath(options), join(env.LOCALAPPDATA, 'NotionSI', 'config.json'));
  assert.equal(codexAuthPath(options), join(env.LOCALAPPDATA, 'NotionSI', 'auth', 'openai-codex', 'auth.json'));
  assert.equal(userConfigDirectory({ env: { USERPROFILE: 'test-user' }, platform: 'win32' }), join('test-user', 'AppData', 'Local', 'NotionSI'));
  assert.equal(userConfigDirectory({ env: { XDG_CONFIG_HOME: 'xdg-root' }, platform: 'linux' }), join('xdg-root', 'NotionSI'));
});

test('user JSON is atomic, permission-restricted and detects concurrent edits', t => {
  const root = temporary(t), path = join(root, 'config.json');
  assert.deepEqual(readUserConfig({ path }).values, {});
  const saved = saveUserConfig({ NOTIONSI_PROVIDER: 'openai', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'gpt-test' }, { path });
  assert.deepEqual(readUserConfig({ path }).values, saved.values);
  assert.deepEqual(readdirSync(root), ['config.json']);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  writeFileSync(path, JSON.stringify({ version: 1, values: { NOTIONSI_PROVIDER: 'mock' } }));
  assert.throws(() => saveUserConfig(saved.values, { path, expectedSource: saved.source }), /其他进程/);
  assert.equal(readUserConfig({ path }).values.NOTIONSI_PROVIDER, 'mock');
});

test('runtime priority is process env > user config > project env; only allowed keys load', t => {
  const root = temporary(t), path = join(root, '.env.local'), userPath = join(root, 'config.json');
  writeFileSync(path, 'NOTIONSI_PROVIDER=openai\nOPENAI_MODEL=project-model\nOPENAI_API_KEY=project-key\nOPENAI_MAX_TOKENS=512\nNODE_OPTIONS=evil\n');
  saveUserConfig({ OPENAI_MODEL: 'user-model', OPENAI_API_KEY: 'user-key', NODE_OPTIONS: 'evil', PATH: 'evil' }, { path: userPath });
  const env = { OPENAI_MODEL: 'process-model' }; loadLocalEnv({ env, path, userPath });
  assert.equal(env.OPENAI_MODEL, 'process-model'); assert.equal(env.OPENAI_API_KEY, 'user-key');
  assert.equal(env.OPENAI_MAX_TOKENS, '512'); assert.equal(env.NOTIONSI_PROVIDER, 'openai');
  assert.equal(env.PATH, undefined); assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(JSON.stringify(publicConfig(providerConfig({ env }))).includes('user-key'), false);
  const config = providerConfig({ env: { LOCALAPPDATA: root, XDG_CONFIG_HOME: root }, provider: 'openai-codex' });
  assert.equal(config.authFile, codexAuthPath({ env: { LOCALAPPDATA: root, XDG_CONFIG_HOME: root } }));
});

test('malformed/oversized user config and multiline credentials are never accepted or silently ignored', t => {
  const root = temporary(t), path = join(root, 'config.json');
  for (const content of ['{broken', '{"version":2,"values":{}}', '{"version":1,"values":[]}', '{"version":1,"values":{"OPENAI_API_KEY":1}}', 'x'.repeat(65537)]) {
    writeFileSync(path, content); assert.throws(() => readUserConfig({ path }), /无法读取用户配置/);
    assert.equal(readFileSync(path, 'utf8'), content);
  }
  rmSync(path);
  assert.throws(() => saveUserConfig({ OPENAI_API_KEY: 'secret\nvalue' }, { path }), /无效字段/);
  assert.throws(() => saveUserConfig({ OPENAI_API_KEY: 'x'.repeat(65536) }, { path }), /64 KiB/);
});
