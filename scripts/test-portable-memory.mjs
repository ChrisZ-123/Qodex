import assert from 'node:assert/strict';
import path from 'node:path';
import {bridgeHarness} from './audit-bridge-harness.mjs';

const config={backend:'codex',codex:{conversationMode:'model'}};
const instances=[];
try {
  const first=await bridgeHarness({config}); instances.push(first);
  const second=await bridgeHarness({config}); instances.push(second);
  assert.equal(first.modelChat.memory.root,path.join(first.temp,'state','chat-memory'));
  assert.equal(second.modelChat.memory.root,path.join(second.temp,'state','chat-memory'));
  first.modelChat.memory.update('group:456',{content:'Only this deployment.',enabled:true,revision:0});
  assert.equal(second.modelChat.memory.read('group:456').content,'');
  const relative=await bridgeHarness({config:{...config,chatMemory:{directory:'本地 memory'}}}); instances.push(relative);
  assert.equal(relative.modelChat.memory.root,path.join(relative.temp,'本地 memory'));
  const absoluteDir=path.join(first.temp,'explicit memory');
  const absolute=await bridgeHarness({config:{...config,chatMemory:{directory:absoluteDir}}}); instances.push(absolute);
  assert.equal(absolute.modelChat.memory.root,absoluteDir);
  absolute.modelChat.memory.update('private:123',{content:'Explicit directory.',enabled:true,revision:0});
  assert.equal(first.modelChat.memory.read('private:123').content,'');
  console.log('PASS default deployment isolation, relative Chinese/space path and explicit absolute memory directory');
} finally {
  for(const h of instances.reverse())await h.close();
}
