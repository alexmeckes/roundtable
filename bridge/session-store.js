import {mkdir,readFile,writeFile,rename,rm,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';

// Local-only references. Never upload thread IDs or workspace paths to the table.
export class SessionStore {
  static async open(scope,{root=join(process.env.CODEX_HOME || join(homedir(),'.codex'),'roundtable','sessions')}={}){
    const identity={...scope,project:await realpath(scope.project)};
    const name=createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    await mkdir(root,{recursive:true,mode:0o700});
    const store=new SessionStore();store.file=join(root,name+'.json');store.lock=join(root,name+'.lock');store.nonce=randomUUID();store.queue=Promise.resolve();
    for(let attempt=0;;attempt++){
      try{await writeFile(store.lock,JSON.stringify({pid:process.pid,nonce:store.nonce}),{flag:'wx',mode:0o600});break;}
      catch(error){if(error.code!=='EEXIST')throw error;
        let lock;try{lock=JSON.parse(await readFile(store.lock,'utf8'));}catch{throw new Error('Local session lock is unreadable. Inspect '+store.lock);}
        if(!Number.isSafeInteger(lock.pid) || lock.pid<=0)throw new Error('Invalid local session lock. Inspect '+store.lock);
        let alive=true;try{process.kill(lock.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
        if(!alive){await rm(store.lock);continue;}
        if(attempt>=20)throw new Error('Another bridge is using this local table session. Stop it before reconnecting.');
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    }
    try{store.data=JSON.parse(await readFile(store.file,'utf8'));if(store.data.version!==1 || !store.data.conversations || !store.data.runs)throw new Error('Unsupported local session state.');}
    catch(error){if(error.code==='ENOENT')store.data={version:1,conversations:{},runs:{}};else{await store.close();throw error;}}
    return store;
  }
  async update(change){
    const operation=this.queue.then(async()=>{change(this.data);const temp=this.file+'.'+this.nonce+'.tmp';await writeFile(temp,JSON.stringify(this.data),{mode:0o600});await rename(temp,this.file);});
    this.queue=operation.catch(()=>{});return operation;
  }
  conversation(agentId){return this.data.conversations[agentId];}
  saveConversation(agentId,threadId){return this.update(data=>{data.conversations[agentId]=threadId;});}
  checkpoint(id){return this.data.runs[id];}
  saveRun(id,record){return this.update(data=>{data.runs[id]={...data.runs[id],...record};});}
  async close(){await this.queue;try{const lock=JSON.parse(await readFile(this.lock,'utf8'));if(lock.nonce===this.nonce)await rm(this.lock);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
