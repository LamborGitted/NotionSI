import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { MockRouter } from '../src/router.js';
import { chatContext, pageIdFromLocation } from '../src/chat-context.js';
import { notionText } from '../src/notion-text.js';
import { NotionNativeTools } from '../src/tools/notion-native.js';
import { editorFixture } from './helpers/editor-memory.js';
import { image } from './helpers/image.js';

const id = '8e89b7b4-3641-49bf-afce-3edf90e4cf94';
const url = `https://www.notion.so/${id.replaceAll('-', '')}`;

test('model text preserves hyperlink URLs, page mentions and their labels without changing native tokens', () => {
  const tokens = [['阅读 ', [['b']]], ['文章[一]', [['a', 'https://example.org/a(b)?q=1'], ['b']]], [' 和 '], ['‣', [['p', id]]], ['具名页面', [['p', id, 'space', 'extra']]]];
  const original = structuredClone(tokens);
  assert.equal(notionText(tokens), `阅读 [文章\\[一\\]](https://example.org/a%28b%29?q=1) 和 [页面引用](${url})[具名页面](${url})`);
  assert.deepEqual(tokens, original);
  assert.equal(notionText([['笔记', [['a', `/${id.replaceAll('-', '')}`]]]]), `[笔记](${url})`);
  assert.equal(notionText([['unsafe', [['a', 'javascript:alert(1)']]], ['bad', [['p', 'invented']]], ['ok', [null, 1]]]), 'unsafebadok');
  assert.equal(notionText('literal **Markdown**'), 'literal **Markdown**');
  assert.equal(notionText([['‣', [['lm', 'https://example.org/article']]]]), '[链接](https://example.org/article)');
});

test('current location accepts page routes and excludes conversations, workflow IDs and foreign origins', () => {
  for (const value of [url, `https://app.notion.com/p/${id.replaceAll('-', '')}?t=chat`, `https://www.notion.so/My-note-${id}`]) assert.equal(pageIdFromLocation(value), id);
  for (const value of [`https://app.notion.com/chat/${id}`, `https://app.notion.com/agent/${id}`, 'https://app.notion.com/ai', `https://evil.test/${id}`, `https://app.notion.com.evil.test/${id}`, `https://user:pass@app.notion.com/p/${id}`, undefined]) assert.equal(pageIdFromLocation(value), undefined);
});

function fixture({ toolsEnabled = true, stream } = {}) {
  const f = editorFixture({ titles: ['Note body: launch on Friday.'] });
  f.received = [];
  const provider = { name: 'test', stream: async function*(request) {
    f.received.push(structuredClone(request.messages));
    if (stream) yield* stream(request);
    else { request.onHistory?.([...request.messages, { role: 'assistant', content: 'Done' }]); yield 'Done'; }
  } };
  f.router = new MockRouter(new EventEmitter(), { provider, toolsEnabled, log: () => {} });
  f.router.toolRequest = (_context, path, body, signal) => f.request(path, body, signal);
  f.threadId = randomUUID();
  f.close = () => { f.router.agent.close(); f.router.writer.close(); };
  return f;
}

async function turn(f, { text = '这篇文章说了什么', threadContext, pageUrl } = {}) {
  const body = { spaceId: f.spaceId, threadId: f.threadId, clientEventId: randomUUID(),
    event: { type: 'user.message', content: [{ type: 'text', text }] }, ...(threadContext === undefined ? {} : { threadContext }) };
  assert.equal((await f.router.agent.handle('/api/v3/sendEventToAgentThread', body,
    { toolContext: { spaceId: f.spaceId, threadId: f.threadId, pageUrl } })).status, 200);
  const session = f.router.agent.session(f.spaceId, f.threadId);
  await session.task;
  assert.equal([...session.entities.values()].some(e => e.kind === 'error'), false);
  return session;
}

const context = messages => messages.flatMap(m => {
  if (m.role !== 'user' || typeof m.content !== 'string') return [];
  try { return JSON.parse(m.content).notionContext?.pages ?? []; } catch { return []; }
});

test('native thread creation hydrates page context and converts references before its first model turn', async t => {
  const f = fixture(); t.after(f.close);
  const tokens = [['这篇文章说了什么 '], ['‣', [['p', f.pageId]]]];
  const result = await f.router.agent.handle('/api/v3/createAgentThread', { spaceId: f.spaceId, threadId: f.threadId,
    type: 'personal_agent', clientMessageId: randomUUID(), content: [{ type: 'text', text: tokens }],
    threadContext: { currentBlockId: f.pageId } }, { toolContext: { spaceId: f.spaceId } });
  assert.equal(result.status, 200);
  const session = f.router.agent.session(f.spaceId, f.threadId); await session.task;
  assert.equal(context(f.received[0])[0].status, 'read');
  assert.ok(f.received[0].at(-1).content.includes(f.pageId.replaceAll('-', '')));
  assert.deepEqual([...session.entities.values()].find(e => e.kind === 'user_message').text, tokens);
});

