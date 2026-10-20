import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {ModelPreferences} from '../src/model-preferences.js';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qq-natural-settings-'));
try{
 const preferences=new ModelPreferences(path.join(temp,'preferences.json'));
 const defaults={model:'fixture',reasoningEffort:'high',role:null,style:''};
 assert.equal(preferences.conversation('group:456').replyMode,null);
 assert.equal(preferences.effective('group:456',defaults).replyMode,'natural');
 assert.equal(preferences.effective('group:456',{...defaults,replyMode:'single'}).replyMode,'single');
 preferences.updateConversation('group:456',{replyMode:'natural'},0);
 assert.equal(preferences.effective('group:456',{...defaults,replyMode:'single'}).replyMode,'natural');
 preferences.updateConversation('group:456',{replyMode:'single'},1);
 assert.equal(new ModelPreferences(preferences.file).effective('group:456',defaults).replyMode,'single');
 preferences.updateConversation('group:456',{replyMode:null},2);
 for(const replyMode of ['other',true,0,{}])assert.throws(()=>preferences.updateConversation('group:456',{replyMode},3),/回复方式/);
 assert.throws(()=>preferences.updateConversation('group:456',{replyMode:'single'},0),/更新/);
}finally{fs.rmSync(temp,{recursive:true,force:true});}

