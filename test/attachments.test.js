import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentMock } from '../src/agent-mock.js';
import { ClassicAdapter } from '../src/classic-adapter.js';
import { MockRouter } from '../src/router.js';
import { NotionAttachments, notionUserContent } from '../src/notion-attachments.js';
import { validateMessages } from '../src/providers/http-common.js';
import { checkMessageBudget, imageMediaType, MAX_IMAGE_BYTES } from '../src/multimodal.js';
import { image, png } from './helpers/image.js';

const file = { type: 'file', file_id: 'image-id' };
const context = { session: 'cdp', context: 1, spaceId: 'space', threadId: 'thread' };
const request = { spaceId: 'space', threadId: 'thread', type: 'personal_agent', clientMessageId: 'one', content: [file] };
const signed = 'https://prod-files-secure.s3.us-west-2.amazonaws.com/image?signature=private';

test('classic attachment steps are signed and only new attachments are added to conversation history', async () => {
  const calls = [], requests = [];
  const reader = new NotionAttachments({ request: async (_ctx, path, body) => { calls.push({ path, body }); return { status: 200, data: { signedUrls: [signed] } }; }, fetchImpl: async () => new Response(png) });
  const adapter = new ClassicAdapter({ async *stream({ messages }) { requests.push(messages); yield '回答'; } }, { readAttachments: (...args) => reader.read(...args) });
  const attachment = { type: 'attachment', id: 'legacy-file', fileUrl: 'attachment:original-image:image.png', contentType: 'image/png', permissionRecord: { table: 'thread', id: 'thread', spaceId: 'space' } };
  const collect = async stream => { const frames = []; for await (const frame of stream) frames.push(frame); return frames; };
  const common = { spaceId: 'space', threadId: 'thread' };
  const transcript = [attachment, { type: 'user', value: [['看图']] }];
  const first = await collect(adapter.stream({ ...common, transcript }, { toolContext: context }));
  assert.equal(first.at(-1).value, '回答');
  assert.deepEqual(calls[0], { path: 'getSignedFileUrls', body: { urls: [{ url: attachment.fileUrl, permissionRecord: attachment.permissionRecord, download: false }] } });
  await collect(adapter.stream({ ...common, transcript: [...transcript, { type: 'agent-inference', value: '回答' }, { type: 'user', value: '继续' }] }, { toolContext: context }));
  assert.equal(calls.length, 1); assert.deepEqual(requests[1][0].content, [{ type: 'text', text: '看图' }, image]);
  assert.equal(requests[1].at(-1).content, '继续');
  const pure = await collect(adapter.stream({ spaceId: 'space', threadId: 'another', transcript: [{ ...attachment, permissionRecord: undefined }] }, { toolContext: { ...context, threadId: 'another' } }));
  assert.equal(pure.at(-1).value, '回答'); assert.deepEqual(requests[2][0].content, [image]);
  const bad = await collect(adapter.stream({ spaceId: 'space', threadId: 'third', transcript: [attachment] }, { toolContext: { ...context, threadId: 'third' } }));
  assert.equal(bad.at(-1).type, 'error'); assert.match(bad.at(-1).message, /当前聊天/); assert.equal(requests.length, 3);
});

test('native file references support image-only and TextToken[] messages with bounded validation', () => {
  assert.deepEqual(notionUserContent([file]), { text: [], files: [file] });
  const text = [['看图片', [['b']]]];
  assert.deepEqual(notionUserContent([{ type: 'text', text }, file]), { text, files: [file] });
  for (const content of [[], [file, { type: 'text', text: 'late' }], [{ type: 'file', file_id: '' }], [{ type: 'image', url: signed }],
    [{ type: 'text', text: ' ' }], Array(11).fill(file), [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]]) assert.throws(() => notionUserContent(content));
});

