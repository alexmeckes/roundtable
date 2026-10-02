import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionStore} from '../bridge/session-store.js';

test('session references survive restart, isolate owner/table/project, and serialize parallel writes',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rt-sessions-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const scope={origin:'https://table.example',room:'room',ownerId:'alice',project:root,workspaceMode:'folder',projectId:'local-project'};
  let store=await SessionStore.open(scope,{root});
  await Promise.all([store.saveConversation('mira','thread-mira'),store.saveRun('run-one',{cwd:join(root,'output'),agentId:'mira',taskId:'task'})]);
  await store.saveRun('run-one',{threadId:'thread-work'});
  assert.equal((await stat(store.file)).mode & 0o777,0o600);
  await store.close();store=await SessionStore.open(scope,{root});
  assert.equal(store.conversation('mira'),'thread-mira');assert.equal(store.checkpoint('run-one').threadId,'thread-work');assert.equal(store.checkpoint('run-one').agentId,'mira');
  for(const different of [{ownerId:'bob'},{room:'other'},{origin:'https://other.example'},{workspaceMode:'git'},{projectId:'another-project'}]){
    const other=await SessionStore.open({...scope,...different},{root});assert.equal(other.conversation('mira'),undefined);await other.close();
  }
  await store.close();await writeFile(store.lock,JSON.stringify({pid:2147483647,nonce:'dead'}));
  const recovered=await SessionStore.open(scope,{root});assert.equal(recovered.conversation('mira'),'thread-mira');await recovered.close();
});

test('ChatGPT registrations keep private conversations separate from Codex login and other accounts',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rt-auth-sessions-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const scope={origin:'https://table.example',room:'room',ownerId:'alice',project:root,workspaceMode:'folder',projectId:'local-project'};
  const plan={...scope,authMode:'chatgpt-plan',authClientId:'oaiapp_alice',authSubject:'alice-account'};
  const store=await SessionStore.open(plan,{root});await store.saveConversation('mira','private-alice-thread');await store.close();
  for(const otherScope of [scope,{...plan,authClientId:'oaiapp_alice-other-workspace'},{...plan,authSubject:'bob-account'}]){
    const other=await SessionStore.open(otherScope,{root});assert.equal(other.conversation('mira'),undefined);await other.close();
  }
  const resumed=await SessionStore.open(plan,{root});assert.equal(resumed.conversation('mira'),'private-alice-thread');await resumed.close();
});
