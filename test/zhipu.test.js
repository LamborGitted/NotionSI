import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ZhipuProvider, ZhipuError, ZHIPU_ENDPOINT, sseData } from '../src/providers/zhipu.js';
import { AgentMock } from '../src/agent-mock.js';
import { ClassicAdapter } from '../src/classic-adapter.js';

const packet = (text, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] })}\r\n\r\n`;
function streamBytes(text, size = 1) {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({ pull(controller) {
    if (at === bytes.length) return controller.close();
    controller.enqueue(bytes.slice(at, at + size)); at = Math.min(at + size, bytes.length);
  } });
}
const sseResponse = text => new Response(streamBytes(text), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
const input = [{ role: 'user', content: '你好' }];
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };

test('SSE handles UTF-8 split bytes, split CRLF, multiline data and missing final blank line', async () => {
  const data = ': comment\r\nevent: message\r\ndata: {"text":\r\ndata: "你好🐱"}\r\n\r\ndata: [DONE]';
  assert.deepEqual(await collect(sseData(streamBytes(data))), ['{"text":\n"你好🐱"}', '[DONE]']);
});

test('standard endpoint receives only explicit model messages and key; reasoning is not final text', async () => {
  let call;
  const provider = new ZhipuProvider({ apiKey: 'fictional-test-key', model: 'glm-4.7', fetchImpl: async (url, init) => {
    call = { url, init };
    return sseResponse('data: {"choices":[{"index":0,"delta":{"reasoning_content":"private reasoning"}}]}\n\n'
      + packet('你好') + packet('🐱') + packet('', 'stop') + 'data: {"choices":[],"usage":{"total_tokens":4}}\n\ndata: [DONE]\n\n');
  } });
  assert.equal((await collect(provider.stream({ messages: input }))).join(''), '你好🐱');
  assert.equal(call.url, ZHIPU_ENDPOINT);
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.redirect, 'error');
  assert.deepEqual(Object.keys(call.init.headers).sort(), ['Accept', 'Authorization', 'Content-Type']);
  assert.equal(call.init.headers.Authorization, 'Bearer fictional-test-key');
  const body = JSON.parse(call.init.body);
  assert.deepEqual(body.messages, input); assert.equal(body.stream, true);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(JSON.stringify(provider).includes('fictional-test-key'), false);
});

test('HTTP failure bodies never leak credentials or echoed prompt to the user', async () => {
  const provider = new ZhipuProvider({ apiKey: 'private-test-key', fetchImpl: async () => new Response(
    JSON.stringify({ error: { message: 'private-test-key secret-prompt' } }), { status: 401 }) });
  await assert.rejects(collect(provider.stream({ messages: input })), error =>
    error instanceof ZhipuError && error.status === 401 && !/private-test-key|secret-prompt/.test(error.message));
});

test('system prompt precedes every turn exactly once without mutating history or exposing content', async () => {
  const calls = [];
  const systemPrompt = 'Private local instructions 测试';
  const provider = new ZhipuProvider({ apiKey: 'test-only', systemPrompt, fetchImpl: async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return sseResponse(packet('reply') + packet('', 'stop'));
  } });
  const history = structuredClone(input);
  await collect(provider.stream({ messages: history }));
  history.push({ role: 'assistant', content: 'reply' }, { role: 'user', content: 'second turn' });
  await collect(provider.stream({ messages: history }));
  for (const body of calls) {
    assert.deepEqual(body.messages[0], { role: 'system', content: systemPrompt });
    assert.equal(body.messages.filter(message => message.role === 'system').length, 1);
    assert.equal(Object.hasOwn(body, 'tools'), false);
  }
  assert.deepEqual(calls[1].messages.slice(1), history);
  assert.equal(history.length, 3);
  assert.equal(history.some(message => message.role === 'system'), false);
  assert.equal(JSON.stringify(provider).includes(systemPrompt), false);
  await assert.rejects(collect(provider.stream({ messages: [{ role: 'user', content: 'x'.repeat(100000) }] })), /过长/);
  assert.equal(calls.length, 2);
});

test('Coding Plan CN never retries through the standard endpoint after an error', async () => {
  const calls = [];
  const provider = new ZhipuProvider({ apiKey: 'test-only', apiProfile: 'coding-cn', fetchImpl: async url => {
    calls.push(url);
    return new Response('{"error":{"code":"1309"}}', { status: 429 });
  } });
  await assert.rejects(collect(provider.stream({ messages: input })), error => error.code === '1309');
  assert.deepEqual(calls, ['https://open.bigmodel.cn/api/coding/paas/v4/chat/completions']);
});

test('abrupt EOF, invalid JSON, token limit and tool calls cannot fabricate successful completion', async () => {
  for (const data of [packet('partial'), 'data: {broken}\n\n', packet('truncated', 'length'),
    'data: {"choices":[{"delta":{"tool_calls":[{}]},"finish_reason":"tool_calls"}]}\n\n']) {
    const provider = new ZhipuProvider({ apiKey: 'test-only', fetchImpl: async () => sseResponse(data) });
    await assert.rejects(collect(provider.stream({ messages: input })), ZhipuError);
  }
});

test('HTTP 429 distinguishes model congestion from balance and account limits using safe numeric codes', async () => {
  for (const [code, expression] of [['1305', /访问量过大/], ['1113', /余额不足/], ['1302', /速率限制/]]) {
    const provider = new ZhipuProvider({ apiKey: 'test-only', fetchImpl: async () => new Response(
      JSON.stringify({ error: { code, message: 'Do not echo this provider text' } }), { status: 429 }) });
    await assert.rejects(collect(provider.stream({ messages: input })), error => error.code === code && expression.test(error.message)
      && !error.message.includes('Do not echo'));
  }
});

test('cancellation reaches fetch and ends a pending provider request', async () => {
  const controller = new AbortController(); let observed;
  const provider = new ZhipuProvider({ apiKey: 'test-only', fetchImpl: (_url, init) => {
    observed = init.signal;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } });
  const pending = collect(provider.stream({ messages: input, signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(observed.aborted, true);
});

test('cancellation interrupts an idle SSE read and releases its reader', async () => {
  const controller = new AbortController(); let canceled = false;
  const provider = new ZhipuProvider({ apiKey: 'test-only', fetchImpl: async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode(packet('first'))); },
    cancel() { canceled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  const stream = provider.stream({ messages: input, signal: controller.signal });
  assert.equal((await stream.next()).value, 'first');
  const pending = stream.next(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(canceled, true);
});

async function idle(agent) {
  for (let i = 0; i < 200; i++) {
    const { body } = await agent.handle('/api/v3/getThreadTranscript', { spaceId: 'space', threadId: 'thread' });
    if (body.session.status === 'idle') return body;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Timed out waiting for a terminal transcript.');
}

test('local HTTP fixture exercises SSE to Notion transcript, rich text and two-turn history', async t => {
  const seen = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    seen.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const data = packet('来自') + packet('智谱') + packet('', 'stop') + 'data: [DONE]\n\n';
    for (const byte of new TextEncoder().encode(data)) response.write(Buffer.of(byte));
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const provider = new ZhipuProvider({ apiKey: 'fixture-key', fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${server.address().port}`, init) });
  const agent = new AgentMock({ generateText: args => provider.stream(args) });
  t.after(() => agent.close());
  const created = await agent.handle('/api/v3/createAgentThread', {
    spaceId: 'space', threadId: 'thread', type: 'personal_agent', clientMessageId: 'first',
    content: [{ type: 'text', text: [['记住', [['b']]], ['小猫']] }],
  });
  assert.equal(created.status, 200);
  let transcript = await idle(agent);
  assert.equal(transcript.patches.find(p => p.entity?.kind === 'assistant_message').entity.content[0].text, '来自智谱');
  assert.equal(transcript.patches.find(p => p.entity?.kind === 'turn_completed').entity.stop_reason, 'end_turn');
  assert.equal((await agent.handle('/api/v3/sendEventToAgentThread', {
    spaceId: 'space', threadId: 'thread', clientEventId: 'second',
    event: { type: 'user.message', content: [{ type: 'text', text: [['我说了什么？']] }] },
  })).status, 200);
  await idle(agent);
  assert.deepEqual(seen[1].messages, [
    { role: 'user', content: '记住小猫' }, { role: 'assistant', content: '来自智谱' }, { role: 'user', content: '我说了什么？' },
  ]);
});

