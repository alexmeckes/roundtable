import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTaskInputs,fetchRoomArtifact} from '../bridge/task-inputs.js';
import {createServer} from 'node:http';
const auth={room:'room',token:'a'.repeat(32)};
const dependency={id:'task',title:'Comparison',room:'room',runId:'abcdefgh',deliverables:[{path:'comparison.md',bytes:5},{path:'image.png',bytes:12},{path:'large.txt',bytes:100000}]};
test('prerequisite text is read from paired server with explicit size limits and binary download links',async()=>{
  const calls=[];const context=await loadTaskInputs({dependencies:[dependency]},'http://localhost:3131',{...auth,fetchImpl:async(url,options)=>{calls.push({url,options});return new Response('Atlas');}});
  assert.equal(calls.length,1);assert.equal(calls[0].url,'http://localhost:3131/api/rooms/room/work/abcdefgh/deliverables/comparison.md');assert.equal(calls[0].options.redirect,'error');
  assert.equal(context.dependencies[0].deliverables[0].text,'Atlas');
  assert.equal(calls[0].options.headers.Authorization,'Bearer '+auth.token);assert.ok(!JSON.stringify(context).includes(auth.token));
  assert.match(context.dependencies[0].deliverables[1].note,/Binary/);assert.match(context.dependencies[0].deliverables[2].note,/limit/);
});
test('prerequisite fetch rejects traversal, missing files, oversize responses and cancellation',async()=>{
  const fetchImpl=async()=>new Response('x'.repeat(40000));
  await assert.rejects(loadTaskInputs({dependencies:[{...dependency,room:'../other'}]},'http://localhost',auth),/Invalid/);
  await assert.rejects(loadTaskInputs({dependencies:[{...dependency,deliverables:[{path:'../secret',bytes:5}]}]},'http://localhost',auth),/Invalid/);
  await assert.rejects(loadTaskInputs({dependencies:[dependency]},'http://localhost',{...auth,fetchImpl}),/limit/);
  await assert.rejects(loadTaskInputs({dependencies:[dependency]},'http://localhost',{...auth,fetchImpl:async()=>new Response('',{status:404})}),/unavailable/);
  await assert.rejects(loadTaskInputs({dependencies:[dependency]},'http://localhost',{...auth,signal:AbortSignal.abort()}));
});

test('artifact credentials stay in their room and do not follow redirects',async t=>{
  let leaked=0,authorization;
  const other=createServer((req,res)=>{leaked++;res.end('private');});await new Promise(r=>other.listen(0,'127.0.0.1',r));
  const backend=createServer((req,res)=>{authorization=req.headers.authorization;res.writeHead(302,{location:'http://127.0.0.1:'+other.address().port+'/stolen'});res.end();});await new Promise(r=>backend.listen(0,'127.0.0.1',r));
  t.after(async()=>{await Promise.all([new Promise(r=>backend.close(r)),new Promise(r=>other.close(r))]);});
  const origin='http://127.0.0.1:'+backend.address().port;
  await assert.rejects(fetchRoomArtifact(origin,'/api/rooms/room/work/abcdefgh/patch',auth));
  assert.equal(authorization,'Bearer '+auth.token);assert.equal(leaked,0);
  for(const path of ['https://evil.example/api/rooms/room/work/abcdefgh/patch','//evil.example/api/rooms/room/work/abcdefgh/patch','/api/rooms/other/work/abcdefgh/patch','/api/rooms/room/work/../../other/work/abcdefgh/patch'])assert.throws(()=>fetchRoomArtifact(origin,path,auth),/outside/);
  await assert.rejects(loadTaskInputs({dependencies:[{...dependency,room:'other'}]},origin,auth),/Invalid/);
  assert.throws(()=>fetchRoomArtifact(origin,'/api/rooms/room/work/abcdefgh/patch',{room:'room'}),/Reconnect/);
});
