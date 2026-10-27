import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { EditorSelection } from '../../src/editor-selection.mjs';

export function editorFixture({titles=['prefix TARGET suffix'],rich}={}) {
  const spaceId=randomUUID(),pageId=randomUUID(),outsideId=randomUUID(),ids=titles.map(()=>randomUUID());
  const blocks=new Map(),calls=[];
  const block=(id,type,title,parent)=>({id,version:1,type,alive:true,space_id:spaceId,parent_id:parent,parent_table:'block',properties:{title},content:[],format:{}});
  blocks.set(pageId,{...block(pageId,'page',[['Editor fixture']],spaceId),parent_table:'space',content:[outsideId,...ids]});
  blocks.set(outsideId,block(outsideId,'text',[['Unselected content',[['b']]]],pageId));
  ids.forEach((id,i)=>blocks.set(id,block(id,'text',i===0&&rich?rich:[[titles[i]]],pageId)));
  const wrap=ids=>Object.fromEntries(ids.filter(id=>blocks.has(id)).map(id=>[id,{spaceId,value:{role:'editor',value:structuredClone(blocks.get(id))}}]));
  const request=async(path,body,signal)=>{
    signal?.throwIfAborted();calls.push({path,body:structuredClone(body)});
    if(path==='syncRecordValues')return {status:200,data:{recordMap:{__version__:3,block:wrap(body.requests.map(r=>r.pointer.id))}}};
    assert.equal(path,'saveTransactionsFanout');
    for(const tx of body.transactions)for(const op of tx.operations) {
      assert.equal(op.pointer.spaceId,spaceId);assert.equal(op.pointer.table,'block');
      const id=op.pointer.id;
      if(op.command==='set'&&!op.path.length){blocks.set(id,structuredClone(op.args));continue;}
      const b=blocks.get(id);assert.ok(b,'operation references existing block');
      if(op.command==='updateBlockPropertyValue') {
        assert.equal(op.args.primitiveOp.command,'set');b.properties=structuredClone(op.args.primitiveOp.args);
      } else if(op.command==='update')Object.assign(b,structuredClone(op.args));
      else if(op.command==='listRemove')b.content=b.content.filter(id=>id!==op.args.id);
      else if(op.command==='listAfter') {
        b.content=b.content.filter(id=>id!==op.args.id);
        const index=op.args.after?b.content.indexOf(op.args.after)+1:b.content.length;
        b.content.splice(index,0,op.args.id);
      }else throw new Error('Unsupported fixture operation '+op.command);
      b.version++;
    }
    return {status:200,data:{}};
  };
  const context={currentBlockId:pageId,selectionPageId:pageId,selection:{type:'text',value:{start:{pointer:{table:'block',id:ids[0],spaceId},index:0},end:{pointer:{table:'block',id:ids.at(-1),spaceId},index:titles.at(-1).length}},text:titles.join('\n\n')}};
  return {spaceId,pageId,outsideId,ids,blocks,calls,context,request,engine:new EditorSelection({spaceId,request})};
}
