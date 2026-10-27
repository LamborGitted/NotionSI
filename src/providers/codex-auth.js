import { readFileSync, statSync, mkdirSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve, delimiter, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isSea } from 'node:sea';
import { ProviderError } from './errors.js';

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const authError = () => new ProviderError('OpenAI 订阅凭据不可用，请运行 node index.js login --provider openai-codex 重新登录。');
const claims = token => {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
};
const safeToken = value => typeof value === 'string' && !!value && value.length <= 65536 && !/[\s\x00-\x1f\x7f]/.test(value);

export function readCodexAuth(path) {
  try {
    if (!statSync(path).isFile() || statSync(path).size > 262144) throw new Error();
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record.auth_mode && record.auth_mode !== 'chatgpt') throw new Error();
    const tokens = record.tokens;
    if (!tokens || !safeToken(tokens.access_token)) throw new Error();
    const access = claims(tokens.access_token), identity = claims(tokens.id_token ?? '');
    const accountId = tokens.account_id ?? access['https://api.openai.com/auth']?.chatgpt_account_id ?? identity['https://api.openai.com/auth']?.chatgpt_account_id;
    if (!safeToken(accountId)) throw new Error();
    return { record, accountId, expiresAt: Number.isFinite(access.exp) ? access.exp * 1000 : undefined,
      clientId: access.client_id ?? (typeof identity.aud === 'string' ? identity.aud : identity.aud?.[0]) };
  } catch { throw authError(); }
}

function atomicAuth(path, record) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch {} }
}

/** Only reads the explicitly configured file, never scans the user's Codex profile. */
export class CodexCredentials {
  #path; #fetch; #pending;
  constructor({ authFile, fetchImpl = fetch }) {
    this.#path = resolve(authFile); this.#fetch = fetchImpl;
    readCodexAuth(this.#path); // Fail before attaching to Notion.
  }
  async #refresh() {
    const original = readCodexAuth(this.#path), tokens = original.record.tokens;
    if (!safeToken(tokens.refresh_token) || !safeToken(original.clientId)) throw authError();
    try {
      const response = await this.#fetch(TOKEN_URL, { method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: original.clientId }) });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw authError(); }
      const text = await boundedText(response);
      const result = JSON.parse(text);
      if (!safeToken(result.access_token) || (result.refresh_token !== undefined && !safeToken(result.refresh_token)) ||
          (result.id_token !== undefined && !safeToken(result.id_token))) throw authError();
      // A new login or another process may have replaced this file while refreshing.
      if (readCodexAuth(this.#path).record.tokens.refresh_token !== tokens.refresh_token) return;
      const updated = { ...original.record, tokens: { ...tokens, access_token: result.access_token,
        refresh_token: result.refresh_token ?? tokens.refresh_token, id_token: result.id_token ?? tokens.id_token }, last_refresh: new Date().toISOString() };
      atomicAuth(this.#path, updated);
    } catch { throw authError(); }
  }
  async get(signal, force = false) {
    signal?.throwIfAborted();
    let auth = readCodexAuth(this.#path);
    if (force || (auth.expiresAt !== undefined && auth.expiresAt <= Date.now() + 60000)) {
      if (!this.#pending) this.#pending = this.#refresh().finally(() => { this.#pending = undefined; });
      let abort;
      const canceled = new Promise((_, reject) => {
        abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      try { await Promise.race([this.#pending, canceled]); }
      finally { signal?.removeEventListener('abort', abort); }
      signal?.throwIfAborted(); auth = readCodexAuth(this.#path);
    }
    return { apiKey: auth.record.tokens.access_token, accountId: auth.accountId };
  }
}

async function boundedText(response) {
  const reader = response.body?.getReader(); if (!reader) throw authError();
  let size = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 262144) throw authError(); chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Avoid cmd.exe/PowerShell quoting entirely, including npm's Windows shims. */
export function codexCommand(explicit, { env = process.env, platform = process.platform, packaged = isSea() } = {}) {
  const directories = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const javascript = path => {
    if (!packaged) return [process.execPath, [path]];
    for (const directory of directories) {
      const node = resolve(directory, platform === 'win32' ? 'node.exe' : 'node');
      if (existsSync(node) && statSync(node).isFile()) return [node, [path]];
    }
    throw new Error('npm 安装的 Codex CLI 需要 Node.js。请配置 OPENAI_CODEX_CLI 为原生 codex.exe，或安装 Node.js。');
  };
  if (explicit) {
    const path = resolve(explicit);
    if (!existsSync(path) || !statSync(path).isFile() || (platform === 'win32' && !/\.(exe|js)$/i.test(path))) throw new Error('OPENAI_CODEX_CLI must point to a Codex executable or its bin/codex.js.');
    return /\.js$/i.test(path) ? javascript(path) : [path, []];
  }
  for (const directory of directories) {
    const candidates = platform === 'win32' ? ['codex.exe', 'node_modules/@openai/codex/bin/codex.js', '../node_modules/@openai/codex/bin/codex.js'] : ['codex'];
    for (const candidate of candidates) {
      const path = resolve(directory, candidate);
      if (existsSync(path) && statSync(path).isFile()) return path.endsWith('.js') ? javascript(path) : [path, []];
    }
  }
  throw new Error('找不到 Codex CLI。请安装 npm i -g @openai/codex，或配置 OPENAI_CODEX_CLI。');
}

export async function loginCodex({ authFile, codexCli, spawnImpl = spawn }) {
  const path = resolve(authFile);
  if (basename(path) !== 'auth.json') throw new Error('OPENAI_CODEX_AUTH_FILE must end with auth.json for CLI login.');
  const [command, prefix] = codexCommand(codexCli);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const env = { ...process.env, CODEX_HOME: dirname(path) };
  delete env.OPENAI_API_KEY;
  await new Promise((resolve, reject) => {
    const child = spawnImpl(command, [...prefix, 'login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'], { env, stdio: 'inherit', windowsHide: true, shell: false });
    child.once('error', () => reject(new Error('无法启动 Codex 登录，请检查 OPENAI_CODEX_CLI。')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Codex 登录未完成，请重试。')));
  });
  readCodexAuth(path);
}
