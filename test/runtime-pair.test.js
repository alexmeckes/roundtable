import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {createWorkspaces} from '../workspace/server.js';
import {saveTask} from '../workspace/tasks.js';

function fixture(t,{saved,time=1000}={}){
  const room=saved || {id:'room',title:'Shared room',access:'open',members:[{id:'alice',name:'Alice',sitesUserHash:'alice-source',sitesHost:true},{id:'bob',name:'Bob',sitesUserHash:'bob-source'}],people:new Map(),chat:[],work:[],specialists:[]};
  room.people=new Map();room.personalBridges=new Map();
  const other={id:'other',title:'Other room',access:'open',members:[],people:new Map(),chat:[],work:[],specialists:[]},rooms=new Map([[room.id,room],[other.id,other]]),broadcasts=[];
  const f={room,other,rooms,time,persistFailure:false,persisted:0,runs:0};
  const workspace=createWorkspaces({rooms,dataDir:tmpdir(),now:()=>f.time,broadcast:(_,message)=>broadcasts.push(message),persist:()=>{if(f.persistFailure)throw new Error('disk unavailable');f.persisted++;},tell:()=>{},say:(_,message)=>room.chat.push(message),allowRun:()=>{f.runs++;return true;},canSpeak:(room,you)=>room.access!=='view' || you.isHost===true});
  workspace.init(room);workspace.init(other);
  const auth=(member,{human=true}={})=>{const credentialHash=member.sitesUserHash;return {source:'sites',credentialHash,human,actor:{id:member.id,name:member.name,isHost:member.sitesHost===true},isCurrent:()=>room.members.includes(member) && member.sitesUserHash===credentialHash};};
  const ws=({failSend=false}={})=>({readyState:1,messages:[],send(data){if(failSend)throw new Error('socket unavailable');this.messages.push(JSON.parse(data));},close(code,reason){this.closed={code,reason};this.readyState=3;}});
  t.after(()=>{for(const bridge of [...room.personalBridges.values()])workspace.detach(bridge.ws);});
  return Object.assign(f,{workspace,broadcasts,auth,ws,alice:room.members[0],bob:room.members[1]});
}

test('runtime pairing exchanges an owner-scoped one-use grant for a separate reconnect credential',async t=>{
  const f=fixture(t),pair=f.workspace.runtimePair(f.room,f.alice,f.auth(f.alice));
  assert.deepEqual(Object.keys(pair).sort(),['expiresAt','member','pairToken','room','version']);
  assert.deepEqual(pair.member,{id:'alice',name:'Alice'});assert.equal(pair.version,1);assert.equal(pair.expiresAt,301000);assert.equal(f.alice.chatMode,'mentions');
  assert.equal(f.workspace.authorizedRoomRead(f.room,pair.pairToken),false);
  const connection=f.ws();assert.equal(f.workspace.attach(connection,f.other,pair.pairToken,{authMode:'chatgpt-plan'}),false);
  assert.equal(f.workspace.attach(connection,f.room,pair.pairToken,{authMode:'api-key'}),false);
  assert.equal(f.workspace.attach(connection,f.room,pair.pairToken,{authMode:'chatgpt-plan',workspaceMode:'folder',project:'Shared trial'}),true);
  const admitted=connection.messages.find(message=>message.t==='workspace_connected');assert.equal(admitted.ownerId,'alice');assert.notEqual(admitted.sessionToken,pair.pairToken);assert.match(admitted.sessionToken,/^[A-Za-z0-9_-]{32}$/);
  assert.equal(f.workspace.attach(f.ws(),f.room,pair.pairToken,{}),false);assert.equal(f.workspace.authorizedRoomRead(f.room,pair.pairToken),false);
  assert.equal(f.workspace.authorizedRoomRead(f.room,admitted.sessionToken),true);assert.equal(f.workspace.authorizedRoomRead(f.other,admitted.sessionToken),false);
  const snapshot=await f.workspace.nativeOperation(f.room,f.alice,'snapshot',{},f.auth(f.alice));
  assert.equal(snapshot.conversation.agents[0].authMode,'chatgpt-plan');assert.equal(snapshot.conversation.agents[0].mode,'mentions');
  for(const text of [JSON.stringify(snapshot),JSON.stringify(f.broadcasts),JSON.stringify(f.workspace.roster(f.room))])for(const secret of [pair.pairToken,admitted.sessionToken,f.alice.bridgeHash,f.alice.bridgeSourceHash])assert.ok(!text.includes(secret));
  const reconnected=f.ws();assert.equal(f.workspace.attach(reconnected,f.room,admitted.sessionToken,{authMode:'chatgpt-plan'}),true);assert.equal(connection.closed.code,1008);assert.equal(reconnected.messages[0].sessionToken,undefined);
  assert.equal(f.runs,0,'Pairing must not start model work.');
});

