import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the actual panel event handlers with a minimal DOM and local API fixture.
const nodes=[];
function el(tag,text='',className=''){
 const n={tag,textContent:text,className,children:[],value:'',append(...children){this.children.push(...children);},prepend(...children){this.children.unshift(...children);},replaceChildren(...children){this.children=children;}};nodes.push(n);return n;
}
let revision=0,authRevision=0,enabled=true,override=null,subscribed=true,loadPanel;
const authorization=()=>({revision:authRevision,shared:false,rank:{configured:authRevision>0,state:authRevision?'configured_unverified':'unconfigured'},score:{configured:false,state:'unconfigured'}});
const writes=[];
const context=vm.createContext({
 el,Option:class{constructor(text,value){this.text=text;this.value=value;}},selected:'group:456',title:k=>k,labels:{},toast:()=>{},safe:fn=>fn(),messageNode:()=>el('div'),
 window:{registerModelPanel(id,label,load){loadPanel=load;return el('section');},addEventListener(){}},URL,
 api:async(route,body)=>{
  if(route==='/api/waves/authorization'){if(body){assert.equal(body.revision,authRevision);writes.push({route,body});authRevision++;}return authorization();}
  if(body){assert.equal(body.revision,revision,'A preserved draft must save using the refreshed revision');writes.push({route,body});revision++;if(route==='/api/waves/settings'){if(body.key)override=body.enabled;else enabled=body.enabled;}else subscribed=false;return {};}
  if(route.startsWith('/api/waves/status'))return {settings:{enabled,revision},override,effective:enabled&&(override??true),service:{ready:true},runs:[]};
  if(route.startsWith('/api/chat?'))return {messages:[]};
  if(route==='/api/waves/accounts')return {accounts:[]};
  if(route==='/api/waves/subscriptions')return {subscriptions:subscribed?[{key:'group:456',senderQQ:'998',signEnabled:true,reminderEnabled:true}]:[]};
  throw Error('Unexpected fixture route '+route);
 }
});
vm.runInContext(fs.readFileSync(new URL('../public/model-waves.js',import.meta.url),'utf8'),context);
const field=id=>nodes.find(n=>n.id===id),button=label=>nodes.find(n=>n.tag==='button'&&n.textContent===label);
await loadPanel();
field('wavesGlobal').value='false';field('wavesGlobal').oninput();field('wavesLocal').value='true';field('wavesLocal').oninput();
await button('停用这条自动订阅').onclick();
assert.equal(revision,1);assert.equal(field('wavesGlobal').value,'false');assert.equal(field('wavesLocal').value,'true');assert.equal(context.window.modelExtensionDirty(),true);
await button('保存全局开关').onclick();assert.equal(writes.at(-1).body.revision,1);assert.equal(writes.at(-1).body.enabled,false);assert.equal(field('wavesLocal').value,'true');assert.equal(context.window.modelExtensionDirty(),true);
await button('保存当前会话').onclick();assert.equal(writes.at(-1).body.revision,2);assert.equal(writes.at(-1).body.enabled,true);assert.equal(context.window.modelExtensionDirty(),false);
field('wavesGlobal').value='true';field('wavesGlobal').oninput();field('wavesLocal').value='false';field('wavesLocal').oninput();
await button('重新载入').onclick();assert.equal(field('wavesGlobal').value,'false');assert.equal(field('wavesLocal').value,'true');assert.equal(context.window.modelExtensionDirty(),false);
console.log('PASS Waves actual UI handlers preserve both drafts after subscription stop, refresh revision, save fields independently and discard only on explicit reload');
field('wavesRankToken').value='fixture-author-token';field('wavesRankToken').oninput();
field('wavesTokenShared').checked=true;field('wavesTokenShared').oninput();
assert.equal(field('wavesRankToken').type,'password');assert.equal(field('wavesScoreToken').disabled,true);
await loadPanel();assert.equal(field('wavesRankToken').value,'fixture-author-token');assert.equal(field('wavesTokenShared').checked,true,'Refresh does not overwrite an authorization draft');
field('wavesLocal').value='false';field('wavesLocal').oninput();await button('保存授权').onclick();
assert.equal(writes.at(-1).body.WavesToken,'fixture-author-token');assert.equal(writes.at(-1).body.shared,true);assert.equal(writes.at(-1).body.xwtoken,undefined);
assert.equal(field('wavesRankToken').value,'');assert.equal(field('wavesScoreToken').value,'');assert.equal(field('wavesLocal').value,'false');assert.equal(context.window.modelExtensionDirty(),true,'Saving authorization preserves an unrelated conversation draft');
await button('重新载入').onclick();assert.equal(context.window.modelExtensionDirty(),false);
console.log('PASS authorization password fields/shared selection preserve drafts, use independent revision, clear submitted secrets and retain unrelated drafts');

