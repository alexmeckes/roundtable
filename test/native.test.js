import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mkdtemp,rm,readFile,stat,mkdir,readdir} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNativeParticipation} from '../workspace/native.js';
import {saveContext,changeContextStatus} from '../workspace/context.js';
import {saveTask,syncTaskRun} from '../workspace/tasks.js';

function makeRoom(id='table-one'){
  return {id,title:'Native participation',problem:'Compare the supplied options',access:'edit',
    members:[{id:'alice',name:'Alice',agentHandle:'alice-codex'},{id:'bob',name:'Bob',agentHandle:'bob-codex'}],
    specialists:[],tasks:[],work:[],chat:[],sharedContext:{revision:0,entries:[],adoptions:{}}};
}
const alice={id:'alice',name:'Alice',isHost:true},bob={id:'bob',name:'Bob',isHost:false};
const taskFields={title:'Compare options',details:'Use the accepted evidence',dependencies:[],contextIds:[]};

async function fixture(t,{room=makeRoom(),pair=true,onRequest=null,onHumanMessage,onChatMode,conversationAgents,clock=Date.now}={}){
  const artifactRoot=await mkdtemp(join(tmpdir(),'rt-native-'));t.after(()=>rm(artifactRoot,{recursive:true,force:true}));
  const rooms=new Map([[room.id,room],['table-two',makeRoom('table-two')]]),events=[];let persisted=0;
  const options={rooms,artifactRoot,onHumanMessage,onChatMode,conversationAgents,now:clock,persist:()=>{persisted++;},broadcast:(target,message)=>events.push({room:target.id,message}),canSpeak:(target,you)=>target.access!=='view' || Boolean(you.isHost),say:(target,message)=>{target.chat.push({...message,id:message.id || 'chat-'+target.chat.length,ts:clock()});}};
  const native=createNativeParticipation(options);native.initialize(room);native.initialize(rooms.get('table-two'));
  const app=express();native.mount(app);
  if(onRequest){
    // Observe actual successful authorization before the real JSON parser runs.
    // A data listener would itself start the stream flowing and race that parser.
    const route=app._router.stack.find(layer=>layer.route?.path==='/api/rooms/:room/native/:action');
    assert.ok(route,'Native API route must be mounted');
    const authorization=route.route.stack[0].handle;
    route.route.stack[0].handle=(request,response,next)=>authorization(request,response,()=>{onRequest(request);next();});
  }
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.close();server.closeAllConnections();});
  const origin='http://127.0.0.1:'+server.address().port;
  async function call(action,body={},token=credentials?.token,{roomId=room.id,headers={}}={}){
    const response=await fetch(origin+'/api/rooms/'+encodeURIComponent(roomId)+'/native/'+action,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...headers},body:JSON.stringify(body)});
    let data;try{data=await response.json();}catch{data=null;}return {status:response.status,data};
  }
  const credentials=pair?await native.pair(room,alice):null;
  const trusted=(person=alice,{source='sites',human=true,credentialHash='sites-credential-'+person.id,current=()=>true}={})=>async(action,body={})=>{
    try{return {status:200,data:await native.operation(room,room.members.find(member=>member.id===person.id),action,body,{source,human,credentialHash,actor:person,isCurrent:current})};}
    catch(error){return {status:error.status || 400,data:{error:error.message}};}
  };
  return {room,rooms,native,options,credentials,call,trusted,artifactRoot,events,origin,get persisted(){return persisted;}};
}
async function ok(call,action,body={},token){const result=await call(action,body,token);assert.ok(result.status>=200 && result.status<300,action+' should succeed, received '+result.status+': '+JSON.stringify(result.data));return result.data;}
async function rejected(call,action,body={},token,options){const result=await call(action,body,token,options);assert.ok(result.status>=400,action+' should reject the request');return result;}
const secretFree=(value,secrets)=>{const text=JSON.stringify(value);for(const secret of secrets)assert.ok(!text.includes(secret),'Public response leaked a private native credential');for(const key of ['nativeHash','runTokenHash','keyHash'])assert.ok(!text.includes('"'+key+'"'),'Public response leaked private '+key);};

