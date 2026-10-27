#!/usr/bin/env node
// Opt-in integration check against the isolated NotionSI editor fixture only.
import { Cdp } from '../src/cdp.mjs';
import { EditorSelection } from '../src/editor-selection.mjs';
import { isDeepStrictEqual } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

if(!process.argv.includes('--run'))throw new Error('Use --run to edit the isolated .local/editor-sandbox.json fixture.');
const fixture=JSON.parse(await readFile('.local/editor-sandbox.json','utf8'));
const cdp=await Cdp.connect('http://127.0.0.1:9222');let session;
const result={nativeRequestIntercepted:false,generated:false,previewHealthy:false,undone:false,outsideUnchanged:false};
try {
  const {targetInfos}=await cdp.send('Target.getTargets');
  const target=targetInfos.find(t=>t.targetId===fixture.targetId&&t.url.includes(fixture.id.replaceAll('-','')));
  if(!target||!target.title.startsWith('NotionSI'))throw new Error('Select the isolated NotionSI editor fixture.');
  session=(await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
  const evaluate=async expression=>{
    const r=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session,40000);
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;
  };
  const request=async(path,body)=>evaluate(`globalThis.__notionMockRouter.toolRequest(${JSON.stringify({id:crypto.randomUUID(),path,body})})`);
  const engine=new EditorSelection({spaceId:fixture.spaceId,request});
  const page=(await engine.tools.records([fixture.id])).get(fixture.id);
  const before=await engine.tools.records(page.content);
  const selected=[...before.values()].find(b=>b.properties?.title?.map(t=>t[0]).join('').startsWith('待整理内容'));
  const outside=[...before.values()].filter(b=>b.id!==selected?.id);
  if(!selected||!outside.length)throw new Error('Fixture source is not in its initial state.');
  const guard=await evaluate(`fetch('/api/v3/runWriter',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(async r=>({status:r.status,name:(await r.json()).name}))`);
  if(guard.name!=='NotionSIWriterError')throw new Error('runWriter is not intercepted by the local router.');
  result.nativeRequestIntercepted=true;
  await writeFile('.local/editor-before.json',JSON.stringify({page,blocks:[...before.values()]},null,2));
  const custom=process.argv.includes('--table')?'将选中的活动安排整理成表格，列为时间、事项、负责人，只输出表格。':null;
  const opened=await evaluate(`(async()=>{
    let r=globalThis.__notionSIEditorRequire||globalThis.__notionSIWebpackRequire;
    if(!r){const chunks=globalThis.rspackChunknotion_next;chunks.push([[-Date.now()],{},x=>r=x]);chunks.pop();globalThis.__notionSIEditorRequire=r;}
    if(r(304636).default.state.type!=='closed')throw new Error('Close the previous editor popup before verification.');
    const block=r(496704).K.findBlockFromId(${JSON.stringify(selected.id)})?.getBlockStore();
    if(!block)throw new Error('Native block view is not mounted.');
    r(962059).D({stores:[block]});
    const title=block.getTitleStore();r(726923).setMultiSelection({multiSelection:{start:{store:title,index:0},end:{store:title,index:${selected.properties.title.map(t=>t[0]).join('').length}}}});
    const context=r(420459).G4();if(context?.type!=='textSelection')throw new Error('Native text selection could not be constructed.');
    await r(661044).toggleInitialPrompt({environment:block.environment,context,from:'rich_text_menu',prefilledValue:${JSON.stringify(custom||'重新格式化')},...${JSON.stringify(custom?{autoSubmit:true}:{agentPrebuiltPromptType:'reformat'})}});
    return r(304636).default.state.type==='agentCompletionPopup';
  })()`);
  if(!opened)throw new Error('Native writer popup did not open.');
  console.log('Submitted native reformat request for the isolated selection.');
  const stateExpression=`(()=>{let req=globalThis.__notionSIEditorRequire;if(!req){const a=globalThis.rspackChunknotion_next;a.push([[997700124],{},r=>{req=r}]);a.pop();globalThis.__notionSIEditorRequire=req;}const p=req(304636).default.state;return{popup:p.type,working:p.writerRunStore?.state.working,result:p.writerRunStore?.state.result,request:p.writerRunStore?.state.request,crashed:document.body.innerText.includes('糟糕'),undoVisible:!!document.querySelector('[aria-label="撤销"]'),acceptVisible:!!document.querySelector('[aria-label="接受"]')}})()`;
  let state;
  for(let i=0;i<180;i++) {
    await delay(1000);state=await evaluate(stateExpression);
    if(state.crashed)throw new Error('Native editor renderer crashed.');
    if(state.result&&!state.working)break;
  }
  await writeFile('.local/editor-ui-live.json',JSON.stringify(state,null,2));
  if(state?.result?.status!=='edited')throw new Error(state?.result?.acknowledgment||'Editor request did not complete.');
  if(!state.result.sessionIdleEventId?.startsWith('notionsi_writer_'))throw new Error('Unexpected non-local writer result.');
  result.generated=true;result.previewHealthy=!state.crashed&&state.undoVisible&&state.acceptVisible;
  const after=await engine.tools.records(outside.map(b=>b.id));
  result.outsideUnchanged=outside.every(b=>isDeepStrictEqual(after.get(b.id),b));
  if(process.argv.includes('--accept')) {
    await evaluate(`document.querySelector('[aria-label="接受"]').click()`);
    const saved=await engine.tools.records([selected.id]);
    result.accepted=true;result.persisted=!isDeepStrictEqual(saved.get(selected.id).properties,selected.properties)||saved.get(selected.id).type!==selected.type;
  } else {
    await evaluate(`document.querySelector('[aria-label="撤销"]').click()`);
    for(let i=0;i<40;i++) {await delay(250);const restored=(await engine.tools.records([selected.id])).get(selected.id);if(isDeepStrictEqual(restored.properties,selected.properties)&&restored.type===selected.type){result.undone=true;break;}}
  }
  result.popupClosed=(await evaluate(stateExpression)).popup==='closed';
  result.passed=result.nativeRequestIntercepted&&result.generated&&result.previewHealthy&&result.outsideUnchanged&&result.popupClosed&&(process.argv.includes('--accept')?result.accepted&&result.persisted:result.undone);
  await writeFile('.local/editor-ui-verification.json',JSON.stringify({capturedAt:new Date().toISOString(),...result},null,2));
  console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
} catch(error){console.error(error.message);process.exitCode=1;}
finally {if(session)await cdp.send('Target.detachFromTarget',{sessionId:session}).catch(()=>{});cdp.close();}
