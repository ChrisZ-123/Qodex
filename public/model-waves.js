// Waves controls share the local console authentication. No login secrets are rendered.
(()=>{
 let data=null,loadedKey='';const dirty=new Set();
 const button=(label,fn)=>{const b=el('button',label);b.type='button';b.onclick=()=>safe(fn);return b;};
 const field=(p,label,id)=>{const l=el('label',label),s=el('select');l.htmlFor=id;s.id=id;p.append(l,s);return s;};
 const panel=window.registerModelPanel('waves','鸣潮',()=>load(false),{area:'waves'});panel.id='wavesPanel';panel.append(el('h2','鸣潮管理'));
 const state=el('p','正在读取状态','hint'),global=field(panel,'鸣潮总开关 · 全局','wavesGlobal');global.append(new Option('开启','true'),new Option('关闭','false'));panel.prepend(state);
 const scopeLabel=el('p','选择左侧会话后可独立设置','hint');panel.append(scopeLabel);
 const local=field(panel,'鸣潮功能 · 当前会话','wavesLocal');local.append(new Option('继承全局','inherit'),new Option('开启','true'),new Option('关闭','false'));
 global.oninput=()=>dirty.add('global');local.oninput=()=>dirty.add('local');
 window.modelExtensionDirty=()=>dirty.size>0;window.clearModelExtensionDirty=()=>{dirty.clear();loadedKey='';};
 const saved=async(which,body)=>{const r=await api('/api/waves/settings',body);await load(true,which);toast(r.policySynced===false?'本机设置已保存；鸣潮策略同步失败，请查看运行记录。':'鸣潮设置已保存');};
 const actions=el('div',undefined,'row');actions.append(button('保存全局开关',async()=>{if(!data)throw Error('请先载入设置');if(global.value==='true'&&!data.settings.enabled&&!confirm('启用鸣潮后，开启游戏功能的会话会在下一空闲轮建立带工具的 Codex 会话，载入最近100条有效消息及检索记忆；保留旧绑定和全部本地历史供回退。是否启用？'))return;await saved('global',{enabled:global.value==='true',revision:data.settings.revision});}),button('保存当前会话',async()=>{if(!selected||selected!==loadedKey)throw Error('会话已变化，请重新载入');await saved('local',{key:selected,enabled:local.value==='inherit'?null:local.value==='true',revision:data.settings.revision});}),button('重新载入',()=>load(true)));panel.append(actions);
 panel.append(el('p','原版 ww 指令只进入游戏服务；自然语言由当前 GPT 调用。玩家用 ww登录 自助绑定；账号概要核对后才能绑定。自动签到和体力提醒需本人主动确认开启，默认关闭。','hint'));
 panel.append(el('p','鸣潮是可选模块。未安装时，请在部署目录运行 scripts/windows/Install-Waves.ps1 -Python <Python 3.11 可执行文件路径>。远程绑定另需明确启用，基础群聊不需要这些依赖。','hint'));
 const settingsBlock=el('div',undefined,'waves-settings');settingsBlock.append(...panel.children);panel.append(settingsBlock);
 const capabilities=el('section'),accounts=el('section'),subscriptions=el('section'),runs=el('section'),sections=el('div',undefined,'waves-sections'),gameHistory=el('div',undefined,'waves-history');sections.append(capabilities,accounts,subscriptions,runs);panel.append(sections,gameHistory);
 const titles={ready:'可用',pending:'待授权',unavailable:'不可用',failed:'失败',running:'处理中',completed:'完成',cancelled:'取消',confirmation:'等待本人确认'};
 async function load(force,savedField=null){
  const key=selected,r=await api('/api/waves/status'+(key?'?key='+encodeURIComponent(key):''));if(key!==selected)return;state.textContent=(r.service.ready?'鸣潮服务已就绪':'鸣潮服务未就绪')+' · 远程登录 '+(r.service.publicLoginReady?'已就绪':'未就绪')+(r.service.error?' · '+r.service.error:'');
  const changedKey=loadedKey!==key;data=r;loadedKey=key;
  if(force||changedKey){if(savedField&&!changedKey)dirty.delete(savedField);else dirty.clear();}
  if(!dirty.has('global'))global.value=String(r.settings.enabled);if(!dirty.has('local'))local.value=r.override===null||r.override===undefined?'inherit':String(r.override);local.disabled=!key;scopeLabel.textContent=key?title(key)+' · 实际鸣潮功能 '+(r.effective?'开启':'关闭'):'请先选择会话';
  capabilities.replaceChildren(el('h3','功能可用性'));for(const c of r.service.capabilities??[]){capabilities.append(el('p',c.label+' · '+(titles[c.status]||c.status)+(c.reason?' · '+c.reason:''),'mini'));}
  runs.replaceChildren(el('h3','鸣潮运行记录'));for(const item of (r.runs??[]).filter(x=>!key||x.key===key).slice(0,20)){const p=el('div',undefined,'run-card');p.append(el('p',(item.command||'后台任务')+' · '+(titles[item.status]||item.status)),el('p',item.at+' · '+title(item.key)+' · QQ '+(item.senderQQ||'')+(item.elapsedMs!==undefined?' · '+(item.elapsedMs/1000).toFixed(1)+' 秒':''),'mini'));if(item.error)p.append(el('p',item.error,'mini'));runs.append(p);}
  if(r.operational?.policy?.synced===false)runs.append(el('p','策略同步未完成：'+r.operational.policy.error+'；本机关闭/暂停仍会拦截发送，服务侧策略到期停止。','mini'));
  for(const item of (r.operational?.errors??[]).filter(x=>!key||!x.key||x.key===key).slice(-8).reverse())runs.append(el('p',item.at+' · '+item.phase+' · '+item.detail,'mini'));
  if(key){const history=await api('/api/chat?key='+encodeURIComponent(key));if(key!==selected)return;const ids=new Set((r.runs??[]).filter(x=>x.key===key).map(x=>x.id)),messages=history.messages.filter(m=>m.source==='waves'||m.wavesCommand||m.wavesImageId||m.kind==='error'&&ids.has(m.runId)).slice(-20);gameHistory.replaceChildren(el('h3','游戏请求与结果 · '+title(key)));for(const m of messages)gameHistory.append(messageNode(m));if(!messages.length)gameHistory.append(el('p','还没有鸣潮请求。在 QQ 中发送 ww帮助，或用自然语言询问鸣潮。','hint'));}
  accounts.replaceChildren(el('h3','玩家绑定 · 脱敏概要'));subscriptions.replaceChildren(el('h3','自动任务 · 本人开通'));
  if(!r.service.ready){accounts.append(el('p','服务就绪后可查看绑定。','hint'));return;}
  const [a,s]=await Promise.all([api('/api/waves/accounts'),api('/api/waves/subscriptions')]);if(key!==selected)return;
  for(const item of a.accounts??a.bindings??[]){accounts.append(el('p','QQ '+item.senderQQ+' · UID '+(item.uid||'未绑定')+' · '+(item.nickname||'')+' · '+(item.hasCredential?'凭据已加密保存':'未授权'),'mini'));}
  for(const item of (s.subscriptions??[]).filter(x=>!key||x.key===key)){const p=el('div',undefined,'run-card');p.append(el('p',title(item.key)+' · QQ '+item.senderQQ),el('p','自动签到 '+(item.signEnabled?'开启':'关闭')+' · 体力提醒 '+(item.reminderEnabled?'开启':'关闭')+' · 阈值 '+(item.threshold??180),'mini'),button('停用这条自动订阅',async()=>{await api('/api/waves/subscriptions',{key:item.key,senderQQ:item.senderQQ,signEnabled:false,reminderEnabled:false,revision:data.settings.revision});await load(false);toast('订阅已停用');}));subscriptions.append(p);}
  subscriptions.append(el('p','控制台可停用；开通由玩家发送 ww开启自动签到 / ww开启体力提醒，并本人确认。体力提醒在开通群 @本人。','hint'));
 }
 const previews=new Map();window.addEventListener('pagehide',()=>{for(const url of previews.values())URL.revokeObjectURL(url);});
 const oldMessage=messageNode;messageNode=function(m){const n=oldMessage(m);if(!m.wavesImageId)return n;const key=selected,bubble=n.querySelector('.bubble');if(!bubble)return n;bubble.textContent='正在读取鸣潮图片…';(async()=>{try{const cacheKey=key+'/'+m.wavesImageId;let url=previews.get(cacheKey);if(!url){const r=await api('/api/waves/image-preview?key='+encodeURIComponent(key)+'&id='+encodeURIComponent(m.wavesImageId)),bytes=Uint8Array.from(atob(r.image.data),c=>c.charCodeAt(0));url=URL.createObjectURL(new Blob([bytes],{type:r.image.mimeType}));previews.set(cacheKey,url);}const img=el('img'),a=el('a','查看原图 / 下载');img.src=url;img.alt='鸣潮查询结果';img.style.cssText='max-width:100%;max-height:360px;object-fit:contain;display:block';a.href=url;a.download='鸣潮-'+m.wavesImageId+'.png';bubble.replaceChildren(img,a);}catch{bubble.textContent='鸣潮图片不可用，备份不包含图片本体。';}})();return n;};
 labels.gameProcessing='鸣潮处理中';
})();
