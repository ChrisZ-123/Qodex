import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import yaml from 'js-yaml';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CodexRpc} from './codex-rpc.js';
import {MODEL_CHAT_INSTRUCTIONS} from './model-chat.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ok=value=>({result:{ok:true,value}});
const toolNames=text=>String(text).replace(/mcp__snowluma__/g,'').replace(/mcp__web-search-safe__/g,'');
const read=(p,fallback)=>{try{return JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));}catch{return fallback;}};
export class CodexApiClient {
  constructor(config) {
    this.root=root;this.config=config;this.records=read(path.join(this.root,'state/codex-sessions.json'),{});
    this.live=new Set();this.active=new Map();this.queues=new Map();this.frames=[];this.tools=new Map();this.cancelled=new Set();
    this.rpc=new CodexRpc({exe:config.exe,cwd:root,onNotification:(m,p)=>this.notify(m,p),onRequest:(m,p)=>this.toolCall(m,p)});
    this.ready=this.initialize();
    this.events={follow:()=>{},mux:()=>this.mux()};
    this.settings={describe:async()=>{await this.ready;if(this.rpc.closed)throw new Error('Codex process stopped');return ok({namespaces:[{ns:'qq-mode',value:read(path.join(root,'state/mode.json'),{mode:'reserved2'})}]});},update:async({ns,patch})=>{
      if(ns!=='qq-mode'||patch.mode==='closed-agent')throw new Error('Codex backend only permits safe chat modes');
      const p=path.join(root,'state/mode.json');fs.writeFileSync(p,JSON.stringify({...read(p,{}),...patch},null,2));return ok({});
    }};
    this.agentPresets={list:async()=>{await this.ready;return ok({presets:['qq-chat','qq-chat-v2'].map(id=>({id,name:id,isDefault:id==='qq-chat-v2'}))});}};
    this.workspace={create:async()=>ok({created:false,workspace:{workspaceId:'qq-codex'}}),rename:async()=>ok({}),archiveSession:async({sessionId})=>{
      await this.stopSessionWork(sessionId);await this.rpc.request('thread/archive',{threadId:sessionId});delete this.records[sessionId];this.live.delete(sessionId);this.save();return ok({});
    }};
    this.sessions={create:p=>this.create(p),selectModel:p=>this.selectModel(p),prompt:p=>this.prompt(p),list:async()=>ok({items:Object.keys(this.records).map(sessionId=>({sessionId,cwd:path.join(root,'state/agents')}))})};
  }
  async initialize() {
    await this.rpc.initialize();
    const account=await this.rpc.request('account/read',{});
    if(account.account?.type!=='chatgpt')throw new Error('QQ Codex requires the existing ChatGPT login');
    const models=await this.rpc.request('model/list',{});
    const model=models.data.find(m=>m.model===this.config.model);
    if(!model?.supportedReasoningEfforts.some(e=>e.reasoningEffort===this.config.reasoningEffort))throw new Error('Requested Codex model/effort is unavailable; no fallback permitted');
    const env=Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string'));
    this.clients=[];
    if(this.config.conversationMode==='model')return;
    for(const [ns,file] of [['snowluma','mcp-snowluma-safe.js'],['web-search-safe','mcp-web-search-safe.js']]){
      const client=new Client({name:`qq-codex-${ns}`,version:'0.1.0'});
      const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src',file)],cwd:root,env,stderr:'pipe'});
      await client.connect(transport);transport.stderr?.resume();this.clients.push(client);
      for(const tool of (await client.listTools()).tools) this.tools.set(tool.name,{...tool,client,eventName:`mcp__${ns}__${tool.name}`});
    }
  }
  save(){fs.mkdirSync(path.join(this.root,'state'),{recursive:true});fs.writeFileSync(path.join(this.root,'state/codex-sessions.json'),JSON.stringify(this.records,null,2));}
  agentCwd(){const dir=path.join(this.root,'state','agents');fs.mkdirSync(dir,{recursive:true});return dir;}
  async listModels(){
    await this.ready;
    const items=[];let cursor;
    do{const page=await this.rpc.request('model/list',{...(cursor?{cursor}:{})});items.push(...page.data);cursor=page.nextCursor;}while(cursor);
    return items.filter(m=>!m.hidden).map(m=>({model:m.model,name:m.displayName||m.model,efforts:m.supportedReasoningEfforts.map(e=>e.reasoningEffort),defaultEffort:m.defaultReasoningEffort}));
  }
  instructions(preset){
    if(!['qq-chat','qq-chat-v2'].includes(preset))throw new Error('Unsafe or unknown Codex chat preset');
    if(this.config.conversationMode==='model')return MODEL_CHAT_INSTRUCTIONS;
    const plugins=yaml.load(fs.readFileSync(path.join(root,'dsh/agent-presets',preset,'agent.cordis.yml'),'utf8'));
    const persona=plugins.find(p=>p.id==='persona')?.config?.prefix;
    if(typeof persona!=='string')throw new Error('Chat instructions missing');
    return toolNames(persona.replace(/You are a coding agent powered by the \{\{model\}\} model\./,'你是 QQ 对话机器人，使用 GPT 模型。'))+'\n只使用本次会话提供的 QQ 工具。不要创建子智能体、读取技能或资源、执行电脑操作。不可用的工具不能声称已经调用。角色设定由桥接消息提供。';
  }
  async create({agentPreset}) {
    await this.ready;
    const t=await this.rpc.request('thread/start',{
      model:this.config.model,serviceTier:this.config.serviceTier,allowProviderModelFallback:false,
      cwd:this.agentCwd(),environments:[],selectedCapabilityRoots:[],
      sandbox:'read-only',approvalPolicy:'never',baseInstructions:this.instructions(agentPreset),
      dynamicTools:[...this.tools].map(([name,t])=>({type:'function',name,description:t.description??name,inputSchema:t.inputSchema})),
    });
    if(t.model!==this.config.model)throw new Error('Codex selected a different model');
    this.records[t.thread.id]={preset:agentPreset};this.live.add(t.thread.id);this.save();return ok({sessionId:t.thread.id});
  }
  async ensure(id){
    await this.ready;
    if(!this.records[id])throw new Error('Session is not owned by this QQ deployment');
    if(!this.live.has(id)){
      await this.rpc.request('thread/resume',{threadId:id,model:this.config.model,serviceTier:this.config.serviceTier,cwd:this.agentCwd(),sandbox:'read-only',approvalPolicy:'never',baseInstructions:this.instructions(this.records[id].preset)});
      this.live.add(id);
    }
  }
  async selectModel({sessionId,model,reasoningEffort}){
    await this.ensure(sessionId);
    if(model!==this.config.model||reasoningEffort!==this.config.reasoningEffort)throw new Error('Model configuration mismatch');
    return ok({selected:{provider:'codex',model,reasoningEffort}});
  }
  async prompt({sessionId,content,context,outputSchema}) {
    await this.ensure(sessionId);
    const input=content.map(b=>{
      if(b.type==='text')return{type:'text',text:this.config.conversationMode==='model'?b.text:toolNames(b.text),text_elements:[]};
      if(b.type==='image' && b.url)return{type:'image',url:b.url};
      if(b.type==='image' && b.data && b.mediaType)return{type:'image',url:`data:${b.mediaType};base64,${b.data}`};
      if(b.type==='image' && b.source?.data)return{type:'image',url:`data:${b.source.mediaType??b.source.mimeType};base64,${b.source.data}`};
      throw new Error('Unsupported Codex input block; message was not submitted');
    });
    if(this.active.has(sessionId)){
      if(this.config.conversationMode==='model')throw new Error('Conversation already has an active turn');
      const q=this.queues.get(sessionId)??[];q.push(input);this.queues.set(sessionId,q);
    }else await this.startTurn(sessionId,input,context,outputSchema);
    return ok({});
  }
  async startTurn(id,input,context,outputSchema){
    this.cancelled.delete(id);
    this.active.set(id,null);
    try{const r=await this.rpc.request('turn/start',{threadId:id,model:this.config.model,effort:this.config.reasoningEffort,serviceTier:this.config.serviceTier,environments:[],input,...(outputSchema?{outputSchema}:{}),...(context?{additionalContext:{conversation_context:{kind:'application',value:JSON.stringify(context)}}}:{})});if(this.cancelled.has(id))await this.rpc.request('turn/interrupt',{threadId:id,turnId:r.turn.id});else if(this.active.has(id))this.active.set(id,r.turn.id);}
    catch(e){this.active.delete(id);throw e;}
  }
  emit(sessionId,type,data){this.frames.push({payload:{type:'session/event',sessionId,event:{type,data}}});this.wake?.();this.wake=null;}
  notify(method,p){
    if(method==='connection/lost'){
      this.queues.clear();
      for(const [id,turn] of this.active)this.emit(id,'turn/end',{turn,reason:{kind:'aborted'}});
      this.active.clear();return;
    }
    const id=p?.threadId;
    if(method==='item/started'&&p.item?.type==='webSearch')this.emit(id,'web/search',{});
    if(method==='turn/started'){if(!this.cancelled.has(id))this.active.set(id,p.turn.id);this.emit(id,'turn/start',{turn:p.turn.id});}
    if(method==='item/completed'&&p.item.type==='agentMessage'&&p.item.phase!=='commentary')this.emit(id,'assistant/message',{turn:p.turnId,message:{content:[{type:'text',text:p.item.text}]}});
    if(method==='turn/completed'){
      this.active.delete(id);
      this.emit(id,'turn/end',{turn:p.turn.id,reason:{kind:p.turn.status==='completed'?'completed':'aborted'}});
      if(p.turn.status==='failed')console.error('[codex] Model turn failed; inspect Codex account/network status');
      const q=this.queues.get(id);if(q?.length)this.startTurn(id,q.shift()).catch(()=>console.error('[codex] Queued turn failed to start'));
    }
  }
  async toolCall(method,p){
    if(method!=='item/tool/call'||!this.records[p.threadId]||this.cancelled.has(p.threadId)||!this.active.has(p.threadId)||!this.tools.has(p.tool))throw new Error('Tool call rejected');
    const tool=this.tools.get(p.tool);
    this.emit(p.threadId,'tool/call',{callId:p.callId,name:tool.eventName??p.tool,arguments:p.arguments});
    let result;
    try{result=await tool.client.callTool({name:tool.name,arguments:p.arguments},undefined,{timeout:180000});}
    catch{result={isError:true,content:[{type:'text',text:'QQ tool call failed'}]};}
    this.emit(p.threadId,'tool/result',{message:{source:{callId:p.callId},isError:result.isError===true,content:result.content}});
    return{success:result.isError!==true,contentItems:result.content.filter(b=>b.type==='text'||b.type==='image').map(b=>b.type==='text'?{type:'inputText',text:toolNames(b.text)}:{type:'inputImage',imageUrl:`data:${b.mimeType};base64,${b.data}`})};
  }
  async *mux(){await this.ready;for(;;){while(this.frames.length)yield this.frames.shift();await new Promise(r=>this.wake=r);}}
  async stopSessionWork(id){this.cancelled.add(id);this.queues.delete(id);const turnId=this.active.get(id);if(turnId)await this.rpc.request('turn/interrupt',{threadId:id,turnId});}
  async respond(){throw new Error('Interactive approvals are disabled for the QQ bot');}
}
