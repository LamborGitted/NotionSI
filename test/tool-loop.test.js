import test from 'node:test';
import assert from 'node:assert/strict';
import { ZhipuProvider } from '../src/providers/zhipu.js';
import { ToolError } from '../src/tools/notion-native.js';
import { AgentMock } from '../src/agent-mock.js';

const event=(delta,finish_reason=null)=>`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason}]})}\n\n`;
const response=body=>new Response(body,{headers:{'content-type':'text/event-stream'}});
const textResponse=()=>response(event({content:'finished'},'stop')+'data: [DONE]\n\n');
const callResponse=(name='view',args='{"urls":["id"]}',id='call_1')=>response(event({reasoning_content:'private model reasoning'})+event({tool_calls:[{index:0,id,type:'function',function:{name,arguments:args}}]},'tool_calls')+'data: [DONE]\n\n');
const collect=async stream=>{let text='';for await(const part of stream)text+=part;return text;};
const definitions=[{type:'function',function:{name:'view',parameters:{type:'object',properties:{urls:{type:'array',items:{type:'string'}}}}}}];
const input=[{role:'user',content:'read a page'}];

test('fragmented tool calls execute once; reasoning and tool results reach the next round; only text is displayed',async()=>{
  const requests=[],events=[],executed=[];let history;
  const provider=new ZhipuProvider({apiKey:'test-only',systemPrompt:'full prompt',fetchImpl:async(_url,init)=>{
    requests.push(JSON.parse(init.body));
    if(requests.length===1)return response(event({reasoning_content:'private thought'})+event({tool_calls:[{index:0,id:'call_a',type:'function',function:{name:'vi',arguments:'{"urls":'}}]})+event({tool_calls:[{index:0,function:{name:'ew',arguments:'["id"]}'}}]},'tool_calls'));
    return textResponse();
  }});
  const tools={definitions,instructions:'tool adapter',execute:async(name,args)=>{executed.push({name,args});return{content:'actual readback'};}};
  const answer=await collect(provider.stream({messages:input,tools,onToolEvent:e=>events.push(e),onHistory:h=>{history=h;}}));
  assert.equal(answer,'finished');assert.equal(executed.length,1);
  assert.deepEqual(executed[0],{name:'view',args:{urls:['id']}});
  assert.equal(requests[1].messages[0].content,'full prompt\n\ntool adapter');
  assert.equal(requests[1].messages[2].reasoning_content,'private thought');
  assert.equal(requests[1].messages[3].role,'tool');assert.equal(requests[1].messages[3].tool_call_id,'call_a');
  assert.equal(events.map(e=>e.type).join(','),'start,end');
  assert.equal(history.at(-1).content,'finished');assert.equal(history.some(m=>m.role==='system'),false);
  assert.equal(input.length,1);
});

test('invalid JSON, unknown names and executor errors return tool errors without raw exceptions or execution',async()=>{
  for(const [name,args]of [['view','{broken'],['unknown','{}'],['view','{}']]){
    let n=0,calls=0,next;
    const p=new ZhipuProvider({apiKey:'test-only',fetchImpl:async(_u,init)=>{n++;if(n===1)return callResponse(name,args);next=JSON.parse(init.body);return textResponse();}});
    await collect(p.stream({messages:input,tools:{definitions,execute:async()=>{calls++;throw new Error('secret exception');}}}));
    assert.equal(calls,args==='{}'&&name==='view'?1:0);
    const result=JSON.parse(next.messages.at(-1).content);assert.equal(result.is_error,true);assert.equal(result.message.includes('secret exception'),false);
  }
});

test('a failed tool can be corrected and followed by a real successful result',async()=>{
  let fetches=0,executed=0;const p=new ZhipuProvider({apiKey:'test-only',fetchImpl:async()=>++fetches<3?callResponse('view','{}','call_'+fetches):textResponse()});
  const result=await collect(p.stream({messages:input,tools:{definitions,execute:async()=>{if(!executed++)throw new ToolError('请先读取');return{ok:true};}}}));
  assert.equal(result,'finished');assert.equal(executed,2);
});

