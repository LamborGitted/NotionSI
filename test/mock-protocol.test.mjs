import test from 'node:test';
import assert from 'node:assert/strict';
import { createClassicFrames, streamClassicFrames } from '../src/mock-protocol.mjs';

const request = { threadId: 'test-thread', traceId: 'test-trace' };

test('patch frames reconstruct the final answer and preserve the step identity', () => {
  const answer = '你好，世界🐱\n第二行。';
  const frames = createClassicFrames({ ...request, asPatchResponse: true, patchResponseVersion: 2 }, {
    answer, stepId: 'fixed-step', chunkSize: 2,
  });
  const state = structuredClone(frames[0].data);
  assert.equal(frames[0].type, 'patch-start');
  for (const frame of frames.slice(1, -1)) {
    assert.equal(frame.type, 'patch');
    assert.equal(frame.v.length, 1);
    const op = frame.v[0];
    assert.deepEqual({ o: op.o, p: op.p }, { o: 'x', p: '/s/0/value' });
    state.s[0].value += op.v;
  }
  const final = frames.at(-1);
  assert.equal(final.type, 'patch-sync');
  assert.equal(state.s[0].value, answer);
  assert.equal(final.data.s[0].value, answer);
  assert.equal(final.data.s[0].id, 'fixed-step');
  assert.equal(final.data.s[0].traceId, request.traceId);
  assert.equal(final.data.s[0].startedAt, frames[0].data.s[0].startedAt);
  assert.ok(final.data.s[0].finishedAt >= final.data.s[0].startedAt);
  assert.ok(!Object.hasOwn(frames[0].data.s[0], 'finishedAt'));
});

test('legacy patch mode without a version still ends in a full sync snapshot', () => {
  const frames = createClassicFrames({ ...request, asPatchResponse: true }, { answer: '完成' });
  assert.equal(frames[0].type, 'patch-start');
  assert.equal(frames.at(-1).type, 'patch-sync');
  assert.equal(frames.at(-1).data.s[0].value, '完成');
});

test('non-patch mode sends cumulative replacements by one stable id', () => {
  const frames = createClassicFrames(request, { answer: '甲😀乙', chunkSize: 1 });
  const ids = new Set(frames.map(frame => frame.id));
  assert.equal(ids.size, 1);
  assert.deepEqual(frames.map(frame => frame.value), ['', '甲', '甲😀', '甲😀乙', '甲😀乙']);
  assert.ok(frames.every(frame => frame.type === 'agent-inference'));
  assert.ok(frames.at(-1).finishedAt >= frames.at(-1).startedAt);
  assert.ok(frames.slice(0, -1).every(frame => !Object.hasOwn(frame, 'finishedAt')));
});

test('Unicode chunks and encoded NDJSON remain valid', async () => {
  const chunks = [];
  for await (const frame of streamClassicFrames({ ...request, asPatchResponse: true }, {
    answer: '🐱你好\n"引号"\\路径', chunkSize: 1, delayMs: 0,
  })) {
    const line = `${JSON.stringify(frame)}\n`;
    assert.equal(line.split('\n').length, 2);
    const roundTrip = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(line)));
    if (roundTrip.type === 'patch') chunks.push(roundTrip.v[0].v);
  }
  assert.equal(chunks[0], '🐱');
  assert.equal(chunks.join(''), '🐱你好\n"引号"\\路径');
});

test('aborting during a scheduled chunk finishes promptly without a final snapshot', async () => {
  const controller = new AbortController();
  const stream = streamClassicFrames({ ...request, asPatchResponse: true }, {
    answer: 'long answer', chunkSize: 1, delayMs: 10_000, signal: controller.signal,
  });
  assert.equal((await stream.next()).value.type, 'patch-start');
  const next = stream.next();
  controller.abort();
  assert.deepEqual(await next, { done: true, value: undefined });
});

test('an already aborted request emits nothing', async () => {
  const frames = [];
  for await (const frame of streamClassicFrames(request, { signal: AbortSignal.abort() })) frames.push(frame);
  assert.deepEqual(frames, []);
});

test('invalid input is a local protocol error, never a fabricated successful transcript', async () => {
  const check = (fn, code) => assert.throws(fn, { name: 'MockProtocolError', code });
  check(() => createClassicFrames(null), 'INVALID_REQUEST');
  check(() => createClassicFrames([]), 'INVALID_REQUEST');
  check(() => createClassicFrames(request, { answer: '' }), 'INVALID_ANSWER');
  check(() => createClassicFrames(request, { chunkSize: 0 }), 'INVALID_CHUNK_SIZE');
  check(() => createClassicFrames(request, { stepId: '' }), 'INVALID_STEP_ID');
  await assert.rejects(streamClassicFrames(request, { delayMs: -1 }).next(), {
    name: 'MockProtocolError', code: 'INVALID_DELAY',
  });
});