test('page-only chat hydrates the current note on each turn and keeps page snapshots out of history', async t => {
  const f = fixture(); t.after(f.close);
  const session = await turn(f, { threadContext: { currentBlockId: f.pageId } });
  const [page] = context(f.received[0]);
  assert.equal(page.source, 'current_page'); assert.equal(page.status, 'read');
  assert.match(page.content, /Note body: launch on Friday/);
  assert.match(page.content, /Unselected content/);
  assert.deepEqual(session.history, [{ role: 'user', content: '这篇文章说了什么' }, { role: 'assistant', content: 'Done' }]);
  f.blocks.get(f.ids[0]).properties.title = [['Updated: launch on Monday.']];
  await turn(f, { threadContext: { currentBlockId: f.pageId } });
  assert.match(context(f.received[1])[0].content, /launch on Monday/);
  assert.doesNotMatch(JSON.stringify(f.received[1]), /launch on Friday/);
  assert.ok(f.calls.every(c => c.path === 'syncRecordValues'), 'automatic context is read-only');
});

test('request-time location fills missing native context; switching pages or going to chat never reuses stale context', async t => {
  const f = fixture(); t.after(f.close);
  await turn(f, { threadContext: { currentBlockId: f.pageId } });
  const second = randomUUID();
  f.blocks.set(second, { ...structuredClone(f.blocks.get(f.pageId)), id: second, properties: { title: [['Second note']] }, content: [] });
  await turn(f, { pageUrl: `https://app.notion.com/p/${second.replaceAll('-', '')}` });
  assert.equal(context(f.received[1])[0].title, 'Second note');
  assert.doesNotMatch(JSON.stringify(f.received[1]), /launch on Friday/);
  await turn(f, { pageUrl: `https://app.notion.com/chat/${f.threadId}` });
  assert.deepEqual(context(f.received[2]), []);
  await turn(f, { threadContext: { currentBlockId: f.pageId }, pageUrl: `https://app.notion.com/p/${second.replaceAll('-', '')}` });
  assert.match(context(f.received[3])[0].content, /launch on Friday/);
});

test('a prior editor selection is not retained by later page-only chat', async t => {
  const f = fixture(); t.after(f.close);
  await turn(f, { threadContext: f.context });
  assert.equal(context(f.received[0]).length, 0);
  assert.equal(JSON.stringify(f.received[0]).includes('Unselected content'), false);
  await turn(f, { pageUrl: `https://app.notion.com/p/${f.pageId}` });
  assert.match(context(f.received[1])[0].content, /Unselected content/);
});

