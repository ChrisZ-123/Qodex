import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/model-console.html',import.meta.url),'utf8');
const block=source.slice(source.indexOf('let availableModels='),source.indexOf("$('resetChat').onclick"));
class Field{
 constructor(){this.value='';this.disabled=false;this.textContent='';this.children=[];}
 replaceChildren(...options){this.children=options;this.value=options[0]?.value??'';}
 setAttribute(name,value){this[name]=value;}
}
const fields=Object.fromEntries(['modelChoice','effortChoice','modelLoadStatus','refreshModels','saveModel','compactLimit','speedChoice'].map(k=>[k,new Field()]));
let release,fail=false,calls=0;
const page={models:[{model:'gpt-6.1-sol',name:'GPT-6.1 Sol',efforts:['medium','high'],defaultEffort:'medium'}],revision:'current',current:{model:'gpt-6.1-sol',reasoningEffort:'medium',serviceTier:'priority',autoCompactTokenLimit:128000}};
const context=vm.createContext({$:id=>fields[id],Option:class {constructor(text,value){this.textContent=text;this.value=value;}},api:async()=>{calls++;if(release!==null)await new Promise(resolve=>release=resolve);if(fail)throw Error('Codex temporarily unavailable');return structuredClone(page);},safe:async fn=>{try{return await fn();}catch{}},refresh:async()=>{},toast(){}});
vm.runInContext(block+'\nglobalThis.fixture={loadModels,renderEfforts};',context);
const first=context.fixture.loadModels();
assert.equal(fields.modelChoice.disabled,true,'Loading must not expose an empty selectable model');assert.match(fields.modelLoadStatus.textContent,/读取|加载/);
const second=context.fixture.loadModels();assert.equal(calls,1,'Concurrent panel/refresh reads must share one request');release();await Promise.all([first,second]);release=null;
assert.equal(fields.modelChoice.value,'gpt-6.1-sol');assert.equal(fields.effortChoice.value,'medium');assert.equal(fields.saveModel.disabled,false);assert.match(fields.modelLoadStatus.textContent,/1/);
fail=true;await context.fixture.loadModels().catch(()=>{});assert.match(fields.modelLoadStatus.textContent,/失败|未能/);assert.equal(fields.saveModel.disabled,true);assert.equal(fields.modelChoice.children.some(x=>x.value==='gpt-6.1-sol'),true,'Do not erase a previously valid list on transport failure');
fail=false;await fields.refreshModels.onclick();assert.equal(fields.saveModel.disabled,false);assert.equal(fields.effortChoice.value,'medium');
page.current.model='unavailable';await context.fixture.loadModels();assert.equal(fields.modelChoice.value,'');assert.equal(fields.saveModel.disabled,true);assert.match(fields.modelLoadStatus.textContent,/不可用|不在/);
console.log('PASS actual model selector: visible loading/error, coalesced reads, preserved valid list, explicit refresh recovery and no silent model replacement');
