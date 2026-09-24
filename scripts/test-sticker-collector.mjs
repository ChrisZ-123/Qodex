import assert from 'node:assert/strict';
import {StickerCollector} from '../src/sticker-collector.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
let enabled=true,allowed=true,count=0,adds=0,downloads=0,seen=[];
const opts={enabled:()=>enabled,allowed:()=>allowed,count:()=>count,download:async()=>{downloads++;return {buffer:Buffer.from('image')};},add:async()=>{adds++;return 'collected';},sync:async()=>{count++;return {};},save:x=>seen=x};
const c=new StickerCollector(opts),event={user_id:2,self_id:1,message_id:-5};
const image={kind:'image',file:'ABCDEF.png',subType:'1'};
assert.deepEqual(await c.collect('group:123',event,[{...image,subType:'0'},{kind:'face'}]),[]);
await c.collect('private:2',event,[image]);await c.collect('group:123',{...event,user_id:1},[image]);assert.equal(adds,0);
allowed=false;await c.collect('group:123',event,[image]);allowed=true;
enabled=false;await c.collect('group:123',event,[image]);enabled=true;assert.equal(adds,0);
await Promise.all([c.collect('group:123',event,[image]),c.collect('group:123',event,[image])]);assert.equal(adds,1);assert.equal(downloads,1);
await new StickerCollector({...opts,seen}).collect('group:123',event,[image]);assert.equal(adds,1);
count=100;await c.collect('group:123',event,[{...image,file:'new.png'}]);assert.equal(adds,1);count=1;
const revoked=new StickerCollector({...opts,download:async()=>{allowed=false;return {buffer:Buffer.from('x')};}});
await revoked.collect('group:123',event,[image]);assert.equal(adds,1);allowed=true;
const failed=new StickerCollector({...opts,add:async()=>{throw Error('failure');}});
assert.match((await failed.collect('group:123',event,[image]))[0],/失败/);
assert.deepEqual(await failed.collect('group:123',event,[image]),[]);
let received;
class SpyCollector {async collect(k,e,media){received=media;return [];}}
const h=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model'}},globals:{StickerCollector:SpyCollector}});
try{await h.handleIncoming('group',456,{...event,group_id:456,message:[{type:'image',data:{file:'fixture',sub_type:1}}]},h.cfg);assert.equal(received[0].subType,'1');}finally{await h.close();}
console.log('PASS sticker-only selection, whitelist/private/self guards, duplicate/restart, capacity, revoke race and native sub_type');
