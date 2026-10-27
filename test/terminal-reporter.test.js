import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalReporter } from '../src/terminal-reporter.js';
const collect=async stream=>{const parts=[];for await(const part of stream)parts.push(part);return parts;};

test('console output streams replies and tool progress while preserving UI callbacks and omitting raw tool data',async()=>{
  let output='';const events=[];
  const reporter=new TerminalReporter({model:'glm-5.3',write:text=>{output+=text;}});
  const parts=await collect(reporter.stream({onToolEvent:event=>events.push(event)},async function*(request){
    yield '正在读取。';
    await request.onToolEvent({type:'start',name:'view',arguments:{secret:'do not log arguments'}});
    await request.onToolEvent({type:'end',name:'view',result:{body:'do not log tool result'}});
    yield '完成🐱';
  }));
  assert.deepEqual(parts,['正在读取。','完成🐱']);assert.equal(events.length,2);
  assert.match(output,/\[工具 #1\] view · 开始/);assert.match(output,/view · 完成/);assert.match(output,/\[回复 #1\] 完成🐱/);
  assert.equal(output.includes('do not log'),false);assert.match(output,/\[AI #1\] 完成/);
});
test('terminal control sequences are stripped only in console output and status-only mode hides replies',async()=>{
  for(const content of [true,false]){
    let output='';const reporter=new TerminalReporter({content,write:text=>{output+=text;}});
    const text='answer\u001b[31m red\u001b[0m\u0007';
    assert.deepEqual(await collect(reporter.stream({},async function*(){yield text;})),[text]);
    assert.equal(/[\u001b\u0007]/.test(output),false);assert.equal(output.includes('answer'),content);
    assert.match(output,/完成/);
  }
});
test('errors and cancellations retain their original behavior and cannot be logged as successful completion',async()=>{
  let output='';const reporter=new TerminalReporter({write:text=>{output+=text;}});
  const error=new Error('private error detail');
  await assert.rejects(collect(reporter.stream({},async function*(){yield 'partial';throw error;})),e=>e===error);
  assert.match(output,/失败/);assert.equal(output.includes('private error detail'),false);
  const controller=new AbortController();controller.abort();output='';
  await collect(reporter.stream({signal:controller.signal},async function*(){}));
  assert.match(output,/已停止/);assert.equal(output.includes('完成'),false);
});
