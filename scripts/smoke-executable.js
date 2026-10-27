import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('../dist/NotionSI-win-x64/NotionSI.exe', import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), 'notionsi-exe-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NOTION|ZHIPU)/i.test(key)));
env.LOCALAPPDATA = cwd; env.XDG_CONFIG_HOME = cwd;
function run(args) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  return result;
}
try {
  // Execute outside the checkout with no source files or node_modules nearby.
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /start\|attach\|config\|check/);
  writeFileSync(join(cwd, '.env.local'), 'NOTIONSI_PROVIDER=zhipu\nZHIPU_API_KEY=smoke-secret\nZHIPU_MODEL=file-model\n');
  const config = run(['config', '--show', '--attach', '--model', 'cli-model']);
  assert.equal(config.status, 0, config.stderr);
  assert.equal(JSON.parse(config.stdout).model, 'cli-model');
  assert.equal(JSON.parse(config.stdout).apiKeyConfigured, true);
  assert.equal(config.stdout.includes('smoke-secret'), false);
  const interactive = run(['config']);
  assert.equal(interactive.status, 1);
  assert.match(interactive.stderr, /真实终端/);
  const diagnostic = run(['verify-editor']);
  assert.equal(diagnostic.status, 1, diagnostic.stderr);
  assert.match(diagnostic.stderr, /Use --run/);
  const unknown = run(['unknown']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command/);
  console.log('Standalone executable smoke checks passed.');
} finally {
  rmSync(cwd, { recursive: true });
}
