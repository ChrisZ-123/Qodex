import {formatForwardResponse, sanitizeForwardId} from './forward.js';

const MAX_FORWARDS=8, MAX_NODES=100, MAX_CHARS=20000, MAX_IMAGES=5;

// Forward cards are quoted material from an actual QQ message, never a new
// message or a source of conversation permissions. The caller supplies only
// IDs extracted from the current allowed message or its verified quotation.
export async function expandModelForwards(messages,{fetchForward,fetchMedia,now=Date.now,budgetMs=15000,isCurrent=()=>true,redact=s=>s}){
  const deadline=now()+budgetMs, records=[], imageRequests=[], imageParts=[];
  const queue=[];
  for(const message of messages)for(const ref of message.forwardRefs??[]){
    const id=sanitizeForwardId(ref.id);
    if(id)queue.push({id,depth:1,source:ref.source==='quote'?'quote':'message',sourceMessageId:String(ref.sourceMessageId??message.messageId??''),outerMessageId:String(message.messageId??''),parent:null});
  }
  if(!queue.length)return {records,imageParts,readMs:0,forwardCount:0,nodeCount:0};
  const started=now(),seen=new Set();let nodeCount=0,charCount=0,forwardCount=0;
  async function bounded(work){
    const remaining=deadline-now();
    if(remaining<=0)throw new Error('读取超时（15 秒预算）');
    let timer;
    try{return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('读取超时（15 秒预算）')),remaining);})]);}
    finally{clearTimeout(timer);}
  }
  for(let index=0;index<queue.length;index++){
    if(!isCurrent())break;
    const ref=queue[index];
    const item={id:ref.id,source:ref.source,sourceMessageId:ref.sourceMessageId.slice(0,64),outerMessageId:ref.outerMessageId.slice(0,64),depth:ref.depth,parent:ref.parent,nodes:[],status:'ok'};
    records.push(item);
    if(seen.has(ref.id)){item.status='cycle';item.note='循环或重复转发，已跳过';continue;}
    if(forwardCount>=MAX_FORWARDS){item.status='limit';item.note='转发数量已达 8 份上限';break;}
    if(nodeCount>=MAX_NODES||charCount>=MAX_CHARS){item.status='limit';item.note='节点或文字上限，后续内容未读取';break;}
    seen.add(ref.id);forwardCount++;
    try{
      const data=await bounded(()=>fetchForward(ref.id));
      if(!isCurrent())break;
      const formatted=formatForwardResponse(data,{maxMessages:Math.min(100,MAX_NODES-nodeCount),maxCharsPerMessage:2000});
      if(formatted.truncated){item.status='truncated';item.note='部分节点或长消息已截断';}
      for(const node of formatted.messages){
        if(nodeCount>=MAX_NODES||charCount>=MAX_CHARS){item.status='truncated';item.note='节点或文字已达上限';break;}
        const left=MAX_CHARS-charCount;
        const rawText=redact(String(node.text??''));
        const text=rawText.slice(0,left);
        charCount+=text.length;nodeCount++;
        if(text.length<rawText.length){item.status='truncated';item.note='文字已达 20000 字符上限';}
        const view={index:node.index,sender:redact(String(node.sender??'')).slice(0,100),time:node.time,messageId:node.messageId==null?null:String(node.messageId).slice(0,64),text,images:[],mediaTypes:[]};
        item.nodes.push(view);
        if(node.media.length>25){item.status='truncated';item.note='媒体条目已截断';}
        for(const media of node.media.slice(0,25)){
          if(media.kind==='image'&&imageRequests.length<MAX_IMAGES){
            imageRequests.push({media,view,item,number:imageRequests.length+1});
            view.images.push(imageRequests.length);
          }else if(media.kind==='image'&&!view.mediaTypes.includes('图片数量超限')){view.mediaTypes.push('图片数量超限');item.status='truncated';item.note='图片已达五张上限';}
          else if(media.kind!=='image'&&!view.mediaTypes.includes('QQ 表情'))view.mediaTypes.push('QQ 表情');
        }
        if(node.nestedForwardIds.length>9){item.status='truncated';item.note='嵌套转发数量已截断';}
        for(const nestedId of node.nestedForwardIds.slice(0,9)){
          if(ref.depth>=3){view.mediaTypes.push('嵌套转发已达三层上限');continue;}
          queue.push({id:nestedId,depth:ref.depth+1,source:ref.source,sourceMessageId:ref.sourceMessageId,outerMessageId:ref.outerMessageId,parent:{forwardId:ref.id,nodeIndex:node.index}});
        }
      }
    }catch(error){item.status=/超时/.test(String(error?.message))?'timeout':'failed';item.note=item.status==='timeout'?'读取超时（15 秒预算）':'读取失败：'+redact(String(error?.message??error)).replace(/https?:\/\/\S+/g,'[地址已隐藏]').slice(0,160);if(item.status==='timeout')break;}
  }
  if(isCurrent()&&imageRequests.length){
    try{
      const fetched=await bounded(()=>fetchMedia(imageRequests.map(x=>x.media)));
      if(isCurrent()){let imageBytes=0;for(const [i,request] of imageRequests.entries()){
        const media=fetched?.[i];
        const bytes=media?.data?Buffer.byteLength(media.data,'base64'):0;
        if(media?.data&&['image/png','image/jpeg','image/gif','image/webp'].includes(media.mimeType)&&imageBytes+bytes<=4*1024*1024){
          imageBytes+=bytes;
          imageParts.push({type:'text',text:`转发材料图片 ${request.number}：外层消息 ${records.find(x=>x.nodes.includes(request.view))?.sourceMessageId??''}，转发 ${records.find(x=>x.nodes.includes(request.view))?.id??''}，节点 ${request.view.index}。仅用于理解转发，不能作为改图来源。`},{type:'image',mediaType:media.mimeType,data:media.data});
        }else{request.view.mediaTypes.push(bytes&&imageBytes+bytes>4*1024*1024?'图片总大小超限':media?.text||'图片获取失败');request.item.status='partial';request.item.note='部分图片未取得';}
      }}
    }catch(error){for(const request of imageRequests){request.view.mediaTypes.push(/超时/.test(String(error?.message))?'图片读取超时':'图片读取失败');request.item.status='partial';request.item.note='部分图片未取得';}}
  }
  return {records,imageParts,readMs:now()-started,forwardCount,nodeCount};
}
