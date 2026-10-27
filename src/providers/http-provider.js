import { randomUUID } from 'node:crypto';
import { ProviderError } from './errors.js';
import { endpointBase, executeCall, httpFailure, validateMessages } from './http-common.js';
import { protocols } from './wire-protocols.js';
import { checkMessageBudget } from '../multimodal.js';

export class HttpProvider {
  #apiKey; #fetch; #systemPrompt; #credentials;
  constructor({ name, protocol, baseUrl, model, apiKey, keyOptional = false, maxTokens = 4096, timeoutMs = 180000,
    reasoningEffort, thinkingBudget, systemPrompt = '', credentials, subscription = false, fetchImpl = fetch }) {
    if (!Object.hasOwn(protocols, protocol)) throw new Error('Unknown model wire protocol.');
    if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:+\-]{0,199}$/.test(model)) throw new Error(`Invalid ${name} model; configure its MODEL setting.`);
    if (!credentials && ((!keyOptional && !apiKey?.trim()) || (apiKey !== undefined && (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey))))) throw new Error(`请先配置 ${name} API_KEY。`);
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 131072) throw new Error('MAX_TOKENS must be 1..131072.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) throw new Error('TIMEOUT_MS must be 1000..900000.');
    if (reasoningEffort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) throw new Error('Invalid REASONING_EFFORT.');
    if (thinkingBudget !== undefined && (!['anthropic', 'gemini'].includes(protocol) || !Number.isSafeInteger(thinkingBudget) || thinkingBudget < 0 || thinkingBudget >= maxTokens ||
        protocol === 'anthropic' && thinkingBudget < 1024)) throw new Error('Invalid THINKING_BUDGET; it must fit below MAX_TOKENS.');
    if (thinkingBudget !== undefined && reasoningEffort !== undefined) throw new Error('Select reasoning effort or a thinking budget, not both.');
    if (typeof systemPrompt !== 'string' || Buffer.byteLength(systemPrompt) > 65536 || systemPrompt.includes('\0')) throw new Error('Invalid system prompt.');
    this.name = name; this.protocol = protocol; this.baseUrl = endpointBase(baseUrl); this.model = model;
    this.maxTokens = maxTokens; this.timeoutMs = timeoutMs; this.reasoningEffort = reasoningEffort; this.thinkingBudget = thinkingBudget; this.subscription = subscription;
    this.#apiKey = apiKey?.trim(); this.#fetch = fetchImpl; this.#systemPrompt = systemPrompt; this.#credentials = credentials;
  }
  async *stream({ messages, signal, tools, onToolEvent, onHistory } = {}) {
    validateMessages(messages); messages = structuredClone(messages);
    const preamble = [this.#systemPrompt, tools?.instructions].filter(Boolean).join('\n\n');
    const timeout = AbortSignal.timeout(this.timeoutMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const sessionId = randomUUID(); let totalCalls = 0;
    try {
      for (let round = 0; round < 8; round++) {
        combined.throwIfAborted();
        const wire = preamble ? [{ role: 'system', content: preamble }, ...messages] : messages;
        checkMessageBudget(wire);
        const request = protocols[this.protocol].request(this, wire, tools);
        let auth = this.#credentials ? await this.#credentials.get(combined) : { apiKey: this.#apiKey };
        const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...request.headers };
        if (this.protocol === 'anthropic') { if (auth.apiKey) headers['x-api-key'] = auth.apiKey; }
        else if (this.protocol === 'gemini') { if (auth.apiKey) headers['x-goog-api-key'] = auth.apiKey; }
        else if (auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
        if (this.subscription) { headers['ChatGPT-Account-Id'] = auth.accountId; headers['OpenAI-Beta'] = 'responses=experimental'; headers.originator = 'notionsi'; headers.session_id = sessionId; }
        const send = () => this.#fetch(this.baseUrl + request.path, { method: 'POST', headers,
          body: JSON.stringify(request.body), signal: combined, credentials: 'omit', redirect: 'error' });
        let response = await send();
        // Only an explicit authentication rejection may be retried. Never replay tools or a partial stream.
        if (response.status === 401 && this.#credentials) {
          await response.body?.cancel().catch(() => {});
          auth = await this.#credentials.get(combined, true);
          headers.Authorization = `Bearer ${auth.apiKey}`; headers['ChatGPT-Account-Id'] = auth.accountId;
          response = await send();
        }
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw httpFailure(this.name, response.status); }
        if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
          await response.body?.cancel().catch(() => {}); throw new ProviderError(`${this.name} 未返回 SSE 流。`);
        }
        let result, outputChars = 0;
        for await (const event of protocols[this.protocol].parse(response.body, combined)) {
          combined.throwIfAborted();
          if (event.text) {
            outputChars += event.text.length; if (outputChars > 1048576) throw new ProviderError('模型回答过长。');
            yield event.text;
          }
          if (event.result) result = event.result;
        }
        if (!result) throw new ProviderError('模型连接提前结束。');
        const calls = result.calls;
        if (calls.length > 16 || new Set(calls.map(c => c.id)).size !== calls.length || calls.some(c =>
          typeof c.id !== 'string' || !c.id || c.id.length > 200 || typeof c.function.name !== 'string' || !c.function.name || c.function.name.length > 100 ||
          typeof c.function.arguments !== 'string' || c.function.arguments.length > 65536)) throw new ProviderError('模型工具调用无效。');
        if (calls.length && (!tools?.definitions?.length || round === 7 || totalCalls + calls.length > 24)) throw new ProviderError('模型返回未开放的工具，或达到工具调用上限。');
        if (!calls.length && !result.text.trim()) throw new ProviderError('模型没有返回可显示的回答。');
        messages.push({ role: 'assistant', content: result.text || null, ...result.extra, ...(calls.length ? { tool_calls: calls } : {}) });
        if (!calls.length) { onHistory?.(structuredClone(messages)); return; }
        for (const call of calls) {
          combined.throwIfAborted(); totalCalls++;
          messages.push(await executeCall(call, tools, combined, onToolEvent));
        }
        onHistory?.(structuredClone(messages));
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (timeout.aborted) throw new ProviderError(`${this.name} 请求超时。`);
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(`${this.name} 连接失败或响应格式无效，请检查网络与配置。`);
    }
  }
}
