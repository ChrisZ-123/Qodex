import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ModelChat} from '../src/model-chat.js';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qbot-context-exhaustion-'));
const exhausted="Error running remote compact task: Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.";
try{
  let next=0,failPrompt=false;
  const prompts=[],sent=[],stopped=[];
  const api={sessions:{
    create:async()=>({result:{ok:true,value:{sessionId:'fixture-'+(++next)}}}),
    prompt:async p=>{prompts.push(p);if(failPrompt)throw Error(exhausted);return {result:{ok:true}};},
  },stopSessionWork:async id=>stopped.push(id)};
  const memory={ensure(){},retrieve:()=>({enabled:true,entries:[],content:'保留的群约定'}),applyModelOps(){throw Error('No memory writes expected');}};
  const chat=new ModelChat({dir,api,allowed:()=>true,send:async(k,text)=>sent.push([k,text]),persona:()=>({name:'原角色'}),memory});
  const key='group:12345',other='group:67890';
  for(let i=0;i<110;i++)chat.append(key,{kind:'user',text:'earlier-'+i,messageId:String(1000+i)});
  await chat.receive(key,{sender:'user',text:'failed-turn',messageId:'2000'});
  const oldId=chat.entry(key).sessionId;
  const oldMessages=chat.entry(key).messages.map(m=>m.id);
  await chat.receive(other,{sender:'other',text:'independent',messageId:'3000'});
  const otherId=chat.entry(other).sessionId;
  await chat.consume(oldId,{type:'turn/end',data:{reason:{kind:'aborted'},error:{message:exhausted}}});
  assert.equal(chat.entry(key).sessionId,null,'Do not reuse the thread which the native compactor cannot process');
  assert.equal(prompts.length,2,'The failed turn is not retried');
  assert.equal(chat.entry(other).sessionId,otherId);
  assert(chat.running.has(other));
  assert.equal(chat.entry(key).previousBindings.at(-1).sessionId,oldId);
  assert.equal(chat.entry(key).previousBindings.at(-1).reason,'context-window-exhausted');
  assert(oldMessages.every(id=>chat.entry(key).messages.some(m=>m.id===id)));
  const stored=new ModelChat({dir,api,allowed:()=>true,send:async()=>{},persona:()=>({}),memory});
  assert.equal(stored.entry(key).sessionId,null,'Recovery persists across restart');
  await chat.receive(key,{sender:'user',text:'new-message',messageId:'2001'});
  const newId=chat.entry(key).sessionId;
  assert.notEqual(newId,oldId);
  const current=prompts.at(-1);
  assert.equal(current.context.earlierMessages.length,100);
  assert.equal(current.context.earlierMessages.at(-1).text,'failed-turn');
  assert.equal(current.context.longTermMemory.content,'保留的群约定');
  assert.equal(current.context.persona.name,'原角色');
  await chat.consume(oldId,{type:'assistant/message',data:{message:{content:[{type:'text',text:'late old output'}]}}});
  await chat.consume(oldId,{type:'turn/end',data:{reason:{kind:'completed'}}});
  assert.equal(sent.length,0);assert.equal(chat.entry(key).sessionId,newId);assert(chat.running.has(key));
  await chat.consume(newId,{type:'turn/end',data:{reason:{kind:'aborted'},error:{message:'Error running remote compact task: Connection failed: error sending request'}}});
  assert.equal(chat.entry(key).sessionId,newId,'A network error does not discard context');
  failPrompt=true;
  await chat.receive(key,{sender:'user',text:'rpc-rejected-overflow',messageId:'2002'});
  assert.equal(chat.entry(key).sessionId,null,'Synchronous RPC context exhaustion uses the same recovery');
  assert.equal(chat.entry(key).contextStart,undefined,'Preserve the existing reset/history boundary');
  assert.equal(stopped.length,0,'Exhausted native tasks have already ended; do not interrupt other work');
  console.log('PASS context exhaustion recovery, preserved recent history/memory/persona, no replay, late-event isolation, restart persistence and independent groups');
}finally{
  const target=path.resolve(dir);
  assert.equal(path.dirname(target),path.resolve(os.tmpdir()));
  fs.rmSync(target,{recursive:true,force:true});
}
