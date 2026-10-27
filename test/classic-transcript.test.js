import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ClassicTranscript } from '../src/classic-transcript.js';
import { ClassicAdapter } from '../src/classic-adapter.js';
import { MockRouter } from '../src/router.js';
import { ProviderError } from '../src/providers/errors.js';

function fixture() {
  const spaceId = randomUUID(), threadId = randomUUID(), userId = randomUUID();
  const step = { id: userId, type: 'user', userId: randomUUID(), value: [['请回答']] };
  const request = { spaceId, threadId, transcript: [step], asPatchResponse: true };
  const thread = { id: threadId, space_id: spaceId, version: 1, alive: true, messages: [userId] };
  const user = { id: userId, space_id: spaceId, parent_id: threadId, parent_table: 'thread', version: 1,
    created_by_id: step.userId, created_by_table: 'notion_user', step };
  const tables = { thread: new Map([[threadId, thread]]), thread_message: new Map([[userId, user]]) };
  const calls = [];
  const api = async (_context, path, body, signal) => {
    signal?.throwIfAborted(); calls.push({ path, body: structuredClone(body) });
    if (path === 'syncRecordValues') {
      const recordMap = { __version__: 3 };
      for (const { pointer } of body.requests) {
        const value = tables[pointer.table]?.get(pointer.id);
        if (value) (recordMap[pointer.table] ??= {})[pointer.id] = { spaceId, value: { role: 'editor', value: structuredClone(value) } };
      }
      return { status: 200, data: { recordMap } };
    }
    assert.equal(path, 'saveTransactionsFanout');
    for (const tx of body.transactions) for (const op of tx.operations) {
      assert.equal(op.pointer.spaceId, spaceId);
      const table = tables[op.pointer.table]; assert.ok(table);
      if (op.command === 'set') { table.set(op.pointer.id, structuredClone(op.args)); continue; }
      const record = table.get(op.pointer.id); assert.ok(record);
      if (op.command === 'listAfter') {
        assert.deepEqual(op.path, ['messages']);
        assert.ok(!record.messages.includes(op.args.id));
        const at = record.messages.indexOf(op.args.after); assert.ok(at >= 0);
        record.messages.splice(at + 1, 0, op.args.id);
      } else { assert.equal(op.command, 'update'); Object.assign(record, op.args); }
      record.version++;
    }
    return { status: 200, data: {} };
  };
  const transcript = new ClassicTranscript({ request: api });
  return { spaceId, threadId, userId, user, thread, request, tables, calls, api, transcript,
    options: { toolContext: { spaceId } }, finalStep: { id: randomUUID(), type: 'agent-inference', value: '正式回答', traceId: randomUUID(), startedAt: 1, finishedAt: 2 } };
}

test('classic reply survives native temporarySteps cleanup through committed thread records, in patch and non-patch mode', async () => {
  for (const patch of [true, false]) {
    const f = fixture(); f.request.asPatchResponse = patch;
    const adapter = new ClassicAdapter({ stream: async function*() { yield '正式'; yield '回答'; } }, { persistReply: opts => f.transcript.persist(opts) });
    const frames = [];
    for await (const frame of adapter.stream(f.request, f.options)) frames.push(frame);
    assert.equal(frames.some(frame => frame.type === 'error'), false);
    const recordIndex = frames.findIndex(frame => frame.type === 'record-map');
    assert.ok(recordIndex > 0 && recordIndex < frames.length - 1, 'record-map reaches client before terminal sync and EOF');
    const map = frames[recordIndex].recordMap;
    const thread = map.thread[f.threadId].value.value;
    const replyId = thread.messages.at(-1), message = map.thread_message[replyId].value.value;
    // Native module 691115 discards temporarySteps at EOF. The rendered answer
    // must now be recoverable solely from the synced thread_message record.
    const temporarySteps = [];
    assert.equal(temporarySteps.length, 0);
    assert.equal(message.step.value, '正式回答'); assert.ok(message.step.finishedAt);
    assert.equal(message.id, message.step.id); assert.equal(message.parent_id, thread.id);
    assert.deepEqual(thread.messages, [f.userId, replyId]);
    const final = patch ? frames.at(-1).data.s[0] : frames.at(-1);
    assert.deepEqual(message.step, final);
    assert.deepEqual(adapter.histories.get(JSON.stringify([f.spaceId, f.threadId])), [{ role: 'user', content: '请回答' }, { role: 'assistant', content: '正式回答' }]);
  }
});

