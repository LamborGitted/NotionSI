import { ProviderError } from './errors.js';
import { validateMessages } from './http-common.js';
import { chatContent, checkMessageBudget } from '../multimodal.js';

// Official CN endpoints, selected explicitly. Never fall back across profiles.
export const ZHIPU_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
export const ZHIPU_ENDPOINTS = Object.freeze({
  standard: ZHIPU_ENDPOINT,
  'coding-cn': 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
});
export const DEFAULT_ZHIPU_MODEL = 'glm-5.3';

export class ZhipuError extends ProviderError {
  constructor(message, { status, code } = {}) {
    super(message, { status, code }); this.name = 'ZhipuError';
  }
}

const numericCode = value => /^\d{3,8}$/.test(String(value ?? '')) ? String(value) : undefined;
async function readErrorCode(response) {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  let text = '', bytes = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16384) return undefined;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return numericCode(JSON.parse(text + decoder.decode())?.error?.code);
  } catch { return undefined; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function httpError(status, code, apiProfile = 'standard') {
  const known = {
    '1113': apiProfile === 'coding-cn'
      ? '智谱返回余额不足；当前使用 Coding Plan CN，请核对是否为套餐 Key 及其可用额度。'
      : '智谱标准 API 账户余额不足，请检查余额或可用资源包。',
    '1211': '智谱模型不存在，请检查 ZHIPU_MODEL。',
    '1302': '智谱账户已达到速率限制，请稍后重试。',
    '1305': '智谱模型当前访问量过大，请稍后重试或手动选择其他模型。',
    '1308': '智谱当前使用额度已用完，请等待额度恢复。',
    '1310': '智谱每周或每月使用额度已用完。',
    '1309': '智谱 Coding Plan 套餐已到期，请检查套餐状态。',
    '1311': '当前智谱套餐尚未开放所选模型权限。',
    '1313': '智谱账户当前受到公平使用策略限制，请在官方控制台查看状态。',
    '1315': '当前 Key 仅支持企业编程套餐，请核对 Key 产品类型和所选接口。',
  };
  const message = known[code] ?? (status === 401 ? '智谱 API 鉴权失败，请检查本机 ZHIPU_API_KEY。'
    : status === 402 ? '智谱标准 API 余额不足，请检查账户余额。'
    : status === 403 ? '智谱拒绝访问，请检查 Key 和模型权限。'
    : status === 429 ? '智谱请求过于频繁，请稍后再试。'
    : status >= 500 ? '智谱服务暂时不可用，请稍后再试。'
    : '智谱请求失败，请检查模型配置和账户状态。');
  return new ZhipuError(`${message}（HTTP ${status}${code ? `，错误码 ${code}` : ''}）`, { status, code });
}

/** Parse real SSE events, independently of HTTP read boundaries and CRLF. */
export async function* sseData(body, { signal, maxEventChars = 1048576 } = {}) {
  if (!body?.getReader) throw new ZhipuError('智谱没有返回可读取的响应流。');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const onAbort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  let pending = '', lines = [], eventChars = 0, eof = false;
  const accept = line => {
    if (line === '') {
      const data = lines.length ? lines.join('\n') : undefined;
      lines = []; eventChars = 0; return data;
    }
    if (line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /, '');
      eventChars += value.length;
      if (eventChars > maxEventChars) throw new ZhipuError('智谱返回的单个流事件过大。');
      lines.push(value);
    }
  };
  try {
    while (!eof) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      eof = chunk.done;
      pending += eof ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const match = /\r\n|\r|\n/.exec(pending);
        if (!match || (!eof && match[0] === '\r' && match.index === pending.length - 1)) break;
        const line = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        const data = accept(line);
        if (data !== undefined) yield data;
      }
      if (pending.length > maxEventChars) throw new ZhipuError('智谱返回的流数据行过大。');
    }
    if (pending) accept(pending);
    const tail = accept('');
    if (tail !== undefined) yield tail;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!eof) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class ZhipuProvider {
  #apiKey;
  #fetch;
  #systemPrompt;
  constructor({ apiKey, apiProfile = 'standard', model = DEFAULT_ZHIPU_MODEL, maxTokens = 2048, timeoutMs = 180000,
    thinking = /^glm-5\.3(?:-|$)/i.test(model) ? 'enabled' : 'disabled',
    reasoningEffort = /^glm-5\.3(?:-|$)/i.test(model) ? 'low' : undefined, systemPrompt = '', fetchImpl = fetch } = {}) {
    if (!Object.hasOwn(ZHIPU_ENDPOINTS, apiProfile)) throw new Error('ZHIPU_API_PROFILE must be standard or coding-cn.');
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
      throw new Error('请先在本机 .env.local 中填写 ZHIPU_API_KEY；不要将密钥发到聊天。');
    }
    if (typeof model !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(model)) throw new Error('Invalid ZHIPU_MODEL.');
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 131072) throw new Error('ZHIPU_MAX_TOKENS must be 1..131072.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) throw new Error('ZHIPU_TIMEOUT_MS must be 1000..900000.');
    if (!['enabled', 'disabled'].includes(thinking)) throw new Error('ZHIPU_THINKING must be enabled or disabled.');
    if (/^glm-5\.3(?:-|$)/i.test(model) && thinking !== 'enabled') throw new Error('GLM-5.3 requires thinking=enabled.');
    if (reasoningEffort !== undefined && !['low', 'high', 'max'].includes(reasoningEffort)) throw new Error('ZHIPU_REASONING_EFFORT must be low, high or max.');
    if (typeof systemPrompt !== 'string' || Buffer.byteLength(systemPrompt, 'utf8') > 65536 || systemPrompt.includes('\0')) {
      throw new Error('System prompt must be UTF-8 text of at most 64 KiB.');
    }
    this.#systemPrompt = systemPrompt.trim();
    this.#apiKey = apiKey.trim(); this.#fetch = fetchImpl;
    this.model = model; this.maxTokens = maxTokens; this.timeoutMs = timeoutMs; this.thinking = thinking; this.reasoningEffort = reasoningEffort;
    this.name = 'zhipu';
    this.apiProfile = apiProfile; this.endpoint = ZHIPU_ENDPOINTS[apiProfile];
  }
  async *stream({ messages, signal, tools, onToolEvent, onHistory } = {}) {
    validateMessages(messages);
    // Insert afresh on each turn, outside adapters' bounded conversation history.
    // Never mutate the caller's history or store the prompt in a transcript.
    messages = structuredClone(messages);
    const preamble = [this.#systemPrompt, tools?.instructions].filter(Boolean).join('\n\n');
    const wireMessages = () => preamble ? [{role:'system',content:preamble}, ...messages] : messages;
    checkMessageBudget(wireMessages(), 100000);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      let totalCalls = 0;
      for (let round = 0; round < 8; round++) {
      combined.throwIfAborted();
      checkMessageBudget(wireMessages());
      // Build headers explicitly: no Notion cookies, IDs, URLs or request headers.
      response = await this.#fetch(this.endpoint, {
        method: 'POST', redirect: 'error', credentials: 'omit', signal: combined,
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify({ model: this.model, messages: wireMessages().map(m => ({ ...m, content: chatContent(m.content) })), stream: true, max_tokens: this.maxTokens,
          ...(tools?.definitions?.length ? {tools:tools.definitions,tool_choice:'auto'} : {}),
          thinking: { type: this.thinking }, ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}) }),
      });
      if (!response.ok) {
        // Retain only a bounded numeric code; never log/forward echoed text.
        throw httpError(response.status, await readErrorCode(response), this.apiProfile);
      }
      if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
        await response.body?.cancel().catch(() => {});
        throw new ZhipuError('智谱未返回 SSE 流，请检查 API 或模型配置。');
      }
      let finished = false, sawText = false, textChars = 0, finishReason, content = '', reasoning = '';
      const calls = new Map();
      for await (const data of sseData(response.body, { signal: combined })) {
        combined.throwIfAborted();
        if (data.trim() === '[DONE]') break;
        let event;
        try { event = JSON.parse(data); } catch { throw new ZhipuError('智谱响应包含无效的 JSON 流事件。'); }
        if (event.error) throw httpError(response.status, numericCode(event.error.code), this.apiProfile);
        const choice = event.choices?.find(item => item.index === 0) ?? event.choices?.[0];
        if (!choice) continue; // Usage-only final packets are permitted.
        if (choice.delta?.tool_calls?.length) {
          if (!tools?.definitions?.length || finished) throw new ZhipuError('智谱返回了未开放或已结束的工具调用。');
          for (const delta of choice.delta.tool_calls) {
            if (!Number.isInteger(delta.index) || delta.index < 0 || delta.index > 15) throw new ZhipuError('智谱工具调用索引无效。');
            const call = calls.get(delta.index) ?? {id:'',type:'function',function:{name:'',arguments:''}};
            if (delta.id) { if (typeof delta.id !== 'string') throw new ZhipuError('工具调用 ID 无效。'); if (call.id !== delta.id) call.id += delta.id; }
            if (delta.type && delta.type !== 'function') throw new ZhipuError('不支持的工具调用类型。');
            for (const field of ['name','arguments']) if (delta.function?.[field] !== undefined) {
              if (typeof delta.function[field] !== 'string') throw new ZhipuError('工具调用参数格式无效。');
              call.function[field] += delta.function[field];
            }
            if (call.id.length > 128 || call.function.name.length > 100 || call.function.arguments.length > 65536) throw new ZhipuError('工具调用参数过长。');
            calls.set(delta.index, call);
          }
        }
        if (choice.delta?.reasoning_content) {
          if (typeof choice.delta.reasoning_content !== 'string') throw new ZhipuError('思考流格式无效。');
          reasoning += choice.delta.reasoning_content;
          if (reasoning.length > 1048576) throw new ZhipuError('思考流过长。');
        }
        const text = choice.delta?.content;
        if (text !== undefined && text !== null && typeof text !== 'string') throw new ZhipuError('智谱返回了不支持的文本格式。');
        if (text) {
          if (finished) throw new ZhipuError('智谱在结束事件之后返回了额外文本。');
          textChars += text.length;
          if (textChars > 1048576) throw new ZhipuError('智谱回答超过本地显示长度限制。');
          content += text; sawText = true; yield text;
        }
        if (choice.finish_reason) {
          if (choice.finish_reason === 'length') throw new ZhipuError('智谱输出达到 Token 上限，回答可能不完整。');
          if (!['stop','tool_calls'].includes(choice.finish_reason)) throw new ZhipuError('智谱未正常完成回答，可能触发内容限制或不支持的能力。');
          finished = true; finishReason = choice.finish_reason;
        }
        // reasoning_content is deliberately not surfaced as the final answer.
      }
      if (!finished) throw new ZhipuError('智谱连接提前结束，回答尚未确认完成。');
      if (finishReason === 'stop') {
        if(calls.size) throw new ZhipuError('工具调用缺少正确的结束原因。');
        if (!sawText) throw new ZhipuError('智谱没有返回可显示的回答文本。');
        messages.push({role:'assistant',content}); onHistory?.(structuredClone(messages)); return;
      }
      if (!calls.size || !tools) throw new ZhipuError('智谱返回空的工具调用。');
      if (round === 7 || totalCalls + calls.size > 24) throw new ZhipuError('达到本轮工具调用上限，请缩小任务范围。');
      const toolCalls=[...calls.entries()].sort(([a],[b])=>a-b).map(([,c])=>c);
      if(new Set(toolCalls.map(c=>c.id)).size!==toolCalls.length || toolCalls.some(c=>!c.id||!c.function.name))throw new ZhipuError('工具调用 ID 或名称缺失、重复。');
      messages.push({role:'assistant',content:content||null,...reasoning?{reasoning_content:reasoning}:{},tool_calls:toolCalls});
      for(const call of toolCalls) {
        combined.throwIfAborted();totalCalls++;
        const name=call.function.name;
        await onToolEvent?.({type:'start',id:call.id,name});
        let result;
        try {
          if(!tools.definitions.some(d=>d.function.name===name))throw new Error();
          let args;
          try {args=JSON.parse(call.function.arguments);}catch{throw new Error();}
          if(!args||typeof args!=='object'||Array.isArray(args))throw new Error();
          result=await tools.execute(name,args,{signal:combined});
          if(JSON.stringify(result).length>65536)result={is_error:true,message:'工具结果过长，请缩小读取或查询范围。'};
        } catch(error) {
          if(combined.aborted){await onToolEvent?.({type:'end',id:call.id,name,canceled:true});combined.throwIfAborted();}
          result={is_error:true,message:error?.name==='ToolError'?error.message:'工具名称或参数无效，或执行失败。'};
        }
        combined.throwIfAborted();
        messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});
        await onToolEvent?.({type:'end',id:call.id,name,isError:result?.is_error===true});
      }
      onHistory?.(structuredClone(messages));
      }
      throw new ZhipuError('达到工具循环上限。');
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (timeout.aborted) throw new ZhipuError('智谱请求超时，请稍后重试。');
      if (error instanceof ZhipuError) throw error;
      if (error instanceof ProviderError) throw new ZhipuError(error.message, { status: error.status, code: error.code });
      throw new ZhipuError('无法连接智谱 API，请检查网络后重试。');
    }
  }
}