test('pairing scopes bearer credentials to a member and room; snapshots omit private state',async t=>{
  const f=await fixture(t);assert.deepEqual(f.credentials.member,{id:'alice',name:'Alice'});assert.ok(f.credentials.token);assert.ok(f.persisted>0);
  const stored=f.room.members.find(member=>member.id==='alice');assert.notEqual(stored.nativeHash,f.credentials.token);assert.ok(stored.nativeHash);
  const source=saveContext(f.room,alice,{kind:'source',title:'Accepted source',body:'Atlas exports CSV.'});const proposed=saveContext(f.room,{id:'agent',name:'Agent',kind:'agent'},{kind:'learning',title:'Pending idea',body:'Needs checking.'},{proposal:true});
  f.room.work.push({id:'private-work',ownerId:'alice',status:'ready',runToken:'private-work-secret'});
  for(let i=0;i<300;i++)f.room.chat.push({id:'chat-'+i,kind:'human',author:'Alice',text:'Message '+i,ts:i});
  const snapshot=await ok(f.call,'snapshot');assert.equal(snapshot.room.id,f.room.id);assert.deepEqual(snapshot.member,{id:'alice',name:'Alice',isHost:true});assert.ok(snapshot.people.some(person=>person.id==='bob'));assert.ok(snapshot.chat.length<300);assert.equal(snapshot.chat.at(-1).text,'Message 299');
  secretFree(snapshot,[f.credentials.token,stored.nativeHash,'private-work-secret']);assert.ok(!JSON.stringify(snapshot.context).includes(proposed.id));assert.ok(JSON.stringify(snapshot.context).includes(source.id));
  assert.equal((await f.call('snapshot',{},null)).status,403);assert.equal((await f.call('snapshot',{},'forged')).status,403);assert.equal((await f.call('snapshot',{},f.credentials.token,{roomId:'table-two'})).status,403);
  assert.equal((await f.call('snapshot',{},f.credentials.token,{headers:{Origin:'https://attacker.example'}})).status,403);
});

test('native messages and context proposals use authenticated attribution and require human acceptance',async t=>{
  const f=await fixture(t);await ok(f.call,'publish',{text:'I can compare the supplied options.'});assert.equal(f.room.chat.at(-1).text,'I can compare the supplied options.');
  for(const body of [{text:'forged',ownerId:'bob'},{text:'forged',author:'Bob'},{text:'forged',memberId:'bob'},{text:'forged',isHost:true}])await rejected(f.call,'publish',body);
  const source=saveContext(f.room,alice,{kind:'source',title:'Supplied source',body:'Atlas supports exports.'});
  const result=await ok(f.call,'context_propose',{kind:'learning',title:'Export requirement',body:'Exports matter for this comparison.',sources:[source.id]});assert.equal(result.status,'proposed');
  const entry=f.room.sharedContext.entries.find(item=>item.id===result.id);assert.equal(entry.status,'proposed');assert.notEqual(entry.createdBy.id,'bob');assert.equal((await ok(f.call,'context_read',{ids:[entry.id]})).entries.length,0);
  await rejected(f.call,'context_propose',{kind:'decision',title:'Self accepted',body:'Skip review.',status:'accepted'});await rejected(f.call,'context_status',{id:entry.id,version:entry.version,status:'accepted'});assert.equal(entry.status,'proposed');
  changeContextStatus(f.room,alice,{id:entry.id,version:entry.version,status:'accepted'});assert.equal((await ok(f.call,'context_read',{ids:[entry.id]})).entries[0].status,'accepted');
  await rejected(f.call,'context_propose',{kind:'brief',title:'Replace brief',body:'Agent authored brief.'});await rejected(f.call,'publish',{text:'x'.repeat(6001)});await rejected(f.call,'context_read',{ids:Array(9).fill(source.id)});
});

