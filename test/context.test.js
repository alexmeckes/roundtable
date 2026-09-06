import test from 'node:test';
import assert from 'node:assert/strict';
import {saveContext,changeContextStatus,adoptContextSkill,contextSummary,readContext} from '../workspace/context.js';

const human={id:'alice',name:'Alice'},agent={id:'mira',name:'Mira',kind:'agent',ownerName:'Alice'};
const item=(kind='source')=>({kind,title:'Reference',body:'Evidence from a shared source',url:'https://example.com/reference'});

test('context keeps accepted knowledge separate from proposals, preserves history, and survives serialization',()=>{
  const room={chat:[]};const source=saveContext(room,human,item());
  const proposal=saveContext(room,agent,{...item('learning'),refs:[source.id]},{proposal:true});
  assert.deepEqual(proposal.evidence,[{id:source.id,version:1,title:source.title}]);
  assert.equal(contextSummary(room,human.id).items.length,1);
  assert.equal(readContext(room,human.id,{ids:[proposal.id]}).entries.length,0);
  changeContextStatus(room,human,{id:proposal.id,version:1,status:'accepted'});
  assert.equal(readContext(room,human.id,{ids:[proposal.id]}).entries[0].createdBy.name,'Mira');
  assert.equal(proposal.history[0].status,'proposed');
  saveContext(room,human,{...item('learning'),id:proposal.id,version:2,body:'Corrected claim',refs:[source.id]});
  assert.throws(()=>saveContext(room,human,{...item('learning'),id:proposal.id,version:2}),/changed/);
  assert.equal(proposal.body,'Corrected claim');
  changeContextStatus(room,human,{id:source.id,version:1,status:'retired'});
  const restored=JSON.parse(JSON.stringify(room));
  assert.equal(contextSummary(restored,'alice').items.length,1);
  assert.equal(restored.sharedContext.entries[1].history.length,2);
  assert.equal(readContext(restored,'alice',{query:'Corrected'}).entries[0].id,proposal.id);
  assert.equal(restored.sharedContext.entries[1].evidence[0].version,1);
});

test('shared skill adoption belongs to a person and exact version, never installs tools',()=>{
  const room={chat:[]};const skill=saveContext(room,human,{...item('skill'),body:'Cite source dates in every comparison.'});
  assert.equal(contextSummary(room,'alice').items[0].adopted,false);
  adoptContextSkill(room,human,{id:skill.id,version:1,use:true});
  assert.equal(readContext(room,'alice',{ids:[skill.id]}).entries[0].adopted,true);
  assert.equal(readContext(room,'bob',{ids:[skill.id]}).entries[0].adopted,false);
  saveContext(room,human,{...item('skill'),id:skill.id,version:1,body:'New instructions require another opt-in.'});
  assert.equal(contextSummary(room,'alice').items[0].adopted,false);
  assert.throws(()=>adoptContextSkill(room,human,{id:skill.id,version:1,use:true}),/current/);
  adoptContextSkill(room,human,{id:skill.id,version:2,use:true});
  adoptContextSkill(room,human,{id:skill.id,version:2,use:false});
  assert.equal(contextSummary(room,'alice').items[0].adopted,false);
});

test('context validates links, evidence, bounds, and conversation attribution',()=>{
  const room={chat:[{id:'message',kind:'agent',author:'Mira',text:'Actual evidence',ts:1}]};
  const entry=saveContext(room,human,{...item('decision'),chatId:'message'});
  assert.equal(entry.origin.author,'Mira');assert.equal(entry.origin.text,'Actual evidence');
  for(const url of ['javascript:alert(1)','file:///etc/passwd','https://user:password@example.com'])assert.throws(()=>saveContext(room,human,{...item(),url}),/http|link/);
  assert.throws(()=>saveContext(room,human,{...item(),refs:['other-room']}),/this table/);
  assert.throws(()=>saveContext(room,human,{...item(),body:'x'.repeat(6001)}),/too long/);
  saveContext(room,human,item('brief'));
  assert.throws(()=>saveContext(room,human,item('brief')),/existing shared brief/);
  assert.throws(()=>saveContext(room,agent,item('brief'),{proposal:true}),/people maintain/);
  assert.throws(()=>readContext(room,human.id,{ids:Array(9).fill(entry.id)}),/eight/);
});
