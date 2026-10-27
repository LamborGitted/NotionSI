import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NotionNativeTools, notionId, parseMarkdown, ToolError } from '../src/tools/notion-native.mjs';
import { trimConversation } from '../src/conversation.mjs';

function fixture() {
  const spaceId=randomUUID(),root=randomUUID(),tables={block:new Map(),collection:new Map(),collection_view:new Map()},calls=[];
  tables.block.set(root,{id:root,type:'page',space_id:spaceId,version:1,alive:true,properties:{title:[['Sandbox']]},content:[]});
  const wrap = (table,ids) => Object.fromEntries(ids.filter(id=>tables[table]?.has(id)).map(id=>[id,{value:{value:structuredClone(tables[table].get(id)),role:'editor'},spaceId}]));
  const request=async(path,body,signal)=>{
    signal?.throwIfAborted();calls.push({path,body:structuredClone(body)});
    if(path==='syncRecordValues') {
      const recordMap={};for(const {pointer} of body.requests){recordMap[pointer.table]??={};Object.assign(recordMap[pointer.table],wrap(pointer.table,[pointer.id]));}
      return {status:200,data:{recordMap}};
    }
    if(path==='search') {
      const blocks=[...tables.block.values()].filter(b=>b.alive&&b.type==='page'&&(!body.collectionId||b.parent_id===body.collectionId));
      return {status:200,data:{results:blocks.map(b=>({id:b.id,spaceId})),recordMap:{block:wrap('block',blocks.map(b=>b.id))},total:blocks.length}};
    }
    if(path==='queryCollection')return {status:200,data:{result:{reducerResults:{results:{blockIds:[...tables.block.values()].filter(b=>b.parent_id===body.source.id&&b.alive).map(b=>b.id),hasMore:false}}}}};
    assert.equal(path,'saveTransactionsFanout');
    for(const tx of body.transactions)for(const op of tx.operations) {
      const {table,id}=op.pointer;let value=tables[table].get(id);assert.equal(op.pointer.spaceId,spaceId);
      if(op.command==='set'&&!op.path.length){value=structuredClone(op.args);tables[table].set(id,value);continue;}
      assert.ok(value);let target=value;
      for(const part of op.path.slice(0,-1))target=target[part]??={};
      const last=op.path.at(-1);
      if(op.command==='set')target[last]=structuredClone(op.args);
      if(op.command==='update')Object.assign(last?(target[last]??={}):target,structuredClone(op.args));
      if(op.command==='updateCollectionPropertySchema')Object.assign(target[last],structuredClone(op.args.primitiveOp.args));
      if(op.command==='listAfter'){const list=target[last]??=[];list.push(op.args.id);}
      value.version++;
    }
    return {status:200,data:{}};
  };
  const state={},tools=new NotionNativeTools({spaceId,request,state});
  return {spaceId,root,tables,calls,tools,state};
}

test('native page tools create, read, edit, search and trash actual records through fixed endpoints',async()=>{
  const f=fixture(),{tools,root}=f;
  const created=await tools.execute('create-pages',{parentPageUrl:root,pages:[{title:'Tool Test',content:'# Header\n\nfirst\n- [ ] task'}]});
  const id=created.pages[0].id;
  const page=(await tools.execute('view',{urls:[id]})).pages[0];
  assert.equal(page.content,'# Header\n\nfirst\n\n- [ ] task');
  const updated=await tools.execute('update-page-v2',{pageUrl:id,command:'updateContent',oldStr:'first',newStr:'second'});
  assert.ok(updated.page.content.includes('second'));
  assert.ok((await tools.execute('search',{query:'Tool'})).results.some(p=>p.id===id));
  await tools.execute('delete-pages',{urls:[id]});assert.equal(f.tables.block.get(id).alive,false);
  assert.deepEqual(new Set(f.calls.map(c=>c.path)),new Set(['syncRecordValues','saveTransactionsFanout','search']));
});