test('native human chat binds attribution and permits bridge requests separately from model contributions',async t=>{
  const requests=[],agents=[{id:'alice',ownerId:'alice',ownerName:'Alice',name:"Alice's Codex",handle:'alice-codex',mode:'mentions',connected:true,ready:true,busy:false,available:true}];
  const f=await fixture(t,{onHumanMessage:(room,you,text)=>requests.push({room:room.id,you,text}),conversationAgents:()=>agents});
  const snapshot=await ok(f.call,'snapshot');assert.deepEqual(snapshot.conversation,{canSend:true,canRequestBridge:true,canSetOwnMode:false,agents});
  const result=await ok(f.call,'chat_send',{text:'  @alice-codex What should we compare?  '});
  assert.equal(result.sent,true);assert.equal(f.room.chat.at(-1).kind,'human');assert.equal(f.room.chat.at(-1).author,'Alice');
  assert.equal(f.room.chat.at(-1).ownerId,'alice');assert.equal(result.message.text,'@alice-codex What should we compare?');
  assert.deepEqual(requests,[{room:f.room.id,you:alice,text:'@alice-codex What should we compare?'}]);
  await ok(f.call,'chat_send',{text:'@alice-codex This question is for my native AI.',requestReply:false});
  assert.equal(f.room.chat.at(-1).kind,'human');assert.equal(f.room.chat.at(-1).author,'Alice');assert.equal(requests.length,1);
  await ok(f.call,'publish',{text:'@alice-codex Here is my model contribution.'});assert.equal(f.room.chat.at(-1).kind,'agent');assert.equal(requests.length,1);
  for(const body of [{text:'Forged human',author:'Bob'},{text:'Forged owner',ownerId:'bob'},{text:'Change bridge mode',mode:'auto'},{text:'Invalid reply flag',requestReply:'false'},{text:'x'.repeat(6001)}])await rejected(f.call,'chat_send',body);
  assert.equal(requests.length,1);
  const guest=await f.native.pair(f.room,bob);f.room.access='view';
  const readOnly=await ok(f.call,'snapshot',{},guest.token);assert.equal(readOnly.conversation.canSend,false);assert.equal(readOnly.conversation.canRequestBridge,false);
  assert.equal((await f.call('chat_send',{text:'@alice-codex Run for me'},guest.token)).status,403);assert.equal(requests.length,1);
});

test('native reply mode stays owner-bound and a view-only member can still pause',async t=>{
  const changes=[];
  const f=await fixture(t,{onChatMode:(room,you,mode)=>changes.push({ownerId:you.id,mode}),conversationAgents:()=>[{ownerId:'bob',connected:true,available:false}]});
  const guest=await f.native.pair(f.room,bob);
  await ok(f.call,'chat_mode',{mode:'mentions'},guest.token);assert.deepEqual(changes,[{ownerId:'bob',mode:'mentions'}]);
  await rejected(f.call,'chat_mode',{mode:'auto',ownerId:'alice'},guest.token);await rejected(f.call,'chat_mode',{mode:'unexpected'},guest.token);
  f.room.access='view';assert.equal((await f.call('chat_mode',{mode:'auto'},guest.token)).status,403);
  const paused=await ok(f.call,'chat_mode',{mode:'off'},guest.token);assert.equal(paused.conversation.canSetOwnMode,true);
  assert.deepEqual(changes,[{ownerId:'bob',mode:'mentions'},{ownerId:'bob',mode:'off'}]);
});

test('task ownership, versions and completed dependencies gate claims; submission requires human review',async t=>{
  const f=await fixture(t),bobCredentials=await f.native.pair(f.room,bob);
  const first=(await ok(f.call,'task_save',taskFields)).task;assert.equal(first.ownerId,'alice');assert.equal(first.status,'planned');
  await rejected(f.call,'task_save',{...taskFields,ownerId:'bob'});await rejected(f.call,'task_save',{...taskFields,status:'done'});await rejected(f.call,'task_claim',{id:first.id,version:first.version},bobCredentials.token);await rejected(f.call,'task_claim',{id:first.id,version:0});
  const dependant=(await ok(f.call,'task_save',{...taskFields,title:'Write recommendation',dependencies:[first.id]})).task;await rejected(f.call,'task_claim',{id:dependant.id,version:dependant.version});
  const claim=await ok(f.call,'task_claim',{id:first.id,version:first.version});assert.equal(claim.task.status,'working');assert.ok(claim.run.id);assert.ok(claim.runToken);
  secretFree((await ok(f.call,'snapshot')),[claim.runToken]);secretFree(f.events.map(event=>event.message),[claim.runToken]);
  const submission={id:claim.run.id,runToken:claim.runToken,summary:'Atlas meets the export requirement.',deliverables:[{path:'comparison.md',content:'# Comparison\nAtlas supports exports.\n'}]};
  await rejected(f.call,'task_submit',{...submission,runToken:'forged'});await rejected(f.call,'task_submit',submission,bobCredentials.token);
  const submitted=await ok(f.call,'task_submit',submission);assert.equal(submitted.task.status,'needs_review');assert.notEqual(submitted.task.status,'done');assert.equal(f.room.tasks.find(task=>task.id===first.id).status,'needs_review');
  await rejected(f.call,'task_submit',submission);await rejected(f.call,'task_claim',{id:dependant.id,version:dependant.version});
  const reviewed=f.room.tasks.find(task=>task.id===first.id);saveTask(f.room,alice,{...reviewed,status:'done'});const secondClaim=await ok(f.call,'task_claim',{id:dependant.id,version:dependant.version});assert.equal(secondClaim.task.status,'working');
});

