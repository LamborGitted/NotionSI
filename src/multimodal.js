import { ProviderError } from './providers/errors.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 10;
const mediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const fail = message => { throw new ProviderError(message); };

export function imageMediaType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  fail('附件不是支持的图片，请使用 PNG、JPEG、WebP 或 GIF。');
}

export function validateImage(part) {
  if (!mediaTypes.has(part.mediaType) || typeof part.data !== 'string' || !part.data.length ||
      part.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || part.data.length % 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(part.data)) fail('图片数据无效或单张超过 5 MiB。');
  const bytes = Buffer.from(part.data, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== part.data || imageMediaType(bytes) !== part.mediaType) fail('图片格式与内容不匹配。');
  return bytes.length;
}

// Images have one provider-independent representation; signed Notion URLs never enter history.
export function validateMessageContent(message) {
  if (typeof message.content === 'string') return true;
  if (message.role === 'assistant' && message.content === null && message.tool_calls?.length) return true;
  if (message.role !== 'user' || !Array.isArray(message.content) || !message.content.length) return false;
  return message.content.every(p => p && (p.type === 'text' ? typeof p.text === 'string' : p.type === 'image' && !!validateImage(p)));
}

export function checkMessageBudget(messages, maxTextChars = 250000) {
  let bytes = 0, count = 0;
  const text = JSON.stringify(messages, (key, value) => {
    if (value?.type === 'image') { bytes += validateImage(value); count++; return { type: 'image' }; }
    return value;
  });
  if (bytes > MAX_TOTAL_IMAGE_BYTES || count > MAX_IMAGES) fail('当前会话图片超过 10 张或总计 10 MiB，请新建对话或减少图片。');
  if (text.length > maxTextChars) fail('当前会话文本过长，请新建对话。');
}

export function imageDataUrl(part) { return `data:${part.mediaType};base64,${part.data}`; }
export function chatContent(content) {
  return typeof content === 'string' || content === null ? content : content.map(p => p.type === 'text'
    ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: imageDataUrl(p) } });
}