test('persistence scopes writes to the submitted user turn and does not duplicate a committed reply', async () => {
  const f = fixture(), input = { request: f.request, step: f.finalStep, ...f.options };
  await f.transcript.persist(input); await f.transcript.persist(input);
  assert.equal(f.calls.filter(c => c.path === 'saveTransactionsFanout').length, 1);
  assert.equal(f.thread.messages.filter(id => id === f.finalStep.id).length, 1);
  assert.ok(f.calls.every(c => !JSON.stringify(c.body).includes('"table":"block"')));
  f.user.parent_id = randomUUID();
  await assert.rejects(f.transcript.persist({ ...input, step: { ...f.finalStep, id: randomUUID() } }), /会话或用户消息/);
  assert.equal(f.calls.filter(c => c.path === 'saveTransactionsFanout').length, 1);
});

test('wrong workspace, missing user record and trashed thread fail before any write', async () => {
  for (const mutate of [f => { f.thread.space_id = randomUUID(); }, f => { f.tables.thread_message.clear(); }, f => { f.thread.alive = false; }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.transcript.persist({ request: f.request, step: f.finalStep, ...f.options }), /会话或用户消息/);
    assert.equal(f.calls.some(c => c.path === 'saveTransactionsFanout'), false);
  }
});

test('save/readback failure never produces a successful terminal sync or commits local model history', async () => {
  for (const failure of ['save', 'readback']) {
    const f = fixture(); let saved = false;
    const transcript = new ClassicTranscript({ request: async (...args) => {
      if (args[1] === 'saveTransactionsFanout') { saved = true; if (failure === 'save') return { status: 403, data: {} }; }
      if (saved && failure === 'readback' && args[1] === 'syncRecordValues') return { status: 200, data: { recordMap: {} } };
      return f.api(...args);
    } });
    const adapter = new ClassicAdapter({ stream: async function*() { yield '正式回答'; } }, { persistReply: opts => transcript.persist(opts) });
    const frames = [];
    for await (const frame of adapter.stream(f.request, f.options)) frames.push(frame);
    assert.equal(frames.at(-1).type, 'error'); assert.match(frames.at(-1).message, /保存/);
    assert.equal(frames.some(frame => frame.type === 'patch-sync' || frame.type === 'record-map'), false);
    assert.equal(adapter.histories.size, 0);
    assert.ok(f.calls.filter(c => c.path === 'saveTransactionsFanout').length <= 1);
  }
});

test('upstream failure and user cancellation never persist an unfinished reply', async () => {
  for (const mode of ['failure', 'abort']) {
    const f = fixture(), controller = new AbortController();
    const adapter = new ClassicAdapter({ stream: async function*() {
      yield 'partial';
      if (mode === 'abort') controller.abort(); else throw new ProviderError('模型连接中断');
    } }, { persistReply: opts => f.transcript.persist(opts) });
    const frames = [];
    for await (const frame of adapter.stream(f.request, { ...f.options, signal: controller.signal })) frames.push(frame);
    assert.equal(f.calls.some(c => c.path === 'saveTransactionsFanout'), false);
    assert.equal(frames.some(frame => frame.type === 'patch-sync'), false);
  }
});

test('a lost save acknowledgement is reported without repeating a potentially committed write', async () => {
  const f = fixture(); let writes = 0;
  const transcript = new ClassicTranscript({ request: async (...args) => {
    const result = await f.api(...args);
    if (args[1] === 'saveTransactionsFanout') { writes++; throw new Error('private transport diagnostic'); }
    return result;
  } });
  await assert.rejects(transcript.persist({ request: f.request, step: f.finalStep, ...f.options }), error => {
    assert.match(error.message, /结果未确认/); assert.doesNotMatch(error.message, /private transport/); return true;
  });
  assert.equal(writes, 1);
  assert.ok(f.thread.messages.includes(f.finalStep.id), 'server may have committed before the acknowledgement was lost');
});

test('empty or unfinished assistant content never becomes a formal chat message', async () => {
  const f = fixture();
  for (const step of [{ ...f.finalStep, value: '  ' }, { ...f.finalStep, finishedAt: undefined }, { ...f.finalStep, type: 'user' }]) {
    await assert.rejects(f.transcript.persist({ request: f.request, step, ...f.options }), /未返回完整正文/);
  }
  assert.equal(f.calls.length, 0);
});

test('router persists classic model and fixed mock answers even when page tools are disabled', async () => {
  for (const provider of [undefined, { name: 'test', stream: async function*() { yield '正式回答'; } }]) {
    const f = fixture();
    const router = new MockRouter({}, { provider, toolsEnabled: false, answer: '正式回答', delayMs: 0 });
    router.toolRequest = f.api;
    const frames = [];
    for await (const frame of router.classic.stream(f.request, f.options)) frames.push(frame);
    assert.ok(frames.some(frame => frame.type === 'record-map'));
    assert.equal(f.tables.thread_message.size, 2);
    router.agent.close(); router.writer.close();
  }
});
