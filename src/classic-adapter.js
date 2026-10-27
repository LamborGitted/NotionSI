import { ProviderError } from './providers/errors.js';
import { randomUUID } from 'node:crypto';
import { trimConversation } from './conversation.js';
import { checkMessageBudget } from './multimodal.js';

function textValue(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(token => Array.isArray(token) && typeof token[0] === 'string')) return value.map(token => token[0]).join('');
  if (value && !Array.isArray(value) && typeof value === 'object') return textValue(value.text);
  return undefined;
}

/** A partial transcript cannot bootstrap old history. */
export class ClassicAdapter {
  constructor(provider, { readAttachments } = {}) { this.provider = provider; this.readAttachments = readAttachments; this.histories = new Map(); this.active = new Set(); this.toolStates=new Map(); }
  async *stream(request, { signal, toolContext } = {}) {
    const key = JSON.stringify([request?.spaceId, request?.threadId]);
    if (this.active.has(key)) throw new Error('该经典对话已有请求正在生成。');
    const history = this.histories.get(key) ?? [];
    const transcript = Array.isArray(request?.transcript) ? request.transcript : [];
    const userIndex = transcript.findLastIndex(step => step.type === 'user' || step.type === 'user-injected');
    const user = textValue(transcript[userIndex]?.value);
    const boundary = transcript.findLastIndex((step, index) => (userIndex < 0 || index < userIndex) &&
      ['user', 'user-injected', 'agent-inference', 'assistant'].includes(step.type));
    const files = transcript.slice(boundary + 1).filter(step => ['attachment', 'computer-file'].includes(step.type));
    if (!user?.trim() && !files.length) throw new Error('经典请求未包含可识别的用户文本或图片，请新建普通 AI 对话。');
    if(!this.toolStates.has(key))this.toolStates.set(key,{});
    const id = randomUUID(), traceId = request.traceId ?? randomUUID(), startedAt = Date.now();
    const step = (value, finished = false) => ({ id, type: 'agent-inference', value, traceId, startedAt, ...(finished ? { finishedAt: Date.now() } : {}) });
    const patch = request.asPatchResponse === true;
    this.active.add(key);
    let accumulated = '';
    try {
      signal?.throwIfAborted();
      yield patch ? { type: 'patch-start', data: { s: [step('')] } } : step('');
      let content = user ?? '';
      if (files.length) {
        if (!this.readAttachments) throw new ProviderError('当前经典聊天未配置图片附件读取。');
        const images = await this.readAttachments(files, { toolContext, signal, classic: true });
        signal?.throwIfAborted();
        if (!Array.isArray(images) || images.length !== files.length) throw new ProviderError('图片附件读取不完整，请重新上传。');
        content = [...(user?.trim() ? [{ type: 'text', text: user }] : []), ...images];
      }
      const messages = trimConversation([...history, { role: 'user', content }]);
      checkMessageBudget(messages);
      let updatedHistory;
      for await (const text of this.provider.stream({ messages, signal,toolContext,toolState:this.toolStates.get(key),onHistory:history=>{updatedHistory=history;} })) {
        signal?.throwIfAborted();
        accumulated += text;
        yield patch ? { type: 'patch', v: [{ o: 'x', p: '/s/0/value', v: text }] } : step(accumulated);
      }
      signal?.throwIfAborted();
      this.histories.set(key, trimConversation(updatedHistory ?? [...messages, { role: 'assistant', content: accumulated }]));
      yield patch ? { type: 'patch-sync', data: { s: [step(accumulated, true)] } } : step(accumulated, true);
    } catch (error) {
      if (!signal?.aborted) yield { id: randomUUID(), type: 'error', traceId,
        message: error instanceof ProviderError ? error.message : '模型生成失败，请检查本地工具配置。', errorCode: 502 };
    } finally { this.active.delete(key); }
  }
}
