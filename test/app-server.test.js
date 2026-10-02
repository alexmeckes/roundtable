import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexAppServer,codexAccountScope} from '../bridge/app-server.js';
import {SessionStore} from '../bridge/session-store.js';

test('Codex login scopes saved sessions to the authenticated account and rejects switching before a turn',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'roundtable-account-scope-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const account={type:'chatgpt',email:'Alice@example.com',planType:'pro'},alice=codexAccountScope(account),bob=codexAccountScope({...account,email:'bob@example.com'});
  assert.equal(alice,codexAccountScope({...account,email:' alice@EXAMPLE.com ',planType:'plus'}));assert.notEqual(alice,bob);assert.ok(!alice.includes('Alice'));
  assert.throws(()=>codexAccountScope({...account,email:null}),/identify/);
  const scope={origin:'https://room.example',room:'room',ownerId:'room-owner',project:dir,workspaceMode:'folder',authMode:'codex',authSubject:alice};
  let store=await SessionStore.open(scope,{root:dir});await store.saveConversation('primary','alice-thread');await store.close();
  store=await SessionStore.open({...scope,authSubject:bob},{root:dir});assert.equal(store.conversation('primary'),undefined);await store.close();
  store=await SessionStore.open(scope,{root:dir});assert.equal(store.conversation('primary'),'alice-thread');await store.close();
  const server=Object.create(CodexAppServer.prototype),calls=[];let signedIn=account;
  server.rpc=async(method)=>{calls.push(method);assert.equal(method,'account/read');return {account:signedIn};};
  assert.equal(await server.useChatGPTAccount(),alice);signedIn={...account,email:'bob@example.com'};
  await assert.rejects(server.run({cwd:dir,job:{},sessionId:'alice-thread'}),/account changed/);assert.deepEqual(calls,['account/read','account/read']);
});

test('the local runtime receives its OAuth token without inheriting room pairing credentials',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'roundtable-runtime-env-')),fixture=join(dir,'server.cjs'),log=join(dir,'env.json');
  await writeFile(fixture,`
    const {createInterface}=require('node:readline'),{writeFileSync}=require('node:fs');
    createInterface({input:process.stdin}).on('line',line=>{
      const msg=JSON.parse(line);
      if(msg.method==='initialize'){
        writeFileSync(process.argv[2],JSON.stringify({accessToken:process.env.ACCESS_TOKEN,pairToken:process.env.ROUNDTABLE_PAIR_TOKEN,bridgeSecret:process.env.ROUNDTABLE_BRIDGE_SECRET,clientInfo:msg.params.clientInfo}));
        process.stdout.write(JSON.stringify({id:msg.id,result:{}})+'\\n');
      }
    });
  `);
  const server=new CodexAppServer({command:process.execPath,args:[fixture,log],env:{ACCESS_TOKEN:'test-access-token',ROUNDTABLE_PAIR_TOKEN:'test-pair-token',ROUNDTABLE_BRIDGE_SECRET:'test-room-secret'}});
  t.after(async()=>{server.close();await rm(dir,{recursive:true,force:true});});
  await server.initialize();const result=JSON.parse(await readFile(log,'utf8'));
  assert.equal(result.accessToken,'test-access-token');assert.equal(result.pairToken,undefined);assert.equal(result.bridgeSecret,undefined);
  assert.equal(result.clientInfo.name,'roundtable-workspace');assert.equal(result.clientInfo.title,'Roundtable');
});

