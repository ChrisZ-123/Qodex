import {spawnSync} from 'node:child_process';
const steps=[
  [process.execPath,['scripts/test-audit.mjs']],
  [process.execPath,['scripts/test-portable-memory.mjs']],
];
if(process.platform==='win32')steps.push(['powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/test-windows-deployment.ps1']]);
else console.log('Windows deployment tests require Windows; only core tests will run on this platform.');
for(const [command,args] of steps){
  const result=spawnSync(command,args,{stdio:'inherit',env:{...process.env,QQ_BRIDGE_TEST_LIVE:'0'},timeout:180000});
  if(result.error||result.status!==0){console.error('Release check failed:',args[0],result.error?.message??result.status);process.exit(1);}
}
console.log('Qodex release checks passed.');
