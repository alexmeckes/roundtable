import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import express from 'express';
import {createSitesGateway} from '../workspace/sites.js';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,readFile,stat,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRoomEvents,webhookKey,signedWebhookHeaders,publicAddress,callbackUrl,secureWebhookPost} from '../workspace/events.js';
import {createNativeParticipation} from '../workspace/native.js';

const secret='whsec_'+Buffer.alloc(32,7).toString('base64'),nextSecret='whsec_'+Buffer.alloc(32,8).toString('base64'),siteOrigin='https://roundtable.example.com';
const subscription=(room='room',url='https://receiver.example.com/hooks/alice')=>({name:'roundtable.ai_requested',arguments:{room_id:room},delivery:{mode:'webhook',url,secret},cursor:null,_siteOrigin:siteOrigin});
const unsubscribe=body=>({name:body.name,arguments:body.arguments,delivery:{mode:body.delivery.mode,url:body.delivery.url}});
function fixture(t,{saved,post,persist}={}){
  let time=Date.parse('2026-10-01T12:00:00Z'),disk,deliverStatus=200;
  const room=saved || {id:'room',title:'Event trial',access:'open',members:[{id:'alice',name:'Alice',sitesUserHash:'alice-hash',sitesHost:true},{id:'bob',name:'Bob',sitesUserHash:'bob-hash'}],chat:[],tasks:[],work:[]};
  const rooms=new Map([[room.id,room]]),calls=[];
  const events=createRoomEvents({rooms,canSpeak:(room,actor)=>room.access!=='view' || actor.isHost,allowedRoom:id=>id==='room',siteOrigins:[siteOrigin],now:()=>time,autostart:false,persist:()=>{persist?.();disk=JSON.parse(JSON.stringify(room));},post:post || (async(url,options)=>{
    const body=JSON.parse(options.body);calls.push({url,options,body,disk});
    const timestamp=options.headers['webhook-timestamp'],id=options.headers['webhook-id'];
    assert.ok([7,8].some(key=>options.headers['webhook-signature'].split(' ').includes('v1,'+createHmac('sha256',Buffer.alloc(32,key)).update(id+'.'+timestamp+'.'+options.body).digest('base64'))),'Receiver verifies the exact signed bytes.');
    if(body.type==='verification')return {status:200,body:JSON.stringify({challenge:body.challenge})};
    return {status:deliverStatus,body:''};
  })});t.after(()=>events.close());
  const auth=(owner='alice',human=false)=>({source:'sites',human,credentialHash:owner+'-hash',actor:{id:owner,name:owner==='alice'?'Alice':'Bob',isHost:owner==='alice'},isCurrent:()=>room.members.some(member=>member.id===owner && member.sitesUserHash===owner+'-hash')});
  const member=owner=>room.members.find(member=>member.id===owner);
  const call=(action,body={},owner='alice',human=false)=>events.operation(room,member(owner),action,body,auth(owner,human));
  const native=createNativeParticipation({rooms,artifactRoot:'/unused-event-test',persist:()=>{},now:()=>time,canSpeak:(room,actor)=>room.access!=='view' || actor.isHost,broadcast:()=>{},say:(room,message)=>room.chat.push(message)});native.initialize(room);
  const request=async(id='request-one',owner='alice')=>{
    const result=await native.operation(room,member(owner),'chat_request',{text:'Question '+id,requestId:id},auth(owner,true));
    const record=room.replyRequests.find(request=>request.id===id);events.emit(room,member(owner),record,auth(owner,true));return {result,record,delivery:events.deliveryState(room,record)};
  };
  return {room,rooms,events,native,calls,call,request,auth,member,get disk(){return disk;},advance:milliseconds=>{time+=milliseconds;},setStatus:status=>{deliverStatus=status;}};
}

test('Standard Webhooks keys, signatures and callback addresses follow the contract',()=>{
  assert.equal(webhookKey(secret).length,32);
  for(const value of ['bad','whsec_!', 'whsec_'+Buffer.alloc(23).toString('base64'),'whsec_'+Buffer.alloc(65).toString('base64'),'whsec_AB=='])assert.throws(()=>webhookKey(value));
  const body='{"answer":42}',headers=signedWebhookHeaders('evt_test',body,[secret],1739980800000);
  assert.equal(headers['webhook-signature'],'v1,'+createHmac('sha256',Buffer.alloc(32,7)).update('evt_test.1739980800.'+body).digest('base64'));
  for(const address of ['0.0.0.0','127.0.0.1','10.0.0.1','100.64.0.1','169.254.1.2','172.31.2.1','192.168.1.2','192.0.2.1','192.88.99.1','198.19.0.1','198.51.100.2','203.0.113.1','224.1.2.3','240.0.0.1','::','::1','::ffff:8.8.8.8','64:ff9b::808:808','2001:db8::1','2001::1','2002:0808:0808::1','3fff::1','fd00::1','fe80::1','ff02::1'])assert.equal(publicAddress(address),false,address);
  for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(publicAddress(address),true,address);
  for(const url of ['http://receiver.example.com','https://user:password@receiver.example.com','https://receiver.example.com/#fragment','https://localhost/x','https://[::1]/','https://2130706433/','https://127.1/'])assert.throws(()=>callbackUrl(url));
});

