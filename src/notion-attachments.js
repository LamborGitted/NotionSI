import { ProviderError } from './providers/errors.js';
import { imageMediaType, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, MAX_IMAGES } from './multimodal.js';

const fail = message => { throw new ProviderError(message); };
export function notionUserContent(content) {
  if (!Array.isArray(content) || !content.length || content.length > 20) fail('聊天消息需要文本或图片附件，最多 20 个内容块。');
  let text = [], files = [], hasText = false;
  for (const [index, part] of content.entries()) {
    if (part?.type === 'text') {
      if (index !== 0 || hasText) fail('聊天消息只能包含一个位于开头的文本块。');
      hasText = true;
      text = typeof part.text === 'string' ? [[part.text]] : part.text;
      if (!Array.isArray(text) || !text.length || !text.every(t => Array.isArray(t) && typeof t[0] === 'string') || !text.some(t => t[0].trim())) fail('聊天文本不能为空。');
    } else if (part?.type === 'file' && typeof part.file_id === 'string' && part.file_id.trim() && part.file_id.length <= 200) {
      files.push({ type: 'file', file_id: part.file_id });
    } else fail('聊天仅支持文本和图片附件。');
  }
  if (files.length > MAX_IMAGES) fail('每条消息最多支持 10 张图片。');
  return { text: structuredClone(text), files };
}

function assetUrl(value) {
  let url; try { url = new URL(value); } catch { fail('Notion 没有返回有效的图片下载地址。'); }
  const hosts = ['notion.so', 'notion.com', 'notion.site', 'notionusercontent.com', 'notion-static.com', 'amazonaws.com'];
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' ||
      !hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) fail('Notion 图片下载地址不受支持。');
  return url.href;
}

export class NotionAttachments {
  constructor({ request, fetchImpl = fetch }) { this.request = request; this.fetch = fetchImpl; }
  async download(url, signal) {
    let response;
    for (let redirects = 0; redirects <= 3; redirects++) {
      url = assetUrl(url);
      response = await this.fetch(url, { signal, credentials: 'omit', redirect: 'manual' });
      signal?.throwIfAborted();
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (redirects === 3 || !location) fail('图片下载重定向无效，请重新上传。');
      try { url = new URL(location, url).href; } catch { fail('Notion 图片下载地址不受支持。'); }
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); fail('图片下载失败，请重新上传附件。'); }
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) { await response.body.cancel(); fail('单张图片不能超过 5 MiB。'); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    const abort = () => reader.cancel().catch(() => {});
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      for (;;) {
        const { done, value } = await reader.read(); signal?.throwIfAborted(); if (done) break;
        size += value.byteLength; if (size > MAX_IMAGE_BYTES) fail('单张图片不能超过 5 MiB。');
        chunks.push(value);
      }
    } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    return { type: 'image', mediaType: imageMediaType(bytes), data: bytes.toString('base64') };
  }
  async read(files, { toolContext, signal, classic = false } = {}) {
    if (!files.length) return [];
    if (!toolContext?.spaceId || !toolContext?.threadId) fail('图片附件没有绑定到 Notion 聊天会话。');
    if (files.length > MAX_IMAGES) fail('每条消息最多支持 10 张图片。');
    const timeout = AbortSignal.timeout(30000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const images = []; let size = 0;
    try {
      for (const file of files) {
        combined.throwIfAborted();
        let url;
        if (classic) {
          if (typeof file.fileUrl !== 'string' || !file.fileUrl || file.fileUrl.length > 16000) fail('经典聊天附件缺少有效的文件地址。');
          const permissionRecord = file.permissionRecord ?? { table: 'thread', id: toolContext.threadId, spaceId: toolContext.spaceId };
          if (!['thread', 'block'].includes(permissionRecord.table) || typeof permissionRecord.id !== 'string' || !permissionRecord.id ||
              permissionRecord.spaceId && permissionRecord.spaceId !== toolContext.spaceId ||
              permissionRecord.table === 'thread' && permissionRecord.id !== toolContext.threadId) fail('图片附件不属于当前聊天会话。');
          const result = await this.request(toolContext, 'getSignedFileUrls', {
            urls: [{ url: file.fileUrl, permissionRecord, download: false }],
          }, combined);
          if (result.status === 200) url = result.data?.signedUrls?.[0];
        } else {
          const result = await this.request(toolContext, 'getFileContentURLForAgentThread', {
            spaceId: toolContext.spaceId, threadId: toolContext.threadId, fileId: file.file_id, includeFileMetadata: true,
          }, combined);
          if (result.status === 200) url = result.data?.url;
        }
        if (typeof url !== 'string') fail('无法读取 Notion 图片附件，请重新上传后再试。');
        const image = await this.download(url, combined);
        size += Buffer.byteLength(image.data, 'base64');
        if (size > MAX_TOTAL_IMAGE_BYTES) fail('图片总大小不能超过 10 MiB。');
        images.push(image);
      }
      return images;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (timeout.aborted) fail('读取图片附件超时，请重新上传后再试。');
      if (error instanceof ProviderError) throw error;
      fail('无法读取 Notion 图片附件，请重新上传后再试。');
    }
  }
}
