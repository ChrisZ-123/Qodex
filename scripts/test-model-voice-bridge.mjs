import assert from 'node:assert/strict';
import {bridgeHarness} from './audit-bridge-harness.mjs';

const h=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max'},allow:{groups:['456','789','555'],private:['123']}}});
try{
  h.chatPreferences.updateConversation('group:456',{voiceEnabled:true},h.chatPreferences.data.revision);
  h.chatPreferences.updateConversation('group:789',{voiceEnabled:true},h.chatPreferences.data.revision);
  h.chatPreferences.updateConversation('group:555',{voiceEnabled:true},h.chatPreferences.data.revision);
  h.chatPreferences.updateConversation('private:123',{voiceEnabled:true},h.chatPreferences.data.revision);
  h.setVoice('10',{text:'今天晚上一起开黑吗'});
  await h.handleIncoming('group',456,{user_id:998,group_id:456,self_id:111,message_id:10,message:[{type:'record',data:{file:'fixture-record'}}],sender:{nickname:'当前群友'}},h.cfg);
  const direct=JSON.parse(h.calls.prompts.at(-1).content[0].text).messages[0];
  assert.equal(direct.voice[0].source,'message');assert.equal(direct.voice[0].text,'今天晚上一起开黑吗');
  assert.equal(h.modelChat.history('group:456').messages.find(m=>m.messageId==='10').voice[0].status,'ok');
  h.setVoice('11',{text:'私聊也能识别'});
  await h.handleIncoming('private',123,{user_id:123,self_id:111,message_id:11,message:[{type:'record',data:{file:'private-record'}}],sender:{nickname:'管理员'}},h.cfg);
  assert.equal(JSON.parse(h.calls.prompts.at(-1).content[0].text).messages[0].voice[0].text,'私聊也能识别');

  h.setMessage('50',{group_id:789,user_id:997,time:1790000000,sender:{nickname:'原说话人',user_id:997},message:[{type:'record',data:{file:'another-record'}}]});
  h.setVoice('50',{text:'被引用的语音内容'});
  await h.handleIncoming('group',789,{user_id:996,group_id:789,self_id:111,message_id:51,message:[{type:'reply',data:{id:'50'}},{type:'text',data:{text:'刚才说的是什么？'}}],sender:{nickname:'提问者'}},h.cfg);
  const quoted=JSON.parse(h.calls.prompts.at(-1).content[0].text).messages[0].voice[0];
  assert.equal(quoted.source,'quote');assert.equal(quoted.sourceMessageId,'50');assert.equal(quoted.sender.includes('原说话人'),true);

  h.setMessage('60',{group_id:456,user_id:997,sender:{nickname:'外群',user_id:997},message:[{type:'record',data:{file:'foreign-record'}}]});
  h.setVoice('60',{text:'不应跨群读取'});
  await h.handleIncoming('group',555,{user_id:996,group_id:555,self_id:111,message_id:61,message:[{type:'reply',data:{id:'60'}},{type:'text',data:{text:'跨群引用'}}],sender:{nickname:'提问者'}},h.cfg);
  assert.equal(JSON.parse(h.calls.prompts.at(-1).content[0].text).messages[0].voice,undefined);
  console.log('PASS bridge voice: group and allowed private record, verified quotation and cross-group refusal');
}finally{await h.close();}
