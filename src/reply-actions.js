export const REPLY_ACTION_SCHEMA={type:'object',properties:{type:{type:'string',enum:['text','sticker','generatedImage','wavesImage']},text:{type:['string','null']},resourceId:{type:['string','null']}},required:['type','text','resourceId'],additionalProperties:false};

// The model owns the composition; this boundary owns resource and send scope.
export function validateReplyActions(output,{replyMode='natural',stickers=[],gameAssets=new Map(),messageIds=new Set(),imageMode='auto',imageSources=new Map()}={}){
  const fields=['protocolVersion','replyActions','memoryOps','stickerNotes','replyTo','imagePrompt','imageSourceMessageId'];
  if(!output||Array.isArray(output)||output.protocolVersion!==2||Object.keys(output).some(k=>!fields.includes(k))||fields.some(k=>!Object.hasOwn(output,k))||!Array.isArray(output.replyActions)||output.replyActions.length>27||!Array.isArray(output.memoryOps)||output.memoryOps.length>8||!Array.isArray(output.stickerNotes)||output.stickerNotes.length>2)throw Error('模型回复协议或格式无效');
  for(const note of output.stickerNotes)if(!note||Array.isArray(note)||Object.keys(note).length!==2||typeof note.id!=='string'||typeof note.note!=='string'||note.note.length>200)throw Error('表情笔记协议格式无效');
  const opFields=['action','id','version','text','sourceMessageId','kind','participantQQs','topicState','evidenceMessageIds'];
  for(const op of output.memoryOps)if(!op||Array.isArray(op)||Object.keys(op).length!==opFields.length||opFields.some(k=>!Object.hasOwn(op,k))||!['add','revise','disable'].includes(op.action)||(op.id!==null&&typeof op.id!=='string')||(op.version!==null&&!Number.isSafeInteger(op.version))||(op.text!==null&&typeof op.text!=='string')||typeof op.sourceMessageId!=='string'||!['fact','person','episode','topic'].includes(op.kind)||!Array.isArray(op.participantQQs)||op.participantQQs.length>8||op.participantQQs.some(q=>typeof q!=='string'||!/^[1-9]\d*$/.test(q))||!['open','closed',null].includes(op.topicState)||!Array.isArray(op.evidenceMessageIds)||op.evidenceMessageIds.length>4||op.evidenceMessageIds.some(id=>typeof id!=='string'))throw Error('记忆增量协议格式无效');
  if(output.replyTo!==null&&(typeof output.replyTo!=='string'||!messageIds.has(output.replyTo)))throw Error('引用目标不属于本批真实消息');
  if(typeof output.imagePrompt!=='string'||output.imagePrompt.length>2000)throw Error('生图指令格式无效');
  if(output.imageSourceMessageId!==null&&(typeof output.imageSourceMessageId!=='string'||!imageSources.has(output.imageSourceMessageId)))throw Error('参考图不属于本轮可用来源');
  const actions=[],usedStickers=new Set(),usedGame=new Set(),catalog=new Set(stickers.map(s=>s.id));let texts=0,generated=0;
  for(const item of output.replyActions){
    if(!item||Array.isArray(item)||Object.keys(item).length!==3||!['type','text','resourceId'].every(k=>Object.hasOwn(item,k)))throw Error('回复动作格式无效');
    if(item.type==='text'){
      if(typeof item.text!=='string'||!item.text.trim()||item.resourceId!==null)throw Error('文字动作格式无效');
      texts++;actions.push({...item,text:item.text.trim()});
    }else if(item.type==='sticker'){
      if(item.text!==null||typeof item.resourceId!=='string'||!catalog.has(item.resourceId))throw Error('表情不属于本轮可用目录');
      if(usedStickers.has(item.resourceId))throw Error('表情选择重复');usedStickers.add(item.resourceId);actions.push({...item});
    }else if(item.type==='wavesImage'){
      if(item.text!==null||typeof item.resourceId!=='string'||!gameAssets.has(item.resourceId)||usedGame.has(item.resourceId))throw Error('鸣潮图片不属于本轮结果或选择重复');
      usedGame.add(item.resourceId);actions.push({...item});
    }else if(item.type==='generatedImage'){
      if(item.text!==null||item.resourceId!==null)throw Error('生图动作格式无效');generated++;actions.push({...item});
    }else throw Error('未知回复动作');
  }
  if(texts>4)throw Error('文字动作超过单轮四段上限');
  if(replyMode==='single'&&texts>1)throw Error('当前单段文字模式最多一段文字');
  if(usedStickers.size>2)throw Error('表情动作超过单轮两张上限');
  if(usedGame.size>20)throw Error('鸣潮图片超过单轮二十张上限');
  if(generated>1||Boolean(output.imagePrompt.trim())!==(generated===1))throw Error('生图动作与生图请求不一致');
  if(generated&&imageMode==='off')throw Error('本会话已关闭生图');
  if(!generated&&output.imageSourceMessageId!==null)throw Error('没有生图请求时不能指定参考图');
  return {actions,replyTo:output.replyTo,imagePrompt:output.imagePrompt.trim(),imageSourceMessageId:output.imageSourceMessageId};
}