test('bounded tool loop stops repeated calls and an incomplete stream never executes tools',async()=>{
  let fetches=0,executed=0;
  const p=new ZhipuProvider({apiKey:'test-only',fetchImpl:async()=>callResponse('view','{}','call_'+(++fetches))});
  await assert.rejects(collect(p.stream({messages:input,tools:{definitions,execute:async()=>{executed++;return{};}}})),/上限/);
  assert.equal(executed,7);assert.equal(fetches,8);
  const broken=new ZhipuProvider({apiKey:'test-only',fetchImpl:async()=>response(event({tool_calls:[{index:0,id:'c',function:{name:'view',arguments:'{}'}}]}))});
  await assert.rejects(collect(broken.stream({messages:input,tools:{definitions,execute:async()=>{executed++;}}})),/提前结束/);
  assert.equal(executed,7);
});

test('interrupt during tool execution aborts the executor and ends the native transcript idle',async()=>{
  let toolStarted,signalSeen;const started=new Promise(r=>{toolStarted=r;});
  const provider=new ZhipuProvider({apiKey:'test-only',fetchImpl:async()=>callResponse()});
  const agent=new AgentMock({generateText:req=>provider.stream({...req,tools:{definitions,execute:(_n,_a,{signal})=>{
    signalSeen=signal;toolStarted();return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }}})});
  const spaceId='space',threadId='thread';
  await agent.handle('/api/v3/createAgentThread',{spaceId,threadId,type:'personal_agent',clientMessageId:'message',content:[{type:'text',text:'read'}]});
  await started;
  await agent.handle('/api/v3/sendEventToAgentThread',{spaceId,threadId,clientEventId:'stop',event:{type:'user.interrupt'}});
  const session=agent.session(spaceId,threadId);await session.task;
  assert.equal(signalSeen.aborted,true);assert.equal(session.status.status,'idle');
  assert.equal([...session.entities.values()].find(e=>e.kind==='turn_completed').stop_reason,'interrupted');
  const tool=[...session.entities.values()].find(e=>e.kind==='tool');assert.equal(tool.interaction_status,'dismissed');agent.close();
});

test('native generic tool cards provide TextToken[] in every renderer status, including errors and cancel',async()=>{
  for(const outcome of ['success','error','cancel']) {
    let initial;
    const agent=new AgentMock({generateText:async function*(req){
      req.onToolEvent({type:'start',id:'tool_native',name:'search'});
      initial=agent.snapshot(agent.session('space','thread')).find(p=>p.entity?.kind==='tool').entity;
      req.onToolEvent({type:'end',id:'tool_native',name:'search',isError:outcome==='error',canceled:outcome==='cancel'});
      yield '工具验证成功';
    }});
    await agent.handle('/api/v3/createAgentThread',{spaceId:'space',threadId:'thread',type:'personal_agent',clientMessageId:'message',content:[{type:'text',text:'search'}]});
    const session=agent.session('space','thread');await session.task;
    const finished=agent.snapshot(session).find(p=>p.entity?.kind==='tool').entity;
    for(const entity of [initial,finished])for(const status of ['running','finished','errored','canceled']) {
      // Actual native consumer iterates value.entries(), and interprets each
      // item as a rich-text token. Exercise that contract on serialized wire data.
      const wire=JSON.parse(JSON.stringify(entity));
      assert.ok(Array.isArray(wire.text[status]),`${outcome}/${status} must be a rich-text array`);
      for(const [,token]of wire.text[status].entries())assert.equal(typeof token[0],'string');
      assert.equal(wire.text[status].map(token=>token[0]).join(''),'Notion · search');
    }
    assert.equal(finished.result.is_error,outcome==='error');
    assert.equal(session.status.status,'idle');agent.close();
  }
});
