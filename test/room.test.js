import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const textBlock = (content) => [{type:'text', title:'Notes', content}];

async function fixture(t, env = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'roundtable-test-'));
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ROUNDTABLE_') && key !== 'ANTHROPIC_API_KEY'));
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {...cleanEnv, PORT:'0', ROUNDTABLE_DATA:join(dataDir,'rooms.json'), ROUNDTABLE_BRIDGE_SECRET:'test-secret', ROUNDTABLE_DEFAULT_ACCESS:'managed', ROUNDTABLE_DEFAULT_HOST_ONLY_SPEND:'1', ...env},
    stdio:['ignore','pipe','pipe'],
  });
  let logs = '';
  proc.stderr.on('data', chunk => { logs += chunk; });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    if (proc.exitCode === null && proc.signalCode === null) { const stopped = once(proc, 'exit'); proc.kill(); await stopped; }
    await rm(dataDir, {recursive:true, force:true});
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out: '+logs)), 5000);
    proc.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: '+code+' '+logs)); });
    proc.stdout.on('data', chunk => {
      logs += chunk;
      const match = logs.match(/listening on http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  async function connect() {
    const ws = new WebSocket('ws://127.0.0.1:'+port);
    sockets.push(ws);
    ws.messages = [];
    ws.on('message', raw => ws.messages.push(JSON.parse(raw)));
    await once(ws,'open');
    const wait = async (predicate, timeout = 2500) => {
      const deadline = Date.now()+timeout;
      while (Date.now()<deadline) {
        const index = ws.messages.findIndex(predicate);
        if (index>=0) return ws.messages.splice(index,1)[0];
        if (proc.exitCode !== null) throw new Error(logs);
        await pause(10);
      }
      throw new Error('Message timed out. Remaining: '+JSON.stringify(ws.messages)+'\n'+logs);
    };
    return {ws, wait, send:msg => ws.send(JSON.stringify(msg))};
  }
  async function person(room='room', name='Host', hostKey, memberKey) {
    const client = await connect();
    client.send({t:'join', room, name, hostKey, memberKey});
    client.welcome = await client.wait(m=>m.t==='welcome');
    return client;
  }
  async function brain(room='room', canApply=false) {
    const client = await connect();
    client.send({t:'bridge_join', room, name:'mock', provider:'test', secret:'test-secret', canApply});
    // Peek on the same connection is a barrier after bridge registration.
    client.send({t:'peek', room:room==='*'?'room':room});
    await client.wait(m=>m.t==='preview');
    client.task = () => client.wait(m=>m.t==='task');
    client.reply = (task, canvas, note='Done') => client.send({t:'result', id:task.id, ok:true, note, canvas, actions:[]});
    return client;
  }
  async function inspect(room='room') { return (await person(room,'Observer')).welcome.state; }
  async function seed(host, bridge, blocks=textBlock('Original')) {
    host.send({t:'chat', text:'@Agent seed'});
    bridge.reply(await bridge.task(), blocks);
    return (await host.wait(m=>m.t==='canvas')).blocks;
  }
  return {connect, person, brain, inspect, seed, proc,dataDir, origin: `http://127.0.0.1:${port}`};
}

test('new room hosts cannot use shared compute; operator-approved rooms can', async t => {
  const f=await fixture(t,{ROUNDTABLE_SHARED_ROOMS:'approved'});
  const bridge=await f.brain('*',true);
  const stranger=await f.person('stranger');
  assert.equal(stranger.welcome.you.isHost,true);
  assert.equal(stranger.welcome.state.hostOnlySpend,true);
  assert.deepEqual(stranger.welcome.state.brains,[]);
  stranger.send({t:'chat',text:'@Agent use shared compute'});
  await stranger.wait(m=>m.t==='chat' && m.entry.text.includes('no brain'));
  assert.equal(bridge.ws.messages.some(m=>m.t==='task'),false);
  const approved=await f.person('approved');
  assert.equal(approved.welcome.state.brains.length,1);
  assert.equal(approved.welcome.state.brains[0].canApply,false);
  await f.seed(approved,bridge);
});

test('room-scoped bridge works without shared authorization and cannot leak to another room', async t => {
  const f=await fixture(t);
  const host=await f.person();
  const bridge=await f.brain();
  await f.seed(host,bridge);
  assert.equal((await f.inspect('unrelated')).brains.length,0);
});

test('house compute is also denied to new rooms by default', async t => {
  const f=await fixture(t,{ANTHROPIC_API_KEY:'test-placeholder-never-called'});
  assert.deepEqual((await f.inspect()).brains,[]);
});

test('view-only guests cannot mutate canvas, title, problem, agents, auto or access', async t => {
  const f=await fixture(t);
  const host=await f.person(); const bridge=await f.brain();
  const [block]=await f.seed(host,bridge);
  host.send({t:'set_access',tier:'view',hostOnlySpend:true});
  await host.wait(m=>m.t==='access');
  const guest=await f.person('room','Viewer');
  for (const msg of [
    {t:'edit_title',text:'Bad title'}, {t:'edit_problem',text:'Bad problem'},
    {t:'edit_block',blockId:block.id,baseContent:block.content,content:'Bad edit'},
    {t:'set_auto',on:false}, {t:'set_access',tier:'open'},
    {t:'agent_upsert',name:'Extra',brief:'Bad'}, {t:'agent_retire',name:'Agent'},
    {t:'chat',text:'@Agent spend'}, {t:'merge'},
  ]) guest.send(msg);
  const conflict=await guest.wait(m=>m.t==='canvas_conflict');
  assert.equal(conflict.draft,'Bad edit');
  guest.send({t:'peek',room:'room'}); await guest.wait(m=>m.t==='preview');
  const state=await f.inspect();
  assert.equal(state.title,'Untitled table'); assert.equal(state.problem,'');
  assert.equal(state.canvas[0].content,'Original'); assert.equal(state.auto,true);
  assert.equal(state.access,'view'); assert.equal(state.agents.length,1);
  assert.equal(bridge.ws.messages.some(m=>m.t==='task'),false);
  host.send({t:'edit_block',blockId:block.id,baseContent:block.content,content:'Host edit'});
  assert.equal((await host.wait(m=>m.t==='block')).content,'Host edit');
});

test('late agent results cannot overwrite human edits, and snapshots stay immutable', async t => {
  const f=await fixture(t); const host=await f.person(); const bridge=await f.brain();
  const [block]=await f.seed(host,bridge);
  host.send({t:'chat',text:'@Agent think'}); const task=await bridge.task();
  host.send({t:'edit_block',blockId:block.id,baseContent:'Original',content:'Human edit'});
  await host.wait(m=>m.t==='block');
  assert.equal(task.canvas[0].content,'Original');
  bridge.reply(task,textBlock('Agent replacement'));
  await host.wait(m=>m.t==='chat' && m.entry.text.includes('was not applied'));
  assert.equal((await f.inspect()).canvas[0].content,'Human edit');
});

test('stale human edits retain drafts and cannot target replacement blocks by index', async t => {
  const f=await fixture(t); const host=await f.person(); const bridge=await f.brain();
  const [block]=await f.seed(host,bridge);
  const guest=await f.person('room','Editor');
  host.send({t:'edit_block',blockId:block.id,baseContent:'Original',content:'First edit'});
  await host.wait(m=>m.t==='block');
  guest.send({t:'edit_block',blockId:block.id,baseContent:'Original',content:'Second edit'});
  const conflict=await guest.wait(m=>m.t==='canvas_conflict');
  assert.equal(conflict.draft,'Second edit'); assert.equal(conflict.blocks[0].content,'First edit');
  host.send({t:'chat',text:'@Agent replace'});
  bridge.reply(await bridge.task(),textBlock('Replacement'));
  const replaced=await host.wait(m=>m.t==='canvas');
  assert.notEqual(replaced.blocks[0].id,block.id);
  guest.send({t:'edit_block',blockId:block.id,index:0,baseContent:'First edit',content:'Wrong block'});
  assert.equal((await guest.wait(m=>m.t==='canvas_conflict')).blocks[0].content,'Replacement');
});

test('busy and queued agents retain every explicit follow-up in order', async t => {
  const f=await fixture(t); const host=await f.person(); const bridge=await f.brain();
  host.send({t:'chat',text:'@Agent first'}); const first=await bridge.task();
  host.send({t:'chat',text:'@Agent second'}); host.send({t:'chat',text:'@Agent third'});
  host.send({t:'peek',room:'room'}); await host.wait(m=>m.t==='preview');
  bridge.reply(first,textBlock('First'));
  const second=await bridge.task(); assert.equal(second.directTask,'@Agent second');
  assert.equal(second.canvas[0].content,'First'); bridge.reply(second,textBlock('Second'));
  const third=await bridge.task(); assert.equal(third.directTask,'@Agent third');
  assert.equal(third.canvas[0].content,'Second'); bridge.reply(third,textBlock('Third'));
  await host.wait(m=>m.t==='canvas' && m.blocks[0].content==='Third');
});

test('auto replies received during a turn queue a follow-up with the latest conversation', async t => {
  const f=await fixture(t); const host=await f.person(); const bridge=await f.brain();
  host.send({t:'chat',text:'@Agent first'}); const first=await bridge.task();
  host.send({t:'chat',text:'Here is a correction while you think'});
  await pause(1350);
  bridge.reply(first,textBlock('First'));
  const followUp=await bridge.task();
  assert.ok(followUp.chat.some(m=>m.text==='Here is a correction while you think'));
  bridge.reply(followUp,textBlock('Corrected'));
});

test('branch merge cannot overwrite newer parent work; retry succeeds', async t => {
  const f=await fixture(t); const host=await f.person(); const bridge=await f.brain();
  const [block]=await f.seed(host,bridge);
  host.send({t:'chat',text:'/branch Side discussion'});
  const branch=await host.wait(m=>m.t==='chat' && m.entry.kind==='branch');
  const child=await f.person(branch.entry.room,'Host',host.welcome.hostKey);
  const childBrain=await f.brain(branch.entry.room);
  child.send({t:'merge'}); const merge=await childBrain.task();
  host.send({t:'edit_block',blockId:block.id,baseContent:'Original',content:'New parent decision'});
  await host.wait(m=>m.t==='block');
  childBrain.reply(merge,textBlock('Old merged decision'));
  await child.wait(m=>m.t==='chat' && m.entry.text.includes('Merge was not applied'));
  assert.equal((await f.inspect()).canvas[0].content,'New parent decision');
  child.send({t:'merge'}); const retry=await childBrain.task();
  assert.equal(retry.canvas[0].content,'New parent decision');
  childBrain.reply(retry,textBlock('Integrated decision'));
  await child.wait(m=>m.t==='chat' && m.entry.text.startsWith('Merged into'));
  assert.equal((await f.inspect()).canvas[0].content,'Integrated decision');
});

test('host-only spend also blocks merge for guests in open rooms', async t => {
  const f=await fixture(t); const host=await f.person();
  host.send({t:'set_access',tier:'open',hostOnlySpend:true}); await host.wait(m=>m.t==='access');
  host.send({t:'chat',text:'/branch Side'});
  const branch=await host.wait(m=>m.t==='chat' && m.entry.kind==='branch');
  const child=await f.person(branch.entry.room,'Guest'); const bridge=await f.brain(branch.entry.room);
  child.send({t:'chat',text:'/merge'});
  await child.wait(m=>m.t==='chat' && m.entry.text.includes('do not have permission'));
  assert.equal(bridge.ws.messages.some(m=>m.t==='task'),false);
});

test('malformed messages and repeated joins cannot corrupt room membership', async t => {
  const f=await fixture(t); const host=await f.person();
  host.send(null); host.send([]); host.send({t:'join',room:'other'});
  await host.wait(m=>m.t==='chat' && m.entry.text.includes('Already joined'));
  host.send({t:'edit_title',text:'Still in original'});
  host.send({t:'peek',room:'room'}); await host.wait(m=>m.t==='preview');
  assert.equal((await f.inspect()).title,'Still in original');
  assert.equal((await f.inspect('other')).title,'Untitled table');
});

test('diff application requires current block identity and a room-scoped bridge', async t => {
  const f=await fixture(t,{ROUNDTABLE_SHARED_ROOMS:'room'});
  const host=await f.person(); const shared=await f.brain('*',true);
  const [oldBlock]=await f.seed(host,shared,[{type:'diff',title:'Change',content:'old patch'}]);
  host.send({t:'apply_diff',blockId:oldBlock.id});
  await host.wait(m=>m.t==='chat' && m.entry.text.includes('No attached bridge allows applying'));
  assert.equal(shared.ws.messages.some(m=>m.t==='apply'),false);
  const scoped=await f.brain('room',true);
  host.send({t:'chat',text:'@Agent new patch'});
  scoped.reply(await scoped.task(),[{type:'diff',title:'Change',content:'new patch'}]);
  const current=await host.wait(m=>m.t==='canvas');
  host.send({t:'apply_diff',blockId:oldBlock.id,index:0});
  await host.wait(m=>m.t==='chat' && m.entry.text.includes('not a diff'));
  assert.equal(scoped.ws.messages.some(m=>m.t==='apply'),false);
  host.send({t:'apply_diff',blockId:current.blocks[0].id});
  const apply=await scoped.wait(m=>m.t==='apply');
  assert.equal(apply.diff,'new patch');
  scoped.send({t:'apply_result',id:apply.id,ok:true,output:'simulated; no files changed'});
});

test('branches do not inherit shared compute authorization', async t => {
  const f=await fixture(t,{ROUNDTABLE_SHARED_ROOMS:'room'});
  const host=await f.person(); const bridge=await f.brain('*');
  await f.seed(host,bridge);
  host.send({t:'chat',text:'/branch Research'});
  const branch=await host.wait(m=>m.t==='chat' && m.entry.kind==='branch');
  assert.deepEqual((await f.inspect(branch.entry.room)).brains,[]);
});

test('room creation limits reject branching without terminating the server', async t => {
  const f=await fixture(t,{ROUNDTABLE_MAX_ROOMS:'1'}); const host=await f.person();
  host.send({t:'chat',text:'/branch Extra'});
  await host.wait(m=>m.t==='chat' && m.entry.text.includes('branch was not created'));
  host.send({t:'edit_title',text:'Still running'});
  host.send({t:'peek',room:'room'});
  assert.equal((await host.wait(m=>m.t==='preview')).title,'Still running');
});

async function personalBridge(f,person,room='room') {
  person.send({t:'workspace_pair'});
  const {token}=await person.wait(m=>m.t==='workspace_pair');
  const bridge=await f.connect();
  bridge.send({t:'workspace_bridge_join',room,token,project:'game',approach:'My own approach'});
  const connected=await bridge.wait(m=>m.t==='workspace_connected');
  return {...bridge,token,ownerId:connected.ownerId,task:()=>bridge.wait(m=>['workspace_task','workspace_integrate'].includes(m.t))};
}
async function upload(f,bridge,job,body,room='room') {
  return fetch(f.origin+'/api/rooms/'+room+'/work/'+job.id+'/result',{method:'POST',headers:{Authorization:'Bearer '+bridge.token,'X-Run-Token':job.runToken,'Content-Type':'application/json'},body:JSON.stringify(body)});
}

test('friends run their own Codex concurrently even when host-only shared spending is enabled',async t=>{
  const f=await fixture(t),alice=await f.person('room','Alice'),bob=await f.person('room','Bob');
  const a=await personalBridge(f,alice),b=await personalBridge(f,bob);
  assert.notEqual(a.ownerId,b.ownerId);
  alice.send({t:'workspace_start',instructions:'Improve player movement',ownerId:b.ownerId});
  bob.send({t:'workspace_start',instructions:'Build enemies'});
  const [at,bt]=await Promise.all([a.task(),b.task()]);
  assert.equal(at.instructions,'Improve player movement');assert.equal(bt.instructions,'Build enemies');
  const state=await f.inspect();assert.equal(state.work.filter(w=>w.status==='running').length,2);
  assert.ok(state.work.every(w=>!w.runToken));assert.deepEqual(state.brains,[]);
  assert.equal((await upload(f,b,at,{status:'ready'})).status,403);
  bob.send({t:'workspace_cancel',id:at.id});
  await bob.wait(m=>m.t==='chat' && m.entry.text.includes('only manage your own'));
  assert.equal((await upload(f,a,at,{status:'ready',summary:'Movement improved',patch:'diff example',baseCommit:'a'.repeat(40)})).status,200);
  assert.equal((await upload(f,b,bt,{status:'ready',summary:'Enemies ready'})).status,200);
  const finished=await f.inspect();assert.equal(finished.work.filter(w=>w.status==='ready').length,2);
});

test('member identity survives reconnection and a matching display name grants no ownership',async t=>{
  const f=await fixture(t),alice=await f.person('room','Alice');
  const bridge=await personalBridge(f,alice);
  const returned=await f.person('room','Alice',undefined,alice.welcome.memberKey);
  assert.equal(returned.welcome.you.id,alice.welcome.you.id);
  assert.equal(returned.welcome.state.connections[0].ownerId,returned.welcome.you.id);
  const impostor=await f.person('room','Alice');
  assert.notEqual(impostor.welcome.you.id,returned.welcome.you.id);
  impostor.send({t:'workspace_start',instructions:'Spend Alice compute',ownerId:bridge.ownerId});
  await impostor.wait(m=>m.t==='chat' && m.entry.text.includes('Connect your Codex'));
  assert.equal(bridge.ws.messages.some(m=>m.t==='workspace_task'),false);
});

test('pairing tokens are room-scoped and rotation revokes old connections and late results',async t=>{
  const f=await fixture(t),alice=await f.person('room','Alice'),bridge=await personalBridge(f,alice);
  await f.person('other','Other');const wrong=await f.connect();
  const closed=once(wrong.ws,'close');wrong.send({t:'workspace_bridge_join',room:'other',token:bridge.token,project:'game'});
  assert.equal((await closed)[0],1008);
  alice.send({t:'workspace_start',instructions:'Work'});const task=await bridge.task();
  alice.send({t:'workspace_pair'});await alice.wait(m=>m.t==='workspace_pair');
  assert.equal((await upload(f,bridge,task,{status:'ready'})).status,403);
  assert.equal((await f.inspect()).work[0].status,'interrupted');
});

test('preview files are bounded and sandboxed; traversal is rejected',async t=>{
  const f=await fixture(t),owner=await f.person(),bridge=await personalBridge(f,owner);
  owner.send({t:'workspace_start',instructions:'Build a playable game'});const job=await bridge.task();
  assert.equal((await upload(f,bridge,job,{status:'ready',preview:[{path:'../escape.html',data:'eA=='}]})).status,400);
  const body={status:'ready',patch:'example diff',preview:[{path:'index.html',data:Buffer.from('<canvas>Game</canvas>').toString('base64')}]};
  assert.equal((await upload(f,bridge,job,body)).status,200);
  const response=await fetch(f.origin+'/api/rooms/room/work/'+job.id+'/preview/index.html');
  assert.equal(response.status,200);assert.equal(await response.text(),'<canvas>Game</canvas>');
  assert.match(response.headers.get('content-security-policy'),/sandbox allow-scripts/);
  assert.ok(response.headers.get('content-security-policy').includes('/work/'+job.id+'/preview/'));
  assert.ok(!response.headers.get('content-security-policy').includes("connect-src 'self'"));
  assert.ok(!response.headers.get('content-security-policy').includes('allow-same-origin'));
  assert.equal((await upload(f,bridge,job,body)).status,403);
});

test('integration is dispatched to the receiving person, not the author or room host',async t=>{
  const f=await fixture(t),alice=await f.person('room','Alice'),bob=await f.person('room','Bob');
  const a=await personalBridge(f,alice),b=await personalBridge(f,bob);
  alice.send({t:'workspace_start',instructions:'Create movement'});const task=await a.task();
  await upload(f,a,task,{status:'ready',patch:'example',baseCommit:'b'.repeat(40)});
  bob.send({t:'workspace_integrate',id:task.id});const integration=await b.task();
  assert.equal(integration.t,'workspace_integrate');assert.equal(integration.sourceId,task.id);assert.equal(integration.baseCommit,'b'.repeat(40));
  assert.equal(a.ws.messages.some(m=>m.t==='workspace_integrate'),false);
  assert.equal((await upload(f,b,integration,{status:'conflict',message:'Conflict; checkout unchanged'})).status,200);
});

test('view-only owners can still stop their own active Codex and revoke its connection',async t=>{
  const f=await fixture(t),host=await f.person(),guest=await f.person('room','Guest'),bridge=await personalBridge(f,guest);
  guest.send({t:'workspace_start',instructions:'Work'});const job=await bridge.task();
  host.send({t:'set_access',tier:'view',hostOnlySpend:true});await host.wait(m=>m.t==='access');
  guest.send({t:'workspace_cancel',id:job.id});await bridge.wait(m=>m.t==='workspace_cancel');
  guest.send({t:'workspace_start',instructions:'More work'});await guest.wait(m=>m.t==='chat' && m.entry.text.includes('view-only'));
  guest.send({t:'workspace_disconnect'});await guest.wait(m=>m.t==='workspaces' && m.connections.length===0);
});

async function chatMode(person,mode){
  person.send({t:'workspace_chat_mode',mode});
  await person.wait(m=>m.t==='chat' && m.entry.kind==='system' && /invited their Codex|paused their Codex/.test(m.entry.text));
}
const chatTask=bridge=>bridge.wait(m=>m.t==='workspace_chat');
const chatReply=(bridge,job,text)=>bridge.send({t:'workspace_chat_result',room:'room',id:job.id,text,author:'Spoofed'});

test('personal conversation is owner opt-in, shared, authenticated, and bounded across agents',async t=>{
  const f=await fixture(t),alice=await f.person('room','Alice'),bob=await f.person('room','Bob'),eve=await f.person('room','Eve');
  const a=await personalBridge(f,alice),b=await personalBridge(f,bob);
  eve.send({t:'workspace_chat_mode',mode:'auto',ownerId:a.ownerId});
  await eve.wait(m=>m.t==='chat' && m.entry.text.includes('Connect your Codex'));
  alice.send({t:'chat',text:'Nobody opted in yet'});await pause(40);
  assert.equal(a.ws.messages.some(m=>m.t==='workspace_chat'),false);
  await chatMode(alice,'mentions');await chatMode(bob,'mentions');
  eve.send({t:'chat',text:'@alice-codex coordinate the dash with Bob'});
  const first=await chatTask(a);
  chatReply(b,first,'Impersonation');await pause(40);
  assert.equal((await f.inspect()).chat.some(m=>m.text==='Impersonation'),false);
  chatReply(a,first,'@bob-codex should dash collect coins?');
  const second=await chatTask(b);
  assert.ok(second.context.chat.some(m=>m.author==="Alice's Codex" && m.text.includes('collect coins')));
  chatReply(b,second,'@alice-codex yes, collect along the swept path.');
  chatReply(a,await chatTask(a),'@bob-codex agreed, test the endpoints too.');
  chatReply(b,await chatTask(b),'@alice-codex agreed, ready for implementation.');
  await pause(80);
  assert.equal(a.ws.messages.some(m=>m.t==='workspace_chat'),false);
  const messages=(await f.inspect()).chat.filter(m=>m.workspaceOwnerId);
  assert.equal(messages.length,4);
  assert.deepEqual(messages.map(m=>m.author),["Alice's Codex","Bob's Codex","Alice's Codex","Bob's Codex"]);
});

test('conversation queues follow-ups, runs beside work, passes discussion into tasks, and pause rejects late replies',async t=>{
  const f=await fixture(t),alice=await f.person('room','Alice'),bob=await f.person('room','Bob');
  const a=await personalBridge(f,alice),b=await personalBridge(f,bob);
  await chatMode(alice,'auto');await chatMode(bob,'auto');
  alice.send({t:'chat',text:'Discuss the game'});
  const [first,other]=await Promise.all([chatTask(a),chatTask(b)]);
  alice.send({t:'chat',text:'Keep the dash deterministic'});
  chatReply(a,first,'Use a fixed 30-unit dash.');
  const follow=await chatTask(a);assert.match(follow.trigger,/deterministic/);
  alice.send({t:'workspace_start',instructions:'Implement our dash agreement'});
  const work=await a.task();assert.ok(work.context.chat.some(m=>m.text==='Use a fixed 30-unit dash.'));
  await chatMode(alice,'off');
  assert.equal((await a.wait(m=>m.t==='workspace_chat_cancel')).id,follow.id);
  chatReply(a,follow,'Late paused answer');
  chatReply(b,other,'Bob can still talk.');await chatTask(b);
  assert.equal((await upload(f,a,work,{status:'ready',summary:'Dash implemented'})).status,200);
  await pause(60);assert.equal((await f.inspect()).chat.some(m=>m.text==='Late paused answer'),false);
});

test('mentioning a paused agent does not spend another agent’s compute; view-only cancels guest discussion',async t=>{
  const f=await fixture(t),alice=await f.person('room','Alice'),bob=await f.person('room','Bob');
  const a=await personalBridge(f,alice),b=await personalBridge(f,bob);
  await chatMode(bob,'auto');
  alice.send({t:'chat',text:'@alice-codex this agent is paused'});await pause(60);
  assert.equal(b.ws.messages.some(m=>m.t==='workspace_chat'),false);
  alice.send({t:'chat',text:'@bob-codex please discuss'});const job=await chatTask(b);
  alice.send({t:'set_access',tier:'view',hostOnlySpend:true});
  assert.equal((await b.wait(m=>m.t==='workspace_chat_cancel')).id,job.id);
  chatReply(b,job,'Late guest reply');await pause(40);
  assert.equal((await f.inspect()).chat.some(m=>m.text==='Late guest reply'),false);
  await chatMode(bob,'off');
});

test('specialists can join and accept owner work from chat, with separate conversation identities',async t=>{
  const f=await fixture(t),alice=await f.person('room','Alice'),bob=await f.person('room','Bob'),a=await personalBridge(f,alice);
  alice.send({t:'chat',text:'/specialist Mira | Research options and explain tradeoffs'});
  const intro=await chatTask(a);assert.equal(intro.agentName,'Mira');assert.equal(intro.agentRole,'Research options and explain tradeoffs');assert.notEqual(intro.agentId,a.ownerId);
  chatReply(a,intro,'I can research options.');await alice.wait(m=>m.t==='chat' && m.entry.author==='Mira');
  bob.send({t:'chat',text:'@mira What should we compare?'});const discussion=await chatTask(a);assert.equal(discussion.agentId,intro.agentId);
  chatReply(a,discussion,'Compare cost, usability, and reliability.');await alice.wait(m=>m.t==='chat' && m.entry.text.includes('Compare cost'));
  bob.send({t:'chat',text:'/work @mira Spend Alice compute'});await bob.wait(m=>m.t==='chat' && m.entry.text.includes('only to your own'));assert.equal(a.ws.messages.some(m=>m.t==='workspace_task'),false);
  alice.send({t:'chat',text:'/work @mira Write a decision brief'});const job=await a.task();assert.equal(job.agentId,intro.agentId);assert.equal(job.agentName,'Mira');assert.equal(job.agentRole,intro.agentRole);assert.ok(job.context.chat.some(m=>m.text.includes('Compare cost')));
  alice.send({t:'workspace_specialist_retire',agentId:intro.agentId});await alice.wait(m=>m.t==='chat' && m.entry.text.includes('Stop this specialist'));
  await upload(f,a,job,{status:'ready',summary:'Decision brief ready',deliverables:[{path:'decision.md',data:Buffer.from('# Decision').toString('base64')}]});
  await alice.wait(m=>m.t==='chat' && m.entry.author==='Mira' && m.entry.activity && m.entry.text.includes('Decision brief ready'));
  const output=await fetch(f.origin+'/api/rooms/room/work/'+job.id+'/deliverables/decision.md');assert.equal(await output.text(),'# Decision');assert.match(output.headers.get('content-disposition'),/^attachment/);assert.match(output.headers.get('content-security-policy'),/sandbox/);
  alice.send({t:'workspace_specialist_retire',agentId:intro.agentId});await alice.wait(m=>m.t==='chat' && m.entry.text.includes('retired Mira'));
  const state=await f.inspect();assert.equal(state.connections[0].agents.length,1);assert.ok(state.chat.some(m=>m.author==='Mira'));
});

test('specialist creation is bounded, owner pause cancels all its agents, and unsafe downloads are rejected',async t=>{
  const f=await fixture(t),alice=await f.person('room','Alice'),a=await personalBridge(f,alice);
  const tasks=[];
  for(let i=0;i<4;i++){alice.send({t:'workspace_specialist_create',name:'Researcher',role:'Research a topic'});tasks.push(await chatTask(a));}
  assert.equal(new Set(tasks.map(j=>j.handle)).size,4);
  alice.send({t:'workspace_specialist_create',name:'Fifth',role:'Extra'});await alice.wait(m=>m.t==='chat' && m.entry.text.includes('limit reached'));
  await chatMode(alice,'off');for(let i=0;i<4;i++)await a.wait(m=>m.t==='workspace_chat_cancel');
  for(const job of tasks)chatReply(a,job,'Late specialist reply');await pause(40);assert.equal((await f.inspect()).chat.some(m=>m.text==='Late specialist reply'),false);
  alice.send({t:'workspace_start',instructions:'Document'});const job=await a.task();
  for(const path of ['../secret.txt','.env','folder/.secret','a\\b','bad\nname'])assert.equal((await upload(f,a,job,{status:'ready',deliverables:[{path,data:'eA=='}]})).status,400);
  assert.equal((await upload(f,a,job,{status:'ready',deliverables:[{path:'result.html',data:Buffer.from('<script>bad()</script>').toString('base64')}]})).status,200);
  const output=await fetch(f.origin+'/api/rooms/room/work/'+job.id+'/deliverables/result.html');assert.match(output.headers.get('content-type'),/application\/octet-stream/);assert.match(output.headers.get('content-disposition'),/attachment/);
});

async function saveShared(client,value){
  const requestId='save-'+Math.random();client.send({t:'context_save',requestId,...value});
  await client.wait(m=>m.t==='context_saved' && m.requestId===requestId);
  return (await client.wait(m=>m.t==='context' && m.context.entries.some(e=>e.title===value.title))).context.entries.find(e=>e.title===value.title);
}

test('shared context edits preserve concurrent work, original attribution, and room permissions',async t=>{
  const f=await fixture(t),alice=await f.person('room','Alice'),bob=await f.person('room','Bob');
  alice.send({t:'chat',text:'Use the supplied source, and verify its date.'});
  const message=(await alice.wait(m=>m.t==='chat' && m.entry.author==='Alice')).entry;
  const entry=await saveShared(alice,{kind:'decision',title:'Source policy',body:'Verify the date',chatId:message.id});
  assert.equal(entry.origin.author,'Alice');assert.equal(entry.origin.text,message.text);
  await bob.wait(m=>m.t==='context' && m.context.entries.length===1);
  await saveShared(alice,{id:entry.id,version:entry.version,kind:'decision',title:'Source policy updated',body:'Check date and scope'});
  bob.send({t:'context_save',requestId:'stale',id:entry.id,version:1,kind:'decision',title:'Stale policy',body:'Overwrite'});
  assert.match((await bob.wait(m=>m.t==='context_error' && m.requestId==='stale')).message,/changed/);
  const latest=(await f.inspect()).sharedContext.entries[0];assert.equal(latest.body,'Check date and scope');assert.equal(latest.history[0].body,'Verify the date');
  alice.send({t:'set_access',tier:'view',hostOnlySpend:true});await bob.wait(m=>m.t==='access' && m.access==='view');
  bob.send({t:'context_save',requestId:'view',kind:'source',title:'No',body:'Blocked'});
  assert.match((await bob.wait(m=>m.t==='context_error' && m.requestId==='view')).message,/view-only/);
  assert.equal((await f.inspect('another')).sharedContext.entries.length,0);
});

test('agent context tools are room and run scoped, proposals need human acceptance, and cancellation revokes access',async t=>{
  const f=await fixture(t),alice=await f.person('room','Alice'),bob=await f.person('room','Bob'),a=await personalBridge(f,alice),b=await personalBridge(f,bob);
  const source=await saveShared(alice,{kind:'source',title:'Supplied comparison',body:'Atlas costs 30; Beacon costs 20 but has no exports.'});
  await chatMode(alice,'mentions');alice.send({t:'chat',text:'@alice-codex read our source and propose a finding'});const job=await chatTask(a);
  assert.equal(job.context.shared.items[0].id,source.id);
  async function context(bridge,action,args,id=job.id,room='room'){
    const requestId='request-'+Math.random();bridge.send({t:'workspace_context_request',room,id,requestId,action,args});
    return bridge.wait(m=>m.t==='workspace_context_result' && m.requestId===requestId);
  }
  assert.match((await context(b,'read',{ids:[source.id]})).error,/no longer active/);
  assert.match((await context(a,'read',{},job.id,'another')).error,/connected table/);
  assert.equal((await context(a,'read',{ids:[source.id]})).result.entries[0].body,source.body);
  const result=await context(a,'propose',{kind:'learning',title:'Exports cost more',body:'The cheaper supplied option lacks exports.',refs:[source.id],status:'accepted'});
  assert.equal(result.result.status,'proposed');const id=result.result.id;
  assert.equal((await context(a,'read',{ids:[id]})).result.entries.length,0);
  const proposal=(await f.inspect()).sharedContext.entries.find(e=>e.id===id);
  assert.equal(proposal.createdBy.name,"Alice's Codex");assert.equal(proposal.createdBy.ownerName,'Alice');
  alice.send({t:'context_status',id,version:1,status:'accepted',requestId:'accept'});await alice.wait(m=>m.t==='context_saved' && m.requestId==='accept');
  assert.equal((await context(a,'read',{ids:[id]})).result.entries[0].status,'accepted');
  alice.send({t:'workspace_start',instructions:'Use the accepted finding'});const work=await a.task();
  assert.ok(work.context.shared.items.some(e=>e.id===id));
  assert.equal((await context(a,'read',{ids:[id]},work.id)).result.entries[0].title,'Exports cost more');
  await chatMode(alice,'off');assert.match((await context(a,'propose',{kind:'learning',title:'Late',body:'Late'})).error,/no longer active/);
  alice.send({t:'workspace_cancel',id:work.id});await a.wait(m=>m.t==='workspace_cancel' && m.id===work.id);
  assert.match((await context(a,'read',{},work.id)).error,/no longer active/);
});

test('shared task board routes concurrent owners, links discussion, reviews results, and persists restart',async t=>{
  const f=await fixture(t),alice=await f.person('room','Alice'),bob=await f.person('room','Bob');
  const a=await personalBridge(f,alice),b=await personalBridge(f,bob);
  async function save(person,fields){const requestId=Math.random().toString();person.send({t:'task_save',requestId,...fields});await person.wait(m=>m.t==='task_saved' && m.requestId===requestId);return (await f.inspect()).tasks.find(task=>task.title===fields.title);}
  const fields={title:'Compare options',details:'Deliver a comparison',ownerId:a.ownerId,agentId:a.ownerId,status:'planned',dependencies:[],contextIds:[]};
  alice.send({t:'chat',text:'We need a comparison.'});const message=await alice.wait(m=>m.t==='chat' && m.entry.text==='We need a comparison.');
  let first=await save(alice,{...fields,chatId:message.entry.id});
  let second=await save(alice,{...fields,title:'Draft recommendation',ownerId:b.ownerId,agentId:b.ownerId,dependencies:[first.id]});
  alice.send({t:'task_start',id:second.id,version:second.version});assert.match((await alice.wait(m=>m.t==='task_error')).message,/owner/);
  bob.send({t:'task_start',id:second.id,version:second.version});assert.match((await bob.wait(m=>m.t==='task_error')).message,/prerequisite/);
  second=await save(bob,{...second,dependencies:[]});
  alice.send({t:'task_start',id:first.id,version:first.version});bob.send({t:'task_start',id:second.id,version:second.version});
  const [ar,br]=await Promise.all([a.task(),b.task()]);
  assert.equal(ar.context.task.id,first.id);assert.equal(br.context.task.id,second.id);
  assert.equal((await f.inspect()).tasks.filter(task=>task.status==='working').length,2);
  alice.send({t:'workspace_chat_mode',mode:'mentions'});await alice.wait(m=>m.t==='chat' && m.entry.text.includes('invited their Codex'));
  const connection=(await f.inspect()).connections.find(c=>c.ownerId===a.ownerId);
  bob.send({t:'chat',taskId:first.id,text:'@'+connection.handle+' Explain the comparison.'});
  const discussion=await a.wait(m=>m.t==='workspace_chat');
  assert.ok(discussion.context.tasks.some(task=>task.id===first.id));assert.equal(discussion.context.task.details,fields.details);
  a.send({t:'workspace_chat_result',id:discussion.id,text:'I am comparing the supplied sources.'});
  assert.equal((await bob.wait(m=>m.t==='chat' && m.entry.text==='I am comparing the supplied sources.')).entry.taskId,first.id);
  assert.equal((await upload(f,a,ar,{status:'ready',summary:'Comparison ready',deliverables:[{path:'comparison.md',data:Buffer.from('Compared sources').toString('base64')}]})).status,200);
  first=(await f.inspect()).tasks.find(task=>task.id===first.id);assert.equal(first.status,'needs_review');
  first=await save(bob,{...first,status:'done'});assert.equal(first.status,'done');
  const dependent=await save(alice,{...fields,title:'Use reviewed file',dependencies:[first.id]});
  alice.send({t:'task_start',id:dependent.id,version:dependent.version});const next=await a.task();
  assert.equal(next.context.dependencies[0].runId,ar.id);assert.equal(next.context.dependencies[0].deliverables[0].path,'comparison.md');
  assert.equal((await upload(f,a,next,{status:'ready',summary:'Used reviewed predecessor'})).status,200);
  alice.send({t:'workspace_archive',id:ar.id});await alice.wait(m=>m.t==='chat' && m.entry.text.includes('retained with their task'));
  alice.send({t:'set_access',tier:'view',hostOnlySpend:true});await alice.wait(m=>m.t==='access');
  bob.send({t:'task_save',...second,title:'Forbidden'});assert.match((await bob.wait(m=>m.t==='task_error')).message,/view-only/);
  await pause(1200);const stopped=once(f.proc,'exit');f.proc.kill();await stopped;
  const resumed=await fixture(t,{ROUNDTABLE_DATA:join(f.dataDir,'rooms.json')});
  const state=await resumed.inspect();
  assert.equal(state.tasks.find(task=>task.id===first.id).status,'done');
  assert.equal(state.tasks.find(task=>task.id===second.id).status,'blocked');
  assert.equal(state.tasks.find(task=>task.id===first.id).origin.chatId,message.entry.id);
  assert.equal(await (await fetch(resumed.origin+'/api/rooms/room/work/'+ar.id+'/deliverables/comparison.md')).text(),'Compared sources');
});
