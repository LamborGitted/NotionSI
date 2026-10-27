import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentMock } from '../src/agent-mock.mjs';

const api = event => `/api/v3/${event}`;
const request = { spaceId: 'space', threadId: 'thread' };
const send = (id, text = 'hello') => ({
  ...request, clientEventId: id, event: { type: 'user.message', content: [{ type: 'text', text }] },
});

async function waitForIdle(mock) {
  for (let i = 0; i < 200; i++) {
    const response = await mock.handle(api('getThreadTranscript'), request);
    if (response.body.session.status === 'idle') return response;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Agent did not finish its turn.');
}

test('unsupported creation modes and operations fail closed with explicit errors', async () => {
  const mock = new AgentMock();
  assert.equal(mock.handles(api('createAgentThread')), true);
  assert.equal(mock.handles('/other/createAgentThread'), false);
  assert.equal((await mock.handle(api('createAgentThread'), { ...request, type: 'custom_agent' })).status, 501);
  assert.equal((await mock.handle(api('createCalendarAgentThread'), request)).status, 501);
  assert.equal((await mock.handle(api('listenToThreadTranscript'), { spaceId: 's', listenToken: '' })).status, 400);
  assert.equal((await mock.handle(api('sendEventToAgentThread'), {
    ...request, clientEventId: 'x', event: { type: 'user.tool_confirmation' },
  })).status, 501);
  mock.close();
});

test('personal create returns a raw thread record and binds a subscription opened by listenToken', async () => {
  const mock = new AgentMock({ answer: '本地回答🐱', chunkSize: 1, delayMs: 1 });
  const controller = new AbortController();
  const { frames } = await mock.handle(api('listenToThreadTranscript'), {
    spaceId: 'space', listenToken: 'before-create',
  }, { signal: controller.signal });
  assert.deepEqual((await frames.next()).value, { type: 'keepalive' });
  const created = await mock.handle(api('createAgentThread'), {
    ...request, type: 'personal_agent', clientMessageId: 'first', listenToken: 'before-create',
    content: [{ type: 'text', text: 'hello' }],
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.thread.id, request.threadId);
  assert.equal(created.body.thread.value, undefined);
  assert.equal(created.body.thread.data.agent_provider.providerId, 'agent_service');
  let final;
  for (let i = 0; i < 20; i++) {
    const { value } = await frames.next();
    final = value.patches;
    if (final.find(p => p.op === 'session').session.status === 'idle') break;
  }
  assert.equal(final.find(p => p.entity?.kind === 'assistant_message').entity.content[0].text, '本地回答🐱');
  assert.equal(final.find(p => p.entity?.kind === 'turn_completed').entity.stop_reason, 'end_turn');
  controller.abort();
  await frames.return();
  mock.close();
});

test('create retries are idempotent and a token cannot bind a second thread', async () => {
  const mock = new AgentMock({ answer: 'fixed', delayMs: 0 });
  const create = {
    ...request, type: 'personal_agent', clientMessageId: 'first', listenToken: 'single-use',
    content: [{ type: 'text', text: 'hello' }],
  };
  const first = await mock.handle(api('createAgentThread'), create);
  const again = await mock.handle(api('createAgentThread'), create);
  assert.deepEqual(first, again);
  assert.equal((await mock.handle(api('createAgentThread'), { ...create, threadId: 'other' })).status, 409);
  const { body } = await mock.handle(api('getThreadTranscript'), request);
  assert.equal(body.patches.filter(p => p.entity?.kind === 'assistant_message').length, 1);
  mock.close();
});

test('native TextToken[] input retains formatting while assistant text stays a string', async () => {
  const mock = new AgentMock({ answer: '固定回答', delayMs: 0 });
  const richText = [['格式', [['b']]], ['文本']];
  const response = await mock.handle(api('createAgentThread'), {
    ...request, type: 'personal_agent', clientMessageId: 'rich',
    content: [{ type: 'text', text: richText }],
  });
  assert.equal(response.status, 200);
  await waitForIdle(mock);
  const { body } = await mock.handle(api('getThreadTranscript'), request);
  const user = body.patches.find(p => p.entity?.kind === 'user_message').entity;
  const assistant = body.patches.find(p => p.entity?.kind === 'assistant_message').entity;
  assert.deepEqual(user.text, richText);
  assert.notEqual(user.text, richText);
  assert.equal(assistant.content[0].text, '固定回答');
  const next = await mock.handle(api('sendEventToAgentThread'), {
    ...request, clientEventId: 'next-rich',
    event: { type: 'user.message', content: [{ type: 'text', text: [['第二轮']] }] },
  });
  assert.equal(next.status, 200);
  mock.close();
});

test('subscription observes provisional text then a committed idle terminal snapshot', async () => {
  const mock = new AgentMock({ answer: '你好🐱', chunkSize: 1, delayMs: 2 });
  const controller = new AbortController();
  const stream = await mock.handle(api('listenToThreadTranscript'), request, { signal: controller.signal });
  assert.equal(stream.headers['Content-Type'], 'application/x-ndjson');
  const frames = stream.frames[Symbol.asyncIterator]();
  await frames.next();
  assert.equal((await mock.handle(api('sendEventToAgentThread'), send('one'))).status, 200);
  let sawRunning = false;
  let snapshot;
  for (let i = 0; i < 10; i++) {
    const { value } = await frames.next();
    snapshot = value.patches;
    const state = snapshot.find(p => p.op === 'session').session;
    sawRunning ||= state.status === 'running';
    if (state.status === 'idle') break;
  }
  assert.equal(sawRunning, true);
  const entities = snapshot.filter(p => p.op === 'put').map(p => p.entity);
  assert.equal(entities.find(e => e.kind === 'assistant_message').content[0].text, '你好🐱');
  assert.equal(entities.find(e => e.kind === 'assistant_message').source, 'committed');
  assert.equal(entities.find(e => e.kind === 'turn_completed').stop_reason, 'end_turn');
  controller.abort();
  await frames.return();
  mock.close();
});

test('client event deduplication does not generate a second turn', async () => {
  const mock = new AgentMock({ answer: 'fixed', delayMs: 0 });
  await mock.handle(api('sendEventToAgentThread'), send('same'));
  await waitForIdle(mock);
  await mock.handle(api('sendEventToAgentThread'), send('same'));
  const response = await mock.handle(api('getThreadTranscript'), request);
  assert.equal(response.body.patches.filter(p => p.entity?.kind === 'assistant_message').length, 1);
  assert.equal(response.body.session.status, 'idle');
  mock.close();
});

test('interrupt cancels pending chunks and still emits an idle terminal state', async () => {
  const mock = new AgentMock({ answer: 'never fully generated', delayMs: 100 });
  await mock.handle(api('sendEventToAgentThread'), send('one'));
  await mock.handle(api('sendEventToAgentThread'), {
    ...request, clientEventId: 'stop', event: { type: 'user.interrupt' },
  });
  await waitForIdle(mock);
  await mock.session('space', 'thread').task;
  const { body } = await mock.handle(api('getThreadTranscript'), request);
  assert.equal(body.session.status, 'idle');
  assert.equal(body.patches.find(p => p.entity?.kind === 'turn_completed').entity.stop_reason, 'interrupted');
  assert.equal(body.patches.some(p => p.entity?.kind === 'assistant_message'), false);
  mock.close();
});

test('abort releases subscription listeners and independent threads stay isolated', async () => {
  const mock = new AgentMock({ answer: 'fixed', delayMs: 0 });
  const controller = new AbortController();
  const { frames } = await mock.handle(api('listenToThreadTranscript'), request, { signal: controller.signal });
  await frames.next();
  const pending = frames.next();
  controller.abort();
  assert.equal((await pending).done, true);
  assert.equal(mock.session('space', 'thread').listeners.size, 0);
  await mock.handle(api('sendEventToAgentThread'), send('one'));
  const { body } = await mock.handle(api('getThreadTranscript'), { ...request, threadId: 'other' });
  assert.equal(body.patches.filter(p => p.op === 'put').length, 0);
  mock.close();
});
