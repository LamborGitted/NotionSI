#!/usr/bin/env node
import { resolveNotionPath } from './notion-path.js';
import { Cdp, loopbackEndpoint } from './cdp.js';
import { MockRouter } from './router.js';
import { loadLocalEnv, providerConfig, createProvider, publicConfig } from './config.js';
import { openNotion } from './notion-launcher.js';
import { providerNames } from './providers/index.js';
import { TerminalReporter } from './terminal-reporter.js';

export async function main(args = process.argv.slice(2)) {
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}.`);
  return args[index + 1];
}
if (args.includes('--help')) {
  console.log(`Usage: node index.js [start|attach|config|check|verify|verify-editor|check-tools|verify-tool-ui] [options]

  --provider ${providerNames.join('|')}  Select a model provider
  --profile standard|coding-cn  Zhipu endpoint profile
  --model MODEL                Override provider model
  --notion PATH                Notion.exe or installation directory
  --endpoint URL               Local CDP endpoint (default http://127.0.0.1:9222)
  --attach                     Connect without launching Notion
  --check-config               Display configuration without sending requests
  --check-api                  Send a fixed test prompt without connecting to Notion
  --no-content-log             Hide assistant reply content in terminal
  --answer TEXT                Mock response text
  --delay-ms 60                Mock chunk delay

Configuration: .env.local. CLI options override environment/file settings.
Ctrl+C or q removes the hook and leaves Notion open.`);
  return;
}
const known = new Set(['--attach', '--check-config', '--check-api', '--no-content-log', '--provider', '--profile', '--model', '--endpoint', '--notion', '--answer', '--delay-ms']);
for (let i = 0; i < args.length; i++) { if (!known.has(args[i])) throw new Error(`Unknown option ${args[i]}`); if (!['--attach', '--check-config', '--check-api', '--no-content-log'].includes(args[i])) { option(args[i]); i++; } }
if (args.includes('--check-config') && args.includes('--check-api')) throw new Error('Choose config or check, not both.');
loadLocalEnv();
const config = providerConfig({ provider: option('--provider', process.env.NOTIONSI_PROVIDER ?? 'mock'), model: option('--model', undefined),
  apiProfile: option('--profile', undefined) });
if(args.includes('--no-content-log'))config.logContent=false;
if (args.includes('--check-api')) {
  const provider = createProvider(config);
  if (!provider) throw new Error('mock has no API to check. Select a model provider with --provider.');
  console.log(JSON.stringify(publicConfig(config), null, 2));
  let answer = '';
  for await (const chunk of provider.stream({ messages: [{ role: 'user', content: '请只回复：连接成功' }] })) answer += chunk;
  console.log(answer);
  console.log(`${provider.name} SSE connectivity check passed.`);
  return;
}
const executable = args.includes('--attach') ? undefined : resolveNotionPath({ path: option('--notion', undefined) });
if (args.includes('--check-config')) {
  console.log(JSON.stringify({ ...publicConfig(config), notionPath: executable ?? null, attachOnly: args.includes('--attach') }, null, 2));
  return;
}
// Validate credentials before opening CDP or modifying the page.
const provider = createProvider(config);
const endpoint = loopbackEndpoint(option('--endpoint', 'http://127.0.0.1:9222'));
const delayMs = Number(option('--delay-ms', '60'));
if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 10000) throw new Error('delay-ms must be between 0 and 10000.');
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
  console.log(`Router ready: ${provider ? `${provider.name} / ${provider.model}` : 'local fixed answer'}. Ordinary Notion requests are unchanged. Ctrl+C or q to detach.`);
} catch (error) { console.error(error.message); process.exitCode = 1; await stop(); }
}
