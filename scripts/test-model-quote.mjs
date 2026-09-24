import assert from 'node:assert/strict';
import {text,normalizeMessage} from '@snowluma/sdk';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const h=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model'},sendDelayMs:0},globals:{text}});
try{
 await h.handleIncoming('group',456,{user_id:998,group_id:456,self_id:111,message_id:-123,message:[{type:'text',data:{text:'请引用回复'}}],sender:{nickname:'测试'}},h.cfg);
 const id=h.calls.prompts[0].sessionId;
 await h.modelChat.consume(id,{type:'assistant/message',data:{message:{content:[{type:'text',text:JSON.stringify({reply:'引用文字回复',memory:null,stickerIds:[],stickerNotes:[],replyTo:'-123'})}]}}});
 await h.modelChat.consume(id,{type:'turn/end',data:{reason:{kind:'completed'}}});
 assert.equal(h.calls.sent.length,1);
 const segments=JSON.parse(JSON.stringify(normalizeMessage(h.calls.sent[0].text)));
 assert.deepEqual(segments,[{type:'reply',data:{id:'-123'}},{type:'text',data:{text:'引用文字回复'}}]);
 console.log('PASS actual SDK quoted text serializes as flat OneBot segments');
}finally{await h.close();}
