import test from 'node:test';
import assert from 'node:assert/strict';
import { openNotion } from '../src/notion-launcher.mjs';

function fixture(overrides={}) {
  let time=0;const calls=[],connected={connected:true};
  const options={endpoint:'http://127.0.0.1:9222',executable:'Notion.exe',
    connect:async()=>{throw new Error('not ready');},processes:async()=>[],
    launch:async(executable,port)=>{calls.push({executable,port});},log:()=>{},
    sleep:async ms=>{time+=ms;},now:()=>time,...overrides};
  return {options,calls,connected};
}
test('an existing debugger is reused without inspecting or launching the app',async()=>{
  const f=fixture();f.options.connect=async()=>f.connected;
  f.options.processes=async()=>{throw new Error('must not inspect');};
  assert.equal(await openNotion(f.options),f.connected);assert.equal(f.calls.length,0);
});
test('a background instance must fully exit before a debuggable instance is launched',async()=>{
  let scans=0,started=false;const logs=[];
  const f=fixture({processes:async()=>++scans<3?[{pid:1,debugPort:null}]:[],log:text=>logs.push(text)});
  f.options.launch=async(executable,port)=>{assert.ok(scans>=3);f.calls.push({executable,port});started=true;};
  f.options.connect=async()=>{if(started)return f.connected;throw new Error();};
  assert.equal(await openNotion(f.options),f.connected);
  assert.deepEqual(f.calls,[{executable:'Notion.exe',port:'9222'}]);
  assert.match(logs[0],/系统托盘/);assert.match(logs[0],/自动启动/);
});
test('a background app is never killed or relaunched after the quit wait expires',async()=>{
  const f=fixture({processes:async()=>[{pid:1}],waitForQuitMs:2000});
  await assert.rejects(openNotion(f.options),/完全退出超时/);assert.equal(f.calls.length,0);
});
test('a debugger that becomes ready while waiting is attached without relaunching',async()=>{
  let attempts=0;const f=fixture({processes:async()=>[{pid:1}]});
  f.options.connect=async()=>{if(++attempts>=3)return f.connected;throw new Error();};
  assert.equal(await openNotion(f.options),f.connected);assert.equal(f.calls.length,0);
});
test('attach-only and a debugger on another port produce actionable errors without launching',async()=>{
  const f=fixture({attachOnly:true});await assert.rejects(openNotion(f.options),/npm start/);
  f.options.attachOnly=false;f.options.processes=async()=>[{debugPort:9333}];
  await assert.rejects(openNotion(f.options),/--endpoint http:\/\/127.0.0.1:9333/);assert.equal(f.calls.length,0);
});
test('slow fresh startup is allowed beyond the previous ten-second polling budget',async()=>{
  let started=false,attempts=0;const f=fixture();
  f.options.launch=async()=>{started=true;};
  f.options.connect=async()=>{if(started&&++attempts>25)return f.connected;throw new Error();};
  assert.equal(await openNotion(f.options),f.connected);
});
test('a spawn failure is reported immediately and an unreachable startup is bounded',async()=>{
  const f=fixture({launch:async()=>{throw new Error('spawn failed');}});
  await assert.rejects(openNotion(f.options),/spawn failed/);
  const g=fixture();await assert.rejects(openNotion(g.options),/45 秒/);
});
