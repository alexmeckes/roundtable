import test from 'node:test';
import assert from 'node:assert/strict';
import {catchupSummary,markSeen} from '../workspace/catchup.js';
test('catchup uses persisted per-member read cursors and rejects future acknowledgements',()=>{
  const room={tasks:[{id:'done',title:'Finished',status:'done',updatedAt:30},{id:'old',updatedAt:10}],sharedContext:{entries:[{id:'decision',kind:'decision',status:'accepted',updatedAt:35}]},chat:[{kind:'human',ts:25},{kind:'agent',ts:40},{kind:'system',ts:42}]},member={lastSeenAt:20};
  const summary=catchupSummary(room,member,50);assert.equal(summary.taskCount,1);assert.equal(summary.contextCount,1);assert.equal(summary.messageCount,2);
  assert.equal(markSeen(member,1000,50),false);assert.equal(member.lastSeenAt,20);
  assert.equal(markSeen(member,50,50),true);assert.equal(catchupSummary(room,member,60).taskCount,0);
  markSeen(member,30,60);assert.equal(member.lastSeenAt,50);
  assert.equal(catchupSummary(room,{},60).messageCount,0);
});
