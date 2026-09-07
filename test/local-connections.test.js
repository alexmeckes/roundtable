import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import express from 'express';
import {allowedLocalRequest,localMember} from '../local/access.js';
import {LocalConnections} from '../local/manager.js';
import {mountLocalConnections} from '../local/routes.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const origin='http://localhost:3131';
function request(headers={},remoteAddress='127.0.0.1'){return {socket:{remoteAddress,localPort:3131},headers:{origin,host:'localhost:3131','content-type':'application/json',...headers}};}

test('local launch requires a loopback socket, exact local origin, port, JSON, and no forwarded identity',()=>{
  assert.equal(allowedLocalRequest(request()),true);
  for(const req of [request({},'192.0.2.1'),request({origin:'https://evil.example'}),request({origin:'http://localhost.evil:3131'}),request({origin:'http://localhost:9999'}),request({origin:undefined}),request({'content-type':'text/plain'}),request({'x-forwarded-for':'127.0.0.1'}),request({'forwarded':'for=127.0.0.1'}),request({host:'evil.example'})])assert.equal(allowedLocalRequest(req),false);
  assert.equal(allowedLocalRequest(request(),{enabled:false}),false);
});

async function fixture(t,{ready=true}={}){
  const root=await mkdtemp(join(tmpdir(),'roundtable-local-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const member={id:'owner',keyHash:hash('member-secret')},other={id:'friend',keyHash:hash('friend-secret')};
  const room={id:'test-room',members:[member,other],people:new Map([['socket',{id:member.id}],['other',{id:other.id}]]),personalBridges:new Map()};
  const rooms=new Map([[room.id,room]]),launched=[];
  let pickerCalls=0;
  const deps={file:join(root,'local.json'),rooms,workspace:{pair(room,ownerId){const token='private-'+ownerId;room.members.find(m=>m.id===ownerId).bridgeHash=hash(token);return token;}},detect:async()=>({installed:true,signedIn:true,version:'0.test',command:'/trusted/codex'}),project:async()=>null,picker:async()=>true,pick:async()=>{pickerCalls++;return root;},describe:async(path,mode)=>({path,name:'Chosen folder',mode:mode==='git'?'git':'folder'}),readyTimeout:2000,stopTimeout:100,launch(args,env){const child=new EventEmitter();child.exitCode=null;child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.exitCode=0;queueMicrotask(()=>{child.emit('exit',0);child.emit('close',0);});return true;};launched.push({child,args,env});if(ready)setTimeout(()=>child.emit('message',{type:'roundtable-ready',room:room.id,ownerId:member.id}),5);return child;}};
  const manager=new LocalConnections(deps);await manager.load();t.after(()=>manager.close());
  return {root,room,rooms,member,other,manager,deps,launched,get pickerCalls(){return pickerCalls;}};
}

test('folder selections are owner scoped; launch arguments are literal and credentials stay private',async t=>{
  const f=await fixture(t),selection=await f.manager.select(origin,f.room,f.member,{});
  await assert.rejects(f.manager.start(origin,f.room,f.other,{selection:selection.selection}),/Choose the folder again/);
  const result=await f.manager.start(origin,f.room,f.member,{selection:selection.selection,check:'printf "$(not-a-shell-launch)"',preview:'folder with spaces'});
  assert.equal(result.connected,true);assert.equal(f.launched.length,1);
  assert.deepEqual(f.launched[0].args.slice(-4),['--check','printf "$(not-a-shell-launch)"','--preview-dir','folder with spaces']);
  assert.equal(f.launched[0].env.ROUNDTABLE_PAIR_TOKEN,'private-owner');
  const state=await f.manager.status(origin,f.room,f.member),stored=await readFile(f.deps.file,'utf8');
  assert.equal(state.state,'connected');assert.equal(state.saved.name,'Chosen folder');assert.equal(f.member.chatMode,'mentions');
  assert.equal(JSON.stringify(state).includes('private-owner'),false);assert.equal(stored.includes('private-owner'),false);
  assert.equal((await stat(f.deps.file)).mode & 0o777,0o600);
  assert.equal((await f.manager.status(origin,f.room,f.other)).saved,null);
  const next=await f.manager.select(origin,f.room,f.member,{});
  await assert.rejects(f.manager.start(origin,f.room,f.member,{selection:next.selection}),/Disconnect/);
});

test('simultaneous start requests produce one bridge; cancellation cleans it up',async t=>{
  const f=await fixture(t,{ready:false}),selection=await f.manager.select(origin,f.room,f.member,{}),controller=new AbortController();
  const one=f.manager.start(origin,f.room,f.member,{selection:selection.selection,signal:controller.signal});
  const rejected=assert.rejects(f.manager.start(origin,f.room,f.member,{selection:selection.selection}),/Choose the folder again|already/);
  await rejected;assert.equal(f.launched.length,1);controller.abort();await assert.rejects(one,/cancelled|could not connect/);
  assert.equal(f.launched[0].child.exitCode,0);
});

test('remembered connections restore after restart; disconnect disables restoration and preserves pause',async t=>{
  const f=await fixture(t);f.member.chatMode='off';
  const selection=await f.manager.select(origin,f.room,f.member,{});await f.manager.start(origin,f.room,f.member,{selection:selection.selection});
  await f.manager.close();assert.equal(f.member.chatMode,'off');
  const restored=new LocalConnections(f.deps);t.after(()=>restored.close());await restored.load();await restored.restore(3131);
  assert.equal(f.launched.length,2);assert.equal((await restored.status(origin,f.room,f.member)).state,'connected');
  await restored.revoke(f.room.id,f.member.id);await restored.close();
  const last=new LocalConnections(f.deps);t.after(()=>last.close());await last.load();await last.restore(3131);assert.equal(f.launched.length,2);
});

test('cancelled picker and missing sign-in do not start a bridge',async t=>{
  const f=await fixture(t);f.manager.pick=async()=>null;
  assert.deepEqual(await f.manager.select(origin,f.room,f.member,{}),{cancelled:true});assert.equal(f.launched.length,0);
  f.manager.detect=async()=>({installed:true,signedIn:false});const selection=await f.manager.select(origin,f.room,f.member,{path:f.root});
  await assert.rejects(f.manager.start(origin,f.room,f.member,{selection:selection.selection}),/Sign in/);assert.equal(f.launched.length,0);
});

test('local HTTP routes require current member credentials and never trust a requested owner',async t=>{
  const f=await fixture(t),app=express();mountLocalConnections(app,{manager:f.manager,rooms:f.rooms,canSpeak:()=>true});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port,path=base+'/api/local/rooms/'+f.room.id+'/status';
  const headers={'Content-Type':'application/json',Origin:base};
  assert.equal((await fetch(path,{method:'POST',headers,body:'{}'})).status,403);
  assert.equal((await fetch(path,{method:'POST',headers:{...headers,Origin:'https://evil.example','X-Roundtable-Member':'member-secret'},body:'{}'})).status,404);
  const response=await fetch(path,{method:'POST',headers:{...headers,'X-Roundtable-Member':'member-secret'},body:JSON.stringify({ownerId:f.other.id})});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).available,true);
  const req={params:{room:f.room.id},headers:{'x-roundtable-member':'member-secret'}};
  assert.equal(localMember(req,f.rooms,()=>false),null);f.room.people.clear();assert.equal(localMember(req,f.rooms,()=>true),null);
});

