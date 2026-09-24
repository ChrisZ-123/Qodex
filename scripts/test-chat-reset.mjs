import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ModelChat} from '../src/model-chat.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-reset-'));
try{
 let index=0;const calls=[],sent=[],stopped=[];
 const api={sessions:{create:async()=>({result:{ok:true,value:{sessionId:'s'+(++index)}}}),prompt:async p=>{calls.push(p);return {result:{ok:true}};}},stopSessionWork:async id=>stopped.push(id)};
 const chat=new ModelChat({dir,api,allowed:()=>true,send:async(k,t)=>sent.push(t),persona:()=>({})});
 await chat.receive('group:1',{text:'before',sender:'a'});
 await chat.reset('group:1');assert.equal(stopped[0],'s1');
 await chat.receive('group:1',{text:'after',sender:'a'});
 assert.equal(calls[1].sessionId,'s2');assert.deepEqual(calls[1].context.earlierMessages,[]);
 await chat.consume('s1',{type:'assistant/message',data:{message:{content:[{type:'text',text:'stale'}]}}});
 await chat.consume('s1',{type:'turn/end',data:{reason:{kind:'completed'}}});assert.equal(sent.length,0);assert(chat.running.has('group:1'));
 const restored=new ModelChat({dir,api,allowed:()=>true,send:async()=>{},persona:()=>({})});assert(restored.entry('group:1').contextStart>0);assert(restored.history('group:1').messages.some(m=>m.text==='before'));
 let release;api.sessions.create=()=>new Promise(r=>release=r);
 const starting=chat.receive('group:2',{text:'old'});await Promise.resolve();await chat.reset('group:2');
 api.sessions.create=async()=>({result:{ok:true,value:{sessionId:'new'}}});await chat.receive('group:2',{text:'new'});
 release({result:{ok:true,value:{sessionId:'late'}}});await starting;
 assert.equal(chat.entry('group:2').sessionId,'new');assert.equal(chat.running.get('group:2').sessionId,'new');assert(stopped.includes('late'));
 console.log('PASS reset isolates old replies, preserves history, excludes pre-reset context and handles creation race');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
