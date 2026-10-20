import assert from 'node:assert/strict';
import {text,normalizeMessage} from '@snowluma/sdk';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {modelOutput} from './model-output-fixture.mjs';
const h=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model'},sendDelayMs:0},globals:{text}});
try{
 await h.handleIncoming('group',456,{user_id:998,group_id:456,self_id:111,message_id:-123,message:[{type:'text',data:{text:'请引用回复'}}],sender:{nickname:'测试'}},h.cfg);
 const id=h.calls.prompts[0].sessionId;
 await h.modelChat.consume(id,{type:'assistant/message',data:{message:{content:[{type:'text',text:JSON.stringify(modelOutput({reply:'引用文字回复',replyTo:'-123'}))}]}}});
 await h.modelChat.consume(id,{type:'turn/end',data:{reason:{kind:'completed'}}});
 assert.equal(h.calls.sent.length,1);
 const segments=JSON.parse(JSON.stringify(normalizeMessage(h.calls.sent[0].text)));
 assert.deepEqual(segments,[{type:'reply',data:{id:'-123'}},{type:'text',data:{text:'引用文字回复'}}]);
 await h.handleIncoming('group',456,{user_id:998,group_id:456,self_id:111,message_id:-124,message:[{type:'text',data:{text:'请引用长答'}}],sender:{nickname:'测试'}},h.cfg);
 const longRun=h.modelChat.running.get('group:456');longRun.text=JSON.stringify(modelOutput({reply:'长'.repeat(8100),replyTo:'-124'}));
 await h.modelChat.consume(longRun.sessionId,{type:'turn/end',data:{requestId:longRun.id,reason:{kind:'completed'}}});
 const chunks=h.calls.sent.slice(1).map(m=>JSON.parse(JSON.stringify(normalizeMessage(m.text))));assert.equal(chunks.length,3);
 assert.equal(chunks[0][0].type,'reply');assert(chunks.slice(1).every(parts=>parts.every(p=>p.type!=='reply')),'Only the first physical QQ message can quote');
 console.log('PASS actual SDK quoted text serializes as flat OneBot segments');
}finally{await h.close();}
