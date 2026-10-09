const MAX_VOICES=5, MAX_TEXT=10000;

// Only voice IDs from the current QQ event or a same-conversation verified
// quotation reach this function. Audio and download URLs are never retained.
export async function transcribeModelVoices(messages,{fetchText,cached=()=>null,isCurrent=()=>true,redact=s=>s,now=Date.now,perVoiceMs=30000,budgetMs=60000}){
  const refs=messages.flatMap(message=>(message.voiceRefs??[]).map(ref=>({
    source:ref.source==='quote'?'quote':'message',
    sourceMessageId:String(ref.sourceMessageId??''),
    outerMessageId:String(message.messageId??''),
    sender:redact(String(ref.sender??message.sender??'')).slice(0,120),
    time:String(ref.time??message.time??'').slice(0,50)
  })));
  const started=now(),deadline=started+budgetMs,records=[],seen=new Map();
  for(const ref of refs){
    if(!isCurrent())break;
    const item={...ref,status:'ok',text:''};records.push(item);
    if(records.length>MAX_VOICES){item.status='limit';item.note='本轮最多读取五条语音';continue;}
    const id=Number(ref.sourceMessageId);
    if(!/^-?[1-9]\d*$/.test(ref.sourceMessageId)||!Number.isSafeInteger(id)){item.status='failed';item.note='语音消息编号无效';continue;}
    const known=seen.get(ref.sourceMessageId)??cached(ref.sourceMessageId);
    if(known?.status==='ok'){item.text=known.text;item.cached=true;item.truncated=Boolean(known.truncated);seen.set(ref.sourceMessageId,item);continue;}
    const remaining=Math.min(perVoiceMs,deadline-now());
    if(remaining<=0){item.status='timeout';item.note='本轮语音转写预算已用完';continue;}
    let timer;
    try{
      const result=await Promise.race([
        Promise.resolve().then(()=>fetchText(id)),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('语音转写超时')),remaining);})
      ]);
      if(!isCurrent())break;
      const raw=typeof result==='string'?result:result?.text??result?.data?.text;
      if(typeof raw!=='string'||!raw.trim()){item.status='empty';item.note='QQ 未返回可识别文字';continue;}
      item.text=redact(raw.trim().slice(0,MAX_TEXT));
      item.truncated=raw.trim().length>MAX_TEXT;
      if(item.truncated)item.note='转写文字超过 10000 字符，已截断';
      seen.set(ref.sourceMessageId,item);
    }catch(error){
      item.status=/超时/.test(String(error?.message))?'timeout':'failed';
      item.note=item.status==='timeout'?'语音转写超时':redact(String(error?.message??error)).replace(/https?:\/\/\S+/g,'[地址已隐藏]').slice(0,160);
    }finally{clearTimeout(timer);}
  }
  return {records,readMs:now()-started,voiceCount:refs.length,transcribedCount:records.filter(r=>r.status==='ok').length};
}
