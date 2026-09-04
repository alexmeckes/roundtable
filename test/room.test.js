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
  async function person(room='room', name='Host', hostKey) {
    const client = await connect();
    client.send({t:'join', room, name, hostKey});
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
  return {connect, person, brain, inspect, seed};
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
