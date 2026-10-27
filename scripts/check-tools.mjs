#!/usr/bin/env node
import { Cdp } from '../src/cdp.mjs';
import { NotionNativeTools } from '../src/tools/notion-native.mjs';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';

// Explicit --write creates an isolated fixture page under a writable page.
// No existing page content is replaced by this check.
const write = process.argv.includes('--write');
const cdp=await Cdp.connect('http://127.0.0.1:9222');let sessionId;
try {
  const {targetInfos}=await cdp.send('Target.getTargets');
  const target=targetInfos.find(t=>t.type==='page'&&t.url.startsWith('https://app.notion.com/chat'));
  if(!target)throw new Error('Open Notion AI first.');
  ({sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true}));
  const spaceId=new URL(target.url).searchParams.get('spaceId');
  const tools=new NotionNativeTools({spaceId,request:async(path,body)=>{
    const response=await cdp.send('Runtime.callFunctionOn',{executionContextId:1,
      functionDeclaration:'async function(req){return globalThis.__notionMockRouter.toolRequest(req)}',
      arguments:[{value:{id:randomUUID(),path,body}}],returnByValue:true,awaitPromise:true},sessionId,40000);
    if(response.exceptionDetails)throw new Error('Native transport failed.');
    const value=response.result.value;
    if(value?.status!==200)console.error(JSON.stringify({path,status:value?.status,debug:value?.data?.debugMessage,errors:value?.data?.clientData?.errors?.map(e=>({name:e.name,type:e.clientData?.type,debug:e.debugMessage}))}));
    return value;
  }});
  const found=await tools.execute('search',{query:'',limit:10});
  const parent=found.results.find(p=>p.type==='page');if(!parent)throw new Error('No accessible ordinary parent page.');
  const out={search:true,read:false,create:false,edit:false,trash:false,database:false};
  await tools.execute('view',{urls:[parent.id]});out.read=true;
  if(write) {
    const existing=process.argv.includes('--resume')&&existsSync('.local/tools-sandbox.json')?JSON.parse(readFileSync('.local/tools-sandbox.json','utf8')):null;
    const created=existing?{pages:[existing]}:await tools.execute('create-pages',{parentPageUrl:parent.id,pages:[{title:'NotionSI 工具集成测试',content:'NotionSI sandbox\n\ninitial'}]});
    const id=created.pages[0].id;out.create=true;
    mkdirSync('.local',{recursive:true});writeFileSync('.local/tools-sandbox.json',JSON.stringify({id,url:created.pages[0].url,spaceId,targetId:target.targetId}));
    const viewed=(await tools.execute('view',{urls:[id]})).pages[0];
    const updated=existing?{page:viewed}:await tools.execute('update-page-v2',{pageUrl:id,command:'updateContent',oldStr:'initial',newStr:'verified'});
    if(!updated.page.content.includes('verified'))throw new Error('Edit readback mismatch.');out.edit=true;
    const existingDb=[...tools.state.viewed.get(id).blocks.values()].find(b=>b.collection_id);
    const db=existingDb?{database:await tools.read(existingDb.id)}:await tools.execute('create-database',{parentPageUrl:id,title:'NotionSI Test Database',properties:{Done:'checkbox',Score:'number'}});
    const hasReference=Object.values(db.database.schema).some(p=>p.name==='Reference');
    const database=await tools.execute('update-database',{databaseUrl:db.database.id,title:'NotionSI Verified Database',...hasReference?{}:{addProperties:{Reference:'url'}}});
    await tools.execute('create-pages',{parentDataSourceUrl:db.database.dataSourceId,pages:[{title:'Integration row',properties:{Done:true,Score:7}}]});
    const rows=await tools.execute('query-data-sources',{dataSourceUrl:db.database.dataSourceId});
    if(database.database.title!=='NotionSI Verified Database'||!rows.rows.length)throw new Error('Database readback mismatch.');out.database=true;
    // Keep only this new fixture for the subsequent model/UI test.
    const disposable=await tools.execute('create-pages',{parentPageUrl:id,pages:[{title:'NotionSI disposable'}]});
    await tools.execute('view',{urls:[disposable.pages[0].id]});await tools.execute('delete-pages',{urls:[disposable.pages[0].id]});out.trash=true;
  }
  mkdirSync('.local',{recursive:true});writeFileSync('.local/native-tools-verification.json',JSON.stringify({timestamp:new Date().toISOString(),...out},null,2));
  console.log(JSON.stringify(out));
} catch(error){console.error(error.message);process.exitCode=1;}
finally {if(sessionId)await cdp.send('Target.detachFromTarget',{sessionId}).catch(()=>{});cdp.close();}
