import { execFile, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync=promisify(execFile);
const processScript=String.raw`
$ErrorActionPreference='Stop'
$items=@(Get-CimInstance Win32_Process -Filter "name = 'Notion.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object {
  $debugPort=$null
  if ($_.CommandLine -match '--remote-debugging-port(?:=|\s+)(\d+)') { $debugPort=[int]$matches[1] }
  [pscustomobject]@{ pid=$_.ProcessId; executable=$_.ExecutablePath; debugPort=$debugPort }
})
ConvertTo-Json -InputObject $items -Compress
`;
function canonical(path) {try{return realpathSync(path).toLowerCase();}catch{return String(path).replaceAll('\\','/').toLowerCase();}}
export async function notionProcesses(executable) {
  if(process.platform!=='win32')return [];
  const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',processScript],{windowsHide:true,timeout:5000,maxBuffer:65536});
  const entries=JSON.parse(stdout.replace(/^\uFEFF/, '').trim()||'[]');
  return entries.filter(entry=>entry.executable&&canonical(entry.executable)===canonical(executable));
}
export function launchNotion(executable,port) {
  const child=spawn(executable,[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],{detached:true,stdio:'ignore',windowsHide:true});
  const started=new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();return started;
}

export async function openNotion({endpoint,executable,connect,attachOnly=false,waitForQuitMs=120000,log=console.log,
  processes=notionProcesses,launch=launchNotion,sleep=delay,now=Date.now}={}) {
  const port=new URL(endpoint).port;
  try{return await connect(endpoint,1000);}catch{}
  if(attachOnly)throw new Error(`未连接到 Notion 调试端口 ${port}。若当前 Notion 未开启调试，请从菜单或托盘完全退出，再执行 npm start。`);
  let running=await processes(executable);
  if(running.length) {
    const otherPort=running.find(p=>p.debugPort&&String(p.debugPort)!==port)?.debugPort;
    if(otherPort)throw new Error(`Notion 已在调试端口 ${otherPort} 运行。请执行 npm start -- --endpoint http://127.0.0.1:${otherPort}，或完全退出 Notion 后重试。`);
    log(`Notion 正在后台运行，但调试端口 ${port} 尚不可用。\n请从 Notion 菜单或系统托盘选择“退出”；只关闭窗口可能仍留在后台。\n正在等待完全退出，随后会自动启动并接管（最多 ${Math.round(waitForQuitMs/1000)} 秒，Ctrl+C 取消）。`);
    const deadline=now()+waitForQuitMs;
    while(running.length) {
      // Another launcher may have started a debuggable instance in the meantime.
      try{return await connect(endpoint,500);}catch{}
      if(now()>=deadline)throw new Error('等待 Notion 完全退出超时。请先从菜单或系统托盘退出 Notion，再执行 npm start。');
      await sleep(1000);running=await processes(executable);
    }
  }
  log(`正在启动 Notion，开启本机调试端口 ${port}…`);
  await launch(executable,port);
  const deadline=now()+45000;
  do {
    await sleep(500);
    try{return await connect(endpoint,1000);}catch{}
  }while(now()<deadline);
  throw new Error(`Notion 已尝试启动，但 45 秒内未能连接调试端口 ${port}。请检查是否还有另一份 Notion 在后台运行，或使用 --notion 指定正确的 Scoop Notion.exe。`);
}
