import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTaskInputs} from '../bridge/task-inputs.js';
const dependency={id:'task',title:'Comparison',room:'room',runId:'abcdefgh',deliverables:[{path:'comparison.md',bytes:5},{path:'image.png',bytes:12},{path:'large.txt',bytes:100000}]};
test('prerequisite text is read from paired server with explicit size limits and binary download links',async()=>{
  const calls=[];const context=await loadTaskInputs({dependencies:[dependency]},'http://localhost:3131',{fetchImpl:async(url,options)=>{calls.push({url,options});return new Response('Atlas');}});
  assert.equal(calls.length,1);assert.equal(calls[0].url,'http://localhost:3131/api/rooms/room/work/abcdefgh/deliverables/comparison.md');assert.equal(calls[0].options.redirect,'error');
  assert.equal(context.dependencies[0].deliverables[0].text,'Atlas');
  assert.match(context.dependencies[0].deliverables[1].note,/Binary/);assert.match(context.dependencies[0].deliverables[2].note,/limit/);
});
test('prerequisite fetch rejects traversal, missing files, oversize responses and cancellation',async()=>{
  const fetchImpl=async()=>new Response('x'.repeat(40000));
  await assert.rejects(loadTaskInputs({dependencies:[{...dependency,room:'../other'}]},'http://localhost'),/Invalid/);
  await assert.rejects(loadTaskInputs({dependencies:[{...dependency,deliverables:[{path:'../secret',bytes:5}]}]},'http://localhost'),/Invalid/);
  await assert.rejects(loadTaskInputs({dependencies:[dependency]},'http://localhost',{fetchImpl}),/limit/);
  await assert.rejects(loadTaskInputs({dependencies:[dependency]},'http://localhost',{fetchImpl:async()=>new Response('',{status:404})}),/unavailable/);
  await assert.rejects(loadTaskInputs({dependencies:[dependency]},'http://localhost',{signal:AbortSignal.abort()}));
});
