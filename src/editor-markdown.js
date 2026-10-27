import { marked } from 'marked';
import { randomUUID } from 'node:crypto';
import { ToolError } from './tools/notion-native.js';

export const richText = tokens => (tokens||[]).map(t=>t[0]).join('');
export function normalizedProperties(properties={}) {
  const out={};
  for(const [key,tokens] of Object.entries(properties||{})) {
    if(!Array.isArray(tokens)){if(tokens!=null)out[key]=tokens;continue;}
    const normalized=[];
    for(const token of tokens) {
      if(!token?.[0])continue;
      const annotations=[...(token[1]||[])].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const last=normalized.at(-1);
      if(last&&JSON.stringify(last[1]||[])===JSON.stringify(annotations))last[0]+=token[0];
      else normalized.push([token[0],...(annotations.length?[annotations]:[])]);
    }
    if(normalized.length)out[key]=normalized;
  }return out;
}
export function sliceRichText(tokens,start=0,end=richText(tokens).length) {
  const text=richText(tokens);
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>text.length)throw new ToolError('选区范围无效。');
  const splitSurrogate=i=>i>0&&i<text.length&&/[\uD800-\uDBFF]/.test(text[i-1])&&/[\uDC00-\uDFFF]/.test(text[i]);
  if(splitSurrogate(start)||splitSurrogate(end))throw new ToolError('选区不能切开 Unicode 字符。');
  let offset=0;const result=[];
  for(const token of tokens||[]) {
    if(!Array.isArray(token)||typeof token[0]!=='string')throw new ToolError('此选区含不支持的富文本格式。');
    const lo=Math.max(0,start-offset),hi=Math.min(token[0].length,end-offset);
    if(hi>lo)result.push([token[0].slice(lo,hi),...structuredClone(token.slice(1))]);
    offset+=token[0].length;
  }return result;
}
const annotate=(tokens,annotation)=>tokens.map(t=>[t[0],[...(t[1]||[]),annotation]]);
export function titleDiff(before,after) {
  const a=richText(before),b=richText(after);let start=0,end=0;
  while(start<Math.min(a.length,b.length)&&a[start]===b[start])start++;
  if(start&&/[\uD800-\uDBFF]/.test(a[start-1]))start--;
  while(end<Math.min(a.length,b.length)-start&&a[a.length-1-end]===b[b.length-1-end])end++;
  if(end&&/[\uDC00-\uDFFF]/.test(a[a.length-end]))end--;
  return [...sliceRichText(before,0,start),...annotate(sliceRichText(before,start,a.length-end),['-']),
    ...annotate(sliceRichText(after,start,b.length-end),['+']),...sliceRichText(before,a.length-end)];
}
function inline(tokens,annotations=[]) {
  const result=[];const append=(text,extra=[])=>{if(text)result.push([text,...(annotations.length||extra.length?[[...annotations,...extra]]:[])]);};
  for(const token of tokens||[])switch(token.type) {
    case 'strong':result.push(...inline(token.tokens,[...annotations,['b']]));break;
    case 'em':result.push(...inline(token.tokens,[...annotations,['i']]));break;
    case 'del':result.push(...inline(token.tokens,[...annotations,['s']]));break;
    case 'codespan':append(token.text,[['c']]);break;
    case 'link': {
      if(!/^(https?:|mailto:)/i.test(token.href))throw new ToolError('生成结果包含不支持的链接协议。');
      result.push(...inline(token.tokens,[...annotations,['a',token.href]]));break;
    }
    case 'br':append('\n');break;
    case 'escape':append(token.text);break;
    case 'text':if(token.tokens)result.push(...inline(token.tokens,annotations));else append(token.text);break;
    case 'html':throw new ToolError('编辑器结果应为 Markdown，暂不接受 HTML/XML。');
    case 'image':throw new ToolError('编辑器暂不支持插入生成图片。');
    default:append(token.text||token.raw||'');
  }return result;
}
export function markdownBlocks(markdown) {
  if(typeof markdown!=='string'||markdown.length>60000)throw new ToolError('编辑器结果过长或不是文本。');
  const fenced=/^```(?:markdown|md)\s*\n([\s\S]*?)\n```\s*$/i.exec(markdown.trim());
  if(fenced)markdown=fenced[1];
  let count=0;
  const block=(type,properties={},children=[],format)=>{
    if(++count>200)throw new ToolError('一次编辑最多生成 200 个区块。');
    return {id:randomUUID(),type,properties,children,...format?{format}:{}};
  };
  function convert(tokens,depth=0) {
    if(depth>8)throw new ToolError('生成结果嵌套过深。');const out=[];
    for(const token of tokens) switch(token.type) {
      case 'space':break;
      case 'heading':out.push(block(['header','sub_header','sub_sub_header'][Math.min(3,token.depth)-1],{title:inline(token.tokens)}));break;
      case 'paragraph':case 'text':out.push(block('text',{title:token.tokens?inline(token.tokens):[[token.text]]}));break;
      case 'code':out.push(block('code',{title:[[token.text]],language:[[({js:'JavaScript',ts:'TypeScript',py:'Python',json:'JSON',sh:'Shell'})[token.lang]||token.lang||'Plain Text']]}));break;
      case 'list':
        for(const item of token.items) {
          const parts=convert(item.tokens,depth+1),head=parts.shift()||block('text',{title:[]});
          head.type=item.task?'to_do':token.ordered?'numbered_list':'bulleted_list';
          if(item.task)head.properties.checked=[[item.checked?'Yes':'No']];
          head.children.push(...parts);out.push(head);
        }break;
      case 'blockquote': {
        const parts=convert(token.tokens,depth+1),head=parts.shift()||block('text',{title:[]});head.type='quote';head.children.push(...parts);out.push(head);break;
      }
      case 'hr':out.push(block('divider'));break;
      case 'table': {
        if(token.header.length>12||token.rows.length>50)throw new ToolError('表格超过 12 列或 50 行。');
        const cols=token.header.map((_,i)=>`col${i}`),rows=[token.header,...token.rows].map(row=>block('table_row',Object.fromEntries(cols.map((col,i)=>[col,inline(row[i]?.tokens||[])]))));
        out.push(block('table',{},rows,{table_block_column_order:cols,table_block_column_header:true,table_block_row_header:false}));break;
      }
      default:throw new ToolError(`编辑器暂不支持 Markdown 元素：${token.type}。`);
    }return out;
  }
  const result=convert(marked.lexer(markdown,{gfm:true}));
  if(!result.length)throw new ToolError('模型未生成可应用的编辑内容。');return result;
}
