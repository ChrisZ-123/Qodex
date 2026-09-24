import http from 'node:http';
import assert from 'node:assert/strict';
import {zstdDecompressSync,gunzipSync} from 'node:zlib';
import {CodexRpc} from '../src/codex-rpc.js';
let received;
const requestSeen=new Promise(r=>received=r);
const server=http.createServer(async(req,res)=>{
 const chunks=[];for await(const b of req)chunks.push(b);
 let bytes=Buffer.concat(chunks);
 if(req.headers['content-encoding']==='zstd')bytes=zstdDecompressSync(bytes);
 if(req.headers['content-encoding']==='gzip')bytes=gunzipSync(bytes);
 const text=bytes.toString();
 try{const body=JSON.parse(text);received({nested:[...JSON.stringify(body).matchAll(/declare const tools: \{ ([\w]+)/g)].map(m=>m[1]),tools:body.tools??body.input.filter(x=>x.type==='additional_tools').flatMap(x=>x.tools)});}catch{console.log(JSON.stringify({encoding:req.headers['content-encoding'],bytes:bytes.length}));}
 res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'intentional offline audit stop',type:'invalid_request_error'}}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const rpc=new CodexRpc({cwd:process.cwd(),onNotification(method,p){if(method==='error')console.log(JSON.stringify({error:p.error?.message,info:p.error?.codexErrorInfo}));}});
let timer;
try{
 await rpc.initialize();
 const t=await rpc.request('thread/start',{
  ephemeral:true,environments:[],model:'gpt-6-luna',modelProvider:'qq_offline_audit',
  baseInstructions:'Offline tool isolation test.',sandbox:'read-only',approvalPolicy:'never',
  config:{model_providers:{qq_offline_audit:{name:'Offline test',base_url:`http://127.0.0.1:${server.address().port}`,requires_openai_auth:false,wire_api:'responses',request_max_retries:0,stream_max_retries:0}}},
  dynamicTools:[{type:'function',name:'qq_probe',description:'Read only probe',inputSchema:{type:'object',properties:{}}}],
 });
 await rpc.request('turn/start',{threadId:t.thread.id,environments:[],input:[{type:'text',text:'test',text_elements:[]}]});
 const {tools,nested}=await Promise.race([requestSeen,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('No model request captured')),20000))]);
 const names=tools.flatMap(t=>t.type==='namespace'?(t.tools??[]).map(x=>`${t.name}.${x.name}`):[t.name??t.type]);
 console.log(JSON.stringify({exposedTools:names,nested}));
 assert(nested.includes('qq_probe'));
 const allowed=new Set(['qq_probe','list_mcp_resource_templates','list_mcp_resources','read_mcp_resource','clock__curr_time','skills__list','skills__read']);
 for(const name of nested)assert(allowed.has(name),`Unexpected executable tool: ${name}`);
 assert(!nested.some(n=>/exec_command|apply_patch|view_image|mcp__|read_file|write_file/.test(n)));
 console.log('PASS QQ tool available; no shell, file, desktop or inherited MCP tools in request');
}finally{clearTimeout(timer);rpc.close();server.closeAllConnections();server.close();}