test('agent links and page mentions reach the model, hydrate referenced pages and preserve native transcript tokens', async t => {
  const f = fixture(); t.after(f.close);
  const tokens = [['请总结 '], ['‣', [['p', f.pageId]]], ['，参考 '], ['网站', [['a', 'https://example.org/article']]]];
  const session = await turn(f, { text: tokens });
  assert.match(f.received[0].at(-1).content, /\[页面引用\]\(https:\/\/www.notion.so\//);
  assert.match(f.received[0].at(-1).content, /https:\/\/example.org\/article/);
  assert.equal(context(f.received[0])[0].source, 'referenced_page');
  assert.match(context(f.received[0])[0].content, /launch on Friday/);
  assert.deepEqual([...session.entities.values()].find(e => e.kind === 'user_message').text, tokens);
  // The same reference supplied as a normal rich-text hyperlink follows the same path.
  await turn(f, { text: [['笔记', [['a', `https://app.notion.com/p/${f.pageId.replaceAll('-', '')}?pvs=24`]]]] });
  assert.equal(context(f.received[1])[0].status, 'read');
});

test('classic chat forwards native page context, preserves mention targets and strips transient tool-loop history', async t => {
  const f = fixture(); t.after(f.close);
  // Persistence has its own record-store fixture; this test covers context.
  f.router.classic.persistReply = undefined;
  const body = { spaceId: f.spaceId, threadId: f.threadId, threadContext: { currentBlockId: f.pageId },
    transcript: [{ type: 'user', value: { text: [['总结 ', [['b']]], ['‣', [['p', f.pageId]]]] } }] };
  for await (const frame of f.router.classic.stream(body, { toolContext: { spaceId: f.spaceId } })) assert.notEqual(frame.type, 'error');
  assert.match(context(f.received[0])[0].content, /launch on Friday/);
  assert.match(f.received[0].at(-1).content, /https:\/\/www.notion.so\//);
  const history = f.router.classic.histories.get(JSON.stringify([f.spaceId, f.threadId]));
  assert.equal(history.length, 2); assert.equal(context(history).length, 0);
});

test('page content itself retains links and nested page mentions for follow-up reading', async () => {
  const f = editorFixture();
  f.blocks.get(f.ids[0]).properties.title = [['Target ', [['b']]], ['‣', [['p', id]]], [' and '], ['external', [['a', 'https://example.org/doc']]]];
  const tools = new NotionNativeTools({ spaceId: f.spaceId, request: f.request });
  const result = await tools.read(f.pageId);
  assert.ok(result.content.includes(url)); assert.ok(result.content.includes('https://example.org/doc'));
});

test('inaccessible or foreign pages produce scoped failure context; tools-off never reads content', async t => {
  const f = fixture(); t.after(f.close);
  f.blocks.get(f.pageId).space_id = randomUUID();
  await turn(f, { threadContext: { currentBlockId: f.pageId } });
  const [failed] = context(f.received[0]); assert.equal(failed.status, 'unavailable');
  assert.match(failed.error, /无权访问或不属于当前工作区/); assert.equal(failed.content, undefined);
  const g = fixture({ toolsEnabled: false }); t.after(g.close);
  await turn(g, { threadContext: { currentBlockId: g.pageId } });
  assert.equal(context(g.received[0])[0].status, 'tools_disabled'); assert.equal(g.calls.length, 0);
});

test('automatic page context is bounded, deduplicated and preserves multimodal user content', async t => {
  const f = fixture(); t.after(f.close);
  const tools = new NotionNativeTools({ spaceId: f.spaceId, request: f.request });
  f.blocks.get(f.ids[0]).properties.title = [['x'.repeat(60000)]];
  const messages = [{ role: 'user', content: [{ type: 'text', text: `总结 https://www.notion.so/${f.pageId.replaceAll('-', '')}` }, image] }];
  const result = await chatContext({ tools, threadContext: { currentBlockId: f.pageId }, messages });
  assert.equal(result.pages.length, 1); assert.equal(result.pages[0].truncated, true);
  assert.ok(result.pages[0].content.length <= 40000);
  const second = randomUUID(), secondBody = randomUUID();
  f.blocks.set(second, { ...structuredClone(f.blocks.get(f.pageId)), id: second, content: [secondBody] });
  f.blocks.set(secondBody, { ...structuredClone(f.blocks.get(f.ids[0])), id: secondBody, parent_id: second });
  const shared = await chatContext({ tools, threadContext: { currentBlockId: f.pageId }, messages: [{ role: 'user', content: `总结 https://www.notion.so/${second.replaceAll('-', '')}` }] });
  assert.ok(shared.pages.every(p => p.content.length > 10000 && p.truncated));
  assert.ok(shared.pages.reduce((n, p) => n + p.title.length + p.content.length, 0) <= 40000);
  const many = await chatContext({ tools, messages: [{ role: 'user', content: Array.from({ length: 10 }, () => `https://www.notion.so/${randomUUID().replaceAll('-', '')}`).join(' ') }] });
  assert.equal(many.pages.length, 5);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(chatContext({ tools, threadContext: { currentBlockId: f.pageId }, messages, signal: controller.signal }), { name: 'AbortError' });
});

test('injected page data preserves a tool call/result pair and the original multimodal message in history', async t => {
  const call = { id: 'view-call', type: 'function', function: { name: 'view', arguments: '{}' } };
  const f = fixture({ stream: async function*(request) {
    const latest = request.messages.at(-1);
    assert.deepEqual(latest.content.at(-1), image);
    request.onHistory([...request.messages, { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: '{"success":true}' }, { role: 'assistant', content: 'Done' }]);
    yield 'Done';
  } }); t.after(f.close);
  f.router.agent.readAttachments = async () => [image];
  await f.router.agent.handle('/api/v3/sendEventToAgentThread', { spaceId: f.spaceId, threadId: f.threadId, clientEventId: randomUUID(),
    threadContext: { currentBlockId: f.pageId }, event: { type: 'user.message', content: [{ type: 'text', text: '解释笔记和图片' }, { type: 'file', file_id: 'image' }] } },
  { toolContext: { spaceId: f.spaceId } });
  const session = f.router.agent.session(f.spaceId, f.threadId); await session.task;
  assert.equal(context(session.history).length, 0);
  assert.deepEqual(session.history[0].content, [{ type: 'text', text: '解释笔记和图片' }, image]);
  assert.deepEqual(session.history[1].tool_calls, [call]); assert.equal(session.history[2].tool_call_id, call.id);
});