test('cancellation waits for its delayed turn ID and stops background terminals without cancelling a sibling turn',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'roundtable-app-server-'));
  const fixture=join(dir,'server.cjs'),log=join(dir,'interrupt.json');
  await writeFile(fixture,`
    const {createInterface}=require('node:readline');
    const {writeFileSync}=require('node:fs');
    let background;
    const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
    createInterface({input:process.stdin}).on('line',line=>{
      const msg=JSON.parse(line),p=msg.params || {};
      const reply=result=>send({id:msg.id,result});
      if(msg.method==='initialize')reply({});
      if(msg.method==='thread/start')reply({thread:{id:p.cwd}});
      if(msg.method==='turn/start'){
        const turn={id:'turn-'+p.threadId,status:'completed'};
        if(p.threadId==='cancel'){
          background=setTimeout(()=>writeFileSync(process.argv[2]+'.finished','continued after cancellation'),250);
          send({method:'item/started',params:{threadId:p.threadId,item:{type:'commandExecution'}}});
          setTimeout(()=>reply({turn}),80);
        }else{
          reply({turn});
          send({method:'item/completed',params:{threadId:p.threadId,item:{type:'agentMessage',text:'Finished '+p.threadId}}});
          send({method:'turn/completed',params:{threadId:p.threadId,turn}});
        }
      }
      if(msg.method==='turn/interrupt'){
        writeFileSync(process.argv[2],JSON.stringify(p));reply({});
      }
      if(msg.method==='thread/backgroundTerminals/clean'){
        if(p.threadId==='cancel')clearTimeout(background);
        setTimeout(()=>{writeFileSync(process.argv[2]+'.cleaned',JSON.stringify(p));reply({});},30);
      }
    });
  `);
  const server=new CodexAppServer({command:process.execPath,args:[fixture,log]});
  t.after(async()=>{server.close();await rm(dir,{recursive:true,force:true});});
  await server.initialize();
  const controller=new AbortController();
  const cancelled=server.run({cwd:'cancel',job:{instructions:'Cancelled task'},signal:controller.signal,progress:()=>controller.abort()});
  const success=server.run({cwd:'other',job:{instructions:'Independent task'}});
  await assert.rejects(cancelled,/Stopped by owner/);
  assert.equal(await success,'Finished other');
  assert.deepEqual(JSON.parse(await readFile(log+'.cleaned','utf8')),{threadId:'cancel'});
  let interrupt;
  for(let i=0;i<100;i++){
    try{interrupt=JSON.parse(await readFile(log,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,10));}
  }
  assert.deepEqual(interrupt,{threadId:'cancel',turnId:'turn-cancel'});
  await new Promise(r=>setTimeout(r,250));
  await assert.rejects(access(log+'.finished'));
});

test('conversation preserves its thread and enforces read-only on every turn',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'roundtable-conversation-')),fixture=join(dir,'server.cjs'),log=join(dir,'calls.jsonl');
  await writeFile(fixture,`
    const {createInterface}=require('node:readline'),{appendFileSync}=require('node:fs');
    const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
    createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);appendFileSync(process.argv[2],line+'\\n');
      if(m.method==='initialize')send({id:m.id,result:{}});
      if(m.method==='config/read')send({id:m.id,result:{config:{mcp_servers:{inherited:{enabled:true}}}}});
      if(m.method==='thread/unsubscribe')send({id:m.id,result:{}});
      if(['thread/start','thread/resume'].includes(m.method))send({id:m.id,result:{thread:{id:'discussion'},sandbox:{type:'readOnly'}}});
      if(m.method==='turn/start'){
        send({id:m.id,result:{turn:{id:'turn'}}});
        send({method:'item/completed',params:{threadId:'discussion',item:{type:'agentMessage',text:'A useful reply'}}});
        send({method:'turn/completed',params:{threadId:'discussion',turn:{status:'completed'}}});
      }
    });
  `);
  const server=new CodexAppServer({command:process.execPath,args:[fixture,log]});
  t.after(async()=>{server.close();await rm(dir,{recursive:true,force:true});});
  await server.initialize();let sessionId;
  const params={cwd:dir,conversation:true,job:{agentName:'Alice',handle:'alice-codex',trigger:'Discuss dash'},onThread:id=>{sessionId=id;}};
  assert.equal(await server.run(params),'A useful reply');
  assert.equal(await server.run({...params,sessionId}),'A useful reply');
  const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
  const starts=calls.filter(m=>m.method==='thread/start');assert.equal(starts.length,1);assert.equal(starts[0].params.sandbox,'read-only');
  assert.equal(calls.filter(m=>m.method==='config/read').length,2);
  assert.equal(calls.filter(m=>m.method==='thread/resume').length,1);
  assert.equal(calls.filter(m=>m.method==='thread/unsubscribe').length,1);
  const turns=calls.filter(m=>m.method==='turn/start');assert.equal(turns.length,2);
  for(const turn of turns){assert.equal(turn.params.threadId,'discussion');assert.equal(turn.params.sandboxPolicy.type,'readOnly');assert.match(turn.params.input[0].text,/Conversation is read-only/);}
});