test('artifact traversal and size limits reject submissions without completing or writing outside the run',async t=>{
  const f=await fixture(t);const task=(await ok(f.call,'task_save',taskFields)).task,claim=await ok(f.call,'task_claim',{id:task.id,version:task.version});
  const base={id:claim.run.id,runToken:claim.runToken,summary:'Draft result.'};
  for(const path of ['../../escape.md','/tmp/escape.md','folder/../escape.md','folder\\escape.md','result.html'])await rejected(f.call,'task_submit',{...base,deliverables:[{path,content:'unsafe'}]});
  await rejected(f.call,'task_submit',{...base,deliverables:[{path:'large.txt',content:'x'.repeat(256*1024+1)}]});await rejected(f.call,'task_submit',{...base,deliverables:Array.from({length:21},(_,index)=>({path:index+'.txt',content:'x'}))});
  await rejected(f.call,'task_submit',{...base,deliverables:Array.from({length:9},(_,index)=>({path:index+'.txt',content:'x'.repeat(256*1024)}))});
  assert.equal(f.room.tasks.find(item=>item.id===task.id).status,'working');await assert.rejects(stat(join(f.artifactRoot,'escape.md')),error=>error.code==='ENOENT');
  const accepted=await ok(f.call,'task_submit',{...base,deliverables:[{path:'notes/brief.md',content:'# Result\n'}]});assert.equal(accepted.task.status,'needs_review');assert.equal(await readFile(join(f.artifactRoot,f.room.id,claim.run.id,'deliverables','notes','brief.md'),'utf8'),'# Result\n');
});

test('human cancellation during artifact staging rejects a late native submission and removes staged output',async t=>{
  const f=await fixture(t);const task=(await ok(f.call,'task_save',taskFields)).task,claim=await ok(f.call,'task_claim',{id:task.id,version:task.version});
  const parent=join(f.artifactRoot,f.room.id);await mkdir(parent,{recursive:true});
  let finished=false;
  // Read actual directory state between asynchronous writes. macOS fs.watch
  // coalesces events and may report creation only after the upload has finished.
  const staged=(async()=>{
    while(!finished){
      if((await readdir(parent)).some(name=>name.startsWith('.native-'+claim.run.id+'-'))){
        const work=f.room.work.find(item=>item.id===claim.run.id);assert.equal(work.status,'running');
        work.status='interrupted';work.message='Cancelled by the task owner.';syncTaskRun(f.room,work);return;
      }
      await new Promise(resolve=>setImmediate(resolve));
    }
    throw new Error('Submission finished without an observable staging directory.');
  })();
  const pending=f.call('task_submit',{id:claim.run.id,runToken:claim.runToken,summary:'Result completed after cancellation.',deliverables:Array.from({length:20},(_,index)=>({path:'selected/'+index+'.txt',content:'x'.repeat(32*1024)}))}).finally(()=>{finished=true;});
  await Promise.race([staged,pending.then(response=>{throw new Error('Submission finished before staging was observed: '+response.status);})]);
  const response=await pending;assert.ok(response.status>=400);assert.equal(f.room.work.find(work=>work.id===claim.run.id).status,'interrupted');assert.equal(f.room.tasks.find(item=>item.id===task.id).status,'blocked');
  await assert.rejects(stat(join(parent,claim.run.id)),error=>error.code==='ENOENT');assert.deepEqual(await readdir(parent),[]);
});

test('revocation rejects late submissions and persisted pairing survives a server restart',async t=>{
  const f=await fixture(t);const task=(await ok(f.call,'task_save',taskFields)).task,claim=await ok(f.call,'task_claim',{id:task.id,version:task.version});
  const restored=JSON.parse(JSON.stringify(f.room)),second=await fixture(t,{room:restored,pair:false});assert.equal((await second.call('snapshot',{},f.credentials.token)).status,200);
  assert.equal(restored.work.find(work=>work.id===claim.run.id).status,'interrupted');assert.equal(restored.tasks.find(item=>item.id===task.id).status,'blocked');await rejected(second.call,'task_submit',{id:claim.run.id,runToken:claim.runToken,summary:'Pre-restart run'},f.credentials.token);
  await f.native.revoke(f.room,alice);assert.equal((await f.call('snapshot')).status,403);await rejected(f.call,'task_submit',{id:claim.run.id,runToken:claim.runToken,summary:'Late result'});assert.notEqual(f.room.tasks.find(item=>item.id===task.id).status,'needs_review');
  const replacement=await f.native.pair(f.room,alice);assert.notEqual(replacement.token,f.credentials.token);await rejected(f.call,'task_submit',{id:claim.run.id,runToken:claim.runToken,summary:'Old run with new credential'},replacement.token);
});