test('upstream failure leaves an idle error transcript without an unhandled rejection or end_turn', async () => {
  const provider = new ZhipuProvider({ apiKey: 'test-only', fetchImpl: async () => new Response('', { status: 429 }) });
  const agent = new AgentMock({ generateText: args => provider.stream(args) });
  await agent.handle('/api/v3/sendEventToAgentThread', { spaceId: 'space', threadId: 'thread', clientEventId: 'failed',
    event: { type: 'user.message', content: [{ type: 'text', text: [['test']] }] } });
  const body = await idle(agent);
  assert.equal(body.patches.find(p => p.entity?.kind === 'turn_completed').entity.stop_reason, 'runtime_error');
  assert.match(body.patches.find(p => p.entity?.kind === 'error').entity.message, /429/);
  assert.equal(body.patches.some(p => p.entity?.kind === 'assistant_message'), false);
  agent.close();
});

test('classic stream preserves stable identity, incremental patches and full final snapshot', async () => {
  const provider = new ZhipuProvider({ apiKey: 'test-only', fetchImpl: async () => sseResponse(packet('模型') + packet('回答', 'stop') + 'data: [DONE]\n\n') });
  const adapter = new ClassicAdapter(provider);
  const frames = await collect(adapter.stream({ spaceId: 's', threadId: 't', asPatchResponse: true,
    transcript: [{ type: 'user', value: [['问题']] }] }));
  assert.equal(frames[0].type, 'patch-start');
  assert.deepEqual(frames.filter(frame => frame.type === 'patch').map(frame => frame.v[0].v), ['模型', '回答']);
  assert.equal(frames.at(-1).data.s[0].value, '模型回答');
  assert.equal(frames.at(-1).data.s[0].id, frames[0].data.s[0].id);
});
