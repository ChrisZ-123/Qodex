import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CodexApiClient} from '../src/codex-client.js';
function fixture(){
 const c=Object.create(CodexApiClient.prototype);
 Object.assign(c,{config:{model:'gpt-6-luna',reasoningEffort:'max',serviceTier:'priority'},records:{owned:{preset:'qq-chat-v2'}},live:new Set(['owned']),active:new Map(),queues:new Map(),frames:[],cancelled:new Set(),tools:new Map(),ready:Promise.resolve()});
 c.calls=[];c.rpc={request:async(m,p)=>{c.calls.push([m,p]);return{turn:{id:'turn-1'}};}};
 return c;
}
{
 const c=fixture();
 await assert.rejects(c.prompt({sessionId:'foreign',content:[{type:'text',text:'hi'}]}),/not owned/);
 await c.prompt({sessionId:'owned',content:[{type:'text',text:'hi'}]});
 assert.equal(c.calls[0][1].model,'gpt-6-luna');assert.equal(c.calls[0][1].effort,'max');assert.deepEqual(c.calls[0][1].environments,[]);
 assert.equal(c.calls[0][1].serviceTier,'priority');
 await c.prompt({sessionId:'owned',content:[{type:'text',text:'second'}]});assert.equal(c.calls.length,1);
 await c.stopSessionWork('owned');assert.equal(c.queues.has('owned'),false);assert.equal(c.calls[1][0],'turn/interrupt');
}
{
 const c=fixture();let called=0;
 c.tools.set('mcp__snowluma__qq_status',{name:'qq_status',client:{callTool:async()=>{called++;return{content:[{type:'text',text:'ok'}]};}}});
 c.active.set('owned','turn-1');
 for(const p of [{threadId:'foreign',tool:'mcp__snowluma__qq_status'},{threadId:'owned',tool:'exec_command'}])await assert.rejects(c.toolCall('item/tool/call',p),/rejected/);
 const result=await c.toolCall('item/tool/call',{threadId:'owned',tool:'mcp__snowluma__qq_status',callId:'call-1',arguments:{}});
 assert.equal(result.success,true);assert.equal(called,1);assert.equal(c.frames[1].payload.event.data.message.source.callId,'call-1');
 c.cancelled.add('owned');await assert.rejects(c.toolCall('item/tool/call',{threadId:'owned',tool:'mcp__snowluma__qq_status'}),/rejected/);
}
{
 const c=fixture();let release;
 c.rpc.request=async(m,p)=>{c.calls.push([m,p]);if(m==='turn/start')return new Promise(r=>release=r);return{};};
 const starting=c.startTurn('owned',[{type:'text',text:'hi'}]);
 await c.stopSessionWork('owned');release({turn:{id:'late'}});await starting;
 assert.equal(c.calls[1][0],'turn/interrupt');assert.equal(c.calls[1][1].turnId,'late');
}
console.log('PASS Codex model pinning, owned-session boundary, tool allowlist, queue cancellation and start/cancel race');
{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qodex-fresh-cwd-'));
 try{
  const c=fixture();c.root=temp;c.config.conversationMode='model';c.records={};c.live.clear();
  c.rpc.request=async(method,params)=>{
   assert(fs.statSync(params.cwd).isDirectory(),'Codex RPC must receive an existing cwd');
   assert.equal(params.cwd,path.join(temp,'state','agents'));
   c.calls.push([method,params]);return{model:c.config.model,thread:{id:'new-thread'}};
  };
  await c.create({agentPreset:'qq-chat'});
  assert.equal(c.calls[0][0],'thread/start');
  assert(fs.existsSync(path.join(temp,'state','codex-sessions.json')));
  fs.rmdirSync(path.join(temp,'state','agents'));c.live.clear();
  await c.ensure('new-thread');assert.equal(c.calls[1][0],'thread/resume');
  console.log('PASS clean-install thread creation and resume recreate the Codex working directory');
 }finally{
  if(!path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep+'qodex-fresh-cwd-'))throw Error('Unexpected fixture path');
  fs.rmSync(temp,{recursive:true,force:true});
 }
}
{
 const c=fixture();c.config.conversationMode='model';
 const outputSchema={type:'object',properties:{reply:{type:'string'}},required:['reply'],additionalProperties:false};
 await c.prompt({sessionId:'owned',content:[{type:'text',text:'test'}],context:{longTermMemory:{enabled:true,content:'fixture preference'}},outputSchema});
 assert.deepEqual(c.calls[0][1].outputSchema,outputSchema);
 assert.equal(JSON.parse(c.calls[0][1].additionalContext.conversation_context.value).longTermMemory.content,'fixture preference');
 console.log('PASS memory context and structured output forwarded to Codex turn');
}
