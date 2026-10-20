// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as forward from '../src/forward.js';
import {expandModelForwards} from '../src/model-forward.js';
import {transcribeModelVoices} from '../src/model-voice.js';
import * as slang from '../src/slang-learner.js';
import * as sticker from '../src/sticker-lib.js';
import * as stickerLearning from '../src/sticker-learning.js';
import {StickerCollector} from '../src/sticker-collector.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';
import { ModelChat, DEFAULT_CHAT_STYLE } from '../src/model-chat.js';
import { ChatMemory } from '../src/chat-memory.js';
import { ModelPreferences } from '../src/model-preferences.js';
import { ModelBackup } from '../src/model-backup.js';
import { loadGeneratedImage } from '../src/generated-images.js';
import {WavesClient,WavesSettings,WavesController,loadWavesAsset,safeGameText,redactWavesLoginLinks} from '../src/waves-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, globals = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [] };
  const forwardReplies=new Map(),voiceReplies=new Map(),messages=new Map();
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    config:{},
    installApplicationTools(tools,version){this.toolGeneration=version;this.applicationTools=tools;},
    listModels:async()=>[{model:'gpt-6-luna',name:'GPT-6 Luna',efforts:['high','max'],defaultEffort:'high'},{model:'fixture-model',name:'Fixture',efforts:['low'],defaultEffort:'low'}],
    events: { follow: (id) => calls.follows.push(id) },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    async raw(method,{id,message_id}={}) { if(method==='get_forward_msg'&&forwardReplies.has(String(id)))return forwardReplies.get(String(id));if(method==='get_record_text'&&voiceReplies.has(String(message_id))){const result=voiceReplies.get(String(message_id));if(result instanceof Error)throw result;return result;}throw Error('Fixture action unavailable'); }
    async getMessage(id) { return messages.get(String(id))??null; }
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async request() { return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] }; }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  source = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '');
  source = source.replace("path.resolve(ROOT,'..','waves')","path.join(ROOT,'waves-runtime')");
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    pumpMux, isConversationBusyV2, modelChat, chatPreferences, chatBackup, waves, wavesClient, wavesSettings,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  const context = vm.createContext({
    fs, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    process: { env: {}, pid: process.pid, platform: process.platform, kill: process.kill, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    CodexApiClient: class { constructor() { return api; } }, ModelChat, DEFAULT_CHAT_STYLE, StickerCollector, ModelPreferences, ModelBackup,WavesClient,WavesSettings,WavesController,loadWavesAsset,safeGameText,
    ChatMemory,loadGeneratedImage,
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,redactWavesLoginLinks,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, expandModelForwards, transcribeModelVoices, ...slang, ...sticker, ...stickerLearning,
    ...globals,
  });
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, setForward:(id,data)=>forwardReplies.set(String(id),data),setVoice:(id,data)=>voiceReplies.set(String(id),data),setMessage:(id,data)=>messages.set(String(id),data),async close() {
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
