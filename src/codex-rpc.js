import { spawn } from 'node:child_process';
import readline from 'node:readline';

// Authentication stays in the existing official Codex credential store.
// All overrides are process-local; the user's desktop configuration is untouched.
export const isolatedConfig = {
  mcp_servers: {}, plugins: {},
  skills: {include_instructions:false,bundled:{enabled:false}},
  cloud: {skills:{enabled:false}},
  agents: {max_threads:1},
  project_doc_max_bytes: 0,
  web_search: 'live',
  approval_policy: 'never', sandbox_mode: 'read-only',
  features: {
    shell_tool: false, unified_exec: false, apply_patch_freeform: false,
    code_mode: true, code_mode_host: true, js_repl: false,
    apps: false, connectors: false, plugins: false,
    browser_use: false, computer_use: false, image_generation: false,
    multi_agent: false, multi_agent_v2:false, collab: false, goals:false, memories: false, memory_tool: false,
    hooks: false, codex_hooks: false, plugin_hooks: false,
    view_image: false, skill_search: false, skip_host_skill_discovery: true,
  },
};
function toml(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return `{ ${Object.entries(value).map(([k,v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(', ')} }`;
  }
  return JSON.stringify(value);
}
export class CodexRpc {
  constructor({exe, cwd, onNotification = () => {}, onRequest = async () => { throw new Error('Tool not permitted'); }} = {}) {
    this.pending = new Map(); this.id = 0;
    const args = ['app-server', '--stdio'];
    for (const [k,v] of Object.entries(isolatedConfig)) args.push('-c',`${k}=${toml(v)}`);
    const env = {...process.env};
    for (const k of Object.keys(env)) if (k.startsWith('QBOT_') || k.startsWith('SNOWLUMA_') || (k.startsWith('CODEX_') && k !== 'CODEX_HOME')) delete env[k];
    this.child = spawn(exe || process.env.QBOT_CODEX_EXE || 'codex', args, {cwd, env, windowsHide:true, stdio:['pipe','pipe','pipe']});
    this.child.stderr.resume(); // Never expose credential-bearing diagnostics.
    readline.createInterface({input:this.child.stdout}).on('line',line => {
      let m; try { m=JSON.parse(line); } catch { return; }
      if (m.method && m.id !== undefined) {
        Promise.resolve().then(()=>onRequest(m.method,m.params)).then(
          result=>this.write({id:m.id,result}),
          ()=>this.write({id:m.id,error:{code:-32601,message:'Request not permitted by QQ bridge'}}));
      } else if (m.method) onNotification(m.method,m.params);
      else {
        const p=this.pending.get(m.id); if(!p)return;
        this.pending.delete(m.id); clearTimeout(p.timer);
        m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);
      }
    });
    const fail=()=>{if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Codex process stopped'));}this.pending.clear();onNotification('connection/lost',{});};
    this.child.on('exit',fail); this.child.on('error',fail);
  }
  write(message) { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message)+'\n'); }
  request(method,params={},timeoutMs=30000) {
    if(this.closed)return Promise.reject(new Error('Codex process stopped'));
    return new Promise((resolve,reject)=>{
      const id=++this.id;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex ${method} timed out`));},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});this.write({id,method,params});
    });
  }
  async initialize() {
    await this.request('initialize',{clientInfo:{name:'qq_snowluma_bridge',version:'0.1.0'},capabilities:{experimentalApi:true}});
    this.write({method:'initialized'});
  }
  close() { this.child.kill(); }
}
