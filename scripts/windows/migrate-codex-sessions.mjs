import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const scriptPath=fileURLToPath(import.meta.url);
const repoRoot=path.resolve(path.dirname(scriptPath),'../..');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inside=(parent,child)=>child.startsWith(parent+path.sep);
function assertOwnedDestination(state,target){
  const parent=path.dirname(target),relative=path.relative(state,parent);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('独立会话目标越过本部署目录');
  let current=state;
  for(const segment of ['',...relative.split(path.sep)]){
    if(segment)current=path.join(current,segment);
    if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw new Error('独立会话目录不能是符号链接');
  }
}

export function planSessionMigration(root,sourceHome){
  const state=path.join(root,'state');
  const recordsPath=path.join(state,'codex-sessions.json');
  const chatsPath=path.join(state,'model-chat');
  const sourceSessions=fs.realpathSync(path.join(sourceHome,'sessions'));
  const destination=path.resolve(state,'codex-home','sessions');
  if(path.resolve(sourceSessions)===destination)throw new Error('源目录不能是本部署的独立会话目录');
  const recordBytes=fs.readFileSync(recordsPath);
  const records=JSON.parse(recordBytes.toString('utf8'));
  const chatFiles=fs.readdirSync(chatsPath).filter(name=>/^(group|private)-[1-9]\d*\.json$/.test(name));
  const ids=[...new Set(chatFiles.map(name=>JSON.parse(fs.readFileSync(path.join(chatsPath,name),'utf8')).sessionId).filter(Boolean))];
  const filenames=fs.readdirSync(sourceSessions,{recursive:true}).filter(name=>typeof name==='string'&&name.endsWith('.jsonl'));
  const pending=[];let alreadyMigrated=0;
  for(const id of ids){
    if(!UUID.test(id)||!Object.hasOwn(records,id))throw new Error('机器人会话映射无效或缺失');
    const imported=records[id].rolloutPath;
    if(imported){
      if(!inside(destination,path.resolve(imported))||!fs.statSync(imported).isFile())throw new Error('已有会话映射不在本部署独立目录');
      assertOwnedDestination(state,imported);
      if(!inside(path.resolve(destination),fs.realpathSync(imported)))throw new Error('已有会话映射指向外部文件');
      alreadyMigrated++;continue;
    }
    const matches=filenames.filter(name=>path.basename(name).endsWith('-'+id+'.jsonl'));
    if(matches.length!==1)throw new Error('旧会话文件缺失或存在多个匹配，未迁移');
    const relative=matches[0],source=path.join(sourceSessions,relative),resolved=fs.realpathSync(source);
    if(!inside(sourceSessions,resolved)||!fs.statSync(resolved).isFile())throw new Error('旧会话文件越过源目录');
    const target=path.join(destination,relative);
    assertOwnedDestination(state,target);
    if(fs.existsSync(target))throw new Error('独立目录已存在同名会话文件，未覆盖');
    pending.push({id,source,target});
  }
  return {root,state,recordsPath,chatsPath,recordBytes,records,pending,alreadyMigrated,total:ids.length};
}

function atomicBytes(file,bytes){
  const temporary=file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temporary,bytes,{flag:'wx'});fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}

export function applySessionMigration(plan,{beforeCommit=()=>{}}={}){
  if(!fs.readFileSync(plan.recordsPath).equals(plan.recordBytes))throw new Error('会话映射在预检后已变化，请重新预检');
  if(!plan.pending.length)return {migrated:0,alreadyMigrated:plan.alreadyMigrated,snapshot:null};
  const snapshot=path.join(plan.state,'upgrade-snapshots','codex-home-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID());
  fs.mkdirSync(snapshot,{recursive:true});
  fs.copyFileSync(plan.recordsPath,path.join(snapshot,'codex-sessions.json'));
  fs.cpSync(plan.chatsPath,path.join(snapshot,'model-chat'),{recursive:true});
  const copied=[];
  try{
    const destination=path.resolve(plan.state,'codex-home','sessions');
    for(const item of plan.pending){
      assertOwnedDestination(plan.state,item.target);
      fs.mkdirSync(path.dirname(item.target),{recursive:true});
      if(!inside(destination,path.resolve(item.target))||fs.existsSync(item.target))throw new Error('独立目录路径冲突');
      fs.copyFileSync(item.source,item.target,fs.constants.COPYFILE_EXCL);
      copied.push(item.target);
      plan.records[item.id].rolloutPath=item.target;
    }
    beforeCommit();
    atomicBytes(plan.recordsPath,Buffer.from(JSON.stringify(plan.records,null,2)+'\n'));
    return {migrated:copied.length,alreadyMigrated:plan.alreadyMigrated,snapshot:path.basename(snapshot)};
  }catch(error){
    if(!fs.readFileSync(plan.recordsPath).equals(plan.recordBytes))atomicBytes(plan.recordsPath,plan.recordBytes);
    for(const target of copied.reverse())if(fs.existsSync(target))fs.unlinkSync(target);
    throw new Error('迁移失败，原会话映射已恢复：'+error.message);
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===scriptPath){
  try{
    const args=process.argv.slice(2),index=args.indexOf('--source-home');
    if(index<0||!args[index+1]||!path.isAbsolute(args[index+1])||args.some((value,i)=>i!==index&&i!==index+1&&value!=='--apply'))throw new Error('用法：node scripts/windows/migrate-codex-sessions.mjs --source-home <旧 Codex 目录> [--apply]');
    const config=JSON.parse(fs.readFileSync(path.join(repoRoot,'config.json'),'utf8'));
    const plan=planSessionMigration(repoRoot,args[index+1]);
    if(args.includes('--apply')&&plan.pending.length){
      const exe=config.codex?.exe;
      if(!exe||!path.isAbsolute(exe)||!fs.existsSync(exe))throw new Error('请先配置官方 codex.exe');
      const checked=spawnSync(process.execPath,[path.join(repoRoot,'scripts','runtime-check.mjs')],{cwd:repoRoot,env:{...process.env,QBOT_CODEX_EXE:exe},stdio:'ignore',timeout:40000,windowsHide:true});
      if(checked.status!==0)throw new Error('请先完成 Qodex 独立 Codex 登录和模型检查');
    }
    const result=args.includes('--apply')?applySessionMigration(plan):{migrated:0,alreadyMigrated:plan.alreadyMigrated,snapshot:null};
    console.log(JSON.stringify({total:plan.total,pending:args.includes('--apply')?0:plan.pending.length,...result}));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
