import assert from 'node:assert/strict';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const h=await bridgeHarness();
const queue=[];
let wait;
h.api.events.mux=async function*(){
  for(;;){
    if(!queue.length)await new Promise(r=>{wait=r});
    const item=queue.shift();
    if(!item)continue;
    yield {payload:{type:'session/event',sessionId:item.sid,event:item.event}};
    item.done();
  }
};
void h.pumpMux();
async function emit(sid,type,data){await new Promise(done=>{queue.push({sid,event:{type,data},done});wait?.();wait=null;});}
try{
 h.setMode('reserved2');
 const sid=await h.ensureSession('group:456');
 await emit(sid,'model/selection',{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'high'});
 assert.equal(h.isConversationBusyV2('group:456'),false,'Selecting the restored session model must not block the next @ wake');
 await emit(sid,'turn/start',{turn:1});
 assert.equal(h.isConversationBusyV2('group:456'),true,'A real running turn must remain busy');
 await emit(sid,'model/selection',{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'high'});
 assert.equal(h.isConversationBusyV2('group:456'),true,'A model event must not clear a running turn');
 await emit(sid,'turn/end',{turn:1,reason:{kind:'completed'}});
 assert.equal(h.isConversationBusyV2('group:456'),false,'An ended turn must permit the next wake');
 await emit(sid,'turn/end',{turn:0,reason:{kind:'aborted'}});
 assert.equal(h.isConversationBusyV2('group:456'),false,'An end received after reconnect without its start must not create a busy collector');
 console.log('PASS model selection and unmatched end cannot leave a restored QQ session permanently busy');
}finally{await h.close();}
