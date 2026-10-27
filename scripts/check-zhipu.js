// Compatibility entry; prefer node index.js check --provider zhipu.
import { main } from '../src/cli.js';
main(['--check-api', '--provider', 'zhipu', ...process.argv.slice(2)])
  .catch(error => { console.error(error.message); process.exitCode = 1; });
