import { loadLocalEnv, providerConfig, createProvider, publicConfig } from '../src/config.mjs';

// This is an explicit real request using the selected profile. No Notion content.
try {
  loadLocalEnv();
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--profile')) throw new Error('Usage: check:zhipu -- [--profile standard|coding-cn]');
  const config = providerConfig({ provider: 'zhipu', ...(args[1] ? { apiProfile: args[1] } : {}) });
  const provider = createProvider(config);
  console.log(JSON.stringify(publicConfig(config), null, 2));
  let answer = '';
  for await (const chunk of provider.stream({ messages: [{ role: 'user', content: '请只回复：连接成功' }] })) answer += chunk;
  console.log(answer);
  console.log('智谱 SSE 联通测试通过。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