test('native writes reject unseen or stale pages, ambiguous edits, unsupported content and foreign spaces',async()=>{
  const f=fixture(),{tools,root,calls}=f;
  await assert.rejects(tools.execute('update-page-v2',{pageUrl:root,command:'replaceContent',content:'x'}),/先使用 view/);
  await tools.execute('view',{urls:[root]});f.tables.block.get(root).version++;
  await assert.rejects(tools.execute('delete-pages',{urls:[root]}),/已发生变化/);
  f.tables.block.get(root).space_id=randomUUID();
  await assert.rejects(tools.execute('view',{urls:[root]}),/不属于/);
  assert.equal(calls.filter(c=>c.path==='saveTransactionsFanout').length,0);
  assert.throws(()=>parseMarkdown('<columns>text</columns>'),ToolError);
  assert.throws(()=>parseMarkdown('```js\nunclosed'),ToolError);
  assert.throws(()=>notionId('https://evil.test/'+root),ToolError);
  assert.throws(()=>notionId('{{page-1}}'),ToolError);
  assert.equal(notionId('https://www.notion.so/Some-Title-'+root.replaceAll('-','')),root);
});

test('nested or unknown content can be read but cannot be destructively replaced',async()=>{
  const f=fixture(),child=randomUUID();f.tables.block.set(child,{id:child,version:1,type:'image',space_id:f.spaceId,properties:{},alive:true});
  f.tables.block.get(f.root).content=[child];
  const page=(await f.tools.execute('view',{urls:[f.root]})).pages[0];assert.equal(page.contentEditable,false);
  await assert.rejects(f.tools.execute('update-page-v2',{pageUrl:f.root,command:'replaceContent',content:'discard image'}),/嵌套、未知块/);
  assert.equal(f.calls.filter(c=>c.path==='saveTransactionsFanout').length,0);
});

test('database tools create schema, add columns, create rows and query a collection',async()=>{
  const f=fixture(),t=f.tools;
  const created=await t.execute('create-database',{parentPageUrl:f.root,title:'Tasks',properties:{Done:'checkbox',Score:'number'}});
  const db=created.database;
  assert.equal(Object.values(db.schema).length,3);
  const updated=await t.execute('update-database',{databaseUrl:db.id,title:'Updated Tasks',addProperties:{Link:'url'}});
  assert.equal(updated.database.title,'Updated Tasks');
  await t.execute('create-pages',{parentDataSourceUrl:db.dataSourceId,pages:[{title:'Row',properties:{Done:true,Score:5}}]});
  const result=await t.execute('query-data-sources',{dataSourceUrl:db.dataSourceId});assert.equal(result.rows.length,1);
  await assert.rejects(t.execute('query-data-sources',{dataSourceUrl:db.dataSourceId,mode:'sql'}),/不支持 SQL/);
});

test('tool failures are explicit, cancellation prevents writes and local todos remain in their conversation',async()=>{
  const f=fixture(),abort=new AbortController();abort.abort();
  await assert.rejects(f.tools.execute('create-pages',{parentPageUrl:f.root,pages:[{title:'No write'}]},{signal:abort.signal}),{name:'AbortError'});
  await assert.rejects(f.tools.execute('exit-setup-mode',{}),/未开放/);
  const result=await f.tools.execute('update-todos',{todos:[{title:'Check tools',status:'done'}]});
  assert.equal(result.storage,'local_chat_memory');assert.equal(f.calls.length,0);
  const other=fixture();assert.equal(other.state.todos.length,0);
});

test('history trimming keeps tool calls and their results in one user turn',()=>{
  const history=[{role:'user',content:'old'},...Array.from({length:10},()=>({role:'assistant',content:'old'})),{role:'user',content:'new'},{role:'assistant',tool_calls:[{id:'c'}],content:null},{role:'tool',tool_call_id:'c',content:'result'},{role:'assistant',content:'answer'}];
  const trimmed=trimConversation(history,5);assert.equal(trimmed[0].role,'user');assert.equal(trimmed.length,4);
});