test('dynamic context calls route only supported tools to the active turn',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'roundtable-context-tools-')),fixture=join(dir,'server.cjs'),log=join(dir,'result.json');
  await writeFile(fixture,`
    const {createInterface}=require('node:readline'),{writeFileSync}=require('node:fs');
    const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');let start,denied,accepted;
    createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);
      if(m.method==='initialize')send({id:m.id,result:{}});
      if(m.method==='config/read')send({id:m.id,result:{config:{}}});
      if(m.method==='thread/start'){start=m.params;send({id:m.id,result:{thread:{id:'context'},sandbox:{type:'readOnly'}}});}
      if(m.method==='turn/start'){
        send({id:m.id,result:{turn:{id:'turn'}}});
        send({id:700,method:'item/tool/call',params:{threadId:'context',tool:'unapproved_tool',arguments:{}}});
      }
      if(m.id===700 && m.result){denied=m.result;send({id:701,method:'item/tool/call',params:{threadId:'context',tool:'roundtable_context_read',arguments:{ids:['source']}}});}
      if(m.id===701 && m.result){accepted=m.result;send({id:702,method:'item/tool/call',params:{threadId:'context',tool:'roundtable_history_read',arguments:{query:'Atlas',limit:10}}});}
      if(m.id===702 && m.result){
        writeFileSync(process.argv[2],JSON.stringify({start,denied,allowed:accepted,history:m.result}));
        send({method:'item/completed',params:{threadId:'context',item:{type:'agentMessage',text:'Read the shared source'}}});
        send({method:'turn/completed',params:{threadId:'context',turn:{status:'completed'}}});
      }
    });
  `);
  const server=new CodexAppServer({command:process.execPath,args:[fixture,log]});
  t.after(async()=>{server.close();await rm(dir,{recursive:true,force:true});});
  await server.initialize();const calls=[];
  assert.equal(await server.run({cwd:dir,conversation:true,job:{agentName:'Mira',handle:'mira',trigger:'Read source'},contextTool:async(name,args)=>{calls.push({name,args});return {entries:[{title:'Shared source'}]};}}),'Read the shared source');
  const result=JSON.parse(await readFile(log,'utf8'));
  assert.equal(result.denied.success,false);assert.equal(result.allowed.success,true);assert.equal(result.history.success,true);
  assert.deepEqual(calls,[{name:'roundtable_context_read',args:{ids:['source']}},{name:'roundtable_history_read',args:{query:'Atlas',limit:10}}]);
  assert.deepEqual(result.start.dynamicTools.map(t=>t.name),['roundtable_context_read','roundtable_history_read','roundtable_context_propose']);
});

test('a new app-server process resumes the saved thread before starting a read-only turn',async()=>{
  const server=Object.create(CodexAppServer.prototype);server.loadedThreads=new Set();server.turns=new Map();
  const calls=[];let persisted=false;
  server.rpc=async(method,params)=>{
    calls.push({method,params});
    if(method==='config/read')return {config:{mcp_servers:{inherited:{enabled:true}}}};
    if(method==='thread/resume')return {thread:{id:'saved-thread'},sandbox:{type:'readOnly'}};
    if(method==='turn/start'){
      assert.equal(persisted,true);queueMicrotask(()=>server.turns.get(params.threadId).resolve('Remembered'));
      return {turn:{id:'continued-turn'}};
    }
    throw new Error('Unexpected call: '+method);
  };
  const result=await server.run({cwd:'/original/project',conversation:true,sessionId:'saved-thread',job:{agentName:'Mira',trigger:'Continue'},onThread:async()=>{await Promise.resolve();persisted=true;}});
  assert.equal(result,'Remembered');assert.deepEqual(calls.map(c=>c.method),['config/read','thread/resume','turn/start']);
  assert.equal(calls[1].params.sandbox,'read-only');assert.equal(calls[1].params.approvalPolicy,'never');assert.equal(calls[2].params.sandboxPolicy.type,'readOnly');
  assert.equal(calls[1].params.config.mcp_servers.inherited.enabled,false);
});

test('missing saved threads fail without silently replacing the conversation',async()=>{
  const server=Object.create(CodexAppServer.prototype);server.loadedThreads=new Set();const calls=[];
  server.turns=new Map();server.rpc=async(method)=>{calls.push(method);if(method==='config/read')return {config:{}};throw new Error('Saved thread not found');};
  await assert.rejects(server.run({cwd:'/original/project',conversation:true,sessionId:'missing',job:{}}),/not found/);
  assert.deepEqual(calls,['config/read','thread/resume']);
});