test('credential rotation while JSON is streaming rejects the previously admitted request',async t=>{
  let markAdmitted;const admitted=new Promise(resolve=>{markAdmitted=resolve;});
  const f=await fixture(t,{onRequest:request=>{if(request.native)markAdmitted(request.native.credentialHash);}});
  let finishRequest;const response=new Promise((resolve,reject)=>{
    const request=httpRequest(f.origin+'/api/rooms/'+f.room.id+'/native/publish',{method:'POST',headers:{authorization:'Bearer '+f.credentials.token,'content-type':'application/json'}},result=>{let body='';result.on('data',data=>{body+=data;});result.on('end',()=>resolve({status:result.statusCode,body}));});
    request.on('error',reject);t.after(()=>request.destroy());request.write('{"text":');finishRequest=()=>request.end('"A contribution from the revoked connection."}');
  });response.catch(()=>{});
  const admittedHash=await Promise.race([admitted,response.then(value=>{throw new Error('Native request replied before admission: '+value.status+' '+value.body);})]);
  assert.equal(admittedHash,f.room.members.find(member=>member.id==='alice').nativeHash);
  const replacement=await f.native.pair(f.room,alice);assert.notEqual(replacement.token,f.credentials.token);finishRequest();
  assert.equal((await response).status,403);assert.equal(f.room.chat.length,0);assert.equal(f.room.tasks.length,0);
  assert.equal((await f.call('publish',{text:'The replacement connection is active.'},replacement.token)).status,200);
});

test('view-only mode rejects member mutations and cannot be bypassed by forged host fields',async t=>{
  const f=await fixture(t),bobCredentials=await f.native.pair(f.room,bob);f.room.access='view';
  assert.equal((await f.call('snapshot',{},bobCredentials.token)).status,200);
  for(const [action,body] of [['publish',{text:'Write attempt'}],['context_propose',{kind:'learning',title:'Write',body:'Write attempt'}],['task_save',taskFields]])assert.equal((await f.call(action,body,bobCredentials.token)).status,403);
  await rejected(f.call,'publish',{text:'Forged host',isHost:true},bobCredentials.token);assert.equal((await f.call('publish',{text:'Trusted host still participates.'})).status,200);
});