test('runtime grants enforce expiry, current source identity, room permission and human authority',t=>{
  const f=fixture(t);
  assert.throws(()=>f.workspace.runtimePair(f.room,f.alice,f.auth(f.alice,{human:false})),/authenticated room owner/);
  assert.throws(()=>f.workspace.runtimePair(f.room,f.bob,f.auth(f.alice)),/authenticated room owner/);
  const expired=f.workspace.runtimePair(f.room,f.alice,f.auth(f.alice));f.time=expired.expiresAt;
  assert.equal(f.workspace.attach(f.ws(),f.room,expired.pairToken,{}),false);
  const changed=f.workspace.runtimePair(f.room,f.alice,f.auth(f.alice));f.alice.sitesUserHash='replacement-source';
  assert.equal(f.workspace.attach(f.ws(),f.room,changed.pairToken,{}),false);
  const guest=f.workspace.runtimePair(f.room,f.bob,f.auth(f.bob));f.room.access='view';
  assert.equal(f.workspace.attach(f.ws(),f.room,guest.pairToken,{}),false);assert.throws(()=>f.workspace.runtimePair(f.room,f.bob,f.auth(f.bob)),/view-only/);
  const host=f.workspace.runtimePair(f.room,f.alice,f.auth(f.alice));assert.equal(f.workspace.attach(f.ws(),f.room,host.pairToken,{}),true);
});

test('pair rotation and disconnect revoke only that owner’s pending grants and active session',t=>{
  const f=fixture(t),first=f.workspace.runtimePair(f.room,f.alice,f.auth(f.alice)),bobPair=f.workspace.runtimePair(f.room,f.bob,f.auth(f.bob));
  const alice=f.ws(),bob=f.ws();f.workspace.attach(alice,f.room,first.pairToken,{});f.workspace.attach(bob,f.room,bobPair.pairToken,{});
  const aliceSession=alice.messages[0].sessionToken,bobSession=bob.messages[0].sessionToken;
  const replacement=f.workspace.runtimePair(f.room,f.alice,f.auth(f.alice));
  assert.equal(alice.closed.code,1008);assert.equal(f.workspace.authorizedRoomRead(f.room,aliceSession),false);assert.equal(f.workspace.attach(f.ws(),f.room,aliceSession,{}),false);
  assert.equal(bob.readyState,1);assert.equal(f.workspace.authorizedRoomRead(f.room,bobSession),true);
  const rotated=f.workspace.runtimePair(f.room,f.alice,f.auth(f.alice));assert.equal(f.workspace.attach(f.ws(),f.room,replacement.pairToken,{}),false);
  assert.deepEqual(f.workspace.runtimeDisconnect(f.room,f.alice,f.auth(f.alice)),{disconnected:true});assert.equal(f.workspace.attach(f.ws(),f.room,rotated.pairToken,{}),false);assert.equal(f.alice.chatMode,'off');
  f.room.access='view';assert.deepEqual(f.workspace.runtimeDisconnect(f.room,f.bob,f.auth(f.bob)),{disconnected:true});assert.equal(bob.closed.code,1008);assert.equal(f.workspace.authorizedRoomRead(f.room,bobSession),false);
});

test('failed persistence or admission does not consume the one-use runtime grant',t=>{
  const f=fixture(t),pair=f.workspace.runtimePair(f.room,f.alice,f.auth(f.alice));f.persistFailure=true;
  assert.throws(()=>f.workspace.attach(f.ws(),f.room,pair.pairToken,{}),/disk unavailable/);assert.equal(f.alice.bridgeHash,undefined);
  f.persistFailure=false;assert.throws(()=>f.workspace.attach(f.ws({failSend:true}),f.room,pair.pairToken,{}),/socket unavailable/);assert.equal(f.alice.bridgeHash,undefined);
  const connection=f.ws();assert.equal(f.workspace.attach(connection,f.room,pair.pairToken,{}),true);assert.equal(f.workspace.attach(f.ws(),f.room,pair.pairToken,{}),false);
});

