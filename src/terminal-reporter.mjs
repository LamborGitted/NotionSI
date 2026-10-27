import { stripVTControlCharacters } from 'node:util';

// Model text is untrusted terminal input. Remove terminal escapes/control bytes.
function terminalText(value) {
  return stripVTControlCharacters(String(value)).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,'');
}
export class TerminalReporter {
  constructor({content=true,model='AI',write=text=>process.stdout.write(text)}={}) {
    this.content=content;this.model=terminalText(model);this.write=write;
    this.sequence=0;this.active=null;this.disabled=false;
  }
  emit(text) {if(this.disabled)return;try{this.write(text);}catch{this.disabled=true;}}
  line(text) {
    if(this.active!==null){this.emit('\n');this.active=null;}
    this.emit(terminalText(text)+'\n');
  }
  text(id,text) {
    if(!this.content)return;
    const safe=terminalText(text);if(!safe)return;
    if(this.active!==id){if(this.active!==null)this.emit('\n');this.emit(`[回复 #${id}] `);this.active=id;}
    this.emit(safe);if(safe.endsWith('\n'))this.active=null;
  }
  async *stream(request,generate) {
    const id=++this.sequence;let completed=false,failed=false,chars=0;
    this.line(`[AI #${id}] 开始生成 · ${this.model}`);
    const onToolEvent=async event=>{
      const status=event.type==='start'?'开始':event.canceled?'已取消':event.isError?'失败':'完成';
      // Only names and status: never serialize arguments, results, or history.
      this.line(`[工具 #${id}] ${terminalText(event.name).replace(/[\n\t]/g,' ').slice(0,100)} · ${status}`);
      return await request.onToolEvent?.(event);
    };
    try {
      for await(const chunk of generate({...request,onToolEvent})) {
        if(typeof chunk==='string'){chars+=Array.from(chunk).length;this.text(id,chunk);}
        yield chunk;
      }
      completed=true;
    } catch(error) {failed=true;throw error;}
    finally {
      const status=request.signal?.aborted?'已停止':failed?'失败':completed?'完成':'已停止';
      this.line(`[AI #${id}] ${status} · ${chars} 字符`);
    }
  }
}
