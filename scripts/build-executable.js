import { build } from 'esbuild';
import { inject } from 'postject';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Build the Windows x64 executable using Windows x64 Node.js.');
}
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error('Use Node.js 24 to build the executable.');
}

const root = fileURLToPath(new URL('../', import.meta.url));
const work = join(root, '.build');
const output = join(root, 'dist', 'NotionSI-win-x64');
await mkdir(work, { recursive: true });
await mkdir(output, { recursive: true });

// Keep ESM and top-level await, including the lazily loaded diagnostic scripts.
// The SEA CommonJS bootstrap imports the bundled ESM from an embedded asset.
await build({
  absWorkingDir: root,
  entryPoints: ['index.js'],
  outfile: join(work, 'app.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: false,
});
await writeFile(join(work, 'bootstrap.cjs'), `
const { getAsset } = require('node:sea');
const source = getAsset('app.mjs', 'utf8');
import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
`);
const blob = join(work, 'app.blob');
const config = join(work, 'sea-config.json');
await writeFile(config, JSON.stringify({
  main: join(work, 'bootstrap.cjs'),
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: { 'app.mjs': join(work, 'app.mjs') },
}));
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });
const executable = join(output, 'NotionSI.exe');
await copyFile(process.execPath, executable);
await inject(executable, 'NODE_SEA_BLOB', await readFile(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
});
// Explicit allowlist: never copy local configuration, keys, or captures.
for (const name of ['.env.example', 'system-prompt.example.txt', 'README.md', 'CHANGELOG.md', 'LICENSE']) {
  await copyFile(join(root, name), join(output, name));
}
await cp(join(root, 'docs'), join(output, 'docs'), { recursive: true });
console.log(`Built ${executable}`);
