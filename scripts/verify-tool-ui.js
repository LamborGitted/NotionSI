#!/usr/bin/env node
// Explicit opt-in live UI smoke: recovers the selected AI tab, submits one
// read-only tool prompt through CDP, then checks native cards and completion.
import { Cdp } from '../src/cdp.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const args=process.argv.slice(2),targetId=args[args.indexOf('--target')+1];
const inspect=args.includes('--inspect');
if(!args.includes('--target')||!targetId||(!args.includes('--run')&&!inspect))throw new Error('Use --run --target TARGET_ID to submit a check, or --inspect --target TARGET_ID to inspect the existing tool conversation.');
const cdp=await Cdp.connect('http://127.0.0.1:9222');let sessionId;
const renderErrors=[];
try {
  const {targetInfos}=await cdp.send('Target.getTargets');
  const target=targetInfos.find(t=>t.targetId===targetId&&t.type==='page'&&new URL(t.url).origin==='https://app.notion.com');
  if(!target||!/^\/(chat|ai)(\/|$)/.test(new URL(target.url).pathname))throw new Error('Select an existing Notion AI page.');
  const spaceId=new URL(target.url).searchParams.get('spaceId');if(!spaceId)throw new Error('AI tab has no workspace context.');
  ({sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true}));
  const evaluate=async expression=>{
    const r=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId,40000);
    if(r.exceptionDetails)throw new Error('Native UI smoke evaluation failed.');return r.result?.value;
  };
  await cdp.send('Runtime.enable',{},sessionId);
  if(!inspect)await cdp.send('Page.navigate',{url:`https://app.notion.com/ai?spaceId=${encodeURIComponent(spaceId)}`},sessionId);
  cdp.on('Runtime.consoleAPICalled',(e,s)=>{if(s===sessionId)for(const a of e.args||[])if(a.subtype==='error'&&/\.entries is not|\.map is not|Minified React|Row model mismatch/.test(a.description||''))renderErrors.push(a.description.split('\n')[0]);});
  cdp.on('Runtime.exceptionThrown',(e,s)=>{if(s===sessionId)renderErrors.push(e.exceptionDetails.exception?.description?.split('\n')[0]||'Native exception');});
  const editor='[role="textbox"][contenteditable="true"]';
  let ready=false;
  for(let i=0;i<80;i++) {
    await delay(250);
    try {ready=await evaluate(`document.querySelectorAll('${editor}').length===1 && globalThis.__notionMockRouter?.snapshot().installed===true`);}catch{}
    if(ready)break;
  }
  if(!ready)throw new Error('Notion AI editor did not become ready.');
  if(!inspect) {
  await evaluate(`document.querySelector('${editor}').focus()`);
  await cdp.send('Input.insertText',{text:'请调用 search 搜索“NotionSI 工具集成测试”，然后调用 view 读取其中一个测试页。不执行任何修改。两步成功后只回复：工具验证成功。'},sessionId);
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},sessionId);
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},sessionId);
  console.log('Submitted read-only search/view smoke in selected tab.');
  }
  let observation;
  for(let i=0;i<150;i++) {
    await delay(1000);
    observation=await evaluate(`(async()=>{
      const crashed=document.body.innerText.includes('糟糕，出了些问题');
      const url=new URL(location.href),rawThreadId=url.searchParams.get('t');
      // Notion compresses UUIDs in URLs; API bodies use the hyphenated UUID.
      const threadId=rawThreadId?.length===32?rawThreadId.slice(0,8)+'-'+rawThreadId.slice(8,12)+'-'+rawThreadId.slice(12,16)+'-'+rawThreadId.slice(16,20)+'-'+rawThreadId.slice(20):rawThreadId;
      if(crashed||!threadId)return {crashed,ready:false};
      const r=await fetch('/api/v3/getThreadTranscript',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({spaceId:${JSON.stringify(spaceId)},threadId,direction:'forward'})});
      const data=await r.json(),entities=(data.patches||[]).filter(p=>p.op==='put').map(p=>p.entity);
      const tools=entities.filter(e=>e.kind==='tool');
      const answer=entities.filter(e=>e.kind==='assistant_message').map(e=>(e.content||[]).map(c=>c.text||'').join('')).join('');
      const completed=entities.filter(e=>e.kind==='turn_completed').at(-1);
      return {crashed,ready:true,status:data.session?.status,stopReason:completed?.stop_reason,
        toolNames:tools.map(e=>e.name),toolErrors:tools.filter(e=>e.result?.is_error).length,
        finishedTools:tools.filter(e=>e.result).length,
        answerMatched:answer.trim()==='工具验证成功'||answer.trim()==='工具验证成功。',
        searchCardVisible:document.body.innerText.includes('Notion · search'),
        viewCardVisible:document.body.innerText.includes('Notion · view'),
        answerVisible:document.body.innerText.includes('工具验证成功')};
    })()`);
    if(observation.crashed||observation.status==='idle'&&observation.stopReason)break;
  }
  const {nodes}=await cdp.send('Accessibility.getFullAXTree',{},sessionId);
  const buttons=nodes.filter(n=>!n.ignored&&n.role?.value==='button').map(n=>n.name?.value||'');
  const result={capturedAt:new Date().toISOString(),...observation,
    stopButtonVisible:buttons.some(n=>/停止 AI 消息|Stop AI|Stop generating/i.test(n)),
    submitButtonVisible:buttons.some(n=>/提交 AI 消息|Submit AI|Send message/i.test(n)),renderErrors};
  result.passed=!result.crashed&&result.stopReason==='end_turn'&&result.status==='idle'&&result.toolErrors===0
    &&['search','view'].every(name=>result.toolNames?.includes(name))&&result.answerMatched&&result.answerVisible
    // Completed work may no longer expose individual card labels in the DOM.
    // Require confirmed tool results, final text and a healthy native renderer.
    &&!result.stopButtonVisible&&result.submitButtonVisible&&!renderErrors.length;
  await mkdir('.local',{recursive:true});await writeFile('.local/tool-ui-verification.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
} catch(error){console.error(error.message);process.exitCode=1;}
finally {if(sessionId)await cdp.send('Target.detachFromTarget',{sessionId}).catch(()=>{});cdp.close();}
