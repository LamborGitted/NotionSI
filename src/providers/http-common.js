import { ProviderError } from './errors.js';
import { validateMessageContent } from '../multimodal.js';

export function endpointBase(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid provider base URL.'); }
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Provider base URL requires HTTPS (HTTP is allowed only on loopback), without credentials, query or fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

export function httpFailure(name, status) {
  const hint = status === 401 ? '鉴权失败，请检查凭据或重新登录。'
    : status === 403 ? '访问被拒绝，请检查账户与模型权限。'
    : status === 402 ? '账户额度不足。'
    : status === 429 ? '达到速率或额度限制，请稍后重试。'
    : status >= 500 ? '服务暂时不可用。' : '请求失败，请检查模型与接口配置。';
  return new ProviderError(`${name} ${hint}（HTTP ${status}）`, { status });
}

/** SSE framing shared by the new protocols; never expose an upstream error body. */
export async function* events(body, signal) {
  if (!body?.getReader) throw new ProviderError('模型没有返回可读取的响应流。');
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let buffer = '', data = [], size = 0, eof = false;
  const line = value => {
    if (!value) { const result = data.length ? data.join('\n') : undefined; data = []; size = 0; return result; }
    if (value.startsWith('data:')) {
      const part = value.slice(5).replace(/^ /, ''); size += part.length;
      if (size > 1048576) throw new ProviderError('模型流事件过大。');
      data.push(part);
    }
  };
  try {
    signal?.throwIfAborted();
    while (!eof) {
      const chunk = await reader.read(); signal?.throwIfAborted(); eof = chunk.done;
      buffer += eof ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match || (!eof && match[0] === '\r' && match.index === buffer.length - 1)) break;
        const item = line(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length);
        if (item !== undefined) yield item;
      }
      if (buffer.length > 1048576) throw new ProviderError('模型流数据行过大。');
    }
    if (buffer) line(buffer);
    const tail = line(''); if (tail !== undefined) yield tail;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!eof) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function* jsonEvents(body, signal) {
  for await (const data of events(body, signal)) {
    if (data.trim() === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); } catch { throw new ProviderError('模型流包含无效 JSON。'); }
    if (!event || typeof event !== 'object' || event.error || event.type === 'error') throw new ProviderError('模型返回错误流事件。');
    yield event;
  }
}

export function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.some(m => m?.role === 'user') || messages.some(m => !m ||
      !['system', 'user', 'assistant', 'tool'].includes(m.role) ||
      !validateMessageContent(m))) {
    throw new ProviderError('没有可发送给模型的有效文本消息。');
  }
}

export async function executeCall(call, tools, signal, onToolEvent) {
  const name = call.function.name;
  await onToolEvent?.({ type: 'start', id: call.id, name });
  let result;
  try {
    if (!tools?.definitions?.some(d => d.function.name === name)) throw new Error();
    const args = JSON.parse(call.function.arguments);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
    result = await tools.execute(name, args, { signal });
    const serialized = JSON.stringify(result);
    if (typeof serialized !== 'string' || serialized.length > 65536) result = { is_error: true, message: '工具结果无效或过长，请缩小查询范围。' };
  } catch (error) {
    if (signal.aborted) { await onToolEvent?.({ type: 'end', id: call.id, name, canceled: true }); signal.throwIfAborted(); }
    result = { is_error: true, message: error?.name === 'ToolError' ? error.message : '工具名称或参数无效，或执行失败。' };
  }
  signal.throwIfAborted();
  await onToolEvent?.({ type: 'end', id: call.id, name, isError: result?.is_error === true });
  return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) };
}