// Area entry and the periodic refresh can overlap with the same selected key.
// Resolve the newer accounts/subscriptions first, then the older snapshot.
const liveApi=context.api,pending=[];
const until=async predicate=>{for(let i=0;i<50&&!predicate();i++)await Promise.resolve();assert(predicate(),'Fixture load must reach its deferred API');};
context.api=(route,body)=>['/api/waves/accounts','/api/waves/subscriptions'].includes(route)&&!body?new Promise(resolve=>pending.push({route,resolve})):liveApi(route,body);
const older=loadPanel();await until(()=>pending.length===2);
const newer=loadPanel();await until(()=>pending.length===4);
const snapshot=(request,qq)=>request.route.endsWith('/accounts')?{accounts:[{senderQQ:qq,uid:'100000001',nickname:qq,hasCredential:true}]}:{subscriptions:[{key:'group:456',senderQQ:qq,signEnabled:true}]};
for(const request of pending.slice(2))request.resolve(snapshot(request,'30001'));await newer;
const section=heading=>nodes.find(n=>n.tag==='section'&&n.children.some(child=>child.tag==='h3'&&child.textContent===heading));
const accounts=section('玩家绑定 · 脱敏概要'),subscriptions=section('自动任务 · 本人开通');
assert.equal(accounts.children.filter(n=>n.tag==='p').length,1);assert.equal(subscriptions.children.filter(n=>n.className==='run-card').length,1);
for(const request of pending.slice(0,2))request.resolve(snapshot(request,'stale-player'));await older;
assert.equal(accounts.children.filter(n=>n.tag==='p').length,1,'Overlapping loads must render each account once');
assert.equal(subscriptions.children.filter(n=>n.className==='run-card').length,1,'Overlapping loads must render each subscription once');
assert(accounts.children[1].textContent.includes('30001'));assert(!JSON.stringify(accounts.children).includes('stale-player'));
assert(subscriptions.children[1].children[0].textContent.includes('30001'));

// A stale authorization read must not replace the newest metadata or its revision.
let authorizationRelease;
context.api=(route,body)=>route==='/api/waves/authorization'&&!body&&!authorizationRelease?new Promise(resolve=>authorizationRelease=resolve):liveApi(route,body);
const staleAuthorization=loadPanel();await until(()=>Boolean(authorizationRelease));
await loadPanel();assert(field('wavesRankToken').placeholder.includes('已配置'));
authorizationRelease({revision:999,shared:true,rank:{configured:false,state:'unconfigured'},score:{configured:false,state:'unconfigured'}});await staleAuthorization;
assert(field('wavesRankToken').placeholder.includes('已配置'),'Stale authorization cannot overwrite the latest status');
assert.equal(field('wavesTokenShared').checked,false);
field('wavesRankToken').value='fixture-next-token';field('wavesRankToken').oninput();context.api=liveApi;
await button('保存授权').onclick();assert.equal(writes.at(-1).body.revision,authRevision-1,'Stale authorization cannot replace the next save revision');

// The same generation check protects settings before any downstream reads.
let statusRelease;
context.api=(route,body)=>route.startsWith('/api/waves/status')&&!statusRelease?new Promise(resolve=>statusRelease=resolve):liveApi(route,body);
const staleStatus=loadPanel();await until(()=>Boolean(statusRelease));await loadPanel();
const currentGlobal=field('wavesGlobal').value,currentLocal=field('wavesLocal').value;
statusRelease({settings:{enabled:!enabled,revision:999},override:false,effective:false,service:{ready:false},runs:[]});await staleStatus;
assert.equal(field('wavesGlobal').value,currentGlobal);assert.equal(field('wavesLocal').value,currentLocal);
context.api=liveApi;
console.log('PASS concurrent Waves loads render one account/subscription and reject stale settings, authorization metadata and save revisions');
