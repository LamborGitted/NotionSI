#!/usr/bin/env node
import { main } from './src/cli.js';

const args = process.argv.slice(2);
const command = args[0]?.startsWith('-') || !args.length ? 'start' : args.shift();
const commands = {
  start: () => main(args),
  attach: () => main(['--attach', ...args]),
  config: () => main(['--check-config', ...args]),
  check: () => main(['--check-api', ...args]),
  verify: () => import('./scripts/verify-live.js'),
  'verify-editor': () => import('./scripts/verify-editor.js'),
  'check-tools': () => import('./scripts/check-tools.js'),
  'verify-tool-ui': () => import('./scripts/verify-tool-ui.js'),
};
try {
  if (!Object.hasOwn(commands, command)) throw new Error(`Unknown command ${command}. Use node index.js --help.`);
  // Diagnostic scripts retain their normal argv contract.
  process.argv = [process.argv[0], process.argv[1], ...args];
  await commands[command]();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
