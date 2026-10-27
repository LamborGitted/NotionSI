#!/usr/bin/env node
import { main } from './src/cli.js';
import { runConfigTui } from './src/config-tui.js';

const args = process.argv.slice(2);
const command = args[0]?.startsWith('-') || !args.length ? 'start' : args.shift();
const configure = () => {
  if (args.includes('--help')) return main(['--help']);
  if (args.includes('--show')) return main(['--check-config', ...args.filter(arg => arg !== '--show')]);
  if (args.length) throw new Error('交互配置请运行 node index.js config；查看脱敏配置请用 node index.js config --show [options]。');
  return runConfigTui().then(result => { if (result.saved) console.log(`配置已保存：${result.path}`); });
};
const commands = {
  start: () => main(args),
  attach: () => main(['--attach', ...args]),
  config: configure,
  check: () => main(['--check-api', ...args]),
  login: () => main(['--login', ...args]),
  tui: configure,
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
