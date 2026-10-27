// Model-facing text only. Keep the original tokens for native UI rendering and
// editor offsets; token[0] alone loses hyperlink targets and page mentions.
export function pageReferenceUrl(id) {
  if (typeof id !== 'string' || !/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(id)) return undefined;
  return `https://www.notion.so/${id.replaceAll('-', '').toLowerCase()}`;
}

function linkUrl(value) {
  if (typeof value !== 'string' || !value.trim() || /[\s<>]/.test(value)) return undefined;
  try {
    const url = new URL(value, 'https://www.notion.so');
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) return undefined;
    if (!/^(?:https?:|mailto:|\/)/i.test(value)) return undefined;
    return url.href.replaceAll('(', '%28').replaceAll(')', '%29');
  } catch { return undefined; }
}

export function notionText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(token => {
    if (!Array.isArray(token) || typeof token[0] !== 'string') return '';
    const text = token[0], annotations = Array.isArray(token[1]) ? token[1] : [];
    for (const annotation of annotations) {
      if (!Array.isArray(annotation)) continue;
      const [type, target] = annotation;
      const url = type === 'p' ? pageReferenceUrl(target) : ['a', 'lm'].includes(type) ? linkUrl(target) : undefined;
      if (url) {
        const label = text && text !== '‣' ? text : type === 'p' ? '页面引用' : '链接';
        return `[${label.replace(/[\\[\]]/g, '\\$&')}](${url})`;
      }
    }
    return text;
  }).join('');
}
