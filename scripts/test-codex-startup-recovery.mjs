import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

const rpcUrl=new URL('../src/codex-rpc.js',import.meta.url).href;
const hooks=registerHooks({load(url,context,nextLoad){
  if(url!==rpcUrl)return nextLoad(url,context);
  return {format:'module',shortCircuit:true,source:`
    export {BOT_CODEX_HOME,codexEnvironment} from ${JSON.stringify(rpcUrl+'?real-environment')};
    export class CodexRpc {
      constructor(){this.calls=[];this.accountFailures=1;this.failure='workspace routing discovery failed';}
      async initialize(){this.calls.push(['initialize',{}]);}
      async request(method,params){
        this.calls.push([method,params]);
        if(method==='account/read'){
          if(this.accountFailures-->0)throw Error(this.failure);
          return {account:{type:'chatgpt'}};
        }
        if(method==='model/list')return {data:[{model:'gpt-6.1-sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};
        throw Error('Unexpected RPC in startup test');
      }
      close(){this.closed=true;}
    }
  `};
}});
const {CodexApiClient}=await import('../src/codex-client.js');
hooks.deregister();
const config={model:'gpt-6.1-sol',reasoningEffort:'medium',serviceTier:'priority',conversationMode:'model'};
const counts=(client,method)=>client.rpc.calls.filter(([name])=>name===method).length;

for(const failure of ['workspace routing discovery failed','workspace routing discovery timed out']){
  const client=new CodexApiClient(config);
  client.rpc.failure=failure;
  await assert.rejects(client.ready,{message:failure});
  const originalRecords=structuredClone(client.records);
  await assert.doesNotReject(async()=>{
    await Promise.all(Array.from({length:12},()=>client.settings.describe({})));
  },'A healthy connection check must recover a failed startup instead of reusing its rejected promise');
  assert.equal(counts(client,'initialize'),1,'Do not repeat the successful handshake');
  assert.equal(counts(client,'account/read'),2,'Concurrent health checks share one recovery');
  assert.equal(counts(client,'model/list'),1);
  assert.deepEqual(client.records,originalRecords);
  assert.equal(client.active.size,0);
  assert.equal(client.queues.size,0);
  assert(!client.rpc.calls.some(([name])=>name.startsWith('turn/')||name.startsWith('thread/')));
}
for(const failure of ['workspace routing discovery failed','workspace routing discovery timed out']){
  const client=new CodexApiClient(config);
  client.rpc.failure=failure;
  client.rpc.accountFailures=2;
  await assert.rejects(client.ready,{message:failure});
  await assert.rejects(client.settings.describe({}),{message:failure});
  assert.equal(counts(client,'account/read'),2,'One health check performs at most one initialization');
  await client.settings.describe({});
  assert.equal(counts(client,'account/read'),3);
  await Promise.all(Array.from({length:4},()=>client.settings.describe({})));
  assert.equal(counts(client,'account/read'),3,'Ready clients do not repeat discovery');
}
for(const failure of ['机器人独立 Codex 尚未登录','account/read timed out']){
  const client=new CodexApiClient(config);
  client.rpc.failure=failure;
  await assert.rejects(client.ready,{message:failure});
  for(let n=0;n<3;n++)await assert.rejects(client.settings.describe({}),{message:failure});
  assert.equal(counts(client,'account/read'),1,'Non-routing startup failures must not trigger recovery');
}
{
  const client=new CodexApiClient({...config,model:'unavailable-fixture-model'});
  client.rpc.accountFailures=0;
  await assert.rejects(client.ready,/unavailable/);
  await assert.rejects(client.settings.describe({}),/unavailable/);
  assert.equal(counts(client,'model/list'),1,'Unavailable model must not trigger recovery or fallback');
}
for(const failure of ['workspace routing discovery failed','workspace routing discovery timed out']){
  const client=new CodexApiClient(config);
  client.rpc.failure=failure;
  await assert.rejects(client.ready,{message:failure});
  client.rpc.closed=true;
  await assert.rejects(client.settings.describe({}),{message:failure});
  assert.equal(counts(client,'account/read'),1,'Stopped processes are not silently recreated');
}
console.log('PASS failed/timed-out startup routing recovery, concurrent single initialization, unchanged sessions, no message replay, and explicit non-routing/auth/model/process failures');
