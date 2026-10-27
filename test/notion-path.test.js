import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveNotionPath } from '../src/notion-path.js';
import { loadLocalEnv } from '../src/config.js';

test('local Notion path supports spaces, directories, overrides and rejects invalid explicit paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'notionsi-path-'));
  try {
    const dir = join(root, 'Notion App'); mkdirSync(dir);
    const exe = join(dir, 'Notion.exe'); writeFileSync(exe, '');
    const config = join(root, '.env.local');
    writeFileSync(config, `NOTION_PATH="${dir.replaceAll('\\', '/')}"\n`);
    const env = {}; loadLocalEnv({ env, path: config });
    assert.equal(resolveNotionPath({ env }), exe);
    env.NOTION_PATH = join(root, 'missing');
    loadLocalEnv({ env, path: config });
    assert.throws(() => resolveNotionPath({ env }), /路径无效/);
    assert.equal(resolveNotionPath({ path: exe, env }), exe);
    assert.throws(() => resolveNotionPath({ path: root, env }), /路径无效/);
  } finally { rmSync(root, { recursive: true }); }
});

test('automatic discovery covers Windows installations and user/global Scoop', () => {
  const env = { LOCALAPPDATA: 'local', ProgramFiles: 'programs', 'ProgramFiles(x86)': 'x86', SCOOP: 'scoop', SCOOP_GLOBAL: 'global', ProgramData: 'data' };
  const paths = [
    ['local', 'Programs', 'Notion', 'Notion.exe'], ['local', 'Notion', 'Notion.exe'],
    ['programs', 'Notion', 'Notion.exe'], ['x86', 'Notion', 'Notion.exe'],
    ['scoop', 'apps', 'notion', 'current', 'Notion.exe'],
    ['global', 'apps', 'notion', 'current', 'Notion.exe'],
    ['data', 'scoop', 'apps', 'notion', 'current', 'Notion.exe'],
  ].map(parts => join(...parts));
  for (const expected of paths) {
    const stat = path => { if (path !== expected) throw new Error('missing'); return { isDirectory: () => false, isFile: () => true }; };
    assert.equal(resolveNotionPath({ env, stat }), resolve(expected));
  }
  assert.equal(resolveNotionPath({ env: {}, stat: () => { throw new Error('missing'); } }), undefined);
});
