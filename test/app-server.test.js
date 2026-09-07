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