test('shared AI requests are human-initiated, owner-bound and idempotent across tool retries',async t=>{
  let time=1000;const f=await fixture(t,{clock:()=>time});
  const human=f.trusted(),model=f.trusted(alice,{human:false}),other=f.trusted(bob),differentSource=f.trusted(alice,{source:'native'}),rotated=f.trusted(alice,{credentialHash:'replacement'});
  const input={text:'  Compare these options.  ',requestId:'reply-one'};
  assert.equal((await model('chat_request',input)).status,403);
  assert.equal((await f.call('chat_request',input)).status,403);
  const created=await ok(human,'chat_request',input);assert.equal(created.request.status,'requested');assert.equal(created.request.ownerId,'alice');assert.equal(created.request.text,'Compare these options.');assert.equal(created.message.kind,'human');assert.equal(created.message.author,'Alice');
  assert.equal(f.room.chat.length,1);assert.equal(created.request.messageId,created.message.id);assert.equal(created.request.expiresAt,301000);
  const again=await ok(human,'chat_request',input);assert.equal(again.request.messageId,created.request.messageId);assert.equal(f.room.chat.length,1);
  assert.equal((await human('chat_request',{...input,text:'A different request.'})).status,409);
  for(const call of [other,differentSource,rotated])assert.equal((await call('chat_request',input)).status,403);
  for(const call of [other,differentSource,rotated])assert.equal((await call('reply_start',{id:'reply-one'})).status,403);
  assert.equal((await model('reply_cancel',{id:'reply-one'})).status,403);
  const before=await ok(other,'snapshot');assert.equal(before.replyRequests[0].status,'requested');assert.equal(before.member.isHost,false);
  // Admitting another reader in this running service must not look like restart.
  f.native.initialize(f.room);assert.equal((await ok(human,'snapshot')).replyRequests[0].status,'requested');
  time+=100;const started=await ok(model,'reply_start',{id:'reply-one'});assert.equal(started.request.status,'replying');assert.equal(started.request.updatedAt,1100);
  time+=100;assert.equal((await ok(model,'reply_start',{id:'reply-one'})).request.updatedAt,1100);
  const published=await ok(model,'publish',{text:'Atlas meets the supplied requirements.',replyId:'reply-one'});
  assert.equal(published.request.status,'done');assert.equal(published.message.author,'Alice’s AI');assert.equal(published.message.ownerId,'alice');assert.equal(published.request.publishedMessageId,published.message.id);assert.equal(f.room.chat.length,2);
  assert.equal((await ok(model,'publish',{text:published.message.text,replyId:'reply-one'})).message.id,published.message.id);assert.equal(f.room.chat.length,2);
  assert.equal((await model('publish',{text:'Changed completed answer.',replyId:'reply-one'})).status,409);
  assert.equal((await other('publish',{text:published.message.text,replyId:'reply-one'})).status,403);
  assert.equal((await model('reply_start',{id:'reply-one'})).status,409);
  await ok(model,'publish',{text:'A separate authorized contribution.'});assert.equal(f.room.chat.length,3);
  const snapshot=await ok(human,'snapshot');secretFree(snapshot,['sites-credential-alice','sites-credential-bob']);
  for(const record of [...snapshot.replyRequests,...f.events.flatMap(event=>event.message.replyRequests || [])]){
    assert.equal(record.source,undefined);assert.equal(record.credentialHash,undefined);assert.equal(record.publishedText,undefined);
  }
  assert.ok(f.events.some(event=>event.message.replyRequests?.some(request=>request.status==='replying')));assert.ok(f.persisted>0);
  for(const body of [{...input,requestId:'../bad'},{...input,requestId:'x'.repeat(81)},{...input,ownerId:'bob'}])await rejected(human,'chat_request',body);
});

test('cancelled requests can retry without reposting; expiry and service restart never leave false thinking',async t=>{
  let time=5000;const f=await fixture(t,{clock:()=>time}),human=f.trusted(),model=f.trusted(alice,{human:false});
  const first=await ok(human,'chat_request',{text:'First question',requestId:'first'});
  await ok(model,'reply_start',{id:'first'});const cancelled=await ok(human,'reply_cancel',{id:'first'});assert.equal(cancelled.request.status,'failed');
  assert.equal((await model('publish',{text:'A late result',replyId:'first'})).status,409);
  time+=100;const retried=await ok(human,'chat_request',{text:'First question',requestId:'first'});assert.equal(retried.request.status,'requested');assert.equal(retried.request.messageId,first.request.messageId);assert.equal(f.room.chat.length,1);assert.equal(retried.request.failure,undefined);
  time=retried.request.expiresAt;const expired=await ok(human,'snapshot');assert.equal(expired.replyRequests[0].status,'expired');assert.equal((await model('reply_start',{id:'first'})).status,409);
  assert.equal((await model('publish',{text:'Expired answer',replyId:'first'})).status,409);
  const afterExpiry=await ok(human,'chat_request',{text:'First question',requestId:'first'});assert.equal(afterExpiry.request.status,'requested');assert.equal(afterExpiry.request.messageId,first.request.messageId);assert.equal(f.room.chat.length,1);
  time=afterExpiry.request.expiresAt;assert.equal((await ok(human,'snapshot')).replyRequests[0].status,'expired');
  await ok(human,'chat_request',{text:'Question before restart',requestId:'second'});await ok(model,'reply_start',{id:'second'});
  const saved=JSON.parse(JSON.stringify(f.room)),restored=await fixture(t,{room:saved,pair:false,clock:()=>time}),newHuman=restored.trusted();
  const after=await ok(newHuman,'snapshot');assert.equal(after.replyRequests.find(request=>request.id==='first').status,'expired');assert.equal(after.replyRequests.find(request=>request.id==='second').status,'failed');
  assert.match(after.replyRequests.find(request=>request.id==='second').failure,/restarted/);
  const restarted=await ok(newHuman,'chat_request',{text:'Question before restart',requestId:'second'});assert.equal(restarted.request.status,'requested');assert.equal(saved.chat.length,2);
});

