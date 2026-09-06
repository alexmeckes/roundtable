import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,symlink,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {resolveThreadProject} from '../bridge/thread-project.js';
import {CodexAppServer} from '../bridge/app-server.js';

test('project selection finds a canonical root across pages and respects an explicit project',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'roundtable-project-')),alias=cwd+'-alias';
  await symlink(cwd,alias);
  t.after(async()=>{await rm(alias);await rm(cwd,{recursive:true,force:true});});
  const expected={id:'shared',name:'Shared work',roots:[{path:alias}]};
  const calls=[];
  const rpc=async(method,params)=>{
    calls.push({method,params});
    if(method==='project/read'){assert.equal(params.projectId,'shared');return {project:expected};}
    assert.equal(method,'project/list');
    return params.cursor?{data:[expected],nextCursor:null}:{data:[],nextCursor:'page2'};
  };
  assert.equal(await resolveThreadProject(rpc,{cwd}),expected);
  assert.equal(calls.length,2);
  calls.length=0;
  assert.equal(await resolveThreadProject(rpc,{cwd,projectId:'shared'}),expected);
  assert.deepEqual(calls.map(c=>c.method),['project/read']);
  await assert.rejects(resolveThreadProject(async()=>{throw new Error('Unknown project');},{cwd,projectId:'missing'}),/Unknown project/);
});

test('new project creation uses a stable canonical directory identity',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'roundtable-project-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const creates=[];
  const rpc=async(method,params)=>{
    if(method==='project/list')return {data:[],nextCursor:null};
    assert.equal(method,'project/create');creates.push(params);return {project:{id:'new',...params}};
  };
  await resolveThreadProject(rpc,{cwd});await resolveThreadProject(rpc,{cwd:await realpath(cwd)});
  assert.deepEqual(creates[0],creates[1]);
  assert.deepEqual(creates[0].roots,[{path:await realpath(cwd)}]);
});

test('discussion and work share one project while retaining separate execution directories',async()=>{
  const server=Object.create(CodexAppServer.prototype);
  server.turns=new Map();server.projectId='shared-project';
  const calls=[];let next=0;
  server.rpc=async(method,params)=>{
    calls.push({method,params});
    if(method==='thread/start')return {thread:{id:'thread-'+(++next)}};
    if(method==='thread/name/set')return {};
    if(method==='turn/start'){
      queueMicrotask(()=>server.turns.get(params.threadId).resolve('Done'));
      return {turn:{id:'turn-'+next}};
    }
    throw new Error('Unexpected '+method);
  };
  let sessionId;
  const chat={cwd:'/source',conversation:true,job:{room:'planning',agentName:'Mira',handle:'mira',trigger:'Discuss'},onThread:id=>{sessionId=id;}};
  await Promise.all([server.run(chat),server.run({cwd:'/isolated/task-1',job:{room:'planning',agentName:'Quinn',instructions:'Write a CSV'}})]);
  await server.run({...chat,sessionId});
  const starts=calls.filter(c=>c.method==='thread/start');
  assert.equal(starts.length,2);
  assert.deepEqual(starts.map(c=>c.params.cwd),['/source','/isolated/task-1']);
  for(const c of starts)assert.equal(c.params.projectId,'shared-project');
  const names=calls.filter(c=>c.method==='thread/name/set').map(c=>c.params.name);
  assert.deepEqual(names,['Roundtable · planning · Mira · conversation','Roundtable · planning · Quinn · Write a CSV']);
  const turns=calls.filter(c=>c.method==='turn/start');
  assert.equal(turns[1].params.cwd,'/isolated/task-1');
  assert.equal(turns[0].params.sandboxPolicy.type,'readOnly');
  assert.equal(turns[2].params.threadId,sessionId);
});
