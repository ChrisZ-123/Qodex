import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
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
 const c=fixture();c.config.conversationMode='model';
 const outputSchema={type:'object',properties:{reply:{type:'string'}},required:['reply'],additionalProperties:false};
 await c.prompt({sessionId:'owned',content:[{type:'text',text:'test'}],context:{longTermMemory:{enabled:true,content:'fixture preference'}},outputSchema});
 assert.deepEqual(c.calls[0][1].outputSchema,outputSchema);
 assert.equal(JSON.parse(c.calls[0][1].input[0].text).conversation_context.longTermMemory.content,'fixture preference');
 assert(c.calls[0][1].additionalContext.bridge_context_contract.value.length<1000);
 const longContext={persona:{content:'角色资料'.repeat(4000),botName:'Qodex'},memoryProtocol:'末尾协议'};
 await c.startTurn('long',[{type:'text',text:'test'}],longContext);
 assert.deepEqual(JSON.parse(c.calls.at(-1)[1].input[0].text).conversation_context,longContext);
 await c.startTurn('speed',[{type:'text',text:'test'}],null,null,'speed-request',{serviceTier:null});assert.equal(c.calls.at(-1)[1].serviceTier,null);assert.equal(c.calls.at(-1)[1].serviceTierForTurn,'default');
 console.log('PASS memory context and structured output forwarded to Codex turn');
}
{
 const c=fixture();c.instructions=()=>'';c.save=()=>{};c.agentCwd=()=>process.cwd();c.config.autoCompactTokenLimit=64000;
 await c.ensure('owned');assert.equal(c.calls[0][0],'thread/resume');assert.equal(c.calls[0][1].config.model_auto_compact_token_limit,64000);
 await c.ensure('owned');assert.equal(c.calls.length,1);
 await c.ensure('owned',{autoCompactTokenLimit:null});assert.deepEqual(c.calls[1][1].config,{});
 console.log('PASS native compression threshold applies to existing threads and restores default');
}

{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qodex-fresh-cwd-'));
 try{
  const c=fixture();c.root=temp;c.config.conversationMode='model';c.records={};c.live.clear();c.listModels=async()=>[{model:c.config.model,efforts:[c.config.reasoningEffort]}];
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
 const c=fixture();let calls=0;
 const model=(id,hidden=false)=>({model:id,displayName:id,hidden,supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'});
 c.rpc.request=async(method,params)=>{assert.equal(method,'model/list');calls++;return params.cursor?{data:[model('second')],nextCursor:null}:{data:[model('first'),model('hidden',true)],nextCursor:'page2'};};
 assert.deepEqual((await c.listModels()).map(m=>m.model),['first','second']);assert.equal(calls,2);
 console.log('PASS model catalog pagination and hidden-model exclusion');
}
{
 const c=fixture();c.config.conversationMode='model';c.rpc.initialize=async()=>{};
 c.rpc.request=async(method,params)=>method==='account/read'?{account:{type:'chatgpt'}}:params.cursor?{data:[{model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'max'}]}],nextCursor:null}:{data:[],nextCursor:'second'};
 await c.initialize();console.log('PASS startup validates a selected model beyond the first catalog page');
}

{
 const {codexEnvironment,BOT_CODEX_HOME}=await import('../src/codex-rpc.js');
 const env=codexEnvironment({CODEX_HOME:'desktop-home',CODEX_SESSION_ID:'desktop-session',QBOT_CONSOLE_TOKEN:'fixture-secret',OPENAI_API_KEY:'fixture-secret',PATH:'kept'});
 assert.equal(env.CODEX_HOME,BOT_CODEX_HOME);
 assert.equal(env.CODEX_SESSION_ID,undefined);
 assert.equal(env.QBOT_CONSOLE_TOKEN,undefined);
 assert.equal(env.OPENAI_API_KEY,undefined);
 assert.equal(env.PATH,'kept');
 const c=fixture();c.live.clear();c.records.owned.rolloutPath=path.join(os.tmpdir(),'outside-codex-home','sessions','foreign.jsonl');
 await assert.rejects(c.ensure('owned'),/独立目录以外/);assert.equal(c.calls.length,0);
 console.log('PASS independent Codex home and out-of-bound session refusal');
}