test('verification precedes durable subscription; identity, TTL, secret rotation and public state remain scoped',async t=>{
  const f=fixture(t),body=subscription();
  assert.equal((await f.call('event_list')).events[0].delivery[0],'webhook');
  const first=await f.call('event_subscribe',body);assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.type,'verification');assert.equal(f.calls[0].disk,undefined);assert.equal(f.room.eventSubscriptions.length,1);assert.ok(f.disk.eventSubscriptions[0].secret);
  assert.equal((await f.call('event_subscribe',{...body,ttlMs:120000})).id,first.id);assert.equal(f.calls.length,1);
  const bob=await f.call('event_subscribe',body,'bob');assert.notEqual(bob.id,first.id);assert.equal(f.calls.length,2);
  await f.call('event_unsubscribe',unsubscribe(body),'bob');assert.equal(f.room.eventSubscriptions.length,1);
  f.advance(1000);await f.call('event_subscribe',{...body,delivery:{...body.delivery,secret:nextSecret}});assert.equal(f.calls.length,3);assert.equal(f.room.eventSubscriptions[0].previousSecret,secret);
  await f.request();await f.events.pump();assert.equal(f.calls.at(-1).options.headers['webhook-signature'].split(' ').length,2);
  const state=f.events.state(f.room,f.member('alice'),f.auth());assert.equal(state.subscriptions.length,1);assert.ok(!JSON.stringify(state).includes(secret));assert.ok(!JSON.stringify(state).includes(body.delivery.url));assert.ok(!JSON.stringify(state).includes('credentialHash'));
  assert.equal(f.events.state(f.room,f.member('bob'),f.auth('bob')).subscriptions.length,0);
  await assert.rejects(f.call('event_subscribe',{...body,arguments:{room_id:'other-room'}}),error=>error.rpcError.code===-32012);
  await assert.rejects(f.call('event_subscribe',{...body,name:'unknown'}),error=>error.rpcError.code===-32011);
  await assert.rejects(f.call('event_subscribe',{...body,_siteOrigin:'https://evil.example.com'}),error=>error.rpcError.code===-32602);
  await assert.rejects(f.call('event_subscribe',{...body,ownerId:'bob'}),error=>error.rpcError.code===-32602);
  await f.call('event_subscribe',{...body,ttlMs:null});assert.equal(typeof f.room.eventSubscriptions[0].expiresAt,'number');
  f.advance(60*60_000);assert.equal(f.events.state(f.room,f.member('alice'),f.auth()).subscriptions.length,0);
});

test('durable event queue emits only the requester, preserves retry ID, changes ID for a human retry and never loops on AI output',async t=>{
  const f=fixture(t);await f.call('event_subscribe',subscription());await f.call('event_subscribe',subscription(),'bob');
  const requested=await f.request();assert.deepEqual(requested.delivery,{mode:'events',queued:true});assert.equal(f.room.eventOutbox.length,1);assert.equal(f.disk.eventOutbox.length,1);
  const queued=f.room.eventOutbox[0],eventId=queued.event.eventId;
  assert.equal(queued.event.data.owner_id,'alice');assert.equal(queued.event.data.url,siteOrigin+'/s/room#reply=request-one');assert.deepEqual(Object.keys(queued.event.data).sort(),['room_id','request_id','message_id','owner_id','text','url'].sort());
  await f.request();assert.equal(f.room.chat.length,1);assert.equal(f.room.eventOutbox.length,1);
  f.setStatus(503);await f.events.pump();assert.equal(f.calls.at(-1).disk.eventOutbox[0].attempts,1);const firstTimestamp=f.calls.at(-1).options.headers['webhook-timestamp'];
  f.advance(2000);f.setStatus(200);await f.events.pump();assert.equal(f.calls.at(-1).body.eventId,eventId);assert.notEqual(f.calls.at(-1).options.headers['webhook-timestamp'],firstTimestamp);assert.equal(f.room.eventOutbox.length,0);
  assert.deepEqual((await f.request()).delivery,{mode:'events',queued:true});
  await f.native.operation(f.room,f.member('alice'),'reply_cancel',{id:'request-one'},f.auth('alice',true));await f.request();assert.notEqual(f.room.eventOutbox[0].event.eventId,eventId);assert.equal(f.room.chat.length,1);
  await f.native.operation(f.room,f.member('alice'),'reply_start',{id:'request-one'},f.auth());await f.native.operation(f.room,f.member('alice'),'publish',{text:'Answer',replyId:'request-one'},f.auth());
  const before=f.calls.length;await f.events.pump();assert.equal(f.calls.length,before);assert.equal(f.room.eventOutbox.length,0);
});

