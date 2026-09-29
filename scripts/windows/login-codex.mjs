import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BOT_CODEX_HOME,codexEnvironment} from '../../src/codex-rpc.js';

const exe=process.env.QBOT_CODEX_EXE;
if(!exe||!path.isAbsolute(exe)||path.basename(exe).toLowerCase()!=='codex.exe'||!fs.existsSync(exe)){
  console.error('请指定官方原生 codex.exe 的完整路径。');
  process.exit(1);
}
fs.mkdirSync(BOT_CODEX_HOME,{recursive:true});
const root=fileURLToPath(new URL('../..',import.meta.url));
const child=spawn(exe,['login'],{cwd:root,env:codexEnvironment(),windowsHide:true,stdio:process.env.QODEX_LOGIN_QUIET==='1'?'ignore':'inherit'});
child.on('error',()=>{console.error('无法启动官方 Codex 登录。');process.exitCode=1;});
child.on('exit',code=>{if(code===0)console.log('Qodex 独立 Codex 登录已完成。');else console.error('Codex 登录未完成，请重试。');process.exitCode=code??1;});