test('rotating a native connection fails only its own replies; task expiry does not cancel a fresh conversation',async t=>{
  let time=1000;const f=await fixture(t,{clock:()=>time}),aliceMember=f.room.members.find(member=>member.id==='alice');
  const nativeHuman=f.trusted(alice,{source:'native',credentialHash:aliceMember.nativeHash}),other=f.trusted(bob);
  await ok(nativeHuman,'chat_request',{text:'Alice question',requestId:'alice-native'});await ok(other,'chat_request',{text:'Bob question',requestId:'bob-sites'});
  const replacement=await f.native.pair(f.room,alice);const after=await ok(f.call,'snapshot',{},replacement.token);
  assert.equal(after.replyRequests.find(request=>request.id==='alice-native').status,'failed');assert.equal(after.replyRequests.find(request=>request.id==='bob-sites').status,'requested');
  assert.equal((await f.call('reply_start',{id:'alice-native'},replacement.token)).status,403);
  const human=f.trusted(),model=f.trusted(alice,{human:false}),task=(await ok(model,'task_save',taskFields)).task,claim=await ok(model,'task_claim',{id:task.id,version:task.version});
  time+=30*60_000;
  await ok(human,'chat_request',{text:'Fresh question after task expiry',requestId:'fresh-sites'});
  assert.equal((await model('task_submit',{id:claim.run.id,runToken:claim.runToken,summary:'Expired work'})).status,409);
  assert.equal((await ok(human,'snapshot')).replyRequests.find(request=>request.id==='fresh-sites').status,'requested');
});

test('pending replies and retained records are bounded, and view-only owners can only cancel existing replies',async t=>{
  const f=await fixture(t),human=f.trusted(),model=f.trusted(alice,{human:false});
  for(const id of ['one','two'])await ok(human,'chat_request',{text:id,requestId:id});
  assert.equal((await human('chat_request',{text:'three',requestId:'three'})).status,409);assert.equal(f.room.chat.length,2);
  await ok(human,'reply_cancel',{id:'one'});await ok(human,'chat_request',{text:'three',requestId:'three'});
  for(const id of ['two','three'])await ok(model,'publish',{text:'Answered '+id,replyId:id});
  for(let index=0;index<40;index++){
    await ok(human,'chat_request',{text:'Question '+index,requestId:'bounded-'+index});
    await ok(model,'publish',{text:'Answer '+index,replyId:'bounded-'+index});
  }
  assert.equal(f.room.replyRequests.length,32);assert.equal((await human('reply_start',{id:'one'})).status,404);
  const other=f.trusted(bob);await ok(other,'chat_request',{text:'Bob question',requestId:'bob-pending'});f.room.access='view';
  assert.equal((await other('chat_request',{text:'Forbidden',requestId:'forbidden'})).status,403);
  assert.equal((await other('reply_start',{id:'bob-pending'})).status,403);assert.equal((await other('snapshot')).status,200);
  assert.equal((await other('reply_cancel',{id:'bounded-39'})).status,403);
  assert.equal((await ok(other,'reply_cancel',{id:'bob-pending'})).request.status,'failed');
  assert.equal((await f.trusted(bob,{human:false})('reply_cancel',{id:'bob-pending'})).status,403);
});

test('view-only task owners can stop a native run but cannot accept, reopen, start or publish work',async t=>{
  const f=await fixture(t),human=f.trusted(bob),model=f.trusted(bob,{human:false}),task=(await ok(model,'task_save',taskFields)).task;
  const claim=await ok(model,'task_claim',{id:task.id,version:task.version});f.room.access='view';
  assert.equal((await model('task_review',{id:task.id,version:task.version,decision:'stop'})).status,403);
  assert.equal((await human('task_review',{id:task.id,version:task.version,decision:'done'})).status,403);
  assert.equal((await human('task_review',{id:task.id,version:task.version,decision:'reopen'})).status,403);
  const stopped=await ok(human,'task_review',{id:task.id,version:task.version,decision:'stop'});assert.equal(stopped.stoppedRunId,claim.run.id);assert.equal(stopped.task.status,'blocked');
  assert.equal((await model('task_submit',{id:claim.run.id,runToken:claim.runToken,summary:'Late stopped work'})).status,403);
  assert.equal((await model('task_claim',{id:task.id,version:task.version})).status,403);
  assert.equal((await model('publish',{text:'Write while view-only'})).status,403);
  assert.equal((await human('task_review',{id:task.id,version:task.version,decision:'reopen'})).status,403);
});

