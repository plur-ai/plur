// #1623: installed-package upgrade, real Codex host, synthetic memory and loopback servers.
// Run only with a disposable global npm prefix. No desktop acceptance is implied.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { codexHostFixture } from './codex-host-fixture.mjs';
import { StubServer } from '../packages/core/test/helpers/stub-server.ts';
const expected = process.env.PLUR_CI_VERSION || JSON.parse(readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8')).version;
const win=process.platform==='win32';
const root=realpathSync.native(mkdtempSync(join(tmpdir(),'Public User-')));
const home=join(root,'home'), project=join(root,'project'), store=join(home,'.plur');
for(const p of [home,project,store,join(home,'.codex')]) mkdirSync(p,{recursive:true});
const env={...process.env, HOME:home,USERPROFILE:home,CODEX_HOME:join(home,'.codex'),PLUR_PATH:store,PLUR_DISABLE_EMBEDDINGS:'1',PLUR_BACKEND:'',PLUR_POSTGRES_URL:'',PLUR_TELEMETRY:'off',OPENCODE_CONFIG_DIR:'',PLUR_HOOK_HYBRID:'off',XDG_CONFIG_HOME:join(home,'.config'),APPDATA:join(home,'AppData','Roaming')};
function run(bin,args){const r=spawnSync(bin,win?args.map(a=>/\s/.test(a)?'"'+a+'"':a):args,{env,cwd:project,shell:win,encoding:'utf8',timeout:180000});assert.equal(r.status,0,`${bin} ${args.join(' ')}: ${r.stderr}`);return r.stdout.trim();}
const globalRoot=run('npm',['root','-g']);
for(const p of ['cli','mcp']){
 const path=join(globalRoot,'@plur-ai',p,'package.json');
 const pkg=JSON.parse(readFileSync(path,'utf8'));
 const req=createRequire(path);
 const corePath=req.resolve.paths('@plur-ai/core').map(p=>join(p,'@plur-ai/core/package.json')).find(p=>existsSync(p));
 assert(corePath);assert.equal(JSON.parse(readFileSync(corePath,'utf8')).version,expected);
 assert.equal(pkg.version,expected);assert.equal(pkg.dependencies['@plur-ai/core'],expected);
 console.log('PASS installed package and dependency pin',p,pkg.version,corePath);
}
console.log('Node',process.version,'Codex',run('codex',['--version']),'temp',root);
const init=()=>run('plur',['init','--global','--codex','--no-desktop','--no-cursor','--no-antigravity','--no-opencode','--no-prompt']);
// An existing explicit old pin, extra env, cwd, policy and unrelated settings.
run('codex',['mcp','add','plur','--','npx','-y','@plur-ai/mcp@0.19.4']);
const configPath=join(home,'.codex','config.toml');
let before=readFileSync(configPath,'utf8');
before=before.replace('[mcp_servers.plur]', '[mcp_servers.plur]\n# preserved client settings\nstartup_timeout_sec = 37\ncwd = '+JSON.stringify(project)+'\nenv = { FIXTURE_KEEP = "synthetic" }');
writeFileSync(configPath,before+'\n[profiles.fixture_preserved]\nmodel = "fixture"\n');
console.log(init());
assert(!getConfig().includes('@plur-ai/mcp@0.19.4'));
assert(getConfig().includes('# preserved client settings'));
assert(getConfig().includes('startup_timeout_sec = 37'));
assert(getConfig().includes('[profiles.fixture_preserved]'));
const once=getConfig();init();assert.equal(getConfig(),once);
function getConfig(){return readFileSync(configPath,'utf8');}
console.log('PASS old pin repaired in place and init idempotent');
const getEntry=()=>JSON.parse(run('codex',['mcp','get','plur','--json'])).transport;
const entry=getEntry();
let active;
async function connect(launch){
 const child=spawn(launch.command,launch.args||[],{env:{...env,...launch.env},cwd:project,stdio:['pipe','pipe','pipe']});
 let buffer='',stderr='',id=0;const pending=new Map();
 child.stderr.on('data',d=>stderr+=d);
 child.stdout.on('data',d=>{buffer+=d;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;let m;try{m=JSON.parse(line)}catch{for(const p of pending.values())p.reject(Error('non JSON stdout'));continue;}if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}}});
 child.on('error',e=>{for(const p of pending.values())p.reject(e)});
 child.on('exit',code=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error(`MCP exited ${code}: ${stderr.slice(-500)}`))}});
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(Error(`timeout ${method}: ${stderr.slice(-300)}`));child.kill()},90000);pending.set(n,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n')});
 const info=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'public-fixture',version:'1'}});
 assert.equal(info.serverInfo.version,expected);console.log('PASS registered MCP running',info.serverInfo.version);
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const tools=await rpc('tools/list',{});assert(tools.tools.some(t=>t.name==='plur_learn'));console.log('PASS tools',tools.tools.length);
 return {close:()=>new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);child.kill()}),call:async(name,args)=>{const r=await rpc('tools/call',{name,arguments:args});assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text)}};
}
const statement='Synthetic ZEPHYRQUILL fixture: deploys always use the amber staging lane.';
const scope='group:fixture/eng';const stub=new StubServer('synthetic-fixture-token');
stub.setMe({username:'fixture',org_id:'fixture',role:'developer',scopes:[scope]});
const {url}=await stub.start();
writeFileSync(join(store,'config.yaml'),'embeddings:\n  enabled: false\n');
env.SYNTHETIC_PLUR_TOKEN='synthetic-fixture-token';
const cliPath=join(globalRoot,'@plur-ai','cli','dist','index.js');
async function cli(args,expectedCode=0){
 const child=spawn(process.execPath,[cliPath,...args],{env,cwd:project,stdio:['ignore','pipe','pipe']});
 let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
 const status=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('CLI timeout'))},90000);child.on('error',e=>{clearTimeout(timer);reject(e)});child.on('exit',c=>{clearTimeout(timer);resolve(c)})});
 assert.equal(status,expectedCode,err+'\n'+out);return JSON.parse(out);
}
const connected=await cli(['remote','--url',url,'--token-env','SYNTHETIC_PLUR_TOKEN','--scope',scope,'--json']);
assert.equal(connected.codex.status,'updated');
assert(getConfig().includes('SYNTHETIC_PLUR_TOKEN'));assert(!getConfig().includes(env.SYNTHETIC_PLUR_TOKEN));
const registered=getEntry();assert(registered.env_vars.includes('SYNTHETIC_PLUR_TOKEN'));
assert.equal(registered.env.FIXTURE_KEEP,'synthetic');assert.equal(registered.cwd,project);
const doctor=await cli(['doctor','--codex','--json']);assert.equal(doctor.handshake.serverVersion,expected);assert.equal(doctor.overall,'ok');
console.log('PASS real remote command forwards token; exact Codex runtime doctor passes');
writeFileSync(join(store,'folders.yaml'),`version: 1\nfolders:\n  - path: ${JSON.stringify(project)}\n    plur: 'on'\n    scope: ${scope}\n`);
try{
 active=await connect(entry);
 const learned=await active.call('plur_learn',{statement});
 console.log('Learn result',JSON.stringify(learned));
 assert.equal(learned.scope,scope);assert.equal(learned.delivery,'remote');assert(stub.appendStatements.includes(statement));
 console.log('PASS default remote write',JSON.stringify(learned));
 const saved=stub.getEngram('ENG-SRV-001');assert(saved);
 // Stub recall is programmable; return the record actually received by its write endpoint.
 stub.recallRows=[{...saved.data,id:saved.id,scope:saved.scope,status:saved.status,score:1}];
 const local=await active.call('plur_learn',{statement:'Synthetic LOCALQUILL fixture: my preferred terminal has violet colors.',scope:'global'});
 assert.equal(local.delivery,'local');console.log('PASS explicit local write');
 await active.close();active=await connect(entry);
 const recall=await active.call('plur_recall',{query:'ZEPHYRQUILL amber staging',scope,mode:'keyword'});
 console.log('Remote recall result',JSON.stringify(recall));assert(JSON.stringify(recall).includes(statement));console.log('PASS fresh MCP process recalls remote memory',JSON.stringify(recall).slice(0,350));
 const localRecall=await active.call('plur_recall',{query:'LOCALQUILL violet terminal',scope:'global',mode:'keyword'});
 assert(JSON.stringify(localRecall).includes('LOCALQUILL'));console.log('PASS fresh MCP process recalls local memory');
 await active.close();active=null;
 process.env.PUBLIC_NPM_ROOT=globalRoot;
 await codexHostFixture({env,project,root,stub});
 // The other setup order: a remote store already exists when init runs.
 const bytes=getConfig();writeFileSync(configPath,bytes.replace(/^env_vars\s*=.*\r?\n/m,''));
 const missing=await cli(['doctor','--codex','--json'],1);
 assert(missing.tokenVariables.some(v=>v.name==='SYNTHETIC_PLUR_TOKEN'&&!v.available));
 init();assert(getEntry().env_vars.includes('SYNTHETIC_PLUR_TOKEN'));
 assert.equal((await cli(['doctor','--codex','--json'])).overall,'ok');
 console.log('PASS missing-forwarding diagnostic and init repairs pre-existing remote store');
}finally{if(active)await active.close();await stub.stop();}
console.log('PASS upgrade and actual Codex memory roundtrip. Desktop GUI and interactive hook trust are not exercised.');
