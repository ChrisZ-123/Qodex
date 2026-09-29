import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {planSessionMigration,applySessionMigration} from './windows/migrate-codex-sessions.mjs';
import {BOT_CODEX_HOME} from '../src/codex-rpc.js';
import {GENERATED_ROOT} from '../src/generated-images.js';

const releaseRoot=fileURLToPath(new URL('..',import.meta.url));
assert.equal(path.resolve(BOT_CODEX_HOME),path.join(releaseRoot,'state','codex-home'));
assert.equal(path.resolve(GENERATED_ROOT),path.join(releaseRoot,'state','generated-images'));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'qodex-v040-'));

function fixture(label){
  const root=path.join(temp,label,'Qodex 升级 空格');
  const source=path.join(temp,label,'旧 Codex');
  const id=crypto.randomUUID();
  const sourceFile=path.join(source,'sessions','2026','09','29','rollout-'+id+'.jsonl');
  const recordsPath=path.join(root,'state','codex-sessions.json');
  fs.mkdirSync(path.dirname(sourceFile),{recursive:true});
  fs.mkdirSync(path.join(root,'state','model-chat'),{recursive:true});
  fs.writeFileSync(sourceFile,'{"fixture":"history"}\n');
  fs.writeFileSync(path.join(source,'auth.json'),'fixture credential must stay at source');
  fs.writeFileSync(recordsPath,JSON.stringify({[id]:{preset:'qq-chat-v2'}}));
  fs.writeFileSync(path.join(root,'state','model-chat','group-10001.json'),JSON.stringify({key:'group:10001',sessionId:id,messages:[{text:'fixture conversation'}]}));
  return {root,source,id,recordsPath,sourceFile};
}

try{
  const first=fixture('normal');
  const plan=planSessionMigration(first.root,first.source);
  assert.equal(plan.total,1);assert.equal(plan.pending.length,1);
  assert.equal(fs.existsSync(path.join(first.root,'state','codex-home')),false,'dry-run must not create the target');
  const result=applySessionMigration(plan);
  assert.equal(result.migrated,1);assert(result.snapshot);
  const imported=JSON.parse(fs.readFileSync(first.recordsPath,'utf8'))[first.id].rolloutPath;
  assert.equal(fs.readFileSync(imported,'utf8'),fs.readFileSync(first.sourceFile,'utf8'));
  assert.equal(fs.existsSync(path.join(first.root,'state','codex-home','auth.json')),false);
  assert.equal(fs.readFileSync(path.join(first.source,'auth.json'),'utf8'),'fixture credential must stay at source');
  assert.equal(planSessionMigration(first.root,first.source).pending.length,0);
  assert.equal(applySessionMigration(planSessionMigration(first.root,first.source)).migrated,0);
  assert(fs.existsSync(path.join(first.root,'state','upgrade-snapshots',result.snapshot,'codex-sessions.json')));

  const failed=fixture('rollback');
  const rollbackPlan=planSessionMigration(failed.root,failed.source);
  const original=fs.readFileSync(failed.recordsPath);
  await assert.rejects(async()=>applySessionMigration(rollbackPlan,{beforeCommit:()=>{throw new Error('injected failure');}}),/原会话映射已恢复/);
  assert(fs.readFileSync(failed.recordsPath).equals(original));
  assert.equal(fs.existsSync(rollbackPlan.pending[0].target),false);
  assert.equal(fs.readFileSync(failed.sourceFile,'utf8'),'{"fixture":"history"}\n');

  const conflict=fixture('conflict');
  const conflictPlan=planSessionMigration(conflict.root,conflict.source);
  fs.mkdirSync(path.dirname(conflictPlan.pending[0].target),{recursive:true});
  fs.writeFileSync(conflictPlan.pending[0].target,'different');
  assert.throws(()=>planSessionMigration(conflict.root,conflict.source),/同名/);
  assert.equal(fs.readFileSync(conflictPlan.pending[0].target,'utf8'),'different');

  const foreign=fixture('foreign');
  const record=JSON.parse(fs.readFileSync(foreign.recordsPath,'utf8'));
  record[foreign.id].rolloutPath=foreign.sourceFile;
  fs.writeFileSync(foreign.recordsPath,JSON.stringify(record));
  assert.throws(()=>planSessionMigration(foreign.root,foreign.source),/独立目录/);
  console.log('PASS v0.4 isolated paths, explicit session migration, repeated run, conflict, rollback and credential exclusion');
}finally{
  if(!path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep+'qodex-v040-'))throw new Error('Unexpected cleanup target');
  fs.rmSync(temp,{recursive:true,force:true});
}
