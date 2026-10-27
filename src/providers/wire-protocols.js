import { randomUUID } from 'node:crypto';
import { ProviderError } from './errors.js';
import { jsonEvents } from './http-common.js';

const fail = message => { throw new ProviderError(message); };
const functions = tools => tools?.definitions?.map(d => d.function) ?? [];
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const toolName = (messages, id) => messages.flatMap(m => m.tool_calls ?? []).find(c => c.id === id)?.function.name;

export const protocols = {
  'chat-completions': {
    request(p, messages, tools) {
      return { path: '/chat/completions', body: { model: p.model, stream: true, max_tokens: p.maxTokens,
        messages: messages.map(({ role, content, tool_calls, tool_call_id, reasoning_content }) => ({ role, content,
          ...(tool_calls ? { tool_calls } : {}), ...(tool_call_id ? { tool_call_id } : {}), ...(reasoning_content ? { reasoning_content } : {}) })),
        ...(functions(tools).length ? { tools: tools.definitions, tool_choice: 'auto' } : {}),
        ...(p.reasoningEffort ? { reasoning_effort: p.reasoningEffort } : {}) } };
    },
    async *parse(body, signal) {
      let finish, text = '', reasoning = ''; const calls = new Map();
      for await (const event of jsonEvents(body, signal)) {
        const c = event.choices?.find(c => c.index === 0) ?? event.choices?.[0]; if (!c) continue;
        if (finish && (c.delta?.content || c.delta?.tool_calls?.length)) fail('模型在结束后继续返回内容。');
        const delta = c.delta ?? {};
        if (delta.content != null) {
          if (typeof delta.content !== 'string') fail('模型文本格式无效。');
          text += delta.content; yield { text: delta.content };
        }
        if (delta.reasoning_content) {
          if (typeof delta.reasoning_content !== 'string') fail('模型思考内容格式无效。');
          reasoning += delta.reasoning_content;
        }
        if (reasoning.length > 1048576) fail('模型思考内容过长。');
        for (const d of delta.tool_calls ?? []) {
          if (!Number.isInteger(d.index) || d.index < 0 || d.index > 15) fail('工具索引无效。');
          const item = calls.get(d.index) ?? call('', '', '');
          if (d.id) { if (typeof d.id !== 'string') fail('工具 ID 无效。'); if (d.id !== item.id) item.id += d.id; }
          for (const key of ['name', 'arguments']) if (d.function?.[key] !== undefined) {
            if (typeof d.function[key] !== 'string') fail('工具参数格式无效。');
            item.function[key] += d.function[key];
          }
          if (item.function.arguments.length > 65536 || item.function.name.length > 100 || item.id.length > 200) fail('工具参数过长。');
          calls.set(d.index, item);
        }
        if (c.finish_reason) finish = c.finish_reason;
      }
      if (!['stop', 'tool_calls'].includes(finish) || (finish === 'tool_calls') !== !!calls.size) fail('模型未正常完成回答或达到输出上限。');
      yield { result: { text, calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c),
        extra: reasoning ? { reasoning_content: reasoning } : {} } };
    },
  },
  responses: {
    request(p, messages, tools) {
      const input = messages.flatMap(m => {
        if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.tool_call_id, output: m.content }];
        if (m.role === 'assistant' && m.response_items) return m.response_items;
        const items = m.content ? [{ role: m.role, content: m.content }] : [];
        return [...items, ...(m.tool_calls ?? []).map(c => ({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments }))];
      });
      // Codex subscription transport requires instructions and does not accept max_output_tokens.
      const instructions = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      const body = { model: p.model, stream: true, store: false, input: p.subscription ? input.filter(m => m.role !== 'system') : input,
        ...(p.subscription ? { instructions: instructions || 'You are a helpful assistant.' } : { max_output_tokens: p.maxTokens }),
        include: ['reasoning.encrypted_content'],
        ...(functions(tools).length ? { tools: functions(tools).map(f => ({ type: 'function', ...f, strict: false })), tool_choice: 'auto', parallel_tool_calls: false } : {}),
        ...(p.reasoningEffort ? { reasoning: { effort: p.reasoningEffort } } : {}) };
      return { path: '/responses', body };
    },
    async *parse(body, signal) {
      let completed = false, text = '', final; const items = new Map();
      for await (const event of jsonEvents(body, signal)) {
        if (completed) fail('模型在结束后继续返回事件。');
        if (['response.failed', 'response.incomplete'].includes(event.type)) fail('模型响应失败或不完整。');
        if (event.type === 'response.output_text.delta') {
          if (typeof event.delta !== 'string') fail('模型文本格式无效。');
          text += event.delta; yield { text: event.delta };
        }
        if (event.type === 'response.output_item.done') items.set(event.output_index, event.item);
        if (event.type === 'response.completed') {
          if (event.response?.status !== 'completed') fail('模型未正常完成回答。');
          final = event.response.output ?? [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
          if (!Array.isArray(final)) fail('模型输出结构无效。');
          completed = true;
        }
      }
      if (!completed) fail('模型连接提前结束。');
      const finalText = final.filter(i => i.type === 'message').flatMap(i => i.content ?? []).filter(i => i.type === 'output_text').map(i => i.text).join('');
      if (!text && finalText) { text = finalText; yield { text }; }
      if (finalText && text !== finalText) fail('模型最终文本与流内容不一致。');
      yield { result: { text, calls: final.filter(i => i.type === 'function_call').map(i => call(i.call_id, i.name, i.arguments)), extra: { response_items: final } } };
    },
  },
  anthropic: {
    request(p, messages, tools) {
      const converted = [];
      for (const m of messages.filter(m => m.role !== 'system')) {
        let content, role = m.role;
        if (role === 'tool') { role = 'user'; content = [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }]; }
        else if (role === 'assistant') content = m.anthropic_content ?? [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...(m.tool_calls ?? []).map(c => ({ type: 'tool_use', id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments) }))];
        else content = [{ type: 'text', text: m.content }];
        if (converted.at(-1)?.role === role) converted.at(-1).content.push(...content);
        else converted.push({ role, content });
      }
      return { path: '/messages', headers: { 'anthropic-version': '2023-06-01' }, body: { model: p.model, max_tokens: p.maxTokens, stream: true,
        system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n'), messages: converted,
        ...(p.reasoningEffort ? { output_config: { effort: p.reasoningEffort } } : {}),
        ...(p.thinkingBudget !== undefined ? { thinking: { type: 'enabled', budget_tokens: p.thinkingBudget } } : {}),
        ...(functions(tools).length ? { tools: functions(tools).map(f => ({ name: f.name, description: f.description, input_schema: f.parameters })) } : {}) } };
    },
    async *parse(body, signal) {
      const blocks = new Map(); let text = '', finish, stopped = false;
      for await (const e of jsonEvents(body, signal)) {
        if (stopped && e.type !== 'ping') fail('模型在结束后继续返回事件。');
        if (e.type === 'content_block_start') {
          if (!Number.isInteger(e.index) || e.index < 0 || e.index > 100 || blocks.has(e.index)) fail('模型内容块索引无效。');
          blocks.set(e.index, { ...e.content_block });
          if (e.content_block.type === 'text' && e.content_block.text) { text += e.content_block.text; yield { text: e.content_block.text }; }
        }
        if (e.type === 'content_block_delta') {
          const block = blocks.get(e.index); if (!block) fail('模型内容块顺序无效。');
          const d = e.delta;
          if (d.type === 'text_delta') { block.text = (block.text ?? '') + d.text; text += d.text; yield { text: d.text }; }
          else if (d.type === 'input_json_delta') { block.json = (block.json ?? '') + d.partial_json; if (block.json.length > 65536) fail('工具参数过长。'); }
          else if (d.type === 'thinking_delta') { block.thinking = (block.thinking ?? '') + d.thinking; if (block.thinking.length > 1048576) fail('模型思考内容过长。'); }
          else if (d.type === 'signature_delta') block.signature = (block.signature ?? '') + d.signature;
        }
        if (e.type === 'message_delta') finish = e.delta?.stop_reason;
        if (e.type === 'message_stop') stopped = true;
      }
      if (!stopped || !['end_turn', 'tool_use', 'stop_sequence'].includes(finish)) fail('模型未正常完成回答或达到输出上限。');
      const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => {
        if (b.json !== undefined) { b.input = JSON.parse(b.json); delete b.json; } return b;
      });
      const calls = content.filter(b => b.type === 'tool_use').map(b => call(b.id, b.name, b.input));
      if ((finish === 'tool_use') !== !!calls.length) fail('工具调用结束状态无效。');
      yield { result: { text, calls, extra: { anthropic_content: content } } };
    },
  },
  gemini: {
    request(p, messages, tools) {
      const contents = [];
      for (const m of messages.filter(m => m.role !== 'system')) {
        const role = m.role === 'assistant' ? 'model' : 'user'; let parts;
        if (m.role === 'tool') {
          const original = messages.flatMap(m => m.gemini_parts ?? []).find(p => p.functionCall?.id === m.tool_call_id);
          parts = [{ functionResponse: { ...(original ? { id: m.tool_call_id } : {}), name: toolName(messages, m.tool_call_id), response: JSON.parse(m.content) } }];
        }
        else if (m.role === 'assistant') parts = m.gemini_parts ?? [ ...(m.content ? [{ text: m.content }] : []),
          ...(m.tool_calls ?? []).map(c => ({ functionCall: { name: c.function.name, args: JSON.parse(c.function.arguments) } }))];
        else parts = [{ text: m.content }];
        if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts); else contents.push({ role, parts });
      }
      return { path: `/models/${encodeURIComponent(p.model.replace(/^models\//, ''))}:streamGenerateContent?alt=sse`, body: {
        contents, systemInstruction: { parts: [{ text: messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n') || 'You are a helpful assistant.' }] },
        generationConfig: { maxOutputTokens: p.maxTokens,
          ...(p.reasoningEffort ? { thinkingConfig: { thinkingLevel: p.reasoningEffort.toUpperCase() } } : {}),
          ...(p.thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget: p.thinkingBudget } } : {}) },
        ...(functions(tools).length ? { tools: [{ functionDeclarations: functions(tools).map(f => ({ name: f.name, description: f.description, parametersJsonSchema: f.parameters })) }] } : {}) } };
    },
    async *parse(body, signal) {
      let text = '', finish; const parts = [], calls = [];
      for await (const e of jsonEvents(body, signal)) {
        if (e.promptFeedback?.blockReason) fail('模型拒绝处理此请求。');
        const candidate = e.candidates?.find(c => c.index === 0) ?? e.candidates?.[0]; if (!candidate) continue;
        if (finish) fail('模型在结束后继续返回内容。');
        for (const part of candidate.content?.parts ?? []) {
          parts.push(part);
          if (typeof part.text === 'string' && !part.thought) { text += part.text; yield { text: part.text }; }
          if (part.functionCall) calls.push(call(part.functionCall.id || randomUUID(), part.functionCall.name, part.functionCall.args ?? {}));
        }
        if (JSON.stringify(parts).length > 1048576) fail('模型输出过长。');
        if (candidate.finishReason) finish = candidate.finishReason;
      }
      if (finish !== 'STOP') fail('模型未正常完成回答或达到输出上限。');
      yield { result: { text, calls, extra: { gemini_parts: parts } } };
    },
  },
};
