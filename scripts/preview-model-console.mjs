// Local UI fixture. No real QQ transport, credentials, or model calls.
import fs from 'node:fs';
import path from 'node:path';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const h=await bridgeHarness({config:{backend:'codex',codex:{conversationMode:'model',model:'gpt-6-luna',reasoningEffort:'max',serviceTier:'default'},allow:{groups:['10001','10002'],private:['90001']},ownerQQ:90001}});
fs.mkdirSync(path.join(h.temp,'public'));fs.copyFileSync(new URL('../public/model-console.html',import.meta.url),path.join(h.temp,'public/model-console.html'));
fs.mkdirSync(path.join(h.temp,'roles'));fs.writeFileSync(path.join(h.temp,'roles','猫娘.md'),'温柔活泼的猫娘，说话末尾带喵。认真回答问题，查证事实。');
fs.writeFileSync(path.join(h.temp,'state','current-role.json'),JSON.stringify({role:'猫娘',mode:'active'}));
h.modelChat.append('group:10001',{kind:'user',sender:'小林（演示）',text:'这个群能记住哪些事情？'});
h.modelChat.append('group:10001',{kind:'assistant',sender:'Qodex（演示）',text:'群里的共同约定、长期偏好和没聊完的事情，都可以记在本群笔记里喵。你也能在右侧查看和修改。'});
h.modelChat.append('group:10001',{kind:'user',sender:'小林（演示）',text:'记住周五晚八点讨论读书笔记，平时回答简短一点。'});
h.modelChat.memory.update('group:10001',{content:'演示笔记：本群约定周五 20:00 讨论读书笔记。日常回复简短自然；查资料时附上来源。',enabled:true,revision:0});
h.modelChat.append('group:10001',{kind:'event',text:'本群长期记忆已更新 · 虚构数据演示'});
h.modelChat.append('group:10001',{kind:'assistant',sender:'Qodex（演示）',text:'记住啦：周五 20:00 读书分享，日常回复尽量简短喵。'});
const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));console.log(JSON.stringify({port:server.address().port,fixture:true}));
process.on('SIGINT',async()=>{server.closeAllConnections();server.close();await h.close();process.exit(0)});
