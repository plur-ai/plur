// Real Codex process, loopback deterministic Responses fixture; no provider credentials.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {appendFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
export async function codexHostFixture({env,project,root,stub}){
 let requests=[],error=null;
 const marker='Synthetic HOSTQUILL fixture: the release validation lane is amber.';
 const model=createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString())}catch{res.writeHead(404);res.end();return;}
  requests.push(body);writeFileSync(join(root,'model-requests.json'),JSON.stringify(requests,null,2));
  const tools=body.tools||[];
  const ns=tools.find(t=>t.type==='namespace'&&t.name==='mcp__plur');
  const name=ns?.tools?.find(t=>t.name==='plur_learn')?.name || tools.find(t=>/plur_learn$/.test(t.name||''))?.name;
  const finished=JSON.stringify(body.input).includes(marker)&&JSON.stringify(body.input).includes('delivery');
  if(!name&&!finished) error='PLUR learn tool absent from actual model request';
  const item=finished||!name||requests.length>4?{id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Fixture complete.',annotations:[]}]}:{id:'fc_fixture_'+requests.length,type:'function_call',name,...(ns?{namespace:ns.name}:{}),call_id:'call_fixture_'+requests.length,arguments:JSON.stringify({statement:marker})};
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  let seq=0;const event=(type,extra)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,sequence_number:seq++,...extra})}\n\n`);
  const response={id:'resp_fixture_'+requests.length,object:'response',created_at:Math.floor(Date.now()/1000),status:'in_progress',model:'fixture',output:[]};
  event('response.created',{response});
  event('response.output_item.added',{output_index:0,item});
  event('response.output_item.done',{output_index:0,item});
  event('response.completed',{response:{...response,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
 });
 await new Promise(r=>model.listen(0,'127.0.0.1',r));
 const port=model.address().port;
 appendFileSync(join(env.CODEX_HOME,'config.toml'),`\n[model_providers.fixture]\nname = "Loopback fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
 const hostEnv={...env};delete hostEnv.OPENAI_API_KEY;delete hostEnv.CODEX_API_KEY;
 let stdout='',stderr='';
 try{
 const args=['exec','--skip-git-repo-check','--dangerously-bypass-hook-trust','--sandbox','workspace-write','-c','mcp_servers.plur.tools.plur_learn.approval_mode="approve"','-c','model_provider="fixture"','-c','model="fixture"','--json','Run the synthetic PLUR memory fixture.'];
 const win=process.platform==='win32';
 // For Windows, launch Codex through its npm JS entry; avoid shell quoting TOML.
 const npmRoot=process.env.PUBLIC_NPM_ROOT;
 const child=spawn(npmRoot?process.execPath:'codex',npmRoot?[join(npmRoot,'@openai','codex','bin','codex.js'),...args]:args,{env:hostEnv,cwd:project,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Codex host timeout'))},90000);child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',c=>{clearTimeout(timer);resolve(c)})});
 writeFileSync(join(root,'codex-host.log'),stdout+'\n'+stderr);
 console.log('CODEX_HOST',JSON.stringify({code,requests:requests.length,error,stdout,stderr}));
 assert.equal(code,0);assert.equal(error,null);assert(stub.appendStatements.includes(marker),'actual Codex did not save memory through MCP');
 assert(requests.length>=2,'tool result did not reach model');
 assert(JSON.stringify(requests[0].input).includes('LOCALQUILL'),'automatic recall hook did not reach model input');
 console.log('PASS actual Codex runs PLUR prompt hook and includes stored memory in model input');
 console.log('PASS actual Codex host invokes PLUR learn and receives remote delivery result');
 }finally{await new Promise(r=>model.close(r));}
}
