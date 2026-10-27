import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { editorFixture } from './helpers/editor-memory.mjs';
import { markdownBlocks, richText, sliceRichText, titleDiff, normalizedProperties } from '../src/editor-markdown.mjs';
import { WriterAdapter, WRITER_PATH, WRITER_UNDO_PATH } from '../src/writer-adapter.mjs';
import { AgentMock } from '../src/agent-mock.mjs';
import { MockRouter } from '../src/router.mjs';
import { EventEmitter } from 'node:events';

test('Markdown builds native headings, nested tasks, inline annotations and tables',()=>{
  const blocks=markdownBlocks('## Agenda\n\n- [ ] **Monday**: collect names\n  - Details\n\n| Owner | Time |\n|---|---|\n| Alice | Friday |');
  assert.equal(blocks[0].type,'sub_header');assert.equal(blocks[1].type,'to_do');
  assert.deepEqual(blocks[1].properties.title[0],['Monday',[['b']]]);
  assert.equal(blocks[1].children[0].type,'bulleted_list');assert.equal(blocks[2].type,'table');
  assert.equal(blocks[2].children.length,2);
  assert.throws(()=>markdownBlocks('<script>bad</script>'),/不支持/);
  assert.throws(()=>markdownBlocks('[bad](javascript:alert%281%29)'),/链接协议/);
  assert.throws(()=>sliceRichText([['A🐱B']],2,3),/Unicode/);
  assert.equal(richText(titleDiff([['keep old end']],[['keep new end']])), 'keep oldnew end');
});

test('whole-block editing and undo preserve all unselected blocks, their IDs, annotations and order',async()=>{
  const f=editorFixture({titles:['Original selection']}),outside=structuredClone(f.blocks.get(f.outsideId)),parentContent=[...f.blocks.get(f.pageId).content];
  const snapshot=await f.engine.prepare(f.context);
  const applied=await f.engine.apply(snapshot,'## Result\n\n- [ ] First\n- [ ] Second');
  assert.equal(f.blocks.get(f.ids[0]).type,'sub_header');assert.equal(applied.blockDiffs.length,3);
  assert.deepEqual(f.blocks.get(f.outsideId),outside);
  await f.engine.undo(applied.undo);
  assert.deepEqual(f.blocks.get(f.outsideId),outside);assert.deepEqual(f.blocks.get(f.pageId).content,parentContent);
  assert.equal(richText(f.blocks.get(f.ids[0]).properties.title),'Original selection');
  assert.equal(f.blocks.get(f.ids[0]).type,'text');
  for(const id of applied.undo.createdIds)assert.equal(f.blocks.get(id).alive,false);
});

test('partial rich-text editing preserves annotated prefix and suffix and restores them on undo',async()=>{
  const rich=[['prefix ',[['b']]],['TARGET'],[' suffix',[['i']]]],f=editorFixture({rich});
  f.context.selection.value.start.index=7;f.context.selection.value.end.index=13;f.context.selection.text='TARGET';
  const snapshot=await f.engine.prepare(f.context),applied=await f.engine.apply(snapshot,'**replacement**');
  const title=f.blocks.get(f.ids[0]).properties.title;
  assert.equal(richText(title),'prefix replacement suffix');assert.deepEqual(title[0],rich[0]);assert.deepEqual(title.at(-1),rich.at(-1));
  await f.engine.undo(applied.undo);assert.deepEqual(f.blocks.get(f.ids[0]).properties.title,rich);
});

test('server-normalized empty table cells and merged rich text pass readback; nested rows undo cleanly',async()=>{
  const f=editorFixture({titles:['Original source']}),request=f.engine.tools.request;
  f.engine.tools.request=async(...args)=>{
    const response=await request(...args);
    if(args[0]==='saveTransactionsFanout')for(const b of f.blocks.values()) {
      b.properties=normalizedProperties(b.properties);
      if(!Object.keys(b.properties).length)delete b.properties;
    }
    return response;
  };
  assert.deepEqual(normalizedProperties({title:[['a'],['b',[]]],col2:[]}),{title:[['ab']]});
  const change=await f.engine.apply(await f.engine.prepare(f.context),'| Time | Owner |\n|---|---|\n| Monday | |');
  assert.equal(f.blocks.get(f.ids[0]).type,'table');assert.equal(change.undo.createdIds.length,2);
  assert.equal(f.blocks.get(change.undo.createdIds[1]).properties.col1,undefined);
  await f.engine.undo(change.undo);
  assert.equal(richText(f.blocks.get(f.ids[0]).properties.title),'Original source');
  assert.deepEqual(f.blocks.get(f.pageId).content,[f.outsideId,...f.ids]);
  const removals=f.calls.filter(c=>c.path==='saveTransactionsFanout').at(-1).body.transactions.flatMap(tx=>tx.operations).filter(op=>op.command==='listRemove');
  assert.equal(removals.length,0,'nested rows must not be removed from the page sibling list');
});

