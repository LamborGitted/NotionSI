import { randomUUID } from 'node:crypto';

export const DEFAULT_ANSWER = '这是 NotionSI 的本地固定回答。请求已被接管，生成现已完成。';

/**
 * Minimal classic runInferenceTranscript response, reconstructed from the
 * cached client. It deliberately emits no title, record map, or server write.
 *
 * Evidence: f_000149.js @277107 and f_000393.js @52028 construct
 * agent-inference steps with id/value/traceId/startedAt/finishedAt.
 * f_0000a8.js @68941 consumes patch-start/patch/patch-sync and regards a
 * normal EOF as complete. SW module330942.RM replaces agent-inference by id.
 * Live UI compatibility is validated separately from these local fixtures.
 */
export function createClassicFrames(request, options = {}) {
  return Array.from(classicFrames(request, options));
}

/** Stop quietly on cancellation; callers own their response stream cleanup. */
export async function* streamClassicFrames(request, options = {}) {
  const { signal, delayMs = 40 } = options;
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw protocolError('delayMs must be between 0 and 60000', 'INVALID_DELAY');
  }
  if (signal?.aborted) return;
  let first = true;
  for (const frame of classicFrames(request, options)) {
    if (signal?.aborted) return;
    if (!first && delayMs > 0 && !await wait(delayMs, signal)) return;
    if (signal?.aborted) return;
    first = false;
    yield frame;
  }
}

function* classicFrames(request, options) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw protocolError('runInferenceTranscript body must be a JSON object', 'INVALID_REQUEST');
  }
  const { answer = DEFAULT_ANSWER, chunkSize = 4, stepId = randomUUID() } = options;
  if (typeof answer !== 'string' || answer.length === 0) {
    throw protocolError('answer must be a non-empty string', 'INVALID_ANSWER');
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 4096) {
    throw protocolError('chunkSize must be an integer between 1 and 4096', 'INVALID_CHUNK_SIZE');
  }
  if (typeof stepId !== 'string' || stepId.length === 0) {
    throw protocolError('stepId must be a non-empty string', 'INVALID_STEP_ID');
  }
  const traceId = typeof request.traceId === 'string' && request.traceId.length > 0
    ? request.traceId : randomUUID();
  const startedAt = Date.now();
  const makeStep = (value, complete = false) => ({
    id: stepId,
    type: 'agent-inference',
    value,
    traceId,
    startedAt,
    ...(complete ? { finishedAt: Date.now() } : {}),
  });
  // Array.from keeps surrogate pairs intact across NDJSON messages.
  const codePoints = Array.from(answer);
  const asPatch = request.asPatchResponse === true;
  yield asPatch
    ? { type: 'patch-start', data: { s: [makeStep('')] } }
    : makeStep('');
  let accumulated = '';
  for (let i = 0; i < codePoints.length; i += chunkSize) {
    const text = codePoints.slice(i, i + chunkSize).join('');
    accumulated += text;
    yield asPatch
      ? { type: 'patch', v: [{ o: 'x', p: '/s/0/value', v: text }] }
      : makeStep(accumulated);
  }
  const finalStep = makeStep(answer, true);
  yield asPatch
    ? { type: 'patch-sync', data: { s: [finalStep] } }
    : finalStep;
}

function protocolError(message, code) {
  const error = new TypeError(message);
  error.name = 'MockProtocolError';
  error.code = code;
  return error;
}

function wait(ms, signal) {
  return new Promise(resolve => {
    const finish = completed => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