test('a reconnecting bridge cannot be duplicated; a cancelled reconnect disables restore',async t=>{
  const f=await fixture(t),selection=await f.manager.select(origin,f.room,f.member,{});
  await f.manager.start(origin,f.room,f.member,{selection:selection.selection});
  f.launched[0].child.emit('message',{type:'roundtable-offline'});
  await assert.rejects(f.manager.start(origin,f.room,f.member,{saved:true}),/already/);
  assert.equal(f.launched.length,1);
  await f.manager.stop(f.manager.key(origin,f.room.id,f.member.id));
  const controller=new AbortController();
  const pending=f.manager.start(origin,f.room,f.member,{saved:true,signal:controller.signal});
  const rejection=assert.rejects(pending,/cancelled|could not connect/);
  while(f.launched.length<2)await new Promise(resolve=>setImmediate(resolve));
  controller.abort();await rejection;
  assert.equal(Object.values(JSON.parse(await readFile(f.deps.file,'utf8')).records)[0].enabled,false);
});

test('folder detection uses canonical roots, requires a Git baseline, and rejects files',async t=>{
  const {describeFolder}=await import('../local/runtime.js');
  const {mkdir,writeFile,symlink}=await import('node:fs/promises');
  const {execFileSync}=await import('node:child_process');
  const root=await mkdtemp(join(tmpdir(),'roundtable-folder-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=join(root,'repo'),sub=join(repo,'documents');await mkdir(sub,{recursive:true});
  execFileSync('git',['init',repo],{stdio:'ignore'});
  assert.equal((await describeFolder(repo)).mode,'folder');
  await assert.rejects(describeFolder(repo,'git'),/first commit/);
  execFileSync('git',['-C',repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','Baseline'],{stdio:'ignore'});
  assert.equal((await describeFolder(repo)).mode,'git');
  assert.equal((await describeFolder(sub)).mode,'folder');
  assert.equal((await describeFolder(sub,'git')).path,(await describeFolder(repo)).path);
  await symlink(repo,join(root,'alias'));assert.equal((await describeFolder(join(root,'alias'))).mode,'git');
  await writeFile(join(sub,'brief.md'),'Example');await assert.rejects(describeFolder(join(sub,'brief.md')),/not a file/);
});


test('a known Codex project connects without a folder selection and cannot be supplied by the browser',async t=>{
  const f=await fixture(t);let discoveries=0;
  f.manager.project=async()=>{discoveries++;return {path:f.root,name:'Current Codex project',mode:'folder'};};
  assert.equal((await f.manager.status(origin,f.room,f.member)).suggested.name,'Current Codex project');
  await f.manager.start(origin,f.room,f.member,{project:true,path:'/untrusted/browser/path'});
  assert.equal(f.pickerCalls,0);assert.equal(discoveries,1);
  assert.equal(f.launched[0].args[2],f.root);
});

test('project discovery reads only the launching thread metadata and closes its runtime',async t=>{
  const {discoverProject}=await import('../local/runtime.js');
  const f=await fixture(t);let closed=false;
  const result=await discoverProject('/trusted/codex',{path:'',threadId:'launch-thread',client:()=>({async initialize(){},async rpc(method,params){assert.equal(method,'thread/read');assert.deepEqual(params,{threadId:'launch-thread',includeTurns:false});return {thread:{cwd:f.root}};},close(){closed=true;}})});
  assert.equal(result.name,f.root.split('/').at(-1));assert.equal(closed,true);
  assert.equal(await discoverProject('/trusted/codex',{path:'',threadId:''}),null);
});