test('attachment reader scopes signing to the chat and downloads bytes without Notion cookies or headers', async () => {
  const calls = [];
  const reader = new NotionAttachments({ request: async (...args) => { calls.push(args); return { status: 200, data: { url: signed } }; },
    fetchImpl: async (url, init) => { assert.equal(url, signed); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'manual'); assert.equal(init.headers, undefined); return new Response(png); } });
  assert.deepEqual(await reader.read([file], { toolContext: context }), [image]);
  assert.deepEqual(calls[0].slice(0, 3), [context, 'getFileContentURLForAgentThread', { spaceId: 'space', threadId: 'thread', fileId: 'image-id', includeFileMetadata: true }]);
});

test('signed Notion redirects validate every hop and never follow foreign or loopback destinations', async () => {
  for (const location of [signed, 'https://evil.test/image', 'http://127.0.0.1/image']) {
    let calls = 0;
    const reader = new NotionAttachments({ request: async () => ({ status: 200, data: { url: 'https://www.notion.so/signed/image' } }),
      fetchImpl: async (_url, init) => { calls++; assert.equal(init.credentials, 'omit'); return calls === 1 ? new Response(null, { status: 302, headers: { location } }) : new Response(png); } });
    if (location === signed) { assert.deepEqual(await reader.read([file], { toolContext: context }), [image]); assert.equal(calls, 2); }
    else { await assert.rejects(reader.read([file], { toolContext: context }), /地址/); assert.equal(calls, 1); }
  }
});

test('unsupported files, failed signing, unsafe URLs and oversized downloads fail without forwarding secrets', async () => {
  for (const url of ['http://127.0.0.1/image', 'https://notion.so.evil.test/image', 'file:///local.png', 'https://user:secret@www.notion.so/x']) {
    const reader = new NotionAttachments({ request: async () => ({ status: 200, data: { url } }), fetchImpl: () => assert.fail('unsafe download') });
    await assert.rejects(reader.read([file], { toolContext: context }), /地址/);
  }
  const make = (result, download) => new NotionAttachments({ request: async () => result, fetchImpl: download });
  await assert.rejects(make({ status: 403, data: { secret: signed } }).read([file], { toolContext: context }), /无法读取/);
  await assert.rejects(make({ status: 200, data: {} }).read([file], { toolContext: context }), /无法读取/);
  for (const download of [() => new Response('PDF or HTML'), () => new Response('private error', { status: 403 }),
    () => new Response(png, { headers: { 'Content-Length': MAX_IMAGE_BYTES + 1 } }),
    () => new Response(new Uint8Array(MAX_IMAGE_BYTES + 1)), () => { throw Error(signed); }]) {
    await assert.rejects(make({ status: 200, data: { url: signed } }, download).read([file], { toolContext: context }), error => !error.message.includes('signature') && /图片|附件/.test(error.message));
  }
});

test('interrupt cancels signing and idle image streams and leaves a native idle transcript', async () => {
  for (const idleBody of [false, true]) {
    let entered; const started = new Promise(resolve => { entered = resolve; }); let canceled = false;
    const reader = new NotionAttachments({ request: async (_c, _p, _b, signal) => {
      if (idleBody) return { status: 200, data: { url: signed } };
      entered(); return new Promise((_, reject) => signal.addEventListener('abort', () => { canceled = true; reject(signal.reason); }, { once: true }));
    }, fetchImpl: async () => new Response(new ReadableStream({ start() { entered(); }, cancel() { canceled = true; } })) });
    const agent = new AgentMock({ readAttachments: (...args) => reader.read(...args), generateText: async function* () { assert.fail('canceled image must never reach model'); } });
    await agent.handle('/api/v3/createAgentThread', request, { toolContext: context }); await started;
    await agent.handle('/api/v3/sendEventToAgentThread', { spaceId: 'space', threadId: 'thread', clientEventId: 'stop', event: { type: 'user.interrupt' } });
    const session = agent.session('space', 'thread'); await session.task;
    assert.equal(canceled, true); assert.equal(session.status.status, 'idle'); assert.equal(session.history.length, 0);
    assert.equal([...session.entities.values()].at(-1).stop_reason, 'interrupted'); agent.close();
  }
});

