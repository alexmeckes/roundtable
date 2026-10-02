import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {readRoomHistory} from '../workspace/history.js';
import {createWorkspaces} from '../workspace/server.js';
import {saveTask} from '../workspace/tasks.js';

const messages=length=>Array.from({length},(_,i)=>({id:'message-'+i,kind:i%2?'human':'agent',author:i%2?'Alice':'Alice AI',text:'Discussion '+i,ts:i+1,privateToken:'never-include'}));

test('room history pages earlier discussion in chronological order and searches beyond the prompt excerpt',()=>{
  const room={chat:messages(80)};
  const latest=readRoomHistory(room);assert.equal(latest.messages.length,20);assert.equal(latest.messages[0].id,'message-60');assert.equal(latest.nextBefore,'message-60');
  const older=readRoomHistory(room,{before:latest.nextBefore,limit:40});assert.equal(older.messages[0].id,'message-20');assert.equal(older.messages.at(-1).id,'message-59');
  const earliest=readRoomHistory(room,{before:older.nextBefore,limit:40});assert.equal(earliest.messages[0].id,'message-0');assert.equal(earliest.messages.length,20);assert.equal(earliest.nextBefore,null);
  assert.equal(readRoomHistory(room,{query:'Discussion 3',limit:40}).messages[0].id,'message-3');
  assert.ok(!JSON.stringify(latest).includes('never-include'));assert.equal(latest.retainedMessageCount,80);
});

test('history enforces retained limits, excludes system entries, and rejects foreign cursors or unbounded input',()=>{
  const room={chat:[{id:'very-old',kind:'human',text:'Expired decision'},...messages(400),{id:'system',kind:'system',text:'Internal note'}]};
  assert.equal(readRoomHistory(room,{query:'Expired decision'}).messages.length,0);
  assert.equal(readRoomHistory(room,{query:'Internal note'}).messages.length,0);
  assert.equal(readRoomHistory(room).retainedMessageCount,399);
  for(const args of [{before:'foreign-room-message'},{room:'other'},{limit:0},{limit:41},{limit:1.5},{query:'x'.repeat(201)},null])assert.throws(()=>readRoomHistory(room,args));
});

test('history is bound to the active socket and room, and Site lease expiry revokes discussion and task reads',t=>{
  let time=1000;
  const owner={id:'alice',name:'Alice',sitesUserHash:'alice-site',sitesHost:true};
  const room={id:'history-room',title:'History trial',access:'open',members:[owner],people:new Map(),chat:messages(60),work:[],specialists:[]};
  const other={id:'private-room',members:[],people:new Map(),chat:[{id:'private-message',kind:'human',text:'Different room secret'}],work:[],specialists:[]};
  const workspace=createWorkspaces({rooms:new Map([[room.id,room],[other.id,other]]),dataDir:tmpdir(),now:()=>time,runtimeAccessMs:1000,broadcast(){},persist(){},tell(){},say:(r,message)=>r.chat.push(message),allowRun:()=>true,canSpeak:()=>true});
  workspace.init(room);workspace.init(other);
  const auth={source:'sites',human:true,actor:{...owner,isHost:true},credentialHash:owner.sitesUserHash,isCurrent:()=>true};
  const socket=()=>({readyState:1,messages:[],send(raw){this.messages.push(JSON.parse(raw));},close(){this.readyState=3;}});
  const ws=socket(),stranger=socket(),pair=workspace.runtimePair(room,owner,auth);workspace.attach(ws,room,pair.pairToken,{});
  t.after(()=>workspace.detach(ws));
  workspace.conversation.human(room,owner,'@'+owner.agentHandle+' Catch up');
  const chat=ws.messages.find(message=>message.t==='workspace_chat');
  const task=saveTask(room,owner,{title:'Shared output',details:'Use the discussion.',ownerId:owner.id,agentId:owner.id});
  const work=workspace.runtimeTaskStart(room,owner,{id:task.id,version:task.version},auth).run;
  let counter=0;
  function request(id,{connection=ws,roomId=room.id,args={}}={}){
    const requestId='history-'+counter++;workspace.contextRequest(connection,room,{room:roomId,id,requestId,action:'history',args});
    return connection.messages.find(message=>message.requestId===requestId);
  }
  assert.equal(request(chat.id,{args:{query:'Discussion 1'}}).result.messages[0].id,'message-1');
  assert.ok(request(work.id).result.messages.length>0);
  assert.match(request(chat.id,{connection:stranger}).error,/no longer active/);
  assert.match(request(chat.id,{roomId:other.id}).error,/connected table/);
  assert.match(request(chat.id,{args:{before:'private-message'}}).error,/unavailable/);
  time=2000;
  assert.match(request(chat.id).error,/no longer active|revoked/);
  assert.match(request(work.id).error,/revoked/);
  assert.ok(!JSON.stringify(ws.messages).includes('Different room secret'));
});
