import { randomUUID } from 'node:crypto';
import { notionId, record } from './tools/notion-native.js';
import { ProviderError } from './providers/errors.js';

const fail = message => { throw new ProviderError(message); };

// Classic UI clears temporarySteps at EOF (native module 691115). The final
// answer must exist as a thread_message, and its record-map must reach the
// client before that cleanup. patch-sync alone only updates temporarySteps.
export class ClassicTranscript {
  constructor({ request }) { this.request = request; }

  async api(context, path, body, signal) {
    signal?.throwIfAborted();
    let response;
    try { response = await this.request(context, path, body, signal); }
    catch {
      signal?.throwIfAborted();
      fail('聊天回复保存失败或结果未确认，请重新打开对话检查；未自动重复写入。');
    }
    signal?.throwIfAborted();
    if (response.status !== 200 || response.data?.name?.endsWith('Error')) fail(`保存聊天回复失败（Notion ${path}，HTTP ${response.status}）。`);
    return response.data;
  }

  async read(context, pointers, signal) {
    const data = await this.api(context, 'syncRecordValues', { requests: pointers.map(pointer => ({ pointer, version: -1 })) }, signal);
    return { map: data.recordMap, values: pointers.map(p => record(data.recordMap?.[p.table]?.[p.id])) };
  }

  async persist({ request, step, toolContext, signal }) {
    if (step?.type !== 'agent-inference' || typeof step.value !== 'string' || !step.value.trim() || !Number.isFinite(step.finishedAt)) {
      fail('模型未返回完整正文，未保存聊天回复。');
    }
    const spaceId = notionId(request.spaceId), threadId = notionId(request.threadId), stepId = notionId(step.id);
    const user = request.transcript?.findLast(s => ['user', 'user-injected'].includes(s.type));
    if (!user?.id) fail('保存聊天回复失败：请求缺少用户消息标识。');
    const userId = notionId(user.id);
    const threadPointer = { table: 'thread', id: threadId, spaceId };
    const userPointer = { table: 'thread_message', id: userId, spaceId };
    const replyPointer = { table: 'thread_message', id: stepId, spaceId };
    const { values: [thread, originalUser] } = await this.read(toolContext, [threadPointer, userPointer], signal);
    if (thread?.id !== threadId || thread.space_id !== spaceId || thread.alive === false || !Array.isArray(thread.messages) ||
        !thread.messages.includes(userId) || originalUser?.parent_id !== threadId || originalUser.parent_table !== 'thread' ||
        originalUser.space_id !== spaceId || originalUser.step?.id !== userId || !['user', 'user-injected'].includes(originalUser.step?.type)) {
      fail('保存聊天回复失败：会话或用户消息不存在、无权访问或不属于当前工作区。');
    }
    if (!thread.messages.includes(stepId)) {
      const now = Date.now(), creatorId = originalUser.created_by_id, creatorTable = originalUser.created_by_table;
      const message = { id: stepId, version: 1, space_id: spaceId, parent_id: threadId, parent_table: 'thread',
        created_time: now, step: structuredClone(step),
        ...(creatorId && creatorTable ? { created_by_id: creatorId, created_by_table: creatorTable } : {}) };
      await this.api(toolContext, 'saveTransactionsFanout', { requestId: randomUUID(), transactions: [{ id: randomUUID(), spaceId,
        debug: { userAction: 'NotionSI.chatReply', clientCommitTimeMs: now }, inSudoMode: false,
        isUndoTransaction: false, isTemplateInstantiationTransaction: false, operations: [
          { pointer: replyPointer, command: 'set', path: [], args: message },
          { pointer: threadPointer, command: 'listAfter', path: ['messages'], args: { id: stepId, after: userId } },
          { pointer: threadPointer, command: 'update', path: [], args: { updated_time: now } },
        ] }] }, signal);
    }
    // Return the server's roles/versions, not a fabricated local record. A lost
    // acknowledgement is never retried as another write.
    const { map, values: [savedThread, reply] } = await this.read(toolContext, [threadPointer, replyPointer], signal);
    if (savedThread?.space_id !== spaceId || !savedThread.messages?.includes(stepId) || reply?.space_id !== spaceId ||
        reply.parent_id !== threadId || reply.parent_table !== 'thread' || reply.step?.id !== stepId ||
        reply.step?.type !== 'agent-inference' || reply.step.value !== step.value || reply.step.finishedAt !== step.finishedAt) {
      fail('聊天回复保存结果未确认，请重新打开对话检查；未自动重复写入。');
    }
    return map;
  }
}