test('restart retains queued requested events but fails replying work; revoked identities and cancelled requests suppress delivery',async t=>{
  const f=fixture(t);await f.call('event_subscribe',subscription());await f.request();
  const restored=fixture(t,{saved:JSON.parse(JSON.stringify(f.disk))});assert.equal(restored.room.replyRequests[0].status,'requested');assert.equal(restored.room.eventOutbox.length,1);await restored.events.pump();assert.equal(restored.calls.length,1);assert.equal(restored.calls[0].body.name,'roundtable.ai_requested');
  await f.native.operation(f.room,f.member('alice'),'reply_start',{id:'request-one'},f.auth());const running=fixture(t,{saved:JSON.parse(JSON.stringify(f.room))});assert.equal(running.room.replyRequests[0].status,'failed');await running.events.pump();assert.equal(running.calls.length,0);
  const revoked=fixture(t,{saved:JSON.parse(JSON.stringify(f.disk))});revoked.member('alice').sitesUserHash='rotated';await revoked.events.pump();assert.equal(revoked.calls.length,0);assert.equal(revoked.room.eventSubscriptions.length,0);
  const cancelled=fixture(t);await cancelled.call('event_subscribe',subscription());await cancelled.request();await cancelled.native.operation(cancelled.room,cancelled.member('alice'),'reply_cancel',{id:'request-one'},cancelled.auth('alice',true));await cancelled.events.pump();assert.equal(cancelled.calls.length,1);
});

test('pause is human-only, persists across restart, blocks refresh, and unsubscribe fences a pending handshake',async t=>{
  const f=fixture(t);await f.call('event_subscribe',subscription());await f.request();
  await assert.rejects(f.call('event_stop_all'),error=>error.rpcError.code===-32012);
  const stopped=await f.call('event_stop_all',{},'alice',true);assert.equal(stopped.eventMonitoring.paused,true);assert.equal(f.room.eventSubscriptions.length,0);assert.equal(f.room.eventOutbox.length,0);
  await assert.rejects(f.call('event_subscribe',subscription()),error=>error.rpcError.code===-32012);
  const restored=fixture(t,{saved:JSON.parse(JSON.stringify(f.disk))});await assert.rejects(restored.call('event_subscribe',subscription()),error=>error.rpcError.code===-32012);
  await f.call('event_unsubscribe',unsubscribe(subscription()));await f.call('event_subscribe',subscription());assert.equal(f.room.eventSubscriptions.length,1);
  let release;const pending=fixture(t,{post:async(url,options)=>{await new Promise(resolve=>{release=resolve;});return {status:200,body:JSON.stringify({challenge:JSON.parse(options.body).challenge})};}});
  const creating=pending.call('event_subscribe',subscription());await pending.call('event_unsubscribe',unsubscribe(subscription()));release();await assert.rejects(creating,error=>error.rpcError.code===-32012);assert.equal(pending.room.eventSubscriptions.length,0);
});

test('terminal deliveries never retry and subscription persistence failure cannot activate an unacknowledged subscription',async t=>{
  for(const status of [410,413]){
    const f=fixture(t);await f.call('event_subscribe',subscription());await f.request();f.setStatus(status);await f.events.pump();const before=f.calls.length;f.advance(10000);await f.events.pump();assert.equal(f.calls.length,before);assert.equal(f.room.eventOutbox.length,0);
  }
  const failed=fixture(t,{persist:()=>{throw new Error('synthetic disk failure');}});await assert.rejects(failed.call('event_subscribe',subscription()),/disk failure/);assert.equal(failed.room.eventSubscriptions.length,0);
  const bad=fixture(t,{post:async()=>({status:200,body:'{"challenge":"wrong"}'})});await assert.rejects(bad.call('event_subscribe',subscription()),error=>error.rpcError.code===-32015 && error.rpcError.data.reason==='challenge_failed');assert.equal(bad.room.eventSubscriptions.length,0);
});