// Execute the shipped control script and its handlers against a local DOM/API fixture.
const nodes=[];
class Element{
 constructor(tag,text='',className=''){Object.assign(this,{tag,textContent:text,className,children:[],dataset:{},style:{},listeners:{},attributes:{},parent:null,_value:undefined});nodes.push(this);}
 set value(value){this._value=String(value);}get value(){return this._value??(this.tag==='select'?this.children[0]?.value??'':'');}
 get isConnected(){return this===document.body||this===document.head||Boolean(this.parent?.isConnected);}
 append(...children){for(const child of children){if(!child)continue;child.remove?.();child.parent=this;this.children.push(child);}}
 replaceChildren(...children){for(const child of this.children)child.parent=null;this.children=[];this.append(...children);}
 before(node){this.parent?.append(node);}
 insertBefore(node,before){node.remove();node.parent=this;this.children.splice(this.children.indexOf(before),0,node);}
 remove(){if(this.parent){this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=null;}}
 setAttribute(name,value){this.attributes[name]=value;}
 addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
 fire(name){for(const fn of this.listeners[name]??[])fn({target:this});this['on'+name]?.({target:this});}
 matches(selector){return selector.startsWith('.')?this.className.split(' ').includes(selector.slice(1)):this.tag===selector;}
 querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches?.(selector)?[child]:[]),...(child.querySelectorAll?.(selector)??[])]);}
 querySelector(selector){if(selector==='.hint:last-child')return this.querySelectorAll('.hint').at(-1);return this.querySelectorAll(selector)[0];}
 showModal(){this.open=true;}close(){this.open=false;this.fire('close');}
}
const el=(...args)=>new Element(...args),document={body:el('body'),head:el('head'),createTextNode:text=>el('#text',text)};
const layout=el('div',undefined,'layout'),main=el('main'),aside=el('aside');document.body.append(layout);layout.append(main,aside);
for(let i=0;i<6;i++){const section=el('section');section.append(el('h3'),el('p','','hint'));aside.append(section);}
for(const id of ['chatStyle','stickersEnabled','autoLearnStickers','autoCollectStickers','saveExpression','sessions']){const field=el('input');field.id=id;document.body.append(field);}
document.querySelector=selector=>selector==='aside'?aside:selector==='main'?main:layout;
const field=id=>nodes.findLast(node=>node.id===id&&node.isConnected),button=text=>nodes.findLast(node=>node.tag==='button'&&node.textContent===text&&node.isConnected);
const textTree=node=>[node.textContent,...node.children.map(textTree)].join('\n');
let expression={revision:'expr0',style:'原始口吻',stickersEnabled:true,autoLearnStickers:true,autoCollectStickers:true,imageMode:'auto',stickerStyle:'lively',voiceEnabled:true,replyMode:'natural'},revision=0;
let override={role:null,style:null,model:null,imageMode:null,stickerStyle:null,voiceEnabled:null,replyMode:null,paused:false};
let memory={revision:0,enabled:true,content:'上周聊过咖啡',entries:[{id:'memory-1',version:2,text:'QQ 998 喜欢咖啡',kind:'person',participantQQs:['998'],topicState:null,pinned:true,enabled:true,updatedBy:'model',updatedAt:'2026-10-19',source:{type:'message',messageId:'-1',senderQQ:'998',sender:'小明',time:'2026-10-19'},evidence:[{type:'message',messageId:'-2',senderQQ:'998',time:'2026-10-19',kind:'direct',confirmed:true}],versions:[{version:1,text:'周末约咖啡',editor:'model',at:'2026-10-18',kind:'topic',participantQQs:['998','999'],topicState:'open',pinned:false,enabled:true,source:{type:'message',messageId:'-1',senderQQ:'998'}}]}]};
const writes=[],pending=[];let holdExpression=null,globalModelReads=0;
const fixtureApi=async(route,body)=>{
 if(route==='/api/chat/expression'){if(body){assert.equal(body.revision,expression.revision);writes.push({route,body});expression={...body,revision:'expr'+(writes.length)};return expression;}const value=structuredClone(expression);if(holdExpression)await holdExpression;return value;}
 if(route.startsWith('/api/chat/settings')){if(body){assert.equal(body.revision,revision);writes.push({route,body});override={...override,...body.patch};revision++;return {};}return {revision,override:structuredClone(override),effective:{model:'fixture',reasoningEffort:'high',role:null,style:expression.style,imageMode:'auto',stickerStyle:'lively',voiceEnabled:true,replyMode:override.replyMode??expression.replyMode}};}
 if(route==='/api/roles')return {roles:['自然群友','其他人格'],current:'自然群友'};
 if(route==='/api/chat/models')return {models:[{model:'fixture',name:'Fixture',efforts:['high'],defaultEffort:'high'}]};
 if(route.startsWith('/api/chat/feedback'))return {revision,items:[],hint:''};
 if(route.startsWith('/api/chat/memory')){if(body){writes.push({route,body});memory.revision++;return {};}return structuredClone(memory);}
 if(route.startsWith('/api/chat/runs'))return {pending:0,runs:[{id:'run-1',status:'failed',startedAt:'2026-10-19T00:00:00Z',actions:[{index:0,type:'text',status:'sent',messageIds:['10']},{index:1,type:'sticker',status:'failed',messageIds:[],error:'发送超时'},{index:2,type:'text',status:'not_sent',messageIds:[]}],memory:memory.entries},{id:'old-run',status:'sent',startedAt:'2026-10-18T00:00:00Z',qqResults:[{kind:'text',messageId:'9'}]}]};
 throw Error('Unexpected fixture route '+route);
};
const safe=fn=>{const promise=Promise.resolve().then(fn);pending.push(promise);return promise;},settle=async()=>{while(pending.length)await Promise.all(pending.splice(0));};
const context=vm.createContext({el,document,$:field,Option:class extends Element{constructor(text,value){super('option',text);this.value=value;}},window:{addEventListener(){}},sessionStorage:{getItem(){return null;},setItem(){}},selected:'group:456',availableModels:[],expressionRevision:'',memoryDirty:false,labels:{},listSignature:'',lastSignature:'',title:key=>key,toast(){},api:fixtureApi,safe,loadExpression:async()=>{},loadMemory:async()=>{},loadSettings:async()=>{},loadModels:async()=>{},ensureModelsLoaded:async()=>{globalModelReads++;},refresh:async()=>{},renderList:()=>{},messageNode:()=>el('article'),URL,Blob,Date,setTimeout,Uint8Array});
vm.runInContext(fs.readFileSync(new URL('../public/model-controls.js',import.meta.url),'utf8'),context);await settle();
assert.equal(field('globalReplyMode').value,'natural');assert.equal(field('scopeReplyMode').value,'inherit');
assert.deepEqual(field('scopeRole').children.map(option=>option.value),['inherit','none','自然群友','其他人格']);
assert.equal(field('scopeRole').value,'inherit');
override.role='自然群友';await button('当前会话').onclick();await settle();
assert.equal(field('scopeRole').value,'自然群友','An explicit override equal to the global role must remain explicit');
override.role=null;await button('当前会话').onclick();await settle();assert.equal(field('scopeRole').value,'inherit');
await button('编辑全局人格').onclick();await settle();assert.ok(globalModelReads>0,'Global settings must ensure the model list has loaded');
field('globalReplyMode').value='single';field('globalReplyMode').fire('input');field('chatStyle').value='尚未保存的口吻';field('chatStyle').fire('input');await context.loadExpression();await context.refresh();
assert.equal(field('globalReplyMode').value,'single');assert.equal(field('chatStyle').value,'尚未保存的口吻');
await field('saveExpression').onclick();await settle();assert.equal(writes.at(-1).body.replyMode,'single');assert.equal(writes.at(-1).body.style,'尚未保存的口吻');
let release;holdExpression=new Promise(resolve=>release=resolve);const request=context.loadExpression();await Promise.resolve();field('globalReplyMode').value='natural';field('globalReplyMode').fire('input');release();await request;holdExpression=null;assert.equal(field('globalReplyMode').value,'natural','An in-flight refresh must preserve a new draft');
await button('重新载入全局表达设置').onclick();await settle();assert.equal(field('globalReplyMode').value,'single');
field('scopeReplyMode').value='single';field('scopeReplyMode').fire('input');await button('当前会话').onclick();await context.refresh();assert.equal(field('scopeReplyMode').value,'single');await button('保存当前会话设置').onclick();await settle();assert.equal(writes.at(-1).body.patch.replyMode,'single');
field('scopeReplyMode').value='inherit';field('scopeReplyMode').fire('input');await button('保存当前会话设置').onclick();await settle();assert.equal(writes.at(-1).body.patch.replyMode,null);
await button('记忆').onclick();await settle();assert.match(textTree(aside),/人物 · 关联 QQ：998/);assert.match(textTree(aside),/依据：消息 -2 · QQ 998/);
await button('编辑 / 置顶 / 停用').onclick();await settle();assert.equal(field('entryKind').value,'person');assert.equal(field('entryParticipants').value,'998');field('entryKind').value='topic';field('entryParticipants').value='998, 999';field('entryTopicState').value='open';await button('保存').onclick();await settle();
assert.equal(writes.at(-1).body.kind,'topic');assert.deepEqual(Array.from(writes.at(-1).body.participantQQs),['998','999']);assert.equal(writes.at(-1).body.topicState,'open');assert.equal(writes.at(-1).body.evidence,undefined,'Source evidence stays readonly');
await button('修订与差异').onclick();await settle();assert.match(textTree(document.body),/旧版：话题 \/ 未完事项 · 关联 QQ：998、999 · 话题：未完/);await button('恢复所选版本').onclick();await settle();assert.equal(writes.at(-1).body.restoreVersion,1);assert.equal(writes.at(-1).body.version,2);
await button('运行记录').onclick();await settle();const rendered=textTree(aside);assert.match(rendered,/1\. 文字 · 已发送 · 消息 10/);assert.match(rendered,/2\. 表情 · 发送失败 · 发送超时/);assert.match(rendered,/3\. 文字 · 未发送/);assert.match(rendered,/QQ 发送结果（旧记录）/);assert.match(rendered,/查看本轮实际使用的记忆/);
console.log('PASS reply-mode defaults, explicit/global persona selection, model refresh, scope inheritance, draft protection/save, metadata version restore, evidence and ordered partial-send display');
