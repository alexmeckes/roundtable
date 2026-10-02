import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createWorkspaces} from '../workspace/server.js';
import {createSitesGateway} from '../workspace/sites.js';
import {saveTask} from '../workspace/tasks.js';

test('only fresh Site authorization renews runtime access; expiry cancels replies and fences reconnect/download',async t=>{
  let time=1000;
  const room={id:'sites-trial',title:'Shared room',access:'open',members:[],people:new Map(),chat:[],work:[],specialists:[]},rooms=new Map([[room.id,room]]);
  const ws=()=>({readyState:1,messages:[],send(value){this.messages.push(JSON.parse(value));},close(code){this.readyState=3;this.code=code;}});
  const workspace=createWorkspaces({rooms,dataDir:tmpdir(),now:()=>time,runtimeAccessMs:1000,persist:()=>{},broadcast:()=>{},tell:()=>{},canSpeak:()=>true,allowRun:()=>true,say:(_,message)=>room.chat.push(message)});
  workspace.init(room);
  t.after(()=>{for(const bridge of [...room.personalBridges.values()])workspace.detach(bridge.ws);});
  const secret='runtime-access-fixture-service-secret';
  const gateway=createSitesGateway({rooms,getOrCreateRoom:()=>room,initialize:workspace.init,operation:workspace.nativeOperation,persist:()=>{},now:()=>time,secret,runtimePair:workspace.runtimePair,runtimeAccess:workspace.runtimeAccess});
  const app=express();gateway.mount(app);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{server.close();server.closeAllConnections();});
  const call=async(action,user='alice',credential=secret)=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/sites/rooms/sites-trial/${action}`,{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json','x-roundtable-site-user-id':user,'x-roundtable-site-client':'app'},body:'{}'});
    return {status:response.status,data:await response.json()};
  };
  await call('enroll');await call('enroll','bob');
  const pair=(await call('runtime_pair')).data,alice=ws();assert.equal(workspace.attach(alice,room,pair.pairToken,{}),true);
  const aliceToken=alice.messages[0].sessionToken;
  const bobPair=(await call('runtime_pair','bob')).data,bob=ws();assert.equal(workspace.attach(bob,room,bobPair.pairToken,{}),true);
  const bobToken=bob.messages[0].sessionToken;
  const owner=room.members[0];assert.equal(workspace.conversation.human(room,{id:owner.id,name:'Alice'},'@'+owner.agentHandle+' reply'),true);
  const job=alice.messages.find(message=>message.t==='workspace_chat');assert.ok(job);
  time=1500;assert.equal((await call('snapshot','alice',aliceToken)).status,403);
  assert.equal(workspace.authorizedRoomRead(room,aliceToken),true); // reads never extend access
  assert.equal((await call('snapshot','bob')).status,200); // only Bob renews
  time=2000;
  assert.equal(workspace.authorizedRoomRead(room,aliceToken),false);
  assert.equal(workspace.attach(ws(),room,aliceToken,{}),false);
  workspace.conversation.result(alice,room,{id:job.id,text:'Revoked late reply'});
  assert.ok(!room.chat.some(message=>message.text==='Revoked late reply'));
  workspace.expireRuntimeAccess();assert.equal(alice.code,1008);assert.equal(room.personalBridges.has(owner.id),false);
  assert.equal(workspace.authorizedRoomRead(room,bobToken),true);assert.equal(bob.readyState,1);
  time=2500;workspace.expireRuntimeAccess();assert.equal(bob.code,1008);
  await call('snapshot');assert.equal(workspace.attach(ws(),room,aliceToken,{}),false,'fresh Site access cannot resurrect a revoked credential');
  const replacement=(await call('runtime_pair')).data;assert.equal(workspace.attach(ws(),room,replacement.pairToken,{}),true);
});

test('Site members cannot mint or reuse legacy credentials to bypass runtime access expiry',t=>{
  let time=1000;
  const member={id:'alice',name:'Alice',sitesUserHash:'alice-site',sitesHost:true};
  const room={id:'legacy-room',title:'Legacy audit',access:'open',members:[member],people:new Map(),chat:[],work:[],specialists:[]};
  const errors=[],socket=()=>({readyState:1,messages:[],send(raw){this.messages.push(JSON.parse(raw));},close(){this.readyState=3;}});
  const workspace=createWorkspaces({rooms:new Map([[room.id,room]]),dataDir:tmpdir(),now:()=>time,runtimeAccessMs:1000,broadcast(){},persist(){},tell:(_,message)=>errors.push(message),say(){},allowRun:()=>true,canSpeak:()=>true});workspace.init(room);
  const actor={id:member.id,name:member.name,isHost:true},auth={source:'sites',human:true,actor,credentialHash:member.sitesUserHash,isCurrent:()=>true};
  workspace.runtimeAccess(room,member,auth);const browser=socket();
  for(const type of ['workspace_pair','workspace_native_pair'])workspace.handle(browser,room,actor,{t:type});
  assert.equal(browser.messages.length,0);assert.equal(member.bridgeHash,undefined);assert.equal(member.nativeHash,undefined);assert.equal(errors.length,2);
  const hash=value=>createHash('sha256').update(value).digest('hex');
  member.bridgeHash=hash('legacy-bridge');member.nativeHash=hash('legacy-native');
  assert.equal(workspace.attach(socket(),room,'legacy-bridge',{}),false);assert.equal(workspace.authorizedRoomRead(room,'legacy-native'),false);
  time=2001;workspace.expireRuntimeAccess();
  assert.equal(workspace.attach(socket(),room,'legacy-bridge',{}),false);assert.equal(workspace.authorizedRoomRead(room,'legacy-native'),false);
  const fresh=workspace.runtimePair(room,member,auth),bridge=socket();workspace.attach(bridge,room,fresh.pairToken,{});t.after(()=>workspace.detach(bridge));
  time=3001;
  workspace.handle(browser,room,actor,{t:'workspace_start',instructions:'Must not run after access expiry.'});
  assert.equal(room.work.length,0);assert.ok(!bridge.messages.some(message=>message.t==='workspace_task'));assert.match(errors.at(-1),/expired or was revoked/);
});

test('runtime publication rechecks Site access after artifact writes and exposes no late result',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rt-runtime-publication-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const room={id:'publish-room',title:'Publication audit',access:'open',members:[{id:'alice',name:'Alice',sitesUserHash:'alice-site',sitesHost:true}],people:new Map(),chat:[],work:[],specialists:[]};
  const member=room.members[0],parent=join(directory,'workspaces',room.id);
  let expireDuringWrite=false;
  const clock=()=>{
    if(expireDuringWrite && existsSync(parent) && readdirSync(parent).some(name=>name.startsWith('.runtime-') && existsSync(join(parent,name,'deliverables','report.md'))))return 2000;
    return 1000;
  };
  const workspace=createWorkspaces({rooms:new Map([[room.id,room]]),dataDir:directory,now:clock,runtimeAccessMs:1000,broadcast(){},persist(){},tell(){},say:(_,message)=>room.chat.push(message),allowRun:()=>true,canSpeak:()=>true});workspace.init(room);
  const actor={id:member.id,name:member.name,isHost:true},auth={source:'sites',human:true,actor,credentialHash:member.sitesUserHash,isCurrent:()=>true};
  const bridge={readyState:1,messages:[],send(raw){this.messages.push(JSON.parse(raw));},close(){this.readyState=3;}};
  const pair=workspace.runtimePair(room,member,auth);workspace.attach(bridge,room,pair.pairToken,{});t.after(()=>workspace.detach(bridge));
  const token=bridge.messages[0].sessionToken,task=saveTask(room,actor,{title:'Write report',details:'A shared report.',ownerId:member.id,agentId:member.id});
  const {run}=workspace.runtimeTaskStart(room,member,{id:task.id,version:task.version},auth),job=bridge.messages.find(message=>message.t==='workspace_task');
  const app=express();workspace.mount(app);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.close();server.closeAllConnections();});
  expireDuringWrite=true;
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/${room.id}/work/${run.id}/result`,{method:'POST',headers:{authorization:'Bearer '+token,'x-run-token':job.runToken,'content-type':'application/json'},body:JSON.stringify({status:'ready',summary:'Late result must stay private.',deliverables:[{path:'report.md',data:Buffer.from('private late output').toString('base64')}]})});
  assert.equal(response.status,403);assert.equal(run.status,'running');assert.equal(run.deliverables,undefined);assert.equal(task.status,'working');
  assert.ok(!room.chat.some(message=>message.text?.includes('Late result must stay private.')));assert.equal(existsSync(join(parent,run.id)),false);
  // Cleanup completes after the response has been sent.
  for(let attempt=0;attempt<20 && (await readdir(parent)).length;attempt++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(await readdir(parent),[]);
});
