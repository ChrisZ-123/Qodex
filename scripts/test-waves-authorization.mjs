import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {bridgeHarness} from './audit-bridge-harness.mjs';

const h=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model'}}});
let revision=0;
const calls=[];
h.wavesClient.call=async(route,body)=>{
  calls.push({route,body});
  if(route==='/v1/authorization'){
    if(body){if(body.revision!==revision)throw Object.assign(Error('authorization revision changed'),{statusCode:409});revision++;}
    return {revision,shared:revision>0,rank:{configured:revision>0,state:revision?'configured_unverified':'unconfigured'},score:{configured:revision>0,state:revision?'configured_unverified':'unconfigured'}};
  }
  return {};
};
const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
const base='http://127.0.0.1:'+server.address().port;
const request=(body,headers={})=>fetch(base+'/api/waves/authorization',{method:body===undefined?'GET':'POST',headers:{'x-console-token':'fixture-console-token',...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
try{
  assert.equal((await fetch(base+'/api/waves/authorization')).status,401);
  assert.equal((await request(undefined,{'x-agent-token':'fixture-agent'})).status,403);
  assert.equal((await request({revision:0,shared:true,WavesToken:'fixture-author-secret'},{origin:'https://foreign.invalid'})).status,403);
  assert.equal((await request({revision:0,shared:true,WavesToken:'fixture-author-secret',path:'outside'})).status,400);
  assert.equal((await request({revision:0,shared:true,WavesToken:''})).status,400);
  assert.equal((await request({revision:0,shared:true,WavesToken:'fixture-author-secret'})).status,200);
  const state=await(await request()).json();assert.equal(state.rank.state,'configured_unverified');assert.equal(state.score.state,'configured_unverified');
  assert(!JSON.stringify(state).includes('fixture-author-secret'));
  assert.equal((await request({revision:0,shared:false,xwtoken:'fixture-other-secret'})).status,409);
  assert.equal(calls.filter(x=>x.body?.WavesToken).length,1,'Unauthorized, foreign and invalid writes never reach the private service');
  fs.mkdirSync(path.join(h.temp,'roles'),{recursive:true});
  assert(!JSON.stringify(h.chatBackup.export()).includes('fixture-author-secret'));
  assert(!JSON.stringify(h.waves.runs).includes('fixture-author-secret'));
  assert(!JSON.stringify(h.modelChat.history('group:456')).includes('fixture-author-secret'));
  console.log('PASS local authorization authentication/CSRF/allowlist/revision, metadata-only response, no model/history/backup secret propagation');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await h.close();}