function networkRequest({status=200,responseBody='{}',onOptions=()=>{}}={}){
  return (url,options,callback)=>{
    onOptions(url,options);const request=new EventEmitter();
    request.end=body=>{options.lookup(url.hostname,{all:true},(error,destinations)=>{
      if(error){request.emit('error',error);return;}
      queueMicrotask(()=>{const response=Readable.from([Buffer.from(responseBody)]);response.statusCode=status;response.headers={};callback(response);});
    });};return request;
  };
}
test('callback transport pins public DNS with original TLS name, rejects mixed/private DNS and redirects, and bounds response/time',async()=>{
  let seen;
  const response=await secureWebhookPost('https://receiver.example.com/callback',{body:'{}',headers:{},lookup:async()=>[{address:'8.8.8.8',family:4}],request:networkRequest({onOptions:(url,options)=>{seen={url,options};}})});
  assert.equal(response.status,200);assert.equal(seen.url.hostname,'receiver.example.com');assert.equal(seen.options.servername,'receiver.example.com');assert.equal(seen.options.rejectUnauthorized,true);assert.equal(seen.options.agent,false);
  let connected=false;await assert.rejects(secureWebhookPost('https://receiver.example.com/callback',{body:'{}',headers:{},lookup:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],request:()=>{connected=true;}}));assert.equal(connected,false);
  await assert.rejects(secureWebhookPost('https://receiver.example.com/callback',{body:'{}',headers:{},lookup:async()=>[{address:'8.8.8.8',family:4}],request:networkRequest({status:302})}),error=>error.rpcError.code===-32015);
  await assert.rejects(secureWebhookPost('https://receiver.example.com/callback',{body:'{}',headers:{},lookup:async()=>[{address:'8.8.8.8',family:4}],request:networkRequest({responseBody:'x'.repeat(17000)})}),error=>error.rpcError.code===-32015);
  await assert.rejects(secureWebhookPost('https://receiver.example.com/callback',{body:'{}',headers:{},lookup:()=>new Promise(()=>{}),timeoutMs:10}),error=>error.rpcError.data.reason==='timeout');
  await assert.rejects(secureWebhookPost('https://receiver.example.com/callback',{body:'{}',headers:{},lookup:async()=>[{address:'8.8.8.8',family:4}],request:networkRequest(),beforeConnect:()=>false}),error=>error.rpcError.code===-32012);
});

test('authenticated gateway exposes safe monitoring and chooses actual queued events over a stale browser snapshot',async t=>{
  const f=fixture(t),serviceSecret='synthetic-events-gateway-secret-with-at-least-32-characters';
  const gateway=createSitesGateway({rooms:f.rooms,secret:serviceSecret,roomId:'room',getOrCreateRoom:()=>f.room,initialize:f.native.initialize,operation:f.native.operation,persist:()=>{},events:f.events});
  const app=express();gateway.mount(app);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.close();server.closeAllConnections();});
  const call=async(action,body={},user='real-alice',human=false)=>{
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/sites/rooms/room/'+action,{method:'POST',headers:{authorization:'Bearer '+serviceSecret,'x-roundtable-site-user-id':user,'x-roundtable-site-user-name':user,'content-type':'application/json',...(human?{'x-roundtable-site-client':'app'}:{})},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  await call('enroll');await call('enroll',{},'real-bob');
  assert.equal((await call('snapshot')).data.eventMonitoring.subscriptions.length,0);
  assert.equal((await call('event_subscribe',subscription())).status,200);
  const request=await call('chat_request',{text:'A question for my own AI',requestId:'gateway-queued'},'real-alice',true);assert.equal(request.status,200);assert.deepEqual(request.data.delivery,{mode:'events',queued:true});
  const snapshot=(await call('snapshot')).data;assert.equal(snapshot.eventMonitoring.subscriptions.length,1);assert.equal(snapshot.people.find(person=>person.id===snapshot.member.id).aiConnected,true);
  const other=(await call('snapshot',{},'real-bob')).data;assert.equal(other.eventMonitoring.subscriptions.length,0);assert.equal(other.people.find(person=>person.id===snapshot.member.id).aiConnected,true);
  assert.ok(!JSON.stringify(snapshot).includes(secret));assert.ok(!JSON.stringify(snapshot).includes(subscription().delivery.url));assert.ok(!JSON.stringify(snapshot).includes('credentialHash'));assert.ok(!JSON.stringify(snapshot).includes('eventOutbox'));
  const invalid=await call('event_subscribe',{...subscription(),delivery:{mode:'webhook',url:'https://127.0.0.1/',secret}});assert.equal(invalid.data.rpcError.code,-32602);
  assert.equal((await call('event_stop_all')).status,403);assert.equal((await call('event_stop_all',{},'real-alice',true)).data.eventMonitoring.paused,true);
  const second=await call('chat_request',{text:'Use host handoff after stopping the cloud monitor',requestId:'gateway-host'},'real-alice',true);assert.deepEqual(second.data.delivery,{mode:'host',queued:false});
});

