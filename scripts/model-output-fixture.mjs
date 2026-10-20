// Test-only migration of old fixture notation into the strict production protocol.
export function modelOutput({reply='',stickerIds=[],wavesResultIds=[],memoryOps=[],stickerNotes=[],replyTo=null,imagePrompt='',imageSourceMessageId=null}={}){
  return {protocolVersion:2,replyActions:[
    ...(reply?[{type:'text',text:reply,resourceId:null}]:[]),
    ...wavesResultIds.map(resourceId=>({type:'wavesImage',text:null,resourceId})),
    ...stickerIds.map(resourceId=>({type:'sticker',text:null,resourceId})),
    ...(imagePrompt?[{type:'generatedImage',text:null,resourceId:null}]:[]),
  ],memoryOps:memoryOps.map(op=>({kind:'fact',participantQQs:[],topicState:null,evidenceMessageIds:[],...op})),stickerNotes,replyTo,imagePrompt,imageSourceMessageId};
}
