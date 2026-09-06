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
    if (proc.exitCode === null) { const stopped = once(proc, 'exit'); proc.kill(); await stopped; }
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
  return {connect, person, brain, inspect, seed, origin: `http://127.0.0.1:${port}`};
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
