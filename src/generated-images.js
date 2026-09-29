import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {BOT_CODEX_HOME} from './codex-rpc.js';

export const GENERATED_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../state/generated-images');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY=/^(group|private):[1-9]\d*$/;
export const MAX_GENERATED_IMAGE_BYTES=15_000_000;

function imageFormat(bytes){
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {mimeType:'image/png',extension:'png'};
  if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return {mimeType:'image/jpeg',extension:'jpg'};
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return {mimeType:'image/webp',extension:'webp'};
  throw new Error('生成结果不是支持的 PNG、JPEG 或 WebP 图片');
}

export function readNativeImage({savedPath,result}){
  let bytes;
  if(savedPath){
    const root=fs.realpathSync(path.join(BOT_CODEX_HOME,'generated_images'));
    const source=fs.realpathSync(savedPath);
    if(!source.startsWith(root+path.sep))throw new Error('原生生图文件不在机器人独立目录');
    const stat=fs.statSync(source);
    if(!stat.isFile()||stat.size<16||stat.size>MAX_GENERATED_IMAGE_BYTES)throw new Error('原生生图文件大小无效');
    bytes=fs.readFileSync(source);
  }else if(typeof result==='string'&&result.length<=MAX_GENERATED_IMAGE_BYTES*2){
    const encoded=result.replace(/^data:image\/(?:png|jpeg|webp);base64,/, '');
    if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw new Error('原生生图数据格式无效');
    bytes=Buffer.from(encoded,'base64');
  }else throw new Error('原生生图没有可读取的结果');
  if(bytes.length<16||bytes.length>MAX_GENERATED_IMAGE_BYTES)throw new Error('生成图片超过大小限制');
  return {bytes,...imageFormat(bytes)};
}

function names(key,runId,imageId,extension){
  if(!KEY.test(key)||!UUID.test(runId)||!UUID.test(imageId)||!['png','jpg','webp'].includes(extension))throw new Error('图片归属或编号无效');
  const dir=path.join(GENERATED_ROOT,key.replace(':','-'),runId);
  return {dir,file:path.join(dir,imageId+'.'+extension)};
}

export function saveGeneratedImage(key,runId,nativeResult){
  const {bytes,mimeType,extension}=readNativeImage(nativeResult);
  const imageId=crypto.randomUUID(),{dir,file}=names(key,runId,imageId,extension);
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx'});
  return {imageId,runId,mimeType,extension,bytes:bytes.length,createdAt:new Date().toISOString()};
}

export function loadGeneratedImage(key,metadata){
  const {file}=names(key,metadata.runId,metadata.imageId,metadata.extension);
  const root=fs.realpathSync(GENERATED_ROOT),actual=fs.realpathSync(file);
  if(!actual.startsWith(root+path.sep))throw new Error('图片文件不在生成目录');
  const stat=fs.statSync(actual);if(!stat.isFile()||stat.size<16||stat.size>MAX_GENERATED_IMAGE_BYTES)throw new Error('生成图片大小无效');
  const bytes=fs.readFileSync(actual),format=imageFormat(bytes);
  if(format.extension!==metadata.extension||format.mimeType!==metadata.mimeType)throw new Error('生成图片格式与记录不符');
  return {bytes,mimeType:format.mimeType};
}
