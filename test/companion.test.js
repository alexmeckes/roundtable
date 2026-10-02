import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm,access,symlink,stat,realpath} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {Script} from 'node:vm';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCompanion,validatePairPackage,companionChildEnvironment,DEFAULT_BACKEND_ORIGINS,DEFAULT_ROOM_ORIGINS} from '../bridge/companion.js';

const backend='http://127.0.0.1:3133';
const site='http://127.0.0.1:4143';
const pairing=(extra={})=>({version:1,backendOrigin:backend,room:{id:'sites-trial',title:'Roundtable trial',url:site+'/s/sites-trial'},member:{id:'alice_id',name:'Alice'},pairToken:'A'.repeat(32),expiresAt:Date.now()+5*60_000,...extra});
function fakeChild(){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kills=[];child.kill=signal=>{child.kills.push(signal);return true;};return child;}
async function fixture(t,options={}){
  const folder=await mkdtemp(join(tmpdir(),'roundtable-companion-')),calls=[];
  const companion=createCompanion({port:0,projectRoot:join(folder,'Documents','Roundtable'),backendOrigins:[backend],roomOrigins:[site],environment:{PATH:process.env.PATH,HOME:folder,OPENAI_API_KEY:'must-not-inherit',ACCESS_TOKEN:'must-not-inherit',ROUNDTABLE_SITES_GATEWAY_SECRET:'must-not-inherit',NODE_OPTIONS:'must-not-inherit'},spawnBridge:(...args)=>{const child=fakeChild();calls.push({args,child});return child;},...options});
  const url=await companion.listen();
  t.after(async()=>{await companion.close();for(const call of calls){call.child.stdout.destroy();call.child.stderr.destroy();}await rm(folder,{recursive:true,force:true});});
  async function session(){const response=await fetch(url+'/connect');const html=await response.text();const boot=JSON.parse(html.match(/const boot=([^\n]+);\n/)[1]);return {cookie:response.headers.get('set-cookie').split(';')[0],csrf:boot.csrf,html,response};}
  async function request(client,path,{body,headers={},method=body===undefined?'GET':'POST',raw}={}){
    const response=await fetch(url+path,{method,headers:{cookie:client.cookie,'x-roundtable-csrf':client.csrf,origin:url,...(body!==undefined || raw!==undefined?{'content-type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:raw!==undefined?{body:raw}:{})});
    return {response,data:await response.json()};
  }
  return {folder,calls,companion,url,session,request};
}

test('companion loads and prepares a fragment grant without starting AI or exposing its token',async t=>{
  const f=await fixture(t),client=await f.session();
  assert.equal(f.calls.length,0);assert.match(client.response.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);assert.match(client.response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.match(client.html,/history\.replaceState/);assert.match(client.html,/Continue with ChatGPT/);assert.match(client.html,/shared room context only/);
  assert.doesNotThrow(()=>new Script(client.html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)[1]));
  const returning=await fetch(f.url+'/connect',{headers:{cookie:client.cookie,'sec-fetch-site':'cross-site'}}),returnHtml=await returning.text();assert.equal(returning.status,200);assert.equal(returning.headers.get('set-cookie'),null);assert.equal(JSON.parse(returnHtml.match(/const boot=([^\n]+);\n/)[1]).csrf,client.csrf);
  const prepared=await f.request(client,'/api/prepare',{body:{package:pairing()}});
  assert.equal(prepared.response.status,200);assert.equal(prepared.data.connection.member.name,'Alice');assert.equal(prepared.data.projectPath,join(f.folder,'Documents','Roundtable','sites-trial'));assert.equal(f.calls.length,0);
  assert.doesNotMatch(JSON.stringify(prepared.data),/pairToken|A{32}/);await assert.rejects(access(prepared.data.projectPath));
  const state=await f.request(client,'/api/status');assert.equal(state.data.phase,'idle');assert.equal(state.data.connection,undefined);
});

test('explicit Connect creates a dedicated folder and launches only the scoped bridge',async t=>{
  const f=await fixture(t),client=await f.session();
  const connected=await f.request(client,'/api/connect',{body:{package:pairing(),authMode:'chatgpt-plan'}});
  assert.equal(connected.response.status,202);assert.equal(connected.data.phase,'starting');assert.equal(f.calls.length,1);
  const {args}=f.calls[0],argv=args[1],options=args[2],folder=await realpath(join(f.folder,'Documents','Roundtable','sites-trial'));
  assert.equal(argv[1],backend+'/s/sites-trial');assert.deepEqual(argv.slice(2),['--project',folder,'--workspace-mode','folder','--auth','chatgpt-plan','--expected-owner','alice_id']);
  assert.equal(options.cwd,folder);assert.equal(options.env.ROUNDTABLE_PAIR_TOKEN,'A'.repeat(32));assert.equal(options.env.OPENAI_API_KEY,undefined);assert.equal(options.env.ACCESS_TOKEN,undefined);assert.equal(options.env.ROUNDTABLE_SITES_GATEWAY_SECRET,undefined);assert.equal(options.env.NODE_OPTIONS,undefined);
  assert.ok(!argv.some(value=>value.includes('A'.repeat(32))));assert.equal((await stat(folder)).mode&0o777,0o700);
  const second=await f.request(client,'/api/connect',{body:{package:pairing(),authMode:'codex'}});assert.equal(second.response.status,409);assert.equal(f.calls.length,1);
});

test('readiness follows only the accepted room connection notice and raw child output stays private',async t=>{
  const f=await fixture(t),client=await f.session();await f.request(client,'/api/connect',{body:{package:pairing(),authMode:'codex',projectPath:f.folder}});
  const {child}=f.calls[0];child.stdout.write('Continue with ChatGPT in your system browser. Eligible requests use your ChatGPT plan.\n');
  assert.equal((await f.request(client,'/api/status')).data.phase,'signing_in');
  child.stderr.write('PRIVATE_ACCESS_TOKEN=super-secret-with-private-error\n');child.stdout.write('Your Codex is connected to https://evil.example/s/sites-trial for stolen. Saved conversations: 0\n');
  let state=(await f.request(client,'/api/status')).data;assert.equal(state.phase,'signing_in');assert.doesNotMatch(JSON.stringify(state),/super-secret|PRIVATE_ACCESS_TOKEN|evil\.example|pairToken|A{32}/);
  child.stdout.write('Your Codex is connected to '+backend+'/s/sites-trial for project. Saved conversations: 0\n');
  state=(await f.request(client,'/api/status')).data;assert.equal(state.phase,'connected');assert.equal(state.connection.member.id,'alice_id');assert.equal(state.connection.room.url,site+'/s/sites-trial');
  child.stdout.write('Roundtable connection interrupted. Reconnecting…\n');assert.equal((await f.request(client,'/api/status')).data.phase,'connecting');
  child.emit('exit',1);assert.equal((await f.request(client,'/api/status')).data.phase,'failed');
});

test('only the owning local session can stop its child; another tab cannot read connection details',async t=>{
  const f=await fixture(t),owner=await f.session(),stranger=await f.session();await f.request(owner,'/api/connect',{body:{package:pairing(),authMode:'codex'}});
  const state=await f.request(stranger,'/api/status');assert.equal(state.data.connection,undefined);assert.equal(state.data.phase,'occupied');
  const prepared=await f.request(stranger,'/api/prepare',{body:{package:pairing()}});assert.equal(prepared.data.phase,'occupied');assert.equal(prepared.data.connection,undefined);
  const rejected=await f.request(stranger,'/api/stop',{body:{}});assert.equal(rejected.response.status,403);assert.equal(f.calls[0].child.kills.length,0);
  const stopped=await f.request(owner,'/api/stop',{body:{}});assert.equal(stopped.response.status,200);assert.equal(stopped.data.phase,'stopping');assert.deepEqual(f.calls[0].child.kills,['SIGTERM']);
  f.calls[0].child.emit('exit',0);assert.equal((await f.request(owner,'/api/status')).data.phase,'stopped');
});

test('the original owner can regain control after an hour away without granting a stranger access',async t=>{
  let time=Date.now();const f=await fixture(t,{now:()=>time}),owner=await f.session(),stranger=await f.session();
  await f.request(owner,'/api/connect',{body:{package:pairing(),authMode:'codex'}});
  f.calls[0].child.stdout.write('Your Codex is connected to '+backend+'/s/sites-trial for project. Saved conversations: 1\n');
  time+=60*60_000+1;
  const expiredStranger=await f.request(stranger,'/api/status');assert.equal(expiredStranger.response.status,403);
  const newStranger=await f.session();assert.equal((await f.request(newStranger,'/api/status')).data.phase,'occupied');
  assert.equal((await f.request(newStranger,'/api/stop',{body:{}})).response.status,403);
  const reload=await fetch(f.url+'/connect',{headers:{cookie:owner.cookie,'sec-fetch-site':'cross-site'}});assert.equal(reload.headers.get('set-cookie'),null);
  const restored=await f.request(owner,'/api/status');assert.equal(restored.data.phase,'connected');
  assert.equal((await f.request(owner,'/api/stop',{body:{}})).response.status,200);assert.deepEqual(f.calls[0].child.kills,['SIGTERM']);
});

test('saved conversation counts require the exact accepted-room notice and a bounded canonical integer',async t=>{
  const f=await fixture(t),client=await f.session();await f.request(client,'/api/connect',{body:{package:pairing(),authMode:'codex'}});
  const {child}=f.calls[0],prefix='Your Codex is connected to '+backend+'/s/sites-trial for project. Saved conversations: ';
  for(const value of ['-1','1.5','01','1e3','10001','999999999999','3 secret-thread-id']){child.stdout.write(prefix+value+'\n');const state=(await f.request(client,'/api/status')).data;assert.notEqual(state.phase,'connected');assert.equal(state.savedConversationCount,undefined);}
  child.stdout.write('Your Codex is connected to https://evil.example/s/sites-trial for project. Saved conversations: 3\n');
  child.stderr.write(prefix+'3\n');assert.equal((await f.request(client,'/api/status')).data.savedConversationCount,undefined);
  child.stdout.write(prefix+'3\n');const state=(await f.request(client,'/api/status')).data;assert.equal(state.phase,'connected');assert.equal(state.savedConversationCount,3);assert.match(state.message,/3 saved room conversations are ready to continue/);assert.doesNotMatch(JSON.stringify(state),/thread-id|pairToken|A{32}/);
});

test('room-side revocation is disconnected after readiness and failed before acceptance',async t=>{
  const f=await fixture(t),client=await f.session();await f.request(client,'/api/connect',{body:{package:pairing(),authMode:'codex'}});
  let {child}=f.calls[0];child.stderr.write('Connection revoked or pairing invalid. Generate a new connection command in the room.\n');assert.equal((await f.request(client,'/api/status')).data.phase,'failed');child.emit('exit',1);
  await f.request(client,'/api/connect',{body:{package:pairing(),authMode:'codex'}});child=f.calls[1].child;
  child.stdout.write('Your Codex is connected to '+backend+'/s/sites-trial for project. Saved conversations: 1\n');
  child.stderr.write('Connection revoked or pairing invalid. Generate a new connection command in the room.\n');let state=(await f.request(client,'/api/status')).data;assert.equal(state.phase,'stopped');assert.match(state.message,/Saved room conversations are kept/);child.emit('exit',0);
  state=(await f.request(client,'/api/status')).data;assert.equal(state.phase,'stopped');assert.equal(state.savedConversationCount,1);
});

test('host validation, same-origin checks, cookie-bound CSRF and request bounds reject foreign control',async t=>{
  const f=await fixture(t),client=await f.session();
  const rebinding=await new Promise((resolve,reject)=>{const request=httpRequest(f.url+'/connect',{headers:{host:'evil.example'}},response=>{response.resume();response.once('end',()=>resolve(response.statusCode));});request.once('error',reject);request.end();});assert.equal(rebinding,403);
  for(const headers of [{origin:'https://evil.example'},{'x-roundtable-csrf':'invalid'},{cookie:''},{'sec-fetch-site':'cross-site'}]){
    const denied=await f.request(client,'/api/connect',{body:{package:pairing(),authMode:'codex'},headers});assert.equal(denied.response.status,403);
  }
  const denied=await f.request(client,'/api/connect',{body:{package:pairing(),authMode:'codex'},headers:{origin:''}});assert.equal(denied.response.status,403);
  const large=await f.request(client,'/api/connect',{method:'POST',raw:' '.repeat(9000)});assert.equal(large.response.status,413);
  const badType=await f.request(client,'/api/connect',{body:{},headers:{'content-type':'text/plain'}});assert.equal(badType.response.status,415);
  const query=await f.request(client,'/api/status?pairToken=must-not-be-in-url');assert.equal(query.response.status,400);
  assert.equal(f.calls.length,0);
});

test('package validation pins HTTPS production origins and only explicitly permits local development',()=>{
  const production=pairing({backendOrigin:DEFAULT_BACKEND_ORIGINS[0],room:{id:'sites-trial',title:'Trial',url:DEFAULT_ROOM_ORIGINS[0]+'/s/sites-trial'}});
  assert.equal(validatePairPackage(production).backendOrigin,DEFAULT_BACKEND_ORIGINS[0]);
  assert.throws(()=>validatePairPackage(pairing()),/not trusted/);
  for(const changes of [{backendOrigin:'https://evil.example'},{backendOrigin:'https://user:secret@private-hybrid-backend-private-hybrid-trial.up.railway.app'},{backendOrigin:DEFAULT_BACKEND_ORIGINS[0]+'/path'},{backendOrigin:'http://192.168.1.20'},{expiresAt:Date.now()-1},{expiresAt:Date.now()+60*60_000},{command:'sh -c evil'},{pairToken:'token with spaces'},{room:{id:'another-room',title:'Other',url:DEFAULT_ROOM_ORIGINS[0]+'/s/sites-trial'}}])assert.throws(()=>validatePairPackage({...production,...changes}));
  assert.equal(validatePairPackage(pairing(),{backendOrigins:[backend],roomOrigins:[site]}).room.url,site+'/s/sites-trial');
  assert.throws(()=>validatePairPackage({...production,room:{...production.room,url:'javascript:alert(1)'}}));
  assert.throws(()=>validatePairPackage({...production,room:{...production.room,url:DEFAULT_ROOM_ORIGINS[0]+'/s/sites-trial#secret'}}));
});

test('the browser accepts only the enumerated login selection in the connection URL',async t=>{
  const f=await fixture(t);
  const codex=await fetch(f.url+'/connect?auth=codex');assert.equal(codex.status,200);const html=await codex.text();assert.match(html,/new URLSearchParams\(location.search\)\.get\('auth'\)/);assert.ok(html.indexOf('const requestedAuth=')<html.indexOf('history.replaceState'));
  for(const query of ['auth=api-key','auth=codex&auth=chatgpt-plan','auth=codex&pairToken=secret'])assert.equal((await fetch(f.url+'/connect?'+query)).status,400);
  assert.equal(f.calls.length,0);
});

test('default project refuses a symlink that would expose an unrelated folder',async t=>{
  const f=await fixture(t),client=await f.session(),root=join(f.folder,'Documents','Roundtable');
  const {mkdir}=await import('node:fs/promises');await mkdir(root,{recursive:true});await symlink(f.folder,join(root,'sites-trial'));
  const rejected=await f.request(client,'/api/connect',{body:{package:pairing(),authMode:'codex'}});assert.equal(rejected.response.status,400);assert.equal(f.calls.length,0);
});

test('connection attempts are bounded without returning private request data',async t=>{
  const f=await fixture(t),client=await f.session();
  for(let i=0;i<6;i++){const result=await f.request(client,'/api/connect',{body:{package:pairing(),authMode:'codex',projectPath:join(f.folder,'missing')}});assert.equal(result.response.status,400);}
  const denied=await f.request(client,'/api/connect',{body:{package:pairing(),authMode:'codex'}});assert.equal(denied.response.status,429);assert.doesNotMatch(JSON.stringify(denied.data),/pairToken|A{32}/);assert.equal(f.calls.length,0);
});

test('the child environment preserves only necessary local runtime settings',()=>{
  assert.deepEqual(companionChildEnvironment('P'.repeat(32),{PATH:'/fixture/bin',HOME:'/fixture/home',CODEX_HOME:'/fixture/codex',OPENAI_API_KEY:'secret',ACCESS_TOKEN:'secret',AWS_SECRET_ACCESS_KEY:'secret',ROUNDTABLE_PAIR_TOKEN:'old',ROUNDTABLE_BRIDGE_SECRET:'secret',NODE_OPTIONS:'injected'}),{PATH:'/fixture/bin',HOME:'/fixture/home',CODEX_HOME:'/fixture/codex',ROUNDTABLE_PAIR_TOKEN:'P'.repeat(32)});
});
