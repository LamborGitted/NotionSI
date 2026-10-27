import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HttpProvider } from '../src/providers/http-provider.js';
import { ProviderError } from '../src/providers/errors.js';
import { events } from '../src/providers/http-common.js';
import { AgentMock } from '../src/agent-mock.js';
import { WriterAdapter } from '../src/writer-adapter.js';
import { MockRouter } from '../src/router.js';

const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const response = value => new Response(value, { headers: { 'content-type': 'text/event-stream' } });
const collect = async iterable => { let text = ''; for await (const chunk of iterable) text += chunk; return text; };
const definitions = [{ type: 'function', function: { name: 'view', description: 'Read a page', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } }];
const input = [{ role: 'user', content: 'Read this page' }];
const toolCall = { id: 'call_1', type: 'function', function: { name: 'view', arguments: '{"id":"page"}' } };
const fixtures = {
  'chat-completions': {
    text: event({ choices: [{ index: 0, delta: { content: '回答🐱' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n',
    tool: event({ choices: [{ index: 0, delta: { reasoning_content: 'private thinking', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'vi', arguments: '{"id":' } }] } }] }) +
      event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'ew', arguments: '"page"}' } }] }, finish_reason: 'tool_calls' }] }),
    truncated: event({ choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall }] } }] }),
    limited: event({ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }),
  },
  responses: {
    text: event({ type: 'response.output_text.delta', delta: '回答🐱' }) + event({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '回答🐱' }] }] } }),
    tool: event({ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'r1', encrypted_content: 'opaque-signature' } }) +
      event({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'view', arguments: '{"id":"page"}' } }) +
      event({ type: 'response.completed', response: { status: 'completed' } }),
    truncated: event({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'view', arguments: '{"id":"page"}' } }),
    limited: event({ type: 'response.incomplete', response: { status: 'incomplete' } }),
  },
  anthropic: {
    text: event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '回答🐱' } }) +
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) + event({ type: 'message_stop' }),
    tool: event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'private thinking', signature: 'opaque-signature' } }) +
      event({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'view', input: {} } }) +
      event({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"id":' } }) +
      event({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"page"}' } }) +
      event({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }) + event({ type: 'message_stop' }),
    truncated: event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'view', input: { id: 'page' } } }),
    limited: event({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }) + event({ type: 'message_stop' }),
  },
  gemini: {
    text: event({ candidates: [{ index: 0, content: { parts: [{ text: 'private thinking', thought: true }, { text: '回答🐱' }] }, finishReason: 'STOP' }] }),
    tool: event({ candidates: [{ index: 0, content: { parts: [{ functionCall: { id: 'call_1', name: 'view', args: { id: 'page' } }, thoughtSignature: 'opaque-signature' }] }, finishReason: 'STOP' }] }),
    truncated: event({ candidates: [{ content: { parts: [{ functionCall: { name: 'view', args: { id: 'page' } } }] } }] }),
    limited: event({ candidates: [{ finishReason: 'MAX_TOKENS' }] }),
  },
};
const make = (protocol, fetchImpl, overrides = {}) => new HttpProvider({ name: 'fixture', protocol, baseUrl: 'https://example.test/v1', model: 'fixture/model', apiKey: 'private-test-key', fetchImpl, ...overrides });

