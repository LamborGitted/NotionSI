import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { defaultSystemPrompt } from '../src/system-prompt.js';
import { CONFIG_KEYS } from '../src/config.js';

const executable = fileURLToPath(new URL('../dist/NotionSI-win-x64/NotionSI.exe', import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), 'notionsi-exe-'));
const configKeys = new Set(CONFIG_KEYS);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !configKeys.has(key.toUpperCase()) && !/^(NOTION|ZHIPU)/i.test(key)));
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
  assert.equal(JSON.parse(config.stdout).systemPromptSource, 'builtin');
  assert.equal(JSON.parse(config.stdout).systemPromptConfigured, true);
  assert.equal(JSON.parse(config.stdout).systemPromptBytes, Buffer.byteLength(defaultSystemPrompt()));
  // Custom prompts must load outside the checkout and stay out of diagnostics.
  const prompt = '仅用于 EXE 提示词回归检查，不得出现在配置输出中。';
  writeFileSync(join(cwd, 'prompt.local.txt'), prompt);
  writeFileSync(join(cwd, '.env.local'), 'NOTIONSI_PROVIDER=zhipu\nZHIPU_API_KEY=smoke-secret\nNOTIONSI_SYSTEM_PROMPT_FILE=prompt.local.txt\n');
  const prompted = run(['config', '--show', '--attach']);
  assert.equal(prompted.status, 0, prompted.stderr);
  assert.equal(JSON.parse(prompted.stdout).systemPromptConfigured, true);
  assert.equal(JSON.parse(prompted.stdout).systemPromptSource, 'file');
  assert.equal(JSON.parse(prompted.stdout).systemPromptBytes, Buffer.byteLength(prompt));
  assert.equal(prompted.stdout.includes(prompt), false);
  writeFileSync(join(cwd, 'prompt.local.txt'), '');
  const invalidPrompt = run(['config', '--show', '--attach']);
  assert.equal(invalidPrompt.status, 1);
  assert.match(invalidPrompt.stderr, /NOTIONSI_SYSTEM_PROMPT_FILE/);
  const mock = run(['config', '--show', '--attach', '--provider', 'mock']);
  assert.equal(mock.status, 0, mock.stderr);
  assert.equal(JSON.parse(mock.stdout).systemPromptConfigured, false);
  writeFileSync(join(cwd, 'prompt.local.txt'), prompt);
  // Capture actual model requests from the standalone EXE using a local fixture.
  // This verifies embedded prompt content, not just a diagnostic byte count.
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{"content":"连接成功"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const settings = `NOTIONSI_PROVIDER=openai-compatible\nOPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:${server.address().port}/v1\nOPENAI_COMPATIBLE_MODEL=smoke-model\n`;
    for (const custom of [false, true]) {
      writeFileSync(join(cwd, '.env.local'), settings + (custom ? 'NOTIONSI_SYSTEM_PROMPT_FILE=prompt.local.txt\n' : ''));
      const check = await new Promise((resolve, reject) => {
        const child = spawn(executable, ['check'], { cwd, env, timeout: 15000, windowsHide: true });
        let stdout = '', stderr = '';
        child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
        child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
        child.on('error', reject);
        child.on('close', status => resolve({ status, stdout, stderr }));
      });
      assert.equal(check.status, 0, check.stderr);
      const actual = requests.at(-1).messages[0];
      assert.deepEqual(actual, { role: 'system', content: custom ? prompt : defaultSystemPrompt() });
      assert.equal(check.stdout.includes(custom ? prompt : 'You are Notion AI'), false);
    }
    assert.equal(requests.length, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
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