test('continuous multi-block selections hydrate full text beyond the client preview and undo keeps original IDs',async()=>{
  const f=editorFixture({titles:['one','two','three']});
  f.context.selection={type:'blocks',value:f.ids.map(id=>({table:'block',id,spaceId:f.spaceId})),text:'on',isPreviewTruncated:true};
  const snapshot=await f.engine.prepare(f.context);assert.equal(snapshot.text,'one\n\ntwo\n\nthree');
  const applied=await f.engine.apply(snapshot,'Combined');
  assert.equal(f.blocks.get(f.ids[1]).alive,false);assert.equal(f.blocks.get(f.ids[2]).alive,false);
  await f.engine.undo(applied.undo);
  assert.deepEqual(f.blocks.get(f.pageId).content,[f.outsideId,...f.ids]);
  assert.deepEqual(f.ids.map(id=>richText(f.blocks.get(id).properties.title)),['one','two','three']);
});

test('summary and continuation insertion preserve the original selection and can be undone',async()=>{
  const f=editorFixture({titles:['Original source']}),snapshot=await f.engine.prepare(f.context);
  const applied=await f.engine.append(snapshot,'### Summary\n\nNew summary');
  assert.equal(richText(f.blocks.get(f.ids[0]).properties.title),'Original source');
  assert.equal(f.blocks.get(f.pageId).content.length,4);
  await f.engine.undo(applied.undo);
  assert.deepEqual(f.blocks.get(f.pageId).content,[f.outsideId,...f.ids]);
});

test('changed, unrelated, nested and cross-workspace selections fail before writes; undo refuses later edits',async()=>{
  const f=editorFixture(),snapshot=await f.engine.prepare(f.context);
  f.blocks.get(f.ids[0]).version++;f.blocks.get(f.ids[0]).properties.title=[['User changed it']];
  await assert.rejects(f.engine.apply(snapshot,'overwrite'),/已被修改/);
  assert.equal(f.calls.some(c=>c.path==='saveTransactionsFanout'),false);
  await assert.rejects(f.engine.prepare(f.context),/不一致|范围无效/);
  const g=editorFixture();g.context.selectionPageId=randomUUID();await assert.rejects(g.engine.prepare(g.context),/不匹配/);
  const h=editorFixture();h.context.selection.value.start.pointer.spaceId=randomUUID();await assert.rejects(h.engine.prepare(h.context),/工作区/);
  const k=editorFixture();k.blocks.get(k.ids[0]).content=[randomUUID()];await assert.rejects(k.engine.prepare(k.context),/嵌套/);
  const m=editorFixture(),applied=await m.engine.apply(await m.engine.prepare(m.context),'Updated');
  m.blocks.get(m.ids[0]).version++;m.blocks.get(m.ids[0]).properties.title=[['Subsequent edit']];
  await assert.rejects(m.engine.undo(applied.undo),/拒绝覆盖/);
  assert.equal(richText(m.blocks.get(m.ids[0]).properties.title),'Subsequent edit');
});

function writerFixture(generateText) {
  const f=editorFixture({titles:['Monday: collect names. Friday: hold meeting.']}),agent=new AgentMock({delayMs:0});let generations=0;
  const writer=new WriterAdapter({agent,createSelection:()=>f.engine,generateText:request=>{generations++;return generateText(request);}});
  const body={spaceId:f.spaceId,threadId:randomUUID(),clientMessageId:randomUUID(),type:'personal_agent',content:[{type:'text',text:[['重新格式化']]}],prebuiltPromptType:'reformat',threadContext:f.context};
  return {...f,agent,writer,body,generations:()=>generations,options:{toolContext:{spaceId:f.spaceId}}};
}
test('runWriter returns native JSON diff/undo metadata; retry and undo are idempotent',async()=>{
  const f=writerFixture(async function*(request){
    assert.equal(request.editorTask,true);assert.ok(request.messages.at(-1).content.includes('Monday: collect names'));
    yield '## Agenda\n\n- Monday: collect names\n- Friday: hold meeting';
  });
  const [response,retry]=await Promise.all([f.writer.handle(WRITER_PATH,f.body,f.options),f.writer.handle(WRITER_PATH,f.body,f.options)]);
  assert.equal(f.generations(),1);assert.equal(response.body.status,'edited');assert.equal(response.body.undoReady,true);
  assert.equal(retry.body.sessionIdleEventId,response.body.sessionIdleEventId);assert.ok(response.body.blockDiffs.length);
  const changed=await f.writer.handle(WRITER_PATH,{...f.body,content:[{type:'text',text:'different'}]},f.options);assert.equal(changed.status,409);
  const undoBody={spaceId:f.spaceId,threadId:f.body.threadId,sessionIdleEventId:response.body.sessionIdleEventId};
  const undone=await f.writer.handle(WRITER_UNDO_PATH,undoBody);assert.equal(undone.status,200);
  const writes=f.calls.filter(c=>c.path==='saveTransactionsFanout').length;
  assert.equal((await f.writer.handle(WRITER_UNDO_PATH,undoBody)).status,200);assert.equal(f.calls.filter(c=>c.path==='saveTransactionsFanout').length,writes);
  assert.equal(f.agent.session(f.spaceId,f.body.threadId).status.status,'idle');f.writer.close();f.agent.close();
});

