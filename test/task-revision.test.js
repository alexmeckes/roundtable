import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {createWorkspaces} from '../workspace/server.js';
import {saveTask} from '../workspace/tasks.js';

function fixture(t){
  const alice={id:'alice',name:'Alice',sitesUserHash:'alice-source',sitesHost:true},bob={id:'bob',name:'Bob',sitesUserHash:'bob-source'};
  const room={id:'revision-room',title:'Revision trial',access:'open',members:[alice,bob],people:new Map(),chat:[],work:[],specialists:[]};
  let runs=0;
  const workspace=createWorkspaces({rooms:new Map([[room.id,room]]),dataDir:tmpdir(),broadcast(){},persist(){},tell(){},say:(_,message)=>room.chat.push(message),allowRun:()=>{runs++;return true;},canSpeak:()=>true});
  workspace.init(room);
  const auth=member=>({source:'sites',human:true,actor:{id:member.id,name:member.name,isHost:member.sitesHost===true},credentialHash:member.sitesUserHash,isCurrent:()=>true});
  const connection={readyState:1,messages:[],send(raw){this.messages.push(JSON.parse(raw));},close(){this.readyState=3;}};
  const pair=workspace.runtimePair(room,alice,auth(alice));
  workspace.attach(connection,room,pair.pairToken,{authMode:'chatgpt-plan',workspaceMode:'folder',supportsContinuity:true});
  workspace.ready(connection,room,{savedConversations:[],resumableRuns:[]});
  const task=saveTask(room,alice,{title:'Prepare report',details:'Write report.md using the shared brief.',ownerId:alice.id,agentId:alice.id});
  const prior={id:'completed-report',ownerId:alice.id,agentId:alice.id,taskId:task.id,title:task.title,status:'ready',summary:'Wrote the report.',deliverables:[{path:'report.md',bytes:80}]};
  room.work.push(prior);task.runIds.push(prior.id);task.status='needs_review';
  const ready=ids=>workspace.ready(connection,room,{savedConversations:[],resumableRuns:ids});
  ready([prior.id]);
  t.after(()=>workspace.detach(connection));
  return {room,workspace,alice,bob,auth,connection,task,prior,ready,runs:()=>runs,
    review:(feedback='Add a concise recommendation and preserve the existing analysis.')=>workspace.nativeOperation(room,alice,'task_review',{id:task.id,version:task.version,decision:'reopen',feedback},auth(alice)),
    start:()=>workspace.runtimeTaskStart(room,alice,{id:task.id,version:task.version},auth(alice))};
}

test('review feedback continues the completed task checkpoint and retains the original result',async t=>{
  const f=fixture(t),original=structuredClone(f.prior);
  await f.review();
  assert.equal(f.task.status,'planned');assert.equal(f.task.revision.runId,f.prior.id);
  assert.equal(f.task.revision.requestedBy,f.alice.id);assert.match(f.task.revision.feedback,/recommendation/);
  const result=f.start(),job=f.connection.messages.find(message=>message.t==='workspace_task');
  assert.equal(result.run.resumeFromId,f.prior.id);assert.equal(job.resumeFromId,f.prior.id);
  assert.equal(job.taskId,f.task.id);assert.match(job.instructions,/Write report\.md/);assert.match(job.instructions,/Add a concise recommendation/);
  assert.match(job.instructions,/Revise the retained files/);assert.deepEqual(f.prior,original);
  assert.equal(f.task.status,'working');assert.equal(f.runs(),1);
});

test('missing original-machine checkpoint fails before spending or changing task state',async t=>{
  const f=fixture(t);await f.review();f.ready([]);
  const version=f.task.version,runIds=[...f.task.runIds];
  assert.throws(f.start,/original computer, account, and folder/);
  assert.equal(f.runs(),0);assert.equal(f.task.status,'planned');assert.equal(f.task.version,version);assert.deepEqual(f.task.runIds,runIds);
  assert.ok(!f.connection.messages.some(message=>message.t==='workspace_task'));
});

test('revision retry finds its retained ancestor when an attempted continuation has no checkpoint',async t=>{
  const f=fixture(t);await f.review();
  const attempted={id:'failed-revision',ownerId:f.alice.id,agentId:f.alice.id,taskId:f.task.id,status:'failed',resumeFromId:f.prior.id};
  f.room.work.push(attempted);f.task.runIds.push(attempted.id);f.task.status='blocked';
  const result=f.start();assert.equal(result.run.resumeFromId,f.prior.id);
  assert.match(f.connection.messages.find(message=>message.t==='workspace_task').instructions,/concise recommendation/);
});

test('task revisions never resume another owner, agent, task or native conversation',async t=>{
  for(const change of [{ownerId:'bob'},{agentId:'different-agent'},{taskId:'different-task'},{execution:'native'}]){
    const f=fixture(t);await f.review();Object.assign(f.prior,change);
    assert.throws(f.start,/previous task workspace|native AI chat/);assert.equal(f.runs(),0);
  }
});

test('review feedback requires human authority, task ownership and valid bounded text',async t=>{
  const f=fixture(t),body={id:f.task.id,version:f.task.version,decision:'reopen',feedback:'Make the conclusion clearer.'};
  await assert.rejects(f.workspace.nativeOperation(f.room,f.alice,'task_review',body,{...f.auth(f.alice),human:false}),/person/);
  await assert.rejects(f.workspace.nativeOperation(f.room,f.bob,'task_review',body,f.auth(f.bob)),/owner or room host/);
  for(const feedback of [12,'x'.repeat(4001)])await assert.rejects(f.workspace.nativeOperation(f.room,f.alice,'task_review',{...body,feedback},f.auth(f.alice)),/4,000/);
  await assert.rejects(f.workspace.nativeOperation(f.room,f.alice,'task_review',{...body,decision:'done'},f.auth(f.alice)),/feedback/);
  assert.equal(f.task.status,'needs_review');assert.equal(f.task.revision,undefined);
});

test('legacy task-start also honors a pending reviewed revision',async t=>{
  const f=fixture(t);await f.review();
  f.workspace.handle(f.connection,f.room,{...f.alice,isHost:true},{t:'task_start',id:f.task.id,version:f.task.version});
  const job=f.connection.messages.find(message=>message.t==='workspace_task');assert.equal(job.resumeFromId,f.prior.id);assert.match(job.instructions,/concise recommendation/);
});

test('stopped tasks continue retained work even without a review revision',t=>{
  const f=fixture(t);f.task.status='blocked';f.prior.status='interrupted';
  const result=f.start();assert.equal(result.run.resumeFromId,f.prior.id);
});
