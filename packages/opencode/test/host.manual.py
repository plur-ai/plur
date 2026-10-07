import os,subprocess,tempfile,json,threading,time,shutil,re,platform
from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
# Actual host gate: an installed packed PLUR artifact and a deterministic local model.
# No provider credentials are read or copied. Fixtures stay in a fresh temporary HOME.
import argparse,shlex
parser=argparse.ArgumentParser()
parser.add_argument('--packed',type=Path,required=True,help='npm prefix containing the four packed PLUR packages')
parser.add_argument('--host',type=Path,required=True,help='actual OpenCode executable')
parser.add_argument('--node',type=Path,required=True)
parser.add_argument('--model-cache',type=Path,help='public BGE model directory with config/tokenizer/onnx files')
parser.add_argument('--v1',action='store_true')
parser.add_argument('--mode',choices=['on','off','ask'],default='on')
parser.add_argument('--accept-consent',action='store_true',help='exercise wrong-session refusal, acceptance and replay refusal during an ask fixture')
parser.add_argument('--mcp',action='store_true',help='also load the packed real PLUR MCP server')
args=parser.parse_args()
if args.accept_consent and (args.mode!='ask' or args.v1):parser.error('--accept-consent requires V2 ask mode')
packed=args.packed.resolve()
case=Path(tempfile.mkdtemp(prefix='plur-v2-packed-model-'));home=case/'home';home.mkdir();project=case/'project';project.mkdir()
requests=[]
consent_results=[]
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));requests.append(body)
  if args.accept_consent and not consent_results:
   for m in body.get('messages',[]):
    content=m.get('content','')
    if not isinstance(content,str):continue
    match=re.search(r'^- Yes: (plur [^\n]+)',content,re.M)
    if not match:continue
    offered=shlex.split(match.group(1));cmd=[node,str(cli)]+offered[1:]
    wrong=list(cmd);wrong[wrong.index('--session')+1]='wrong-session'
    for label,argv in [('wrong',wrong),('accept',cmd),('replay',cmd)]:
     r=subprocess.run(argv,cwd=project,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf-8',errors='replace',timeout=30)
     consent_results.append((label,r.returncode));(case/('consent-'+label+'.txt')).write_text(r.stdout,encoding='utf-8')
    break
  text='PACKED_MODEL_OK\n\n---\n🧠 I learned:\n- The signed release marker is PLUR_V2_ASSISTANT_GREEN.'
  self.send_response(200);self.send_header('Content-Type','text/event-stream' if body.get('stream') else 'application/json');self.end_headers()
  choice={'index':0,'message':{'role':'assistant','content':text},'finish_reason':'stop'}
  if body.get('stream'):
   for delta,finish in [({'role':'assistant','content':text},None),({},'stop')]:
    self.wfile.write(('data: '+json.dumps({'id':'fixture','object':'chat.completion.chunk','created':int(time.time()),'model':'probe','choices':[{'index':0,'delta':delta,'finish_reason':finish}]})+'\n\n').encode())
   self.wfile.write(b'data: [DONE]\n\n')
  else:self.wfile.write(json.dumps({'id':'fixture','object':'chat.completion','created':int(time.time()),'model':'probe','choices':[choice],'usage':{'prompt_tokens':100,'completion_tokens':30,'total_tokens':130}}).encode())
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever);thread.start()
config={'plugins':[str(packed/'node_modules/@plur-ai/opencode/dist')],'update':'disable','share':'disabled','model':'plur-local/probe','providers':{'plur-local':{'name':'PLUR local fixture','package':'@opencode/ai/providers/openai-compatible','settings':{'baseURL':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'synthetic-fixture'},'models':{'probe':{'name':'Probe','limit':{'context':32768,'output':1024},'capabilities':{'tools':args.mcp}}}}}}
if args.v1:
 config={'plugin':[(packed/'node_modules/@plur-ai/opencode/dist/index.js').as_uri()],
  'autoupdate':False,'share':'disabled','model':'plur-local/probe','small_model':'plur-local/probe',
  'provider':{'plur-local':{'npm':'@ai-sdk/openai-compatible','name':'PLUR local fixture',
   'options':{'baseURL':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'synthetic-fixture'},
   'models':{'probe':{'name':'Probe','limit':{'context':32768,'output':1024}}}}}}
if args.mcp:
 entry={'type':'local','command':[str(args.node),str(packed/'node_modules/@plur-ai/mcp/dist/index.js')]}
 config['mcp']={'plur':entry} if args.v1 else {'servers':{'plur':entry}}
(project/'opencode.json').write_text(json.dumps(config),encoding='utf-8')
env={'HOME':str(home),'USERPROFILE':str(home),'XDG_CONFIG_HOME':str(home/'.config'),'XDG_DATA_HOME':str(home/'.local/share'),'XDG_CACHE_HOME':str(home/'.cache'),'XDG_STATE_HOME':str(home/'.local/state'),'PATH':os.pathsep.join([str(packed/'node_modules/.bin'),str(args.node.parent),os.environ.get('PATH',os.defpath)]),'PLUR_PATH':str(case/'plur'),'TMPDIR':str(case),'PLUR_DEBUG':'1'}
# Keep only Windows process-launch essentials; never inherit provider credentials.
for key in ('SystemRoot','WINDIR','COMSPEC','PATHEXT','SystemDrive'):
 if key in os.environ:env[key]=os.environ[key]
