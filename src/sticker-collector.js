// Only collect explicit OneBot sticker images, never ordinary chat pictures.
export class StickerCollector {
  constructor({enabled,allowed,count,download,add,sync,save,seen=[]}){
    Object.assign(this,{enabled,allowed,count,download,add,sync,save});
    this.seen=new Set(seen);this.queue=Promise.resolve();
  }
  collect(key,event,media){
    const job=this.queue.then(()=>this.run(key,event,media));
    this.queue=job.catch(()=>{});return job;
  }
  async run(key,event,media){
    if(!key.startsWith('group:')||String(event.user_id)===String(event.self_id)||!this.enabled()||!this.allowed(key))return [];
    const results=[];
    for(const [index,item] of media.entries()){
      if(item.kind!=='image'||String(item.subType)!=='1')continue;
      const file=String(item.file||'');
      const source=/^[\w.{}-]{1,200}$/.test(file)?`file:${file}`:/^-?[1-9]\d*$/.test(String(event.message_id))?`${key}:${event.message_id}:${index}`:null;
      if(!source||this.seen.has(source))continue;
      if(!this.enabled()||!this.allowed(key))break;
      if(this.count()>=100){results.push('收藏库已达 100 张，自动收藏暂停新增');break;}
      // Persist the attempt before external mutation, so restarts or duplicate
      // events cannot silently repeat a collection with an uncertain outcome.
      this.save([...this.seen,source]);this.seen.add(source);
      try{
        const image=await this.download(item);
        if(!image?.buffer)throw Error('image unavailable');
        if(!this.enabled()||!this.allowed(key))break;
        const id=await this.add(image.buffer);
        if(!id)throw Error('collection not confirmed');
        const synced=await this.sync();
        results.push(synced?'已自动收藏群聊表情并同步，后续聊天可看图学习':'QQ 已收藏表情，但本地同步失败，请在控制台同步收藏');
      }catch{results.push('群聊表情自动收藏失败，未自动重试；可在 QQ 手动收藏后同步');}
    }
    return results;
  }
}
