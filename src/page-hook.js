// This function is serialized into the page's main world. Keep it self-contained.
export function installPageHook(config) {
  if (!config.origins.includes(location.origin)) return { installed: false };
  const previous = globalThis.__notionMockRouter;
  if (previous?.binding === config.binding) return previous.snapshot();
  previous?.uninstall?.();
  const nativeFetch = globalThis.fetch;
  const requests = new Map();
  const toolRequests = new Map();
  const toolPaths = new Set(['search','syncRecordValues','saveTransactionsFanout','queryCollection','getFileContentURLForAgentThread','getSignedFileUrls']);
  const counters = { intercepted: 0, completed: 0, aborted: 0, failed: 0 };
  let sequence = 0;
  let enabled = true;
  const state = {
    version: 1, binding: config.binding, last: null,
    snapshot() { return { installed: enabled, version: 1, ...counters, active: requests.size, last: state.last }; },
    async toolRequest({ id, path, body }) {
      if (!enabled || !toolPaths.has(path) || typeof id !== 'string' || toolRequests.has(id)) throw new Error('Invalid tool request.');
      const controller = new AbortController(); toolRequests.set(id, controller);
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await nativeFetch.call(globalThis, `/api/v3/${path}`, {
          method:'POST', credentials:'same-origin', redirect:'error', signal:controller.signal,
          headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
        });
        const reader=response.body.getReader();const decoder=new TextDecoder();let text='',bytes=0;
        try { for(;;) { const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;
          if(bytes>2097152)throw new Error('Tool response too large.');text+=decoder.decode(chunk.value,{stream:true}); }
        } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
        return {status:response.status,data:JSON.parse(text+decoder.decode())};
      } finally {clearTimeout(timeout);toolRequests.delete(id);}
    },
    cancelToolRequest(id) { toolRequests.get(id)?.abort(); },
    receive(event) {
      const request = requests.get(event.id);
      if (!request) return;
      if (event.type === 'headers') {
        request.respond(new Response(request.stream, { status: event.status, headers: event.headers }));
      } else if (event.type === 'data') {
        request.controller.enqueue(new TextEncoder().encode(event.data));
      } else if (event.type === 'end') {
        request.controller.close();
        counters.completed++;
        state.last = { endpoint: request.endpoint, outcome: 'completed' };
        request.cleanup();
      } else if (event.type === 'error') {
        const error = new TypeError(event.message || 'Local mock failed.');
        request.controller.error(error); request.reject(error);
        counters.failed++;
        state.last = { endpoint: request.endpoint, outcome: 'failed' };
        request.cleanup();
      }
    },
    uninstall() {
      enabled = false;
      if (globalThis.fetch === hookedFetch) globalThis.fetch = nativeFetch;
      for (const request of [...requests.values()]) request.abort();
      for (const request of toolRequests.values()) request.abort();
      if (globalThis.__notionMockRouter === state) delete globalThis.__notionMockRouter;
    }
  };
  function send(event) { globalThis[config.binding](JSON.stringify(event)); }
  async function hookedFetch(input, init) {
    let url;
    try { url = new URL(input instanceof Request ? input.url : String(input), location.href); }
    catch { return nativeFetch.call(this, input, init); }
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (!enabled || url.origin !== location.origin || method !== 'POST' || !config.paths.includes(url.pathname)) {
      return nativeFetch.call(this, input, init);
    }
    const request = new Request(input, init);
    if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const text = await request.clone().text();
    if (new TextEncoder().encode(text).length > 1024 * 1024) throw new Error('Mock request exceeds 1 MiB.');
    const body = JSON.parse(text || '{}');
    // Only local writer undo tokens belong to this router. Ordinary Notion
    // Agent undo remains on the native path; runWriter itself never falls back.
    if(url.pathname==='/api/v3/undoAgentServiceTurn'&&
        !(typeof body.sessionIdleEventId==='string'&&body.sessionIdleEventId.startsWith('notionsi_writer_'))) {
      return nativeFetch.call(this,input,init);
    }
    const id = `${Date.now()}-${++sequence}`;
    return new Promise((respond, reject) => {
      let controller;
      const stream = new ReadableStream({ start(value) { controller = value; }, cancel() { entry.abort(); } });
      const cleanup = () => { requests.delete(id); request.signal.removeEventListener('abort', abort); };
      const abort = () => {
        if (!requests.has(id)) return;
        const error = new DOMException('Aborted', 'AbortError');
        try { controller.error(error); } catch {}
        reject(error); counters.aborted++;
        state.last = { endpoint: url.pathname, outcome: 'aborted' };
        cleanup();
        try { send({ type: 'abort', id }); } catch {}
      };
      const entry = { endpoint: url.pathname, respond, reject, stream, controller, cleanup, abort };
      requests.set(id, entry);
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) return abort();
      counters.intercepted++;
      state.last = { endpoint: url.pathname, outcome: 'streaming' };
      try { send({ type: 'request', id, path: url.pathname, body }); }
      catch (error) { controller.error(error); reject(error); cleanup(); }
    });
  }
  globalThis.__notionMockRouter = state;
  globalThis.fetch = hookedFetch;
  return state.snapshot();
}

export function pageHookSource(config) {
  return `(${installPageHook.toString()})(${JSON.stringify(config)})`;
}
