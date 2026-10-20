// Isolated public UI fixture: fictional data, no QQ/Codex/player account calls.
import fs from 'node:fs';
import path from 'node:path';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const group='group:20001',sender='30001';
const h=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max',serviceTier:'default'},allow:{groups:['20001','20002'],private:['10001']},ownerQQ:'10001'}});
fs.mkdirSync(path.join(h.temp,'public'),{recursive:true});
for(const file of ['model-console.html','model-controls.js','model-waves.js']){
 const from=new URL('../public/'+file,import.meta.url),to=path.join(h.temp,'public',file);
 fs.copyFileSync(from,to);fs.watchFile(from,{interval:500,persistent:false},()=>fs.copyFileSync(from,to));
}
fs.mkdirSync(path.join(h.temp,'roles'),{recursive:true});
fs.copyFileSync(new URL('../roles/自然群友.md',import.meta.url),path.join(h.temp,'roles','自然群友.md'));
fs.writeFileSync(path.join(h.temp,'state','current-role.json'),JSON.stringify({role:'自然群友'}));
fs.writeFileSync(path.join(h.temp,'state','chat-expression.json'),JSON.stringify({replyMode:'natural',imageMode:'requested',stickerStyle:'natural',voiceEnabled:false}));
fs.mkdirSync(h.waves.root,{recursive:true});fs.writeFileSync(path.join(h.waves.root,'installation.json'),JSON.stringify({version:1,complete:true}));
h.wavesSettings.update({enabled:true,revision:h.wavesSettings.data.revision});
let authorization={revision:0,shared:false,rank:{configured:true,state:'configured_unverified'},score:{configured:false,state:'unconfigured'}};
let subscription={senderQQ:sender,key:group,signEnabled:false,reminderEnabled:false,threshold:180};
h.wavesClient.call=async(route,body)=>{
 if(route==='/v1/authorization'){
  if(body){if(body.revision!==authorization.revision)throw Object.assign(Error('授权修订号已变化'),{statusCode:409});authorization={revision:authorization.revision+1,shared:body.shared,rank:{configured:true,state:'configured_unverified'},score:{configured:Boolean(body.shared||body.xwtoken),state:body.shared||body.xwtoken?'configured_unverified':'unconfigured'}};}
  return structuredClone(authorization);
 }
 if(route==='/v1/status')return {ready:true,publicLoginReady:true,authorization,capabilities:[{id:'help',label:'帮助、资料与攻略',status:'ready'},{id:'panel',label:'本人角色面板与练度',status:'ready'},{id:'rank',label:'总排行上传',status:'pending',reason:'示例：授权已保存，待实际请求验证'},{id:'score',label:'声骸截图评分',status:'pending',reason:'示例：需作者额外授权'}]};
 if(route==='/v1/accounts')return {accounts:[{senderQQ:sender,uid:'100000001',nickname:'虚构漂泊者',hasCredential:true}]};
 if(route==='/v1/subscriptions'){if(body)subscription={...subscription,...body};return {subscriptions:[subscription]};}
 if(route==='/v1/notices')return {notices:[]};
 return {};
};
const stamp=new Date().toISOString(),runId='11111111-1111-4111-8111-111111111111';
h.waves.runs=[{id:'33333333-3333-4333-8333-333333333333',key:group,senderQQ:sender,command:'ww帮助',at:stamp,status:'completed',elapsedMs:850},{id:'44444444-4444-4444-8444-444444444444',key:group,senderQQ:sender,command:'ww登录',at:stamp,status:'confirmation'}];
h.modelChat.append(group,{kind:'user',sender:'示例群友甲',senderQQ:sender,text:'昨天说的番茄面，今天真的做出来了。',messageId:'9001'});
for(const [index,text] of ['这次番茄面计划终于从聊天记录进厨房了。','[示例收藏表情：庆祝]','味道怎么样？'].entries())h.modelChat.append(group,{kind:'assistant',sender:'Qodex',text,messageId:String(9002+index),runId,actionIndex:index,actionType:index===1?'sticker':'text'});
h.modelChat.append(group,{kind:'event',text:'虚构演示数据：没有向 QQ 发送任何消息。'});
h.modelChat.append('group:20002',{kind:'user',sender:'示例群友乙',senderQQ:'30002',text:'这个会话有独立的历史与记忆。',messageId:'9010'});
h.modelChat.memory.mutate(group,{action:'add',text:'示例群友甲喜欢在周末尝试简单菜谱。',kind:'person',participantQQs:[sender],pinned:true,revision:0});
h.modelChat.memory.mutate(group,{action:'add',text:'昨天讨论过的番茄面今天已完成，之后可聊实际口味。',kind:'topic',participantQQs:[sender],topicState:'closed',revision:1});
const memory=h.modelChat.memory.read(group).entries,entry=h.modelChat.entry(group);
entry.runs=[{id:runId,status:'sent',result:'sent',startedAt:stamp,finishedAt:stamp,inputPreview:'番茄面做出来了',model:'gpt-6-luna',reasoningEffort:'max',totalMs:1300,queueMs:10,modelMs:1000,sendMs:290,memory,actions:[{index:0,type:'text',status:'sent',messageIds:['9002']},{index:1,type:'sticker',status:'sent',messageIds:['9003']},{index:2,type:'text',status:'sent',messageIds:['9004']}]},{id:'22222222-2222-4222-8222-222222222222',status:'failed',result:'failed',startedAt:stamp,finishedAt:stamp,inputPreview:'隔离测试：部分发送失败',model:'gpt-6-luna',reasoningEffort:'max',totalMs:1200,queueMs:0,modelMs:900,sendMs:300,memory:[],actions:[{index:0,type:'text',status:'sent',messageIds:['9020']},{index:1,type:'sticker',status:'failed',messageIds:[],error:'人为模拟的发送失败'},{index:2,type:'text',status:'not_sent',messageIds:[]}]}];h.modelChat.save(entry);
const server=h.startConsoleServer();if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
console.log(JSON.stringify({port:server.address().port,fixture:true}));
process.on('SIGINT',async()=>{for(const file of ['model-console.html','model-controls.js','model-waves.js'])fs.unwatchFile(new URL('../public/'+file,import.meta.url));server.closeAllConnections();server.close();await h.close();process.exit(0);});