test('human task review validates versions and ownership, revokes stopped capabilities, and preserves prerequisites',async t=>{
  const f=await fixture(t),owner=f.trusted(),model=f.trusted(alice,{human:false}),other=f.trusted(bob),otherModel=f.trusted(bob,{human:false});
  const task=(await ok(model,'task_save',taskFields)).task;
  assert.equal((await owner('task_review',{id:task.id,version:task.version,decision:'done'})).status,409);
  const claim=await ok(model,'task_claim',{id:task.id,version:task.version});assert.equal(claim.run.agentName,'Alice’s AI');
  const current=()=>f.room.tasks.find(item=>item.id===task.id);
  assert.equal((await model('task_review',{id:task.id,version:current().version,decision:'stop'})).status,403);
  assert.equal((await other('task_review',{id:task.id,version:current().version,decision:'stop'})).status,403);
  await rejected(owner,'task_review',{id:task.id,version:1,decision:'stop'});assert.equal(current().status,'working');
  const stopped=await ok(owner,'task_review',{id:task.id,version:current().version,decision:'stop'});assert.equal(stopped.stoppedRunId,claim.run.id);assert.equal(stopped.task.status,'blocked');
  assert.equal((await model('task_submit',{id:claim.run.id,runToken:claim.runToken,summary:'A late result'})).status,403);
  const reopened=await ok(owner,'task_review',{id:task.id,version:current().version,decision:'reopen'});assert.equal(reopened.task.status,'planned');
  const secondClaim=await ok(model,'task_claim',{id:task.id,version:current().version});
  const result=await ok(model,'task_submit',{id:secondClaim.run.id,runToken:secondClaim.runToken,summary:'Ready for a person.'});assert.equal(result.task.status,'needs_review');assert.equal(f.room.chat.at(-1).author,'Alice’s AI');
  assert.equal((await model('task_review',{id:task.id,version:current().version,decision:'done'})).status,403);
  assert.equal((await other('task_review',{id:task.id,version:current().version,decision:'done'})).status,403);
  const done=await ok(owner,'task_review',{id:task.id,version:current().version,decision:'done'});assert.equal(done.task.status,'done');
  const dependant=(await ok(model,'task_save',{...taskFields,title:'Dependent work',dependencies:[task.id]})).task;
  const dependentClaim=await ok(model,'task_claim',{id:dependant.id,version:dependant.version});
  await rejected(owner,'task_review',{id:task.id,version:current().version,decision:'reopen'});assert.equal(current().status,'done');
  await ok(owner,'task_review',{id:dependant.id,version:f.room.tasks.find(item=>item.id===dependant.id).version,decision:'stop'});
  // A host may review another person's task, but must use that task's current version.
  const bobTask=(await ok(otherModel,'task_save',{...taskFields,title:'Bob work'})).task;
  const bobClaim=await ok(otherModel,'task_claim',{id:bobTask.id,version:bobTask.version});
  const bobStopped=await ok(owner,'task_review',{id:bobTask.id,version:f.room.tasks.find(item=>item.id===bobTask.id).version,decision:'stop'});assert.equal(bobStopped.stoppedRunId,bobClaim.run.id);
  assert.equal((await otherModel('task_submit',{id:bobClaim.run.id,runToken:bobClaim.runToken,summary:'Late Bob work'})).status,403);
  const bridgeTask=saveTask(f.room,alice,{...taskFields,title:'Bridge work',ownerId:'alice',agentId:'alice'}),bridgeWork={id:'bridge-run',taskId:bridgeTask.id,status:'running',execution:'bridge',ownerId:'alice'};
  bridgeTask.runIds.push(bridgeWork.id);f.room.work.push(bridgeWork);syncTaskRun(f.room,bridgeWork);
  assert.equal((await owner('task_review',{id:bridgeTask.id,version:bridgeTask.version,decision:'stop'})).status,409);assert.equal(bridgeWork.status,'running');
  assert.equal((await f.call('task_review',{id:task.id,version:current().version,decision:'reopen'})).status,403);
  await rejected(owner,'task_review',{id:task.id,version:current().version,decision:'done',isHost:true});
  assert.equal(f.room.work.find(work=>work.id===dependentClaim.run.id).status,'interrupted');
});