test('a committed edit with lost readback returns a recoverable partial result and remains undoable',async()=>{
  const f=writerFixture(async function*(){yield '## Updated\n\n- Item';}),request=f.engine.tools.request;
  let loseReadback=false,lost=false;
  f.engine.tools.request=async(...args)=>{
    if(args[0]==='syncRecordValues'&&loseReadback&&!lost){lost=true;throw new Error('Disconnected after commit');}
    const response=await request(...args);if(args[0]==='saveTransactionsFanout')loseReadback=true;return response;
  };
  const response=await f.writer.handle(WRITER_PATH,f.body,f.options);
  assert.equal(response.body.status,'partial');assert.equal(response.body.undoReady,true);
  assert.equal(f.blocks.get(f.ids[0]).type,'sub_header');
  assert.equal((await f.writer.handle(WRITER_PATH,f.body,f.options)).body.sessionIdleEventId,response.body.sessionIdleEventId);
  assert.equal(f.generations(),1);
  const undo=await f.writer.handle(WRITER_UNDO_PATH,{spaceId:f.spaceId,threadId:f.body.threadId,sessionIdleEventId:response.body.sessionIdleEventId});
  assert.equal(undo.status,200);assert.equal(richText(f.blocks.get(f.ids[0]).properties.title),'Monday: collect names. Friday: hold meeting.');
  assert.deepEqual(f.blocks.get(f.pageId).content,[f.outsideId,...f.ids]);f.writer.close();f.agent.close();
});

test('explain-only and aborted/failed generations never save edits or claim a successful edited result',async()=>{
  const f=writerFixture(async function*(){yield 'Explanation only';});f.body.prebuiltPromptType='explain_this';
  const result=await f.writer.handle(WRITER_PATH,f.body,f.options);assert.equal(result.body.status,'no_edit');assert.equal(f.calls.some(c=>c.path==='saveTransactionsFanout'),false);f.writer.close();f.agent.close();
  const g=writerFixture(async function*(){yield 'Partial';throw new Error('private provider exception');});
  const failed=await g.writer.handle(WRITER_PATH,g.body,g.options);assert.equal(failed.body.status,'failed');assert.equal(failed.body.acknowledgment.includes('private'),false);assert.equal(g.calls.some(c=>c.path==='saveTransactionsFanout'),false);g.writer.close();g.agent.close();
  const h=writerFixture(async function*(){yield 'Not committed';});const controller=new AbortController();controller.abort();
  const aborted=await h.writer.handle(WRITER_PATH,h.body,{...h.options,signal:controller.signal});assert.equal(aborted.body.status,'failed');assert.equal(h.calls.some(c=>c.path==='saveTransactionsFanout'),false);
  const session=h.agent.session(h.spaceId,h.body.threadId);assert.equal([...session.entities.values()].find(e=>e.kind==='turn_completed').stop_reason,'interrupted');h.writer.close();h.agent.close();
});

test('selected-text chat receives complete context, restricts edits to the selection and keeps transient context out of history',async()=>{
  const f=editorFixture({titles:['Selected source only']});let received;
  const provider={name:'test',stream:async function*(request){
    received=request;
    assert.ok(request.messages.some(m=>m.content.includes('Selected source only')));
    assert.equal(JSON.stringify(request.messages).includes('Unselected content'),false);
    const names=request.tools.definitions.map(t=>t.function.name);
    assert.ok(names.includes('update-selection'));assert.equal(names.includes('update-page-v2'),false);
    await assert.rejects(request.tools.execute('delete-pages',{urls:[f.pageId]}),/未开放/);
    await request.tools.execute('update-selection',{content:'Edited selection'},{signal:request.signal});
    request.onHistory([...request.messages,{role:'assistant',content:'Done'}]);yield 'Done';
  }};
  const router=new MockRouter(new EventEmitter(),{provider,toolsEnabled:true,log:()=>{}});
  router.toolRequest=(_context,path,body,signal)=>f.request(path,body,signal);
  const threadId=randomUUID();
  await router.agent.handle('/api/v3/createAgentThread',{spaceId:f.spaceId,threadId,type:'personal_agent',clientMessageId:randomUUID(),content:[{type:'text',text:'Edit the selection'}],threadContext:f.context},{toolContext:{spaceId:f.spaceId}});
  const session=router.agent.session(f.spaceId,threadId);await session.task;
  assert.ok(received);assert.deepEqual(session.history,[{role:'user',content:'Edit the selection'},{role:'assistant',content:'Done'}]);
  assert.equal(richText(f.blocks.get(f.ids[0]).properties.title),'Edited selection');
  assert.equal(f.blocks.get(f.outsideId).version,1);router.agent.close();router.writer.close();
});
