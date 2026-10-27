import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { NotionNativeTools, ToolError, notionId } from './tools/notion-native.mjs';
import { markdownBlocks, richText, sliceRichText, titleDiff, normalizedProperties } from './editor-markdown.mjs';

const fail=message=>{throw new ToolError(message);};
const pointer=(id,spaceId)=>({table:'block',id,spaceId});
const equal=isDeepStrictEqual;
const TEXT_TYPES=new Set(['text','header','sub_header','sub_sub_header','bulleted_list','numbered_list','to_do','quote','code','callout']);
export class EditorSelection {
  constructor({request,spaceId}){this.tools=new NotionNativeTools({request,spaceId});this.spaceId=this.tools.spaceId;}
  async prepare(context,signal) {
    if(!context?.selection)fail('编辑器请求缺少选区。');
    const selection=context.selection,pageId=notionId(context.selectionPageId||context.currentBlockId);
    let firstId,lastId,ids,start,end;
    if(selection.type==='text') {
      const value=selection.value;
      if(value?.start?.pointer?.table!=='block'||value?.end?.pointer?.table!=='block')fail('只支持 Notion 文本区块选区。');
      for(const p of [value.start.pointer,value.end.pointer])if(p.spaceId&&notionId(p.spaceId)!==this.spaceId)fail('选区不属于当前工作区。');
      firstId=notionId(value.start.pointer.id);lastId=notionId(value.end.pointer.id);start=value.start.index;end=value.end.index;
    } else if(selection.type==='blocks') {
      if(!Array.isArray(selection.value)||!selection.value.length||selection.value.length>100)fail('区块选区必须包含 1..100 个区块。');
      ids=selection.value.map(p=>{if(p.table!=='block'||p.transclusion)fail('暂不支持跨引用区块的选区。');if(p.spaceId&&notionId(p.spaceId)!==this.spaceId)fail('选区跨工作区。');return notionId(p.id);});
      firstId=ids[0];lastId=ids.at(-1);start=0;
    } else fail('暂不支持此选区类型。');
    const ends=await this.tools.records([...new Set([firstId,lastId])],'block',signal),first=ends.get(firstId),last=ends.get(lastId);
    if(first.parent_table!=='block'||last.parent_id!==first.parent_id||last.parent_table!=='block')fail('当前支持同一父级中连续的文本或区块选区。');
    const parent=(await this.tools.records([first.parent_id],'block',signal)).get(first.parent_id);
    if(!Array.isArray(parent.content))fail('父对象没有可编辑的区块序列。');
    const begin=parent.content.indexOf(firstId),finish=parent.content.indexOf(lastId);
    if(begin<0||finish<begin)fail('选区顺序已改变，请重新选择。');
    const contiguous=parent.content.slice(begin,finish+1);
    if(contiguous.length>100||ids&&!equal(ids,contiguous))fail('请选择连续的文本区块。');
    ids=contiguous;
    const blocks=await this.tools.records(ids,'block',signal);
    for(const b of blocks.values())if(!b.alive||!TEXT_TYPES.has(b.type)||b.content?.length)fail('暂不支持包含嵌套内容、图片或数据库的选区。');
    // Verify the selected blocks really belong to the supplied page.
    let ancestor=parent;const visited=new Set();
    while(ancestor.id!==pageId) {
      if(visited.has(ancestor.id)||visited.size>=30||ancestor.parent_table!=='block')fail('选区与当前页面不匹配。');
      visited.add(ancestor.id);ancestor=(await this.tools.records([ancestor.parent_id],'block',signal)).get(ancestor.parent_id);
    }
    if(selection.type==='blocks')end=richText(last.properties?.title).length;
    const pieces=ids.map((id,i)=>sliceRichText(blocks.get(id).properties?.title||[],i===0?start:0,i===ids.length-1?end:richText(blocks.get(id).properties?.title).length));
    const text=pieces.map(richText).join('\n\n');
    if(!text.trim()||text.length>50000)fail('选区为空或超过 50000 字符。');
    if(typeof selection.text==='string'&&!selection.isPreviewTruncated&&!equal(selection.text,text)&&selection.text!==pieces.map(richText).join('\n'))fail('选中文字与当前内容不一致，请重新选择后重试。');
    return {pageId,parent:structuredClone(parent),ids,blocks:structuredClone(blocks),start,end,text,
      prefix:sliceRichText(first.properties?.title||[],0,start),suffix:sliceRichText(last.properties?.title||[],end)};
  }
  properties(id,properties){return this.tools.op(id,'updateBlockPropertyValue',['properties'],{primitiveOp:{command:'set',args:properties}});}
  async verify(snapshot,signal) {
    const records=await this.tools.records([...snapshot.ids,snapshot.parent.id],'block',signal);
    for(const id of snapshot.ids)if(records.get(id).version!==snapshot.blocks.get(id).version)fail('生成期间选区已被修改，请重新选择；未覆盖现有内容。');
    if(!equal(records.get(snapshot.parent.id).content,snapshot.parent.content))fail('生成期间区块顺序已变化，请重新选择。');
  }
  async append(snapshot,markdown,signal) {
    await this.verify(snapshot,signal);
    const id=snapshot.ids.at(-1),last=snapshot.blocks.get(id);
    const insertion={...snapshot,ids:[id],blocks:new Map([[id,last]]),start:snapshot.end,end:snapshot.end,
      prefix:sliceRichText(last.properties?.title||[],0,snapshot.end),suffix:sliceRichText(last.properties?.title||[],snapshot.end)};
    return this.apply(insertion,markdown,signal,true);
  }
  async apply(snapshot,markdown,signal,separate=false) {
    this.pendingChange=undefined;this.lastApplied=undefined;
    let roots=markdownBlocks(markdown);
    const original=snapshot.blocks.get(snapshot.ids[0]),last=snapshot.blocks.get(snapshot.ids.at(-1));
    if(!separate&&roots.length===1&&roots[0].type==='text'&&!roots[0].children.length) {
      roots[0].type=snapshot.prefix.length||snapshot.suffix.length?original.type:roots[0].type;
      roots[0].properties={...original.properties,...roots[0].properties,title:[...snapshot.prefix,...roots[0].properties.title,...snapshot.suffix]};
    } else {
      if(snapshot.prefix.length)roots.unshift({id:randomUUID(),type:original.type,properties:{...original.properties,title:snapshot.prefix},children:[],format:original.format});
      if(snapshot.suffix.length)roots.push({id:randomUUID(),type:last.type,properties:{...last.properties,title:snapshot.suffix},children:[],format:last.format});
    }
    roots[0].id=original.id;
    const values=[],create=(node,parentId)=>{
      const value={...this.tools.base(node.id,node.type,parentId),properties:node.properties,content:node.children.map(c=>c.id),...node.format?{format:node.format}:{}};
      values.push(value);for(const child of node.children)create(child,node.id);
    };
    for(const root of roots)create(root,snapshot.parent.id);
    const ops=[];
    for(const v of values) {
      if(v.id===original.id){ops.push(this.properties(v.id,v.properties),this.tools.op(v.id,'update',[],{type:v.type,content:v.content,...v.format?{format:v.format}:{}}));}
      else ops.push(this.tools.op(v.id,'set',[],v));
    }
    for(const id of snapshot.ids.slice(1))ops.push(this.tools.op(id,'update',[],{alive:false}),this.tools.op(snapshot.parent.id,'listRemove',['content'],{id}));
    for(let i=1;i<roots.length;i++)ops.push(this.tools.op(snapshot.parent.id,'listAfter',['content'],{id:roots[i].id,after:roots[i-1].id}));
    await this.verify(snapshot,signal);signal?.throwIfAborted();
    const expected=new Map(snapshot.blocks);
    for(const v of values)expected.set(v.id,{...expected.get(v.id),...v});
    for(const id of snapshot.ids.slice(1))expected.set(id,{...expected.get(id),alive:false});
    const index=snapshot.parent.content.indexOf(snapshot.ids[0]);
    expected.set(snapshot.parent.id,{...snapshot.parent,content:[...snapshot.parent.content.slice(0,index),...roots.map(b=>b.id),...snapshot.parent.content.slice(index+snapshot.ids.length)]});
    const undo={snapshot:structuredClone(snapshot),createdIds:values.filter(v=>v.id!==original.id).map(v=>v.id),createdRootIds:roots.slice(1).map(v=>v.id),expected,applied:null};
    this.pendingChange=undo;
    try{await this.tools.save(ops,signal);}catch(error){if(/HTTP (400|401|403|404|409|422)/.test(error.message))this.pendingChange=undefined;throw error;}
    // Once accepted by the server, retain readback/undo even if the UI disconnects.
    const affected=[...new Set([...values.map(v=>v.id),...snapshot.ids,snapshot.parent.id])];
    const current=await this.tools.records(affected,'block');
    undo.applied=current;
    const blockDiffs=[{pointer:pointer(original.id,this.spaceId),type:'update',titleDiff:titleDiff(original.properties?.title||[],values[0].properties?.title||[])}];
    for(const v of values.slice(1))blockDiffs.push({pointer:pointer(v.id,this.spaceId),type:'create',titleDiff:(v.properties.title||[]).map(t=>[t[0],[...(t[1]||[]),['+']]])});
    for(const id of snapshot.ids.slice(1))blockDiffs.push({pointer:pointer(id,this.spaceId),type:'delete',blockValue:snapshot.blocks.get(id),positioning:{parentPointer:pointer(snapshot.parent.id,this.spaceId),anchorChain:[{type:'existing',id:original.id},{type:'start'}]}});
    const result={undo,blockDiffs,recordMap:await this.recordMap(affected),affected};this.lastApplied=result;
    for(const v of values)if(current.get(v.id).type!==v.type||!equal(normalizedProperties(current.get(v.id).properties),normalizedProperties(v.properties)))fail('编辑结果未能完整确认，请重新读取后再操作。');
    return result;
  }
  async recordMap(ids) {
    const data=await this.tools.api('syncRecordValues',{requests:ids.map(id=>({pointer:pointer(id,this.spaceId),version:-1}))});return data.recordMap;
  }
  async undo(change,signal) {
    const {snapshot,createdIds,applied,expected}=change;
    const ids=[...(applied||expected).keys()],now=await this.tools.records(ids,'block',signal);
    for(const id of ids) {
      if(applied) {if(now.get(id).version!==applied.get(id).version)fail('编辑之后内容已发生变化，拒绝覆盖新修改；请手动撤销或恢复。');}
      else {const a=now.get(id),b=expected.get(id);if(a.type!==b.type||a.alive!==b.alive||!equal(a.content||[],b.content||[])||!equal(normalizedProperties(a.properties),normalizedProperties(b.properties)))fail('无法确认写入结果与待撤销内容一致；拒绝覆盖文档。');}
    }
    const ops=[];
    for(const [id,b] of snapshot.blocks)ops.push(this.properties(id,b.properties||{}),this.tools.op(id,'update',[],{type:b.type,alive:b.alive,content:b.content||[],format:b.format||{}}));
    for(const id of createdIds){ops.push(this.tools.op(id,'update',[],{alive:false}));if((change.createdRootIds||createdIds.filter(key=>(applied||expected).get(key)?.parent_id===snapshot.parent.id)).includes(id))ops.push(this.tools.op(snapshot.parent.id,'listRemove',['content'],{id}));}
    for(let i=1;i<snapshot.ids.length;i++)ops.push(this.tools.op(snapshot.parent.id,'listAfter',['content'],{id:snapshot.ids[i],after:snapshot.ids[i-1]}));
    await this.tools.save(ops,signal);
    const restored=await this.tools.records(snapshot.ids,'block');
    for(const [id,b]of snapshot.blocks)if(!equal(normalizedProperties(restored.get(id).properties),normalizedProperties(b.properties))||restored.get(id).type!==b.type)fail('撤销结果尚未确认，请重新读取。');
    return {recordMap:await this.recordMap(ids)};
  }
}