for (const [protocol, fixture] of Object.entries(fixtures)) {
  test(`${protocol}: fragmented HTTP SSE, native tools, signatures and next-turn history`, async t => {
    const requests = [], executed = [], toolEvents = []; let history;
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const byte of new TextEncoder().encode(requests.length === 1 ? fixture.tool : fixture.text)) res.write(Buffer.of(byte));
      res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const provider = make(protocol, fetch, { baseUrl: `http://127.0.0.1:${server.address().port}`, systemPrompt: 'private system' });
    const tools = { definitions, instructions: 'tool rules', execute: async (name, args) => { executed.push({ name, args }); return { text: 'readback' }; } };
    assert.equal(await collect(provider.stream({ messages: input, tools, onToolEvent: e => toolEvents.push(e), onHistory: h => { history = h; } })), '回答🐱');
    assert.deepEqual(input, [{ role: 'user', content: 'Read this page' }]);
    assert.deepEqual(executed, [{ name: 'view', args: { id: 'page' } }]);
    assert.deepEqual(toolEvents.map(e => e.type), ['start', 'end']);
    assert.equal(history[1].tool_calls[0].function.name, 'view');
    assert.equal(history[2].tool_call_id, 'call_1');
    assert.equal(history.at(-1).content, '回答🐱');
    assert.equal(history.some(m => m.role === 'system'), false);
    assert.match(JSON.stringify(requests[1].body), /readback/);
    assert.match(JSON.stringify(requests[1].body), protocol === 'chat-completions' ? /private thinking/ : /opaque-signature/);
    assert.equal(JSON.stringify(provider).includes('private-test-key'), false);
    assert.equal(JSON.stringify(provider).includes('private system'), false);
    for (const req of requests) {
      assert.equal(req.headers.cookie, undefined);
      assert.match(JSON.stringify(req.body), /private system/);
      assert.match(JSON.stringify(req.body), /tool rules/);
    }
    if (protocol === 'anthropic') { assert.equal(requests[0].headers['x-api-key'], 'private-test-key'); assert.equal(requests[0].headers.authorization, undefined); }
    else if (protocol === 'gemini') { assert.equal(requests[0].headers['x-goog-api-key'], 'private-test-key'); assert.equal(requests[0].url.includes('private-test-key'), false); }
    else assert.equal(requests[0].headers.authorization, 'Bearer private-test-key');
    await collect(provider.stream({ messages: [...history, { role: 'user', content: 'Continue' }], tools }));
    assert.match(JSON.stringify(requests[2].body), /Read this page/);
    assert.match(JSON.stringify(requests[2].body), /Continue/);
  });

  test(`${protocol}: incomplete/error/limited streams cannot execute tools or commit history`, async () => {
    for (const data of [fixture.truncated, fixture.limited, 'data: {broken\n\n', event({ error: { message: 'private-test-key' } })]) {
      let writes = 0, histories = 0;
      const provider = make(protocol, async () => response(data));
      await assert.rejects(collect(provider.stream({ messages: input, tools: { definitions, execute: () => { writes++; } }, onHistory: () => { histories++; } })), error => error instanceof ProviderError && !error.message.includes('private-test-key'));
      assert.equal(writes, 0); assert.equal(histories, 0);
    }
  });

  test(`${protocol}: unadvertised tools are rejected and loops are bounded`, async () => {
    const provider = make(protocol, async () => response(fixture.tool));
    await assert.rejects(collect(provider.stream({ messages: input })), /未开放/);
    let executed = 0;
    await assert.rejects(collect(provider.stream({ messages: input, tools: { definitions, execute: () => { executed++; return { ok: true }; } } })), /上限/);
    assert.equal(executed, 7);
  });
}

test('HTTP errors never expose upstream bodies or fall back to another endpoint', async () => {
  for (const status of [401, 402, 403, 429, 500]) {
    let count = 0;
    const provider = make('responses', async () => { count++; return new Response('private-test-key echoed prompt', { status }); });
    await assert.rejects(collect(provider.stream({ messages: input })), e => e.status === status && !/private-test-key|echoed/.test(e.message));
    assert.equal(count, 1);
  }
  await assert.rejects(collect(make('responses', async () => new Response('{}')).stream({ messages: input })), /SSE/);
});

test('cancel reaches pending fetch, idle stream and native tool executor', async () => {
  const controller = new AbortController(); let upstream;
  const provider = make('responses', async (_url, init) => {
    upstream = init.signal;
    return new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); controller.abort(); });
  });
  await assert.rejects(collect(provider.stream({ messages: input, signal: controller.signal })), { name: 'AbortError' });
  assert.equal(upstream.aborted, true);
  const idle = new AbortController(); let canceled = false;
  const stream = new ReadableStream({ start() { queueMicrotask(() => idle.abort()); }, cancel() { canceled = true; } });
  await assert.rejects(collect(make('responses', async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })).stream({ messages: input, signal: idle.signal })), { name: 'AbortError' });
  assert.equal(canceled, true);
  const toolsAbort = new AbortController(), toolEvents = [];
  await assert.rejects(collect(make('responses', async () => response(fixtures.responses.tool)).stream({ messages: input, signal: toolsAbort.signal,
    tools: { definitions, execute: (_n, _args, { signal }) => { toolsAbort.abort(); signal.throwIfAborted(); } }, onToolEvent: e => toolEvents.push(e) })), { name: 'AbortError' });
  assert.equal(toolEvents.at(-1).canceled, true);
});

