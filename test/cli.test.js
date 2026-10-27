import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../index.js', import.meta.url));
function run(args, cwd, overrides = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NOTION|ZHIPU)/i.test(key)));
  return spawnSync(process.execPath, [entry, ...args], { cwd, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000 });
}

test('unified config command respects file/env/CLI priority and hides secrets without a Notion install', () => {
  const root = mkdtempSync(join(tmpdir(), 'notionsi-cli-'));
  try {
    writeFileSync(join(root, '.env.local'), 'NOTIONSI_PROVIDER=zhipu\nZHIPU_API_KEY=fixture-secret\nZHIPU_MODEL=file-model\nZHIPU_API_PROFILE=coding-cn\n');
    const result = run(['config', '--attach', '--model', 'cli-model'], root, { ZHIPU_MODEL: 'env-model' });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    assert.equal(config.model, 'cli-model');
    assert.equal(config.apiProfile, 'coding-cn');
    assert.equal(config.apiKeyConfigured, true);
    assert.equal(config.notionPath, null);
    assert.equal(result.stdout.includes('fixture-secret'), false);
    const mock = run(['config', '--attach', '--provider', 'mock'], root);
    assert.equal(mock.status, 0, mock.stderr);
    assert.equal(JSON.parse(mock.stdout).apiKeyConfigured, false);
    assert.equal(JSON.parse(mock.stdout).model, undefined);
  } finally { rmSync(root, { recursive: true }); }
});

test('unified CLI rejects missing values, unknown commands and conflicting check modes before doing work', () => {
  for (const [args, expected] of [
    [['config', '--provider'], /Missing value/],
    [['unknown'], /Unknown command/],
    [['config', '--check-api'], /Choose config or check/],
  ]) {
    const result = run(args, tmpdir());
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
  }
});

test('generic check handles mock without network or executable path resolution', () => {
  const result = run(['check', '--provider', 'mock', '--notion', 'missing.exe'], tmpdir());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /mock has no API/);
});

test('unified help works without configuration and diagnostic command forwards its arguments', () => {
  const help = run(['--help'], tmpdir());
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /start\|attach\|config\|check/);
  const diagnostic = run(['verify-editor'], tmpdir());
  assert.equal(diagnostic.status, 1);
  assert.match(diagnostic.stderr, /Use --run/);
});