test('a saved runtime session requires fresh Site access after restart and follows source revocation',async t=>{
  const f=fixture(t),pair=f.workspace.runtimePair(f.room,f.alice,f.auth(f.alice)),connection=f.ws();f.workspace.attach(connection,f.room,pair.pairToken,{authMode:'chatgpt-plan'});
  const session=connection.messages[0].sessionToken,saved=JSON.parse(JSON.stringify(f.room)),restored=fixture(t,{saved});
  assert.equal(restored.workspace.attach(restored.ws(),restored.room,pair.pairToken,{}),false);
  assert.equal(restored.workspace.attach(restored.ws(),restored.room,session,{}),false);
  restored.workspace.runtimeAccess(restored.room,restored.alice,restored.auth(restored.alice));
  assert.equal(restored.workspace.attach(restored.ws(),restored.room,session,{authMode:'chatgpt-plan'}),true);
  restored.alice.sitesUserHash='new-source';assert.equal(restored.workspace.authorizedRoomRead(restored.room,session),false);assert.equal(restored.workspace.attach(restored.ws(),restored.room,session,{}),false);
  const snapshot=await restored.workspace.nativeOperation(restored.room,restored.alice,'snapshot',{},restored.auth(restored.alice));assert.equal(snapshot.conversation.agents[0].available,false);
});

test('a signed-in host can participate without a browser socket; source revocation prevents replies',t=>{
  const f=fixture(t);f.room.access='view';const pair=f.workspace.runtimePair(f.room,f.alice,f.auth(f.alice)),connection=f.ws();f.workspace.attach(connection,f.room,pair.pairToken,{});
  assert.equal(f.room.people.size,0);assert.equal(f.workspace.conversation.human(f.room,{id:'alice',name:'Alice',isHost:true},'@'+f.alice.agentHandle+' hello'),true);
  const job=connection.messages.find(message=>message.t==='workspace_chat');assert.ok(job);f.alice.sitesUserHash='revoked-source';
  f.workspace.conversation.result(connection,f.room,{id:job.id,text:'This late reply must not enter the room.'});assert.ok(!f.room.chat.some(message=>message.text==='This late reply must not enter the room.'));
});

test('runtime task actions enforce owner, version, dependencies and stop active work after view-only',t=>{
  const f=fixture(t),pair=f.workspace.runtimePair(f.room,f.bob,f.auth(f.bob)),connection=f.ws();f.workspace.attach(connection,f.room,pair.pairToken,{});
  const task=saveTask(f.room,f.auth(f.bob).actor,{title:'Build the shared result',details:'Only the intended project.',ownerId:'bob',agentId:'bob'});
  assert.throws(()=>f.workspace.runtimeTaskStart(f.room,f.bob,{id:task.id,version:task.version},f.auth(f.bob,{human:false})),/authenticated room owner/);
  assert.throws(()=>f.workspace.runtimeTaskStart(f.room,f.alice,{id:task.id,version:task.version},f.auth(f.alice)),/Only the task owner/);
  assert.throws(()=>f.workspace.runtimeTaskStart(f.room,f.bob,{id:task.id,version:task.version-1},f.auth(f.bob)),/task changed/);
  const prerequisite=saveTask(f.room,f.auth(f.bob).actor,{title:'Prerequisite',details:'',ownerId:'bob',agentId:'bob'});task.dependencies=[prerequisite.id];
  assert.throws(()=>f.workspace.runtimeTaskStart(f.room,f.bob,{id:task.id,version:task.version},f.auth(f.bob)),/prerequisite/);task.dependencies=[];
  const started=f.workspace.runtimeTaskStart(f.room,f.bob,{id:task.id,version:task.version},f.auth(f.bob));assert.equal(started.task.status,'working');assert.equal(started.run.status,'running');assert.equal(started.run.runToken,undefined);
  assert.ok(connection.messages.some(message=>message.t==='workspace_task' && message.id===started.run.id && message.runToken));
  assert.throws(()=>f.workspace.runtimeTaskStop(f.room,f.alice,{id:task.id,version:task.version},f.auth(f.alice)),/Only the task owner/);
  assert.throws(()=>f.workspace.runtimeTaskStop(f.room,f.bob,{id:task.id,version:task.version-1},f.auth(f.bob)),/task changed/);
  f.room.access='view';const stopped=f.workspace.runtimeTaskStop(f.room,f.bob,{id:task.id,version:task.version},f.auth(f.bob));assert.equal(stopped.task.status,'blocked');assert.equal(stopped.run.status,'interrupted');assert.ok(connection.messages.some(message=>message.t==='workspace_cancel' && message.id===started.run.id));
  assert.throws(()=>f.workspace.runtimeTaskStart(f.room,f.bob,{id:task.id,version:task.version},f.auth(f.bob)),/view-only/);
});