test('router reads attachments independently of page tools, deduplicates retries and retains images on follow-up', async () => {
  const requests = []; let reads = 0;
  const router = new MockRouter({}, { toolsEnabled: false, provider: { async *stream({ messages, onHistory }) { requests.push(messages); yield '看到图片'; onHistory([...messages, { role: 'assistant', content: '看到图片' }]); } } });
  router.toolRequest = async (_ctx, path, body) => { reads++; assert.equal(path, 'getFileContentURLForAgentThread'); assert.equal(body.fileId, file.file_id); return { status: 200, data: { url: signed } }; };
  router.attachments.fetch = async () => new Response(png);
  for (let i = 0; i < 2; i++) await router.agent.handle('/api/v3/createAgentThread', request, { toolContext: context });
  const session = router.agent.session('space', 'thread'); await session.task;
  await router.agent.handle('/api/v3/sendEventToAgentThread', { spaceId: 'space', threadId: 'thread', clientEventId: 'two', event: { type: 'user.message', content: [{ type: 'text', text: '继续分析' }] } }, { toolContext: context });
  await session.task;
  assert.equal(reads, 1); assert.equal(requests.length, 2);
  assert.deepEqual(requests[1][0], { role: 'user', content: [image] });
  const native = [...session.entities.values()].find(e => e.kind === 'user_message');
  assert.deepEqual(native.text, []); assert.deepEqual(native.files, [file]);
  assert.equal(JSON.stringify(session.history).includes('signature'), false);
  assert.equal(JSON.stringify(router.agent.snapshot(session)).includes(image.data), false);
  router.agent.close();
});

test('a failed attachment never generates a text-only answer or pollutes the next turn', async () => {
  let calls = 0;
  const reader = new NotionAttachments({ request: async () => ({ status: 403 }) });
  const agent = new AgentMock({ readAttachments: (...args) => reader.read(...args), generateText: async function* () { calls++; yield 'answer'; } });
  await agent.handle('/api/v3/createAgentThread', request, { toolContext: context });
  const session = agent.session('space', 'thread'); await session.task;
  assert.equal(calls, 0); assert.equal(session.history.length, 0); assert.equal(session.status.status, 'idle');
  assert.equal([...session.entities.values()].at(-1).stop_reason, 'runtime_error');
  assert.ok([...session.entities.values()].some(e => e.kind === 'error' && /附件/.test(e.message)));
  agent.close();
});

test('all four image formats are sniffed; multimodal validation and image budgets remain separate from text limits', () => {
  for (const [bytes, type] of [[png, 'image/png'], [Buffer.from([255,216,255,224]), 'image/jpeg'], [Buffer.from('GIF89a'), 'image/gif'], [Buffer.from('RIFF1234WEBP'), 'image/webp']]) assert.equal(imageMediaType(bytes), type);
  const large = { ...image, data: Buffer.concat([png, Buffer.alloc(300000)]).toString('base64') };
  validateMessages([{ role: 'user', content: [large] }]); checkMessageBudget([{ role: 'user', content: [large] }]);
  assert.throws(() => checkMessageBudget([{ role: 'user', content: 'x'.repeat(250001) }]));
  assert.throws(() => checkMessageBudget([{ role: 'user', content: Array(11).fill(image) }]), /10 张/);
  for (const part of [{ ...image, mediaType: 'image/jpeg' }, { ...image, data: '!!!!' }, { type: 'file', file_id: 'x' }, { ...image, data: png.toString('base64') + '=' }]) assert.throws(() => validateMessages([{ role: 'user', content: [part] }]));
  assert.throws(() => validateMessages([{ role: 'system', content: [image] }]));
});