test('configuration validates credentials, URL, model and bounds before any network request', () => {
  for (const overrides of [{ apiKey: '' }, { apiKey: 'bad\r\nkey' }, { maxTokens: 0 }, { timeoutMs: NaN }, { model: '../bad?secret' },
    { baseUrl: 'http://public.example/v1' }, { baseUrl: 'https://user:pass@example.test' }, { baseUrl: 'https://example.test?key=secret' }]) {
    assert.throws(() => make('responses', () => { throw new Error('must not fetch'); }, overrides));
  }
  assert.equal(make('chat-completions', fetch, { apiKey: undefined, keyOptional: true }).name, 'fixture');
});

test('SSE handles CRLF, multiline JSON and an event without the last blank line', async () => {
  const data = 'data: {\r\ndata: "text": "🐱"\r\ndata: }';
  const chunks = []; for await (const item of events(response(data).body)) chunks.push(JSON.parse(item));
  assert.deepEqual(chunks, [{ text: '🐱' }]);
});

test('new provider drives two-turn Notion Agent history and editor generation through the router', async () => {
  const requests = [];
  const provider = make('responses', async (_url, init) => { requests.push(JSON.parse(init.body)); return response(fixtures.responses.text); });
  const agent = new AgentMock({ generateText: args => provider.stream(args) });
  const common = { spaceId: 'space', threadId: 'thread' };
  await agent.handle('/api/v3/createAgentThread', { ...common, type: 'personal_agent', clientMessageId: 'one', content: [{ type: 'text', text: 'Remember a cat' }] });
  await agent.session('space', 'thread').task;
  await agent.handle('/api/v3/sendEventToAgentThread', { ...common, clientEventId: 'two', event: { type: 'user.message', content: [{ type: 'text', text: 'What did I say?' }] } });
  await agent.session('space', 'thread').task;
  assert.match(JSON.stringify(requests[1]), /Remember a cat/);
  assert.match(JSON.stringify(requests[1]), /What did I say/);
  assert.equal(agent.session('space', 'thread').status.status, 'idle'); agent.close();
  const router = new MockRouter({}, { provider });
  assert.ok(router.writer instanceof WriterAdapter);
  const writerText = await collect(router.writer.generateText({ messages: [{ role: 'system', content: 'Editor instruction' }, ...input], editorTask: true }));
  assert.equal(writerText, '回答🐱'); assert.match(JSON.stringify(requests.at(-1)), /Editor instruction/);
  router.agent.close();
});

test('invalid tool arguments and unknown tools become bounded model-visible tool errors', async () => {
  for (const [name, args] of [['view', '{broken'], ['unknown', '{}'], ['view', '[]']]) {
    let requests = 0, executions = 0, second;
    const tool = event({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'call_1', name, arguments: args }] } });
    const provider = make('responses', async (_url, init) => { requests++; if (requests === 1) return response(tool); second = JSON.parse(init.body); return response(fixtures.responses.text); });
    assert.equal(await collect(provider.stream({ messages: input, tools: { definitions, execute: () => { executions++; } } })), '回答🐱');
    assert.equal(executions, 0); assert.match(JSON.stringify(second), /is_error/);
  }
});

test('Codex subscription sends account auth, stateless instructions and only retries explicit 401 once', async () => {
  const requests = [], authCalls = [];
  const provider = make('responses', async (url, init) => { requests.push({ url, ...init }); return requests.length === 1 ? new Response('secret', { status: 401 }) : response(fixtures.responses.text); },
    { name: 'openai-codex', subscription: true, baseUrl: 'https://chatgpt.com/backend-api/codex', apiKey: undefined,
      credentials: { get: async (_signal, force) => { authCalls.push(force); return { apiKey: force ? 'renewed' : 'initial', accountId: 'account' }; } } });
  assert.equal(await collect(provider.stream({ messages: [{ role: 'system', content: 'Rules' }, ...input] })), '回答🐱');
  assert.deepEqual(authCalls, [undefined, true]); assert.equal(requests.length, 2);
  const body = JSON.parse(requests[1].body);
  assert.equal(body.instructions, 'Rules'); assert.equal(body.max_output_tokens, undefined); assert.equal(body.store, false);
  assert.equal(body.input.some(m => m.role === 'system'), false);
  assert.equal(requests[1].headers['ChatGPT-Account-Id'], 'account');
  assert.equal(requests[1].headers.Authorization, 'Bearer renewed');
  assert.equal(requests[1].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(requests[1].redirect, 'error'); assert.equal(requests[1].credentials, 'omit');
});
