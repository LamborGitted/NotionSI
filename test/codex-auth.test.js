import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { CodexCredentials, readCodexAuth, loginCodex, codexCommand } from '../src/providers/codex-auth.js';

const jwt = values => `header.${Buffer.from(JSON.stringify(values)).toString('base64url')}.signature`;
const credentials = (exp = Math.floor(Date.now() / 1000) + 3600) => ({ auth_mode: 'chatgpt', tokens: {
  access_token: jwt({ exp, client_id: 'fixture-client', 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } }),
  id_token: jwt({ aud: 'fixture-client' }), refresh_token: 'private-refresh', account_id: 'fixture-account',
} });
const setup = t => {
  const root = mkdtempSync(join(tmpdir(), 'notionsi-auth-'));
  t.after(() => rmSync(root, { recursive: true })); return { root, path: join(root, 'auth.json') };
};

test('subscription auth accepts only explicit ChatGPT token files and fails before requests', t => {
  const { path } = setup(t);
  for (const record of [{ OPENAI_API_KEY: 'private-key' }, { ...credentials(), auth_mode: 'apikey' },
    { tokens: { access_token: 'bad\r\ntoken', account_id: 'account' } }, { tokens: { access_token: 'token', account_id: 'bad\naccount' } }, {}]) {
    writeFileSync(path, JSON.stringify(record));
    assert.throws(() => new CodexCredentials({ authFile: path }), e => /login/.test(e.message) && !/private-key|bad/.test(e.message));
  }
  writeFileSync(path, JSON.stringify(credentials()));
  assert.equal(readCodexAuth(path).accountId, 'fixture-account');
  assert.equal(JSON.stringify(new CodexCredentials({ authFile: path })).includes('private-refresh'), false);
});

test('valid tokens need no refresh; expiring tokens refresh once for concurrent readers and persist rotation', async t => {
  const { root, path } = setup(t); let requests = 0;
  writeFileSync(path, JSON.stringify(credentials()));
  const fresh = new CodexCredentials({ authFile: path, fetchImpl: () => { throw new Error('must not fetch'); } });
  assert.equal((await fresh.get()).accountId, 'fixture-account');
  writeFileSync(path, JSON.stringify(credentials(1)));
  const rotated = credentials();
  const auth = new CodexCredentials({ authFile: path, fetchImpl: async (url, init) => {
    requests++;
    assert.equal(url, 'https://auth.openai.com/oauth/token'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal(init.body.get('grant_type'), 'refresh_token'); assert.equal(init.body.get('refresh_token'), 'private-refresh'); assert.equal(init.body.get('client_id'), 'fixture-client');
    return Response.json({ access_token: rotated.tokens.access_token, refresh_token: 'rotated-refresh' });
  } });
  const [first, second] = await Promise.all([auth.get(), auth.get()]);
  assert.equal(requests, 1); assert.deepEqual(first, second);
  assert.equal(first.apiKey, rotated.tokens.access_token);
  assert.equal(JSON.parse(readFileSync(path)).tokens.refresh_token, 'rotated-refresh');
  assert.deepEqual(readdirSync(root), ['auth.json']);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('one canceled refresh waiter does not cancel another conversation', async t => {
  const { path } = setup(t); writeFileSync(path, JSON.stringify(credentials(1)));
  let release;
  const auth = new CodexCredentials({ authFile: path, fetchImpl: () => new Promise(resolve => { release = () => resolve(Response.json({ access_token: credentials().tokens.access_token })); }) });
  const controller = new AbortController();
  const first = auth.get(controller.signal), second = auth.get();
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  release(); assert.equal((await second).accountId, 'fixture-account');
});

test('refresh errors and invalid token payloads are sanitized and preserve the credential file', async t => {
  const { path } = setup(t); const original = JSON.stringify(credentials(1)); writeFileSync(path, original);
  for (const makeResponse of [() => new Response('private-refresh', { status: 401 }), () => Response.json({ access_token: 'bad\r\ntoken' }),
    () => new Response('private-refresh {broken'), () => new Response('x'.repeat(262145))]) {
    const auth = new CodexCredentials({ authFile: path, fetchImpl: async () => makeResponse() });
    await assert.rejects(auth.get(), error => /重新登录/.test(error.message) && !/private-refresh|bad/.test(error.message));
    assert.equal(readFileSync(path, 'utf8'), original);
  }
});

test('refresh never overwrites a replacement login made during the HTTP request', async t => {
  const { path } = setup(t); writeFileSync(path, JSON.stringify(credentials(1)));
  const replacement = credentials(); replacement.tokens.refresh_token = 'new-login';
  const auth = new CodexCredentials({ authFile: path, fetchImpl: async () => {
    writeFileSync(path, JSON.stringify(replacement)); return Response.json({ access_token: credentials().tokens.access_token, refresh_token: 'stale-rotation' });
  } });
  await auth.get(); assert.equal(JSON.parse(readFileSync(path)).tokens.refresh_token, 'new-login');
});

test('device login invokes the configured CLI without a shell and uses an isolated auth directory', async t => {
  const { root, path } = setup(t), script = join(root, 'Codex with spaces.js'); writeFileSync(script, '');
  assert.deepEqual(codexCommand(script), [process.execPath, [script]]);
  assert.throws(() => codexCommand(script, { packaged: true, env: { PATH: '' } }), /原生 codex.exe/);
  assert.throws(() => codexCommand('missing-cli-file'), /OPENAI_CODEX_CLI/);
  let invocation;
  await loginCodex({ authFile: path, codexCli: script, spawnImpl: (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    writeFileSync(path, JSON.stringify(credentials())); queueMicrotask(() => child.emit('exit', 0)); return child;
  } });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [script, 'login', '--device-auth', '-c', 'cli_auth_credentials_store="file"']);
  assert.equal(invocation.options.env.CODEX_HOME, root); assert.equal(invocation.options.env.OPENAI_API_KEY, undefined);
  assert.equal(invocation.options.windowsHide, true); assert.equal(invocation.options.shell, false);
  await assert.rejects(loginCodex({ authFile: join(root, 'other.json'), codexCli: script }), /auth.json/);
});