env.update(TEMP=str(case),TMP=str(case),APPDATA=str(home/'AppData/Roaming'),LOCALAPPDATA=str(home/'AppData/Local'))
if not args.model_cache: env['PLUR_DISABLE_EMBEDDINGS']='1'
node=str(args.node);cli=packed/'node_modules/@plur-ai/cli/dist/index.js'
def command(args,name,timeout=180):
 r=subprocess.run(args,cwd=project,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf-8',errors='replace',timeout=timeout)
 (case/(name+'.txt')).write_text(r.stdout,encoding='utf-8')
 assert r.returncode==0,(name,r.returncode,r.stdout[-2000:])
 return r.stdout
print('Probe root:',case,flush=True)
print('Host:',args.host,'mode:',args.mode,'v1:',args.v1,flush=True)
try:
 seed=args.model_cache
 for name in (['config.json','tokenizer.json','tokenizer_config.json','onnx/model.onnx'] if seed else []):
  target=packed/'node_modules/@huggingface/transformers/.cache/Xenova/bge-small-en-v1.5'/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(seed/name,target)
 setup = 'import {setFolderEntry} from '+json.dumps((packed/'node_modules/@plur-ai/core/dist/index.js').as_uri())+'; setFolderEntry('+json.dumps(str(case/'plur'))+','+json.dumps(str(project))+',{mode:"on"},{configuredScopes:[]});'
 if args.mode!='ask':
  setup=setup.replace('mode:"on"','mode:'+json.dumps(args.mode))
  command([node,'--input-type=module','-e',setup],'fixture-folder-decision')
 command([node,str(cli),'learn','The release codename is PLUR_V2_CANARY_CYAN.'],'seed')
 host=str(args.host)
 host_args=[host,'run']+([] if args.v1 else ['--standalone'])+['--print-logs','--format','json']
 first=command(host_args+['No, use cyan, not violet for the release codename. What is the release codename?'],'first')
 assert 'PluginModule.LoadError' not in first
 assert not re.search(r'\[plur:opencode\].*(TypeError|ReferenceError)',first),'Adapter runtime error in actual host'
 if args.accept_consent:
  assert consent_results[0][1]!=0 and consent_results[1][1]==0 and consent_results[2][1]!=0,consent_results
  print('Actual offered consent command: wrong session refused, accepted once, replay refused.',flush=True)
 if args.mcp:
  assert re.search(r'mcp connected.*server=plur.*tools=14',first),'Real MCP server did not connect with its 14 tools'
  assert 'MCP connection failed' not in first
  print('Packed MCP server connected alongside the plugin with 14 tools.',flush=True)
 if args.mode=='on':
  assert any('PLUR_V2_CANARY_CYAN' in json.dumps(r.get('messages',[])) for r in requests),'Seed memory did not reach actual model request'
 store=(case/'plur/engrams.yaml').read_text(encoding='utf-8')
 if args.mode=='on':
  assert 'PLUR_V2_ASSISTANT_GREEN' in store,'Completed assistant learning absent after host cleanup'
  assert 'opencode:chat.message' in store,'User correction absent'
  print('Actual host loaded packed plugin, injected seeded memory, and learned user/assistant statements.',flush=True)
 else:
  assert not any('PLUR_V2_CANARY_CYAN' in json.dumps(r.get('messages',[])) for r in requests),'Disabled memory reached model'
  assert 'PLUR_V2_ASSISTANT_GREEN' not in store and 'opencode:chat.message' not in store,'Disabled memory learned text'
  if args.mode=='ask':
   assert any('--nonce' in json.dumps(r.get('messages',[])) for r in requests),'Consent question missing'
   if not args.v1: assert any('--session' in json.dumps(r.get('messages',[])) for r in requests),'V2 command has no explicit session binding'
  print('No automatic recall or learning in '+args.mode+' mode.',flush=True)
 ids=[]
 for line in first.splitlines():
  try:
   row=json.loads(line)
   if row.get('sessionID'):ids.append(row['sessionID'])
  except ValueError:pass
 assert ids,'Could not identify actual session'
 before=len(requests)
 command(host_args+['--session',ids[0],'What is the signed release marker and release codename?'],'restart')
 if args.mode=='on':
  assert any('PLUR_V2_ASSISTANT_GREEN' in json.dumps(r.get('messages',[])) for r in requests[before:]),'Learned memory absent after host restart'
 if args.mode!='on' and not args.accept_consent:
  assert not any('PLUR_V2_CANARY_CYAN' in json.dumps(r.get('messages',[])) for r in requests[before:]),'Disabled memory reached model after restart'
  assert (case/'plur/engrams.yaml').read_text(encoding='utf-8')==store,'Disabled memory wrote to the store after restart'
 if args.accept_consent:
  assert any('PLUR_V2_CANARY_CYAN' in json.dumps(r) for r in requests[before:]),'Accepted consent did not enable recall after restart'
 print('Actual host restart PASS.',flush=True)
 result={'passed':True,'os':platform.platform(),'arch':platform.machine(),'node':command([node,'--version'],'node-version').strip(),'host':command([host,'--version'],'host-version').strip(),'mode':args.mode,'v1':args.v1,'model_requests':len(requests),'consent':consent_results,'mcp':args.mcp}
 (case/'result.json').write_text(json.dumps(result),encoding='utf-8');print(json.dumps(result),flush=True)
finally:
 server.shutdown();thread.join();server.server_close();(case/'requests.json').write_text(json.dumps(requests,indent=2),encoding='utf-8')
