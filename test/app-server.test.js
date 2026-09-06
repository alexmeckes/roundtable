import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexAppServer} from '../bridge/app-server.js';

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
      if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'discussion'}}});
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
  const turns=calls.filter(m=>m.method==='turn/start');assert.equal(turns.length,2);
  for(const turn of turns){assert.equal(turn.params.threadId,'discussion');assert.equal(turn.params.sandboxPolicy.type,'readOnly');assert.match(turn.params.input[0].text,/Conversation is read-only/);}
});

test('dynamic context calls route only supported tools to the active turn',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'roundtable-context-tools-')),fixture=join(dir,'server.cjs'),log=join(dir,'result.json');
  await writeFile(fixture,`
    const {createInterface}=require('node:readline'),{writeFileSync}=require('node:fs');
    const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');let start,denied;
    createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);
      if(m.method==='initialize')send({id:m.id,result:{}});
      if(m.method==='thread/start'){start=m.params;send({id:m.id,result:{thread:{id:'context'}}});}
      if(m.method==='turn/start'){
        send({id:m.id,result:{turn:{id:'turn'}}});
        send({id:700,method:'item/tool/call',params:{threadId:'context',tool:'unapproved_tool',arguments:{}}});
      }
      if(m.id===700 && m.result){denied=m.result;send({id:701,method:'item/tool/call',params:{threadId:'context',tool:'roundtable_context_read',arguments:{ids:['source']}}});}
      if(m.id===701 && m.result){
        writeFileSync(process.argv[2],JSON.stringify({start,denied,allowed:m.result}));
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
  assert.equal(result.denied.success,false);assert.equal(result.allowed.success,true);
  assert.deepEqual(calls,[{name:'roundtable_context_read',args:{ids:['source']}}]);
  assert.deepEqual(result.start.dynamicTools.map(t=>t.name),['roundtable_context_read','roundtable_context_propose']);
});