test('actual server atomically persists private subscriptions/outbox and keeps queued requested work through restart',async t=>{
  const f=fixture(t);await f.call('event_subscribe',subscription('room','https://callback.invalid/no-network'));await f.request();
  const seeded=JSON.parse(JSON.stringify(f.disk)),userHash=createHash('sha256').update('sites:persisted-event-owner').digest('hex'),current=Date.now();
  seeded.hostClaimed=true;seeded.members.find(member=>member.id==='alice').sitesUserHash=userHash;
  for(const subscription of seeded.eventSubscriptions){subscription.credentialHash=userHash;subscription.expiresAt=current+60*60_000;}
  for(const request of seeded.replyRequests){request.credentialHash=userHash;request.expiresAt=current+5*60_000;request.updatedAt=current;}
  // Keep delivery later than this test. The reserved .invalid endpoint cannot
  // receive requests; no network test bypasses production address validation.
  for(const delivery of seeded.eventOutbox)delivery.nextAttemptAt=current+60_000;
  const directory=await mkdtemp(join(tmpdir(),'roundtable-event-storage-')),dataPath=join(directory,'rooms.json'),processes=[];
  await writeFile(dataPath,JSON.stringify([seeded]));
  const stop=async process=>{if(process.exitCode===null && process.signalCode===null){const stopped=once(process,'exit');process.kill();await stopped;}};
  t.after(async()=>{for(const process of processes)await stop(process);await rm(directory,{recursive:true,force:true});});
  const serviceSecret='synthetic-event-persistence-service-secret-1234567890';
  const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('ROUNDTABLE_') && key!=='ANTHROPIC_API_KEY'));
  async function start(){
    const process=spawn(globalThis.process.execPath,['server.js'],{cwd:new URL('..',import.meta.url),env:{...cleanEnv,PORT:'0',ROUNDTABLE_DATA:dataPath,ROUNDTABLE_SITES_GATEWAY_SECRET:serviceSecret,ROUNDTABLE_SITES_ROOM:'room',ROUNDTABLE_ALLOWED_ORIGINS:siteOrigin},stdio:['ignore','pipe','pipe']});processes.push(process);let logs='';process.stderr.on('data',chunk=>{logs+=chunk;});
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Event storage server startup timed out: '+logs)),5000);process.once('exit',code=>{clearTimeout(timer);reject(new Error('Event storage server exited: '+code+' '+logs));});process.stdout.on('data',chunk=>{logs+=chunk;const match=logs.match(/listening on http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});});
    const call=async(action,body={})=>{const response=await fetch('http://127.0.0.1:'+port+'/api/sites/rooms/room/'+action,{method:'POST',headers:{authorization:'Bearer '+serviceSecret,'x-roundtable-site-user-id':'persisted-event-owner','x-roundtable-site-user-name':'Alice','content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;};
    return {process,call};
  }
  const first=await start(),before=await first.call('snapshot');assert.equal(before.replyRequests[0].status,'requested');assert.equal(before.eventMonitoring.subscriptions.length,1);assert.equal(before.eventMonitoring.subscriptions[0].pendingDeliveries,1);
  await first.call('task_save',{title:'Persist event state',details:'An isolated persistence fixture.'});
  let saved;const deadline=Date.now()+5000;
  while(Date.now()<deadline){saved=JSON.parse(await readFile(dataPath,'utf8'));if(saved[0].tasks.some(task=>task.title==='Persist event state'))break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal(saved[0].eventSubscriptions.length,1);assert.equal(saved[0].eventSubscriptions[0].secret,secret);assert.equal(saved[0].eventOutbox.length,1);assert.ok(saved[0].tasks.some(task=>task.title==='Persist event state'));
  assert.equal((await stat(dataPath)).mode & 0o777,0o600);assert.equal((await readdir(directory)).some(name=>name.includes('.tmp-')),false);
  await stop(first.process);const second=await start(),after=await second.call('snapshot');assert.equal(after.member.id,'alice');assert.equal(after.replyRequests[0].status,'requested');assert.equal(after.eventMonitoring.subscriptions[0].pendingDeliveries,1);assert.ok(!JSON.stringify(after).includes(secret));assert.ok(!JSON.stringify(after).includes('https://callback.invalid/'));
});
