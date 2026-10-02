import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocketServer} from 'ws';

async function fixture(t,{owner='alice',expectedOwner='alice',sessionToken='s'.repeat(32),accountType='chatgpt',accountEmail='alice@example.com',revision=false,artifact=null}={}){
  const dir=await mkdtemp(join(tmpdir(),'roundtable-bridge-session-')),project=join(dir,'project'),codex=join(dir,'fake-codex.cjs'),rpcLog=join(dir,'rpc.jsonl');await mkdir(project);
  await writeFile(codex,`#!${process.execPath}
const {createInterface}=require('node:readline');
const {appendFileSync,writeFileSync,readFileSync,existsSync}=require('node:fs');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line),params=message.params || {},reply=result=>send({id:message.id,result});
  appendFileSync(${JSON.stringify(rpcLog)},line+'\\n');
  if(message.id===undefined)return;
  if(message.method==='account/read')return reply({account:${accountType===null?'null':JSON.stringify({type:accountType,email:accountEmail,planType:'pro'})}});
  if(message.method==='project/list')return reply({data:[],nextCursor:null});
  if(message.method==='project/create')return reply({project:{id:'project-id',name:'Test project',roots:params.roots}});
  if(message.method==='thread/start')return reply({thread:{id:'thread-id'}});
  if(message.method==='turn/start'){
    if(${revision}){
      const file=params.cwd+'/report.txt',previous=existsSync(file)?readFileSync(file,'utf8'):'';
      writeFileSync(file,previous?previous+'; revised with units':'Original result');
    }
    const turn={id:'turn-id',status:'completed'};reply({turn});
    send({method:'item/completed',params:{threadId:params.threadId,item:{type:'agentMessage',text:'Intended shared result'}}});
    return send({method:'turn/completed',params:{threadId:params.threadId,turn}});
  }
  reply({});
});
`,{mode:0o700});
  const joins=[],requests=[],ready=[],downloads=[];let resolveResult,resolveReconnect,resolveInterrupted,resolveFinished,resolveSecondResult;
  const result=new Promise(resolve=>{resolveResult=resolve;}),reconnect=new Promise(resolve=>{resolveReconnect=resolve;}),interrupted=new Promise(resolve=>{resolveInterrupted=resolve;}),finished=new Promise(resolve=>{resolveFinished=resolve;}),secondResult=new Promise(resolve=>{resolveSecondResult=resolve;});
  const server=createServer(async(request,response)=>{
    if(request.method==='GET'){
      downloads.push({url:request.url,authorization:request.headers.authorization});
      if(request.headers.authorization!=='Bearer '+sessionToken){response.writeHead(403);response.end('Forbidden');return;}
      response.end('Atlas');return;
    }
    let body='';for await(const chunk of request)body+=chunk;requests.push({authorization:request.headers.authorization,body:JSON.parse(body)});response.setHeader('Content-Type','application/json');response.end('{"ok":true}');resolveResult();if(requests.length===2)resolveSecondResult();
  });
  const wss=new WebSocketServer({server});wss.on('connection',ws=>{ws.on('message',raw=>{
    const message=JSON.parse(raw);
    if(message.t==='workspace_bridge_join'){
      joins.push(message);ws.send(JSON.stringify({t:'workspace_connected',room:'room',ownerId:owner,...(joins.length===1?{sessionToken}:{})}));
      if(joins.length>1)resolveReconnect();
    }
    if(message.t==='workspace_ready'){
      ready.push(message);
      if(ready.length===1)ws.send(JSON.stringify({t:artifact==='patch'?'workspace_integrate':'workspace_task',...(artifact==='patch'?{sourceId:'prior-run-id'}:{}),room:'room',id:'task-result-one',runToken:'private-run',agentId:owner,taskId:'shared-task',instructions:'Return the intended shared result.',context:{title:'Shared room',...(artifact==='dependency'?{dependencies:[{room:'room',runId:'prior-run-id',deliverables:[{path:'comparison.md',bytes:5}]}]}:{})}}));
    }
  });});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('ROUNDTABLE_')));
  const child=spawn(process.execPath,['bridge/workspace.js',origin+'/s/room','--project',project,'--workspace-mode','folder','--codex-bin',codex,'--expected-owner',expectedOwner],{cwd:new URL('..',import.meta.url),env:{...env,CODEX_HOME:join(dir,'codex-home'),ROUNDTABLE_PAIR_TOKEN:'p'.repeat(32)},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',chunk=>{logs+=chunk;if(logs.includes('Roundtable connection interrupted. Reconnecting'))resolveInterrupted();if(logs.includes('task-result-one: ready'))resolveFinished();});child.stderr.on('data',chunk=>{logs+=chunk;});
  t.after(async()=>{if(child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.kill('SIGINT');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await exited;}finally{clearTimeout(timer);}}for(const ws of wss.clients)ws.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const wait=promise=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Bridge session timed out: '+logs)),10000);timer.unref();promise.finally(()=>clearTimeout(timer));})]);
  return {joins,requests,ready,downloads,wss,child,wait,result,reconnect,interrupted,finished,secondResult,rpcLog,get logs(){return logs;}};
}

test('the actual workspace bridge privately adopts its exchanged credential for result upload and reconnect',async t=>{
  const f=await fixture(t);await f.wait(f.result);
  assert.equal(f.joins[0].token,'p'.repeat(32));assert.equal(f.requests[0].authorization,'Bearer '+'s'.repeat(32));assert.equal(f.requests[0].body.status,'ready');assert.equal(f.requests[0].body.summary,'Intended shared result');
  for(const ws of f.wss.clients)ws.terminate();await f.wait(f.reconnect);assert.equal(f.joins[1].token,'s'.repeat(32));assert.match(f.logs,/Roundtable connection interrupted\. Reconnecting…/);
  assert.ok(!f.logs.includes('p'.repeat(32)));assert.ok(!f.logs.includes('s'.repeat(32)));
});

test('the actual workspace bridge rejects a mismatched owner before ready, work or result upload',async t=>{
  const f=await fixture(t,{owner:'bob'});await f.wait(once(f.child,'exit'));
  assert.equal(f.joins.length,1);assert.equal(f.ready.length,0);assert.equal(f.requests.length,0);assert.match(f.logs,/different room owner/);assert.ok(!f.logs.includes('s'.repeat(32)));
});

test('the actual workspace bridge rejects malformed session credentials before admitting work',async t=>{
  const f=await fixture(t,{sessionToken:'bad-session'});await f.wait(once(f.child,'exit'));
  assert.equal(f.ready.length,0);assert.equal(f.requests.length,0);assert.match(f.logs,/invalid runtime session/);
});

test('stopping during a reconnect delay never opens another socket or leaves a child running',async t=>{
  const f=await fixture(t);await f.wait(f.result);
  for(const ws of f.wss.clients)ws.terminate();await f.wait(f.interrupted);
  const exited=once(f.child,'exit');f.child.kill('SIGTERM');await f.wait(exited);
  assert.equal(f.joins.length,1);assert.equal(f.wss.clients.size,0);
});

test('revising completed folder work preserves its output directory and original app-server thread',async t=>{
  const f=await fixture(t,{revision:true});await f.wait(f.finished);
  const prior=f.requests[0].body;assert.equal(prior.status,'ready');assert.equal(Buffer.from(prior.deliverables[0].data,'base64').toString(),'Original result');
  assert.ok(f.ready.some(state=>state.resumableRuns.includes('task-result-one')));
  [...f.wss.clients][0].send(JSON.stringify({t:'workspace_task',room:'room',id:'task-result-two',runToken:'second-run',agentId:'alice',taskId:'shared-task',resumeFromId:'task-result-one',instructions:'Revise the existing report: fix units and keep the original results.',context:{title:'Shared room'}}));
  await f.wait(f.secondResult);const revised=f.requests[1].body;
  assert.equal(revised.status,'ready');assert.equal(Buffer.from(revised.deliverables[0].data,'base64').toString(),'Original result; revised with units');
  const calls=(await readFile(f.rpcLog,'utf8')).trim().split('\n').map(JSON.parse),turns=calls.filter(call=>call.method==='turn/start');
  assert.equal(calls.filter(call=>call.method==='thread/start').length,1);assert.equal(turns.length,2);assert.equal(turns[1].params.threadId,turns[0].params.threadId);assert.equal(turns[1].params.cwd,turns[0].params.cwd);assert.match(turns[1].params.input[0].text,/fix units and keep the original results/);
  assert.ok(!f.logs.includes('alice@example.com'));
});

test('the actual bridge authenticates prerequisite and patch downloads with its exchanged runtime token',async t=>{
  for(const artifact of ['dependency','patch']){
    const f=await fixture(t,{artifact});await f.wait(f.result);
    assert.equal(f.downloads.length,1);assert.equal(f.downloads[0].authorization,'Bearer '+'s'.repeat(32));
    assert.equal(f.downloads[0].url,'/api/rooms/room/work/prior-run-id/'+(artifact==='patch'?'patch':'deliverables/comparison.md'));
    if(artifact==='dependency'){
      assert.equal(f.requests[0].body.status,'ready');
      const calls=(await readFile(f.rpcLog,'utf8')).trim().split('\n').map(JSON.parse),prompt=calls.find(call=>call.method==='turn/start').params.input[0].text;
      assert.match(prompt,/Atlas/);assert.ok(!prompt.includes('s'.repeat(32)));
    }else assert.match(f.requests[0].body.message,/Git integration requires a repository/);
  }
});

test('the Codex route requires an existing ChatGPT account before pairing and rejects API-key authentication',async t=>{
  for(const accountType of ['apiKey',null]){
    const f=await fixture(t,{accountType});await f.wait(once(f.child,'exit'));assert.equal(f.joins.length,0);assert.equal(f.requests.length,0);assert.match(f.logs,/Sign in to Codex with your ChatGPT account/);
  }
  const missingIdentity=await fixture(t,{accountEmail:null});await missingIdentity.wait(once(missingIdentity.child,'exit'));assert.equal(missingIdentity.joins.length,0);assert.match(missingIdentity.logs,/could not identify/);
});
