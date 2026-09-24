import {CodexRpc} from '../src/codex-rpc.js';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=process.env.QBOT_CODEX_EXE;
if(!exe){console.error('Set the native Codex executable before checking the account.');process.exit(1);}
let rpc;
try{
  rpc=new CodexRpc({exe,cwd:root});
  await rpc.initialize();
  const account=await rpc.request('account/read',{},15000);
  if(account?.account?.type!=='chatgpt')throw new Error('ChatGPT login unavailable');
  const response=await rpc.request('model/list',{},20000);
  const models=(Array.isArray(response?.data)?response.data:[])
    .filter(item=>typeof item?.model==='string'&&Array.isArray(item.supportedReasoningEfforts))
    .map(item=>({model:item.model,efforts:item.supportedReasoningEfforts.map(e=>e.reasoningEffort).filter(e=>typeof e==='string')}))
    .filter(item=>item.efforts.length);
  if(!models.length)throw new Error('No available models');
  process.stdout.write(JSON.stringify({accountReady:true,models})+'\n');
}catch{
  console.error('Codex login or model catalog is unavailable. Sign in with the official Codex app or CLI and retry.');
  process.exitCode=1;
}finally{rpc?.close();}
