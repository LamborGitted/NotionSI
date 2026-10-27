import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pageHookSource } from '../src/page-hook.js';

function fixture(origin = 'https://app.notion.com', paths = ['/api/v3/runInferenceTranscript'], response = () => new Response('native')) {
  const messages = [], passthrough = [];
  const nativeFetch = async (...args) => { passthrough.push(args); return response(...args); };
  const context = vm.createContext({ location: { origin, href: `${origin}/ai` }, fetch: nativeFetch,
    URL, Request, Response, ReadableStream, TextEncoder, TextDecoder, DOMException, AbortController, setTimeout, clearTimeout, __testBinding: payload => messages.push(JSON.parse(payload)) });
  vm.runInContext(pageHookSource({ origins: ['https://app.notion.com'], paths, binding: '__testBinding' }), context);
  return { context, messages, passthrough, nativeFetch };
}

test('only fixed native attachment signing endpoints are available through the authenticated page bridge', async () => {
  const f = fixture('https://app.notion.com', [], () => Response.json({ url: 'https://prod-files-secure.s3.us-west-2.amazonaws.com/image' }));
  for (const path of ['getFileContentURLForAgentThread', 'getSignedFileUrls']) {
    const body = { spaceId: 'space', threadId: 'thread', fileId: 'image' };
    const result = await f.context.__notionMockRouter.toolRequest({ id: path, path, body });
    assert.equal(result.status, 200);
    const [url, init] = f.passthrough.at(-1);
    assert.equal(url, '/api/v3/' + path); assert.equal(init.credentials, 'same-origin'); assert.equal(init.redirect, 'error');
    assert.deepEqual(JSON.parse(init.body), body); assert.equal(f.messages.length, 0);
  }
  await assert.rejects(f.context.__notionMockRouter.toolRequest({ id: 'bad', path: 'https://evil.test', body: {} }), /Invalid tool request/);
});
async function request(f, init = {}) {
  const pending = f.context.fetch('https://app.notion.com/api/v3/runInferenceTranscript?src=test', { method: 'POST', body: '{"traceId":"test"}', ...init });
  // Reading a cloned Request body involves a stream turn, not just a microtask.
  for (let i = 0; i < 50 && !f.messages.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(f.messages.length, 'bridge should receive the request');
  return { pending, id: f.messages[0].id };
}

test('intercepted fetch returns exact NDJSON headers, streamed bytes and EOF without network', async () => {
  const f = fixture(), { pending, id } = await request(f);
  const bridge = f.context.__notionMockRouter;
  bridge.receive({ id, type: 'headers', status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  const response = await pending;
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
  const reader = response.body.getReader();
  bridge.receive({ id, type: 'data', data: '{"text":"你好🌏"}\n' });
  assert.equal(new TextDecoder().decode((await reader.read()).value), '{"text":"你好🌏"}\n');
  bridge.receive({ id, type: 'end' });
  assert.equal((await reader.read()).done, true);
  assert.equal(f.passthrough.length, 0);
  assert.equal(bridge.snapshot().completed, 1);
  assert.equal(bridge.snapshot().active, 0);
});

test('ordinary endpoints, foreign origins and other methods preserve the original fetch call', async () => {
  const f = fixture();
  for (const [url, init] of [['https://app.notion.com/api/v3/loadPageChunk', { method: 'POST' }],
    ['https://example.org/api/v3/runInferenceTranscript', { method: 'POST' }],
    ['https://app.notion.com/api/v3/runInferenceTranscript', { method: 'GET' }]]) {
    assert.equal(await (await f.context.fetch(url, init)).text(), 'native');
    assert.equal(f.passthrough.at(-1)[0], url);
    assert.equal(f.passthrough.at(-1)[1], init);
  }
  assert.equal(f.messages.length, 0);
});

test('abort cancels the bridge request and errors an already returned response stream', async () => {
  const f = fixture(), controller = new AbortController();
  const { pending, id } = await request(f, { signal: controller.signal });
  f.context.__notionMockRouter.receive({ id, type: 'headers', status: 200, headers: {} });
  const response = await pending;
  controller.abort();
  await assert.rejects(response.text(), { name: 'AbortError' });
  assert.equal(f.messages.at(-1).type, 'abort');
  assert.equal(f.context.__notionMockRouter.snapshot().active, 0);
});

test('malformed request fails locally instead of falling back to official AI', async () => {
  const f = fixture();
  await assert.rejects(f.context.fetch('https://app.notion.com/api/v3/runInferenceTranscript', { method: 'POST', body: '{bad' }), { name: 'SyntaxError' });
  assert.equal(f.passthrough.length, 0);
});

test('uninstall restores fetch and disables any saved wrapper reference', async () => {
  const f = fixture(), wrapper = f.context.fetch;
  f.context.__notionMockRouter.uninstall();
  assert.equal(f.context.fetch, f.nativeFetch);
  assert.equal(await (await wrapper('https://app.notion.com/api/v3/runInferenceTranscript', { method: 'POST' })).text(), 'native');
});

test('untrusted origin is never instrumented', () => {
  const f = fixture('https://example.org');
  assert.equal(f.context.fetch, f.nativeFetch);
  assert.equal(f.context.__notionMockRouter, undefined);
});

test('runWriter and local undo are intercepted, while unrelated native undo remains on its original path',async()=>{
  const f=fixture('https://app.notion.com',['/api/v3/runWriter','/api/v3/undoAgentServiceTurn']);
  const native=await f.context.fetch('https://app.notion.com/api/v3/undoAgentServiceTurn',{method:'POST',body:JSON.stringify({sessionIdleEventId:'event_native'})});
  assert.equal(await native.text(),'native');assert.equal(f.messages.length,0);
  for(const [path,body]of [['runWriter',{clientMessageId:'message'}],['undoAgentServiceTurn',{sessionIdleEventId:'notionsi_writer_test'}]]) {
    const pending=f.context.fetch('https://app.notion.com/api/v3/'+path,{method:'POST',body:JSON.stringify(body)});
    const expected=f.messages.length+1;
    for(let i=0;i<50&&f.messages.length<expected;i++)await new Promise(r=>setTimeout(r,2));
    const message=f.messages.at(-1);assert.equal(message.path,'/api/v3/'+path);
    const bridge=f.context.__notionMockRouter;bridge.receive({id:message.id,type:'headers',status:200,headers:{'Content-Type':'application/json'}});bridge.receive({id:message.id,type:'data',data:'{"status":"edited"}'});bridge.receive({id:message.id,type:'end'});
    assert.equal((await(await pending).json()).status,'edited');
  }
  assert.equal(f.passthrough.length,1);
});
