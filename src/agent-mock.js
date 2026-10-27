import { ProviderError } from './providers/errors.js';
import { randomUUID } from 'node:crypto';
import { trimConversation } from './conversation.js';
import { notionUserContent } from './notion-attachments.js';
import { checkMessageBudget } from './multimodal.js';
import { notionText } from './notion-text.js';

const ENDPOINTS = new Set([
  'createAgentThread', 'createCalendarAgentThread', 'sendEventToAgentThread',
  'getThreadTranscript', 'listenToThreadTranscript',
]);

const json = (status, body) => ({ status, headers: { 'Content-Type': 'application/json' }, body });
const failure = (status, message) => json(status, {
  name: 'NotionSIMockError', message,
  clientData: { type: 'notionsi_mock_unsupported' },
});
const endpoint = path => path.split('?')[0].split('/').at(-1);

// Incoming user text is Notion TextToken[] in the native UI. module247438.x9d
// creates [[plainText]], while q4_ joins token[0]; annotations remain on token[1].
// Assistant content is a different format: 20347-47c... @13388 calls text.trim().
function delay(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Experimental in-memory Agent Service adapter for personal chat threads.
 * Fields follow cached modules 748524 / 177844 / 114427. No Notion writes occur.
 * Thread creation shape is reconstructed from inert shipped code, not a live fixture.
 */
export class AgentMock {
  constructor({ answer = '喵~ 这是 NotionSI 返回的固定回答。', chunkSize = 4, delayMs = 40, generateText, readAttachments, onError = () => {} } = {}) {
    if (typeof answer !== 'string' || !answer) throw new TypeError('answer must be non-empty');
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new TypeError('chunkSize must be positive');
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new TypeError('delayMs must be non-negative');
    this.answer = answer;
    this.chunkSize = chunkSize;
    this.delayMs = delayMs;
    if (generateText !== undefined && typeof generateText !== 'function') throw new TypeError('generateText must be a function');
    this.generateText = generateText;
    this.readAttachments = readAttachments;
    this.onError = onError;
    this.sessions = new Map();
    this.listenTokens = new Map();
    this.closed = false;
  }

  handles(pathname) {
    return /^\/api\/v3\//.test(pathname) && ENDPOINTS.has(endpoint(pathname));
  }

  async handle(pathname, request, { signal, toolContext } = {}) {
    if (!this.handles(pathname)) return failure(404, 'Not an Agent Service mock endpoint.');
    if (this.closed) return failure(503, 'The mock adapter has been closed.');
    const route = endpoint(pathname);
    if (route === 'createCalendarAgentThread') {
      return failure(501, 'Calendar Agent creation is outside this personal text mock.');
    }
    if (!request || typeof request.spaceId !== 'string' || !request.spaceId) {
      return failure(400, 'spaceId is required.');
    }
    if (route === 'listenToThreadTranscript' && request.listenToken !== undefined) {
      if (typeof request.listenToken !== 'string' || !request.listenToken || request.threadId !== undefined) {
        return failure(400, 'Provide exactly one threadId or non-empty listenToken.');
      }
      const key = JSON.stringify([request.spaceId, request.listenToken]);
      if (!this.listenTokens.has(key)) this.listenTokens.set(key, this.newSession(false));
      return {
        status: 200, headers: { 'Content-Type': 'application/x-ndjson' },
        frames: this.listen(this.listenTokens.get(key), signal),
      };
    }
    if (typeof request.threadId !== 'string' || !request.threadId) {
      return failure(400, 'threadId is required.');
    }
    if (route === 'createAgentThread') return this.create(request, toolContext);
    const session = this.session(request.spaceId, request.threadId);
    if(toolContext)session.toolContext=toolContext;
    if (route === 'getThreadTranscript') {
      return json(200, {
        patches: this.snapshot(session), session: { ...session.status }, session_pending: false,
        forward_cursor: String(session.version), backward_cursor: '0',
        has_more_forward: false, has_more_backward: false,
      });
    }
    if (route === 'listenToThreadTranscript') {
      return { status: 200, headers: { 'Content-Type': 'application/x-ndjson' }, frames: this.listen(session, signal) };
    }
    if (!request.clientEventId || typeof request.clientEventId !== 'string') {
      return failure(400, 'clientEventId is required.');
    }
    if (session.seen.has(request.clientEventId)) return json(200, {});
    if (request.events !== undefined || !request.event ||
        !['user.message', 'user.interrupt'].includes(request.event.type)) {
      return failure(501, 'This prototype supports one user.message or user.interrupt event per request.');
    }
    if (request.event.type === 'user.interrupt') {
      session.seen.add(request.clientEventId);
      session.abort?.abort();
      return json(200, {});
    }
    let content;
    try { content = notionUserContent(request.event.content); }
    catch (error) { return failure(400, error.message); }
    if (session.status.status === 'running') return failure(409, 'A mock turn is already running.');
    session.threadContext=structuredClone(request.threadContext);
    this.startTurn(session, content, request.clientEventId);
    return json(200, {});
  }

  create(request, toolContext) {
    if (request.type !== 'personal_agent') return failure(501, 'Only personal_agent creation is supported.');
    if (typeof request.clientMessageId !== 'string' || !request.clientMessageId) {
      return failure(400, 'clientMessageId is required.');
    }
    let content;
    try { content = notionUserContent(request.content); }
    catch (error) { return failure(400, error.message); }
    if (request.listenToken !== undefined && (typeof request.listenToken !== 'string' || !request.listenToken)) {
      return failure(400, 'listenToken must be a non-empty string.');
    }
    const key = JSON.stringify([request.spaceId, request.threadId]);
    const existing = this.sessions.get(key);
    if (existing?.threadRecord) {
      return existing.seen.has(request.clientMessageId)
        ? json(200, { thread: structuredClone(existing.threadRecord) })
        : failure(409, 'This mock thread was already created.');
    }
    const tokenKey = request.listenToken === undefined ? undefined
      : JSON.stringify([request.spaceId, request.listenToken]);
    const pending = tokenKey === undefined ? undefined : this.listenTokens.get(tokenKey);
    if (pending?.threadKey && pending.threadKey !== key) {
      return failure(409, 'This listenToken already belongs to another thread.');
    }
    const session = pending ?? existing ?? this.newSession(true);
    session.bound = true;
    if(toolContext)session.toolContext=toolContext;
    session.threadKey = key;
    this.sessions.set(key, session);
    if (tokenKey !== undefined) this.listenTokens.set(tokenKey, session);
    // Evidence: RecordModel-bd917cd10ea35e34.js @418760 fromValue(table, value)
    // wraps its second argument directly as {table, value}; response.thread is
    // therefore a RAW thread record, never {value, role}. Thread.create @285933
    // declares the structural keys below. Current UI 43815-65fd... @315000 reads
    // data.agent_provider.providerId/sessionId to select Agent Service transport.
    // role=editor is supplied by the cached createAgentThread client, not this JSON.
    const provider = { providerId: 'agent_service', sessionId: session.id };
    for (const field of ['model', 'modelSelection', 'reasoningEffort']) {
      if (request[field] !== undefined) provider[field] = request[field];
    }
    session.threadRecord = {
      id: request.threadId, version: 1, space_id: request.spaceId,
      parent_id: request.spaceId, parent_table: 'space', created_time: Date.now(),
      alive: true, type: request.type, messages: [], permissions: [],
      has_transcript_content: true,
      data: { agent_provider: provider, agent_service_browser_enabled: false },
      ...(request.createdSource === undefined ? {} : { created_source: request.createdSource }),
    };
    session.threadContext=structuredClone(request.threadContext);
    this.startTurn(session, content, request.clientMessageId);
    return json(200, { thread: structuredClone(session.threadRecord) });
  }

  startTurn(session, text, clientMessageId) {
    session.seen.add(clientMessageId);
    session.abort = new AbortController();
    // Creation/send response lifetime must not own the separate subscription.
    session.task = this.generate(session, text, clientMessageId, session.abort.signal);
  }

  newSession(bound) {
    return {
      id: randomUUID(), entities: new Map(), seen: new Set(), version: 0, sequence: 0, bound,
      status: { status: 'idle', sequence: 0, pending_input: null }, listeners: new Set(), history: [], toolState:{},
    };
  }

  session(spaceId, threadId) {
    const key = JSON.stringify([spaceId, threadId]);
    if (!this.sessions.has(key)) {
      this.sessions.set(key, this.newSession(true));
    }
    return this.sessions.get(key);
  }

  snapshot(session) {
    return [
      ...[...session.entities.values()].map(entity => ({ op: 'put', entity: structuredClone(entity) })),
      { op: 'session', session: { ...session.status } },
      { op: 'committed', sequence: session.sequence },
    ];
  }

  publish(session) {
    session.version += 1;
    for (const wake of session.listeners) wake();
  }

  async generate(session, { text, files }, clientMessageId, signal) {
    const createdAt = new Date().toISOString();
    const turnId = randomUUID();
    const common = kind => ({
      id: randomUUID(), kind, created_at: createdAt, source: 'committed',
      sequence: ++session.sequence, session_id: session.id,
    });
    const user = {
      ...common('user_message'), text: structuredClone(text), files: structuredClone(files), is_current_user: true,
      render_on_user_side: true, client_message_id: clientMessageId,
      ...(session.threadContext?{thread_context:structuredClone(session.threadContext)}:{}),
    };
    session.entities.set(user.id, user);
    const assistant = {
      ...common('assistant_message'), source: 'provisional', turn_id: turnId,
      content: [{ type: 'text', text: '' }],
    };
    session.entities.set(assistant.id, assistant);
    session.status = { status: 'running', sequence: session.sequence, pending_input: null };
    this.publish(session);
    const plainText = notionText(text);
    const toolEntities=new Map();let historyUpdated=false;
    const onToolEvent=event=>{
      if(event.type==='start') {
        const label=`Notion · ${event.name}`;
        const entity={...common('tool'),tool_use_id:event.id,name:event.name,turn_id:turnId,
          presentation_kind:'generic',started_at:new Date().toISOString(),
          // Generic tool cards consume TextToken[], unlike assistant content.
          // Live 43815 / module 890820 calls textValue.value.entries(), then
          // converts each token with uPN. Plain strings crash the whole page.
          text:{running:[[label]],finished:[[label]],errored:[[label]],canceled:[[label]]},
        };
        toolEntities.set(event.id,entity);session.entities.set(entity.id,entity);
      } else {
        const entity=toolEntities.get(event.id);
        if(entity){entity.result={is_error:event.isError===true,completed_at:new Date().toISOString()};if(event.canceled)entity.interaction_status='dismissed';}
      }
      this.publish(session);
    };
    let failure;
    try {
      let content = plainText;
      if (files.length) {
        if (!this.readAttachments) throw new ProviderError('当前会话未配置图片附件读取。');
        const images = await this.readAttachments(files, { toolContext: session.toolContext, signal });
        signal.throwIfAborted();
        if (!Array.isArray(images) || images.length !== files.length) throw new ProviderError('图片附件读取不完整，请重新上传。');
        content = [...(plainText ? [{ type: 'text', text: plainText }] : []), ...images];
      }
      const history = trimConversation([...session.history, { role: 'user', content }]);
      checkMessageBudget(history);
      session.history = history;
      const chunks = this.generateText
        ? this.generateText({ messages: structuredClone(session.history), signal,toolContext:session.toolContext,threadContext:session.threadContext,toolState:session.toolState,onToolEvent,
          onHistory:history=>{session.history=trimConversation(history);historyUpdated=true;} })
        : this.fixedText(signal);
      for await (const chunk of chunks) {
        if (signal.aborted) break;
        if (typeof chunk !== 'string') throw new TypeError('Invalid provider chunk');
        assistant.content[0].text += chunk;
        this.publish(session);
      }
      if (!signal.aborted && !assistant.content[0].text.trim()) throw new Error('Empty provider answer');
    } catch (error) {
      if (!signal.aborted) {
        failure = error instanceof ProviderError ? error.message : '模型生成失败，请检查本地工具配置。';
        try { this.onError(failure); } catch {}
        const entity = { ...common('error'), message: failure, error_type: 'provider_error', retry_status: 'not_retryable' };
        session.entities.set(entity.id, entity);
      }
    }
    assistant.source = 'committed';
    if (!assistant.content[0].text.trim()) session.entities.delete(assistant.id);
    if (!failure && !signal.aborted && !historyUpdated) session.history.push({ role: 'assistant', content: assistant.content[0].text });
    for(const entity of toolEntities.values())if(!entity.result){entity.interaction_status='dismissed';entity.result={is_error:!!failure,completed_at:new Date().toISOString()};}
    const completed = {
      // Native eventList treats end_turn as normal completion; the tempting
      // value "completed" renders a client_update_required warning.
      // Evidence: 43815-65fdbe53c1742320.js eventList stopReason switch.
      ...common('turn_completed'), stop_reason: signal.aborted ? 'interrupted' : failure ? 'runtime_error' : 'end_turn',
    };
    session.entities.set(completed.id, completed);
    session.status = { status: 'idle', sequence: session.sequence, pending_input: null };
    if (session.abort?.signal === signal) session.abort = undefined;
    this.publish(session);
  }

  async *fixedText(signal) {
    const chars = Array.from(this.answer);
    for (let at = 0; at < chars.length && !signal.aborted; at += this.chunkSize) {
      if (this.delayMs) await delay(this.delayMs, signal);
      if (!signal.aborted) yield chars.slice(at, at + this.chunkSize).join('');
    }
  }

  async *listen(session, signal) {
    let version = -1;
    try {
      while (!this.closed && !signal?.aborted) {
        if (version !== session.version) {
          version = session.version;
          // A listenToken can open before create. Do not invent a session before
          // it is bound, but flush a keepalive so the fetch stream is established.
          yield session.bound
            ? { type: 'transcript_delta', patches: this.snapshot(session), cursor: String(version) }
            : { type: 'keepalive' };
          continue;
        }
        await new Promise(resolve => {
          const wake = () => {
            clearTimeout(timer);
            session.listeners.delete(wake);
            signal?.removeEventListener('abort', wake);
            resolve();
          };
          const timer = setTimeout(wake, 15000);
          session.listeners.add(wake);
          signal?.addEventListener('abort', wake, { once: true });
          if (signal?.aborted || this.closed) wake();
        });
        if (version === session.version && !signal?.aborted && !this.closed) yield { type: 'keepalive' };
      }
    } finally {
      // All per-wait listeners are removed by wake before returning here.
    }
  }

  close() {
    this.closed = true;
    for (const session of new Set([...this.sessions.values(), ...this.listenTokens.values()])) {
      session.abort?.abort();
      for (const wake of [...session.listeners]) wake();
    }
  }
}
