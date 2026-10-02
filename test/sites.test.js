import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSitesGateway} from '../workspace/sites.js';

const secret='sites-gateway-test-secret-with-64-private-characters-1234567890123456';
async function fixture(t,{saved=[],clock=()=>Date.now(),runtimePair,runtimeDisconnect,runtimeTaskStart,runtimeTaskStop}={}){
  const rooms=new Map(saved.map(room=>[room.id,room]));let persisted=0;
  const gateway=createSitesGateway({rooms,secret,roomId:'sites-trial',now:clock,persist:()=>persisted++,initialize:room=>{room.members ||= [];},runtimePair,runtimeDisconnect,runtimeTaskStart,runtimeTaskStop,
    getOrCreateRoom:id=>{if(!rooms.has(id))rooms.set(id,{id,title:'Shared room',members:[],hostClaimed:false});return rooms.get(id);},
    operation:async(room,member,action,args,auth)=>({action,member:auth.actor,current:auth.isCurrent(),credentialHash:auth.credentialHash,human:auth.human,args}),
  });
  const app=express();gateway.mount(app);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.close();server.closeAllConnections();});
  const origin='http://127.0.0.1:'+server.address().port;
  const call=async(action,{user='site-user-one',name='Alice',body={},headers={},room='sites-trial'}={})=>{
    const response=await fetch(origin+'/api/sites/rooms/'+room+'/'+action,{method:'POST',headers:{authorization:'Bearer '+secret,'x-roundtable-site-user-id':user,'x-roundtable-site-user-name':encodeURIComponent(name),'content-type':'application/json',...headers},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  return {rooms,gateway,call,get persisted(){return persisted;}};
}

test('Sites gateway rejects missing service/user authority and keeps per-user membership across restart',async t=>{
  const f=await fixture(t);
  for(const headers of [{authorization:''},{authorization:'Bearer wrong'},{'x-roundtable-site-user-id':''},{origin:'https://a-browser.example'}])assert.equal((await f.call('session',{headers})).status,403);
  assert.equal((await f.call('session',{room:'another-room'})).status,403);assert.equal(f.rooms.size,0);
  assert.equal((await f.call('snapshot')).status,404);
  assert.equal((await f.call('session',{body:{ownerId:'forged'}})).status,400);assert.equal(f.rooms.size,0);
  const first=await f.call('session');assert.equal(first.status,200);assert.equal(first.data.member.isHost,true);assert.equal(first.data.browser.wsPath,'/');
  const second=await f.call('session',{user:'site-user-two',name:'Alice'});assert.equal(second.status,200);assert.equal(second.data.member.isHost,false);assert.notEqual(first.data.member.id,second.data.member.id);
  const unknown=await f.call('snapshot',{user:'site-user-three'});assert.equal(unknown.status,403);
  const saved=JSON.parse(JSON.stringify([...f.rooms.values()])),restored=await fixture(t,{saved});
  const again=await restored.call('session');assert.equal(again.data.member.id,first.data.member.id);assert.equal(again.data.member.isHost,true);
  assert.equal((await restored.call('session',{user:'site-user-two',name:'Bob'})).data.member.id,second.data.member.id);
  assert.ok(f.persisted>0);assert.ok(!JSON.stringify(first.data).includes(secret));assert.ok(!JSON.stringify(first.data).includes('site-user-one'));assert.ok(!JSON.stringify(first.data).includes('sitesUserHash'));
});

test('browser admission caps bind room/member, are consumed by join, expire, and do not grant another identity',async t=>{
  let time=1000;const f=await fixture(t,{clock:()=>time});
  const alice=(await f.call('session')).data,bob=(await f.call('session',{user:'site-user-two',name:'Bob'})).data;
  assert.equal(f.gateway.browser(alice.browser.token,'another-room'),null);
  const peek=f.gateway.browser(alice.browser.token,'sites-trial');assert.equal(peek.member.id,alice.member.id);assert.equal(peek.actor.isHost,true);
  const joined=f.gateway.browser(alice.browser.token,'sites-trial',{consume:true});assert.equal(joined.member.id,alice.member.id);assert.equal(f.gateway.browser(alice.browser.token,'sites-trial'),null);
  assert.equal(f.gateway.browser(bob.browser.token,'sites-trial').member.id,bob.member.id);
  time=bob.browser.expiresAt;assert.equal(f.gateway.browser(bob.browser.token,'sites-trial'),null);assert.equal(f.gateway.current(joined),true);
  time=joined.expiresAt;assert.equal(f.gateway.current(joined),false);
  const fresh=(await f.call('session')).data,connection=f.gateway.browser(fresh.browser.token,'sites-trial',{consume:true});
  connection.member.sitesUserHash='changed';assert.equal(f.gateway.current(connection),false);
});

test('enrollment is credential-bound and polling does not allocate browser admission caps',async t=>{
  const f=await fixture(t,{clock:()=>1000});
  assert.equal((await f.call('enroll',{headers:{authorization:''}})).status,403);
  assert.equal((await f.call('enroll',{body:{memberId:'someone-else'}})).status,400);assert.equal(f.rooms.size,0);
  const first=(await f.call('enroll')).data;
  assert.equal(first.room.title,'Roundtable trial');assert.equal(first.member.isHost,true);assert.equal(first.browser,undefined);
  // A frozen clock keeps all hypothetical tickets alive. These calls would
  // exhaust the 1000-ticket limit if enrollment still minted browser tickets.
  for(let user=0;user<10;user++)for(let request=0;request<100;request++){
    const result=await f.call('enroll',{user:'polling-user-'+user,name:'Participant '+user});
    assert.equal(result.status,200);assert.equal(result.data.browser,undefined);
  }
  const session=await f.call('session');assert.equal(session.status,200);assert.equal(session.data.member.id,first.member.id);
  assert.ok(f.gateway.browser(session.data.browser.token,'sites-trial'));
  f.rooms.get('sites-trial').title='Existing room title';
  assert.equal((await f.call('enroll')).data.room.title,'Existing room title');
  assert.equal((await f.call('session')).data.room.title,'Existing room title');
  const repeated=await f.call('enroll',{name:'Renamed Alice'});assert.equal(repeated.data.member.id,first.member.id);assert.equal(repeated.data.member.name,'Renamed Alice');
});

test('only a service-authenticated app header grants the human action marker',async t=>{
  const f=await fixture(t);await f.call('enroll');
  for(const action of ['chat_request','reply_start','reply_cancel','task_review']){
    const model=await f.call(action);assert.equal(model.status,200);assert.equal(model.data.human,false);assert.equal(model.data.action,action);
    const app=await f.call(action,{headers:{'x-roundtable-site-client':'app'}});assert.equal(app.status,200);assert.equal(app.data.human,true);assert.equal(app.data.member.name,'Alice');
    assert.equal((await f.call(action,{headers:{'x-roundtable-site-client':'app',authorization:''}})).status,403);
    assert.equal((await f.call(action,{headers:{'x-roundtable-site-client':'app',origin:'https://browser.example'}})).status,403);
    assert.equal((await f.call(action,{headers:{'x-roundtable-site-client':'model'}})).status,400);
    const forged=await f.call(action,{body:{human:true}});assert.equal(forged.status,200);assert.equal(forged.data.human,false);
  }
});

test('Sites runtime controls are app-only, reject forged identity fields and bind the signed-in member',async t=>{
  const calls=[],handler=(room,member,auth)=>{calls.push({room,member,auth});return {ownerId:member.id,human:auth.human};},taskHandler=(room,member,body,auth)=>{calls.push({room,member,auth,body});return {ownerId:member.id,body};};
  const f=await fixture(t,{runtimePair:handler,runtimeDisconnect:handler,runtimeTaskStart:taskHandler,runtimeTaskStop:taskHandler}),alice=(await f.call('enroll')).data,bob=(await f.call('enroll',{user:'site-user-two',name:'Bob'})).data;
  for(const action of ['runtime_pair','runtime_disconnect','runtime_task_start','runtime_task_stop']){
    const body=action.startsWith('runtime_task_')?{id:'task-one',version:1}:{};
    assert.equal((await f.call(action,{body})).status,403);assert.equal((await f.call(action,{body:{...body,human:true}})).status,403);
    assert.equal((await f.call(action,{body,headers:{'x-roundtable-site-client':'app',authorization:''}})).status,403);
    assert.equal((await f.call(action,{body,headers:{'x-roundtable-site-client':'app',origin:'https://browser.example'}})).status,403);
    assert.equal((await f.call(action,{body:{...body,ownerId:bob.member.id},headers:{'x-roundtable-site-client':'app'}})).status,400);
    const first=await f.call(action,{body,headers:{'x-roundtable-site-client':'app'}});assert.equal(first.status,200);assert.equal(first.data.ownerId,alice.member.id);
    const second=await f.call(action,{user:'site-user-two',body,headers:{'x-roundtable-site-client':'app'}});assert.equal(second.status,200);assert.equal(second.data.ownerId,bob.member.id);
  }
  assert.equal(calls.length,8);assert.ok(calls.every(call=>call.auth.human===true && call.auth.isCurrent()));
});

test('real room service persists shared reply ownership and fails interrupted replies after restart',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'roundtable-sites-restart-')),dataPath=join(dataDir,'rooms.json'),processes=[];
  const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('ROUNDTABLE_') && name!=='ANTHROPIC_API_KEY'));
  const stop=async process=>{if(process.exitCode===null && process.signalCode===null){const stopped=once(process,'exit');process.kill();await stopped;}};
  t.after(async()=>{for(const process of processes)await stop(process);await rm(dataDir,{recursive:true,force:true});});
  async function start(){
    const process=spawn(globalThis.process.execPath,['server.js'],{cwd:new URL('..',import.meta.url),env:{...cleanEnv,PORT:'0',ROUNDTABLE_DATA:dataPath,ROUNDTABLE_SITES_GATEWAY_SECRET:secret,ROUNDTABLE_SITES_ROOM:'sites-trial'},stdio:['ignore','pipe','pipe']});processes.push(process);
    let logs='';process.stderr.on('data',chunk=>{logs+=chunk;});
    const port=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Room service startup timed out: '+logs)),5000);
      process.once('exit',code=>{clearTimeout(timer);reject(new Error('Room service exited during startup: '+code+' '+logs));});
      process.stdout.on('data',chunk=>{logs+=chunk;const match=logs.match(/listening on http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
    });
    const call=async(action,body={},human=false)=>{
      const response=await fetch('http://127.0.0.1:'+port+'/api/sites/rooms/sites-trial/'+action,{method:'POST',headers:{authorization:'Bearer '+secret,'x-roundtable-site-user-id':'persisted-person','x-roundtable-site-user-name':'Alice','content-type':'application/json',...(human?{'x-roundtable-site-client':'app'}:{})},body:JSON.stringify(body)});
      const data=await response.json();assert.equal(response.status,200,action+': '+JSON.stringify(data));return data;
    };
    return {process,call};
  }
  const first=await start(),enrolled=await first.call('enroll');
  await first.call('chat_request',{text:'Persist this shared question.',requestId:'persisted-reply'},true);
  await first.call('reply_start',{id:'persisted-reply'});
  const deadline=Date.now()+5000;let saved;
  while(Date.now()<deadline){
    try{saved=JSON.parse(await readFile(dataPath,'utf8'));}catch{}
    if(saved?.find(room=>room.id==='sites-trial')?.replyRequests?.[0]?.status==='replying')break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  const savedRoom=saved?.find(room=>room.id==='sites-trial');assert.equal(savedRoom?.replyRequests?.[0]?.status,'replying','Real persistence must include reply request records.');
  await stop(first.process);
  const second=await start(),returned=await second.call('enroll');assert.equal(returned.member.id,enrolled.member.id);
  const snapshot=await second.call('snapshot');assert.equal(snapshot.replyRequests[0].id,'persisted-reply');assert.equal(snapshot.replyRequests[0].status,'failed');assert.match(snapshot.replyRequests[0].failure,/restarted/);
  assert.equal(snapshot.replyRequests[0].ownerId,enrolled.member.id);assert.equal(snapshot.replyRequests[0].credentialHash,undefined);assert.equal(snapshot.replyRequests[0].source,undefined);
  const retried=await second.call('chat_request',{text:'Persist this shared question.',requestId:'persisted-reply'},true);assert.equal(retried.request.status,'requested');
  assert.equal((await second.call('snapshot')).chat.filter(message=>message.kind==='human' && message.text==='Persist this shared question.').length,1);
});
