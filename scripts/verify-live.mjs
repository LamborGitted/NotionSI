import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Cdp, loopbackEndpoint } from '../src/cdp.mjs';
import { NOTION_ORIGINS } from '../src/router.mjs';
import { DEFAULT_ANSWER } from '../src/mock-protocol.mjs';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1]) throw new Error(`Missing ${name} value.`);
  return args[index + 1];
}
const endpoint = loopbackEndpoint(option('--endpoint', 'http://127.0.0.1:9222'));
const answer = option('--answer', DEFAULT_ANSWER);
const cdp = await Cdp.connect(endpoint);
let sessionId;
try {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const targetId = option('--target');
  const pages = targetInfos.filter(target => {
    try {
      const url = new URL(target.url);
      return target.type === 'page' && NOTION_ORIGINS.includes(url.origin)
        && (targetId ? target.targetId === targetId : /^\/(ai|chat)(\/|$)/.test(url.pathname));
    } catch { return false; }
  });
  if (pages.length !== 1) throw new Error(`Expected one Notion AI page; found ${pages.length}. Use --target ID if necessary.`);
  ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true }));
  const hook = await cdp.send('Runtime.evaluate', {
    expression: 'globalThis.__notionMockRouter?.snapshot() ?? null', returnByValue: true,
  }, sessionId);
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sessionId);
  const texts = nodes.filter(node => !node.ignored).map(node => ({ role: node.role?.value, name: node.name?.value ?? '' }));
  const has = expression => texts.some(node => expression.test(node.name));
  const result = {
    capturedAt: new Date().toISOString(), mode: 'read-only-native-accessibility',
    page: new URL(pages[0].url).pathname,
    hookInstalled: hook.result?.value?.installed === true,
    answerVisible: texts.some(node => node.name.includes(answer)),
    stopButtonVisible: texts.some(node => node.role === 'button' && /停止 AI 消息|Stop AI|Stop generating/i.test(node.name)),
    submitButtonVisible: texts.some(node => node.role === 'button' && /提交 AI 消息|Submit AI|Send message/i.test(node.name)),
    sendErrorVisible: has(/发送消息时出错|Error sending message/i),
    updateWarningVisible: has(/此活动需要更新版本|This activity requires a newer version/i),
    // Agent subscriptions remain open after completion. Active fetch count is
    // deliberately not used as proof that generation is still running.
    hook: hook.result?.value ?? null,
  };
  result.passed = result.hookInstalled && result.answerVisible && !result.stopButtonVisible
    && result.submitButtonVisible && !result.sendErrorVisible && !result.updateWarningVisible;
  const output = option('--output');
  if (output) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(result, null, 2)}\n`); }
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} finally {
  if (sessionId) await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  cdp.close();
}
