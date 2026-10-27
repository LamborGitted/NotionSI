#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Cdp, loopbackEndpoint } from './cdp.mjs';
import { MockRouter } from './router.mjs';
import { loadLocalEnv, providerConfig, createProvider, publicConfig } from './config.mjs';
import { openNotion } from './notion-launcher.mjs';
import { TerminalReporter } from './terminal-reporter.mjs';

async function main() {
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}.`);
  return args[index + 1];
}
if (args.includes('--help')) {
  console.log('Usage: npm start -- [--provider mock|zhipu] [--profile standard|coding-cn] [--model MODEL] [--check-config] [--no-content-log] [--attach] [--endpoint http://127.0.0.1:9222] [--notion PATH] [--answer TEXT] [--delay-ms 60]\nPut ZHIPU_API_KEY and ZHIPU_API_PROFILE in .env.local. Profiles never fall back to each other. Ctrl+C removes the hook; Notion stays open.');
  process.exit(0);
}
const known = new Set(['--attach', '--check-config', '--no-content-log', '--provider', '--profile', '--model', '--endpoint', '--notion', '--answer', '--delay-ms']);
for (let i = 0; i < args.length; i++) { if (!known.has(args[i])) throw new Error(`Unknown option ${args[i]}`); if (!['--attach', '--check-config', '--no-content-log'].includes(args[i])) i++; }
loadLocalEnv();
const config = providerConfig({ provider: option('--provider', process.env.NOTIONSI_PROVIDER ?? 'mock'), model: option('--model', undefined),
  apiProfile: option('--profile', process.env.ZHIPU_API_PROFILE ?? 'standard') });
if(args.includes('--no-content-log'))config.logContent=false;
if (args.includes('--check-config')) { console.log(JSON.stringify(publicConfig(config), null, 2)); process.exit(0); }
// Validate credentials before opening CDP or modifying the page.
const provider = createProvider(config);
const endpoint = loopbackEndpoint(option('--endpoint', 'http://127.0.0.1:9222'));
const delayMs = Number(option('--delay-ms', '60'));
if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 10000) throw new Error('delay-ms must be between 0 and 10000.');
const candidates = [option('--notion', process.env.NOTION_PATH), join(process.env.SCOOP ?? join(homedir(), 'scoop'), 'apps/notion/current/Notion.exe'), process.env.SCOOP_GLOBAL && join(process.env.SCOOP_GLOBAL, 'apps/notion/current/Notion.exe')].filter(Boolean);
const executable = candidates.find(path => existsSync(path));
if (!executable && !args.includes('--attach')) throw new Error('Notion.exe not found. Use --notion with the Scoop executable path.');
const cdp=await openNotion({endpoint,executable,connect:(...args)=>Cdp.connect(...args),attachOnly:args.includes('--attach')});
cdp.on('transportError', error => console.error(error.message));
const reporter=new TerminalReporter({content:config.logContent,model:provider?.model??'固定回答'});
process.stdout.on('error',()=>{reporter.disabled=true;});
const router = new MockRouter(cdp, { reporter,log:message=>reporter.line(message), answer: option('--answer', undefined), delayMs, provider, toolsEnabled: config.tools === 'native' });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  console.log('\nRemoving local mock hooks...');
  await router.stop(); cdp.close();
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
process.stdin.setEncoding('utf8');
process.stdin.on('data', value => { if (value.trim() === 'q') stop(); });
process.stdin.unref?.();
cdp.on('disconnected', () => { if (!stopping) { console.error('Notion debugging connection closed.'); process.exitCode = 1; } });
try {
  await router.start();
  console.log(`Router ready: ${provider ? `智谱 ${provider.apiProfile === 'coding-cn' ? 'GLM Coding Plan CN' : '国内标准 API'} / ${provider.model}` : 'local fixed answer'}. Ordinary Notion requests are unchanged. Ctrl+C or q to detach.`);
} catch (error) { console.error(error.message); process.exitCode = 1; await stop(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