test('conversation isolation disables inherited actions and a new MCP server on resume while assigned tasks retain tools',async()=>{
  const server=Object.create(CodexAppServer.prototype);server.loadedThreads=new Set();server.turns=new Map();
  const inheritedActions=['apps','plugins','shell_tool','unified_exec','hooks','multi_agent'];
  const inherited=()=>({
    ...Object.fromEntries(inheritedActions.map(name=>['features.'+name,true])),'agents.enabled':true,
    mcp_servers:{'legacy.tools':{enabled:true},...(replies?{newlyConnected:{enabled:true}}:{})},
  });
  let replies=0,unsafeExecutions=0;const calls=[],effectiveThreads=new Map(),subscribed=new Set();
  server.rpc=async(method,params)=>{
    calls.push({method,params});
    if(method==='config/read'){
      // A settings reload can add a server to an already loaded conversation.
      if(replies)for(const effective of effectiveThreads.values())effective.mcp_servers.newlyConnected={enabled:true};
      return {config:inherited()};
    }
    if(method==='thread/unsubscribe'){subscribed.delete(params.threadId);return {};}
    if(['thread/start','thread/resume'].includes(method)){
      // Match app-server: resume overrides are ignored while subscribed.
      if(method==='thread/resume' && subscribed.has(params.threadId))return {thread:{id:params.threadId},sandbox:{type:'readOnly'}};
      const base=inherited(),overrides=params.config || {};
      const effective={...base,...overrides,mcp_servers:Object.fromEntries(Object.entries(base.mcp_servers).map(([name,value])=>[name,{...value,...overrides.mcp_servers?.[name]}]))};
      const id=params.threadId || 'thread-'+effectiveThreads.size;
      effectiveThreads.set(id,effective);subscribed.add(id);
      return {thread:{id},sandbox:{type:params.sandbox==='read-only'?'readOnly':'workspaceWrite'}};
    }
    if(method==='turn/start'){
      const effective=effectiveThreads.get(params.threadId);
      const unsafe=effective['agents.enabled']!==false || inheritedActions.some(name=>effective['features.'+name]!==false) || Object.values(effective.mcp_servers).some(server=>server.enabled!==false);
      if(unsafe)unsafeExecutions++;
      replies++;queueMicrotask(()=>server.turns.get(params.threadId).resolve(unsafe?'Task tools available':'Room context only'));
      return {turn:{id:'turn-'+replies}};
    }
    throw new Error('Unexpected call: '+method);
  };
  let sessionId;const conversation={cwd:'/project',conversation:true,job:{trigger:'Discuss'},onThread:id=>{sessionId=id;},contextTool:async()=>({entries:[]})};
  assert.equal(await server.run(conversation),'Room context only');
  assert.equal(await server.run({...conversation,sessionId}),'Room context only');
  assert.equal(unsafeExecutions,0);
  assert.equal(effectiveThreads.get(sessionId).mcp_servers.newlyConnected.enabled,false);
  const resume=calls.find(c=>c.method==='thread/resume');
  assert.ok(calls.findIndex(c=>c.method==='thread/unsubscribe')<calls.findIndex(c=>c.method==='thread/resume'));
  assert.deepEqual(resume.params.dynamicTools.map(tool=>tool.name),['roundtable_context_read','roundtable_history_read','roundtable_context_propose']);
  assert.equal(await server.run({cwd:'/project',job:{instructions:'Owner-assigned task'}}),'Task tools available');
  assert.equal(unsafeExecutions,1);
  const taskStart=calls.filter(c=>c.method==='thread/start').at(-1);
  assert.equal(taskStart.params.config,undefined);assert.equal(taskStart.params.sandbox,'workspace-write');
});

test('conversation fails before starting when effective configuration cannot be inspected',async()=>{
  for(const response of [new Error('Unknown method'),{}, {config:{mcp_servers:[]}}]){
    const server=Object.create(CodexAppServer.prototype),calls=[];server.loadedThreads=new Set();server.turns=new Map();
    server.rpc=async method=>{calls.push(method);if(response instanceof Error)throw response;return response;};
    await assert.rejects(server.run({cwd:'/project',conversation:true,job:{}}),/isolate room replies|MCP configuration/);
    assert.deepEqual(calls,['config/read']);
  }
});

test('conversation refuses a wider effective sandbox without beginning a turn',async()=>{
  const server=Object.create(CodexAppServer.prototype),calls=[];server.loadedThreads=new Set();server.turns=new Map();
  server.rpc=async method=>{calls.push(method);return method==='config/read'?{config:{}}:{thread:{id:'unsafe'},sandbox:{type:'workspaceWrite'}};};
  await assert.rejects(server.run({cwd:'/project',conversation:true,job:{}}),/did not apply read-only/);
  assert.deepEqual(calls,['config/read','thread/start']);
});

test('resume refuses a saved thread that is still running elsewhere',async()=>{
  const server=Object.create(CodexAppServer.prototype);server.loadedThreads=new Set();
  const calls=[];server.rpc=async method=>{calls.push(method);return {thread:{id:'saved',status:{type:'active',activeFlags:[]}}};};
  await assert.rejects(server.run({cwd:'/project',sessionId:'saved',job:{}}),/still active/);
  assert.deepEqual(calls,['thread/resume']);
});
