import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the actual panel event handlers with a minimal DOM and local API fixture.
const nodes=[];
function el(tag,text='',className=''){
 const n={tag,textContent:text,className,children:[],value:'',append(...children){this.children.push(...children);},prepend(...children){this.children.unshift(...children);},replaceChildren(...children){this.children=children;}};nodes.push(n);return n;
}
let revision=0,enabled=true,override=null,subscribed=true,loadPanel;
const writes=[];
const context=vm.createContext({
 el,Option:class{constructor(text,value){this.text=text;this.value=value;}},selected:'group:456',title:k=>k,labels:{},toast:()=>{},safe:fn=>fn(),messageNode:()=>el('div'),
 window:{registerModelPanel(id,label,load){loadPanel=load;return el('section');},addEventListener(){}},URL,
 api:async(route,body)=>{
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
