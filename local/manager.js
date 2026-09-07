import {fork} from 'node:child_process';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {detectCodex,chooseFolder,describeFolder,pickerAvailable,profileRoot,beginLogin,discoverProject} from './runtime.js';
const root=fileURLToPath(new URL('..',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
export class LocalConnections {
  constructor({file,rooms,workspace,detect=detectCodex,pick=chooseFolder,describe=describeFolder,picker=pickerAvailable,project=discoverProject,launch,login=beginLogin,readyTimeout=60000,stopTimeout=40000}={}){
    Object.assign(this,{file,rooms,workspace,detect,pick,describe,picker,project,login,readyTimeout,stopTimeout});
    this.launch=launch || ((args,env)=>fork(resolve(root,'bridge/workspace.js'),args,{cwd:root,env,silent:true,detached:process.platform!=='win32'}));
    this.discoveryAbort=new AbortController();this.records={};this.running=new Map();this.selections=new Map();this.queue=Promise.resolve();this.closing=false;
  }
  key(origin,room,ownerId){return hash(JSON.stringify([origin,room,ownerId,profileRoot()]));}
  async load(){try{const data=JSON.parse(await readFile(this.file,'utf8'));if(data.version!==1 || !data.records || typeof data.records!=='object' || Array.isArray(data.records))throw new Error('Invalid local connection state');this.records=data.records;}catch(e){if(e.code!=='ENOENT')throw new Error('Local connection settings could not be read. Keep the file for recovery and use manual setup.');}}
  save(){const contents=JSON.stringify({version:1,records:this.records});const op=this.queue.then(async()=>{await mkdir(dirname(this.file),{recursive:true,mode:0o700});const temp=this.file+'.tmp';await writeFile(temp,contents,{mode:0o600});await rename(temp,this.file);});this.queue=op.catch(()=>{});return op;}
  async runtime(refresh=false){if(refresh || !this.detecting || Date.now()-this.detectedAt>15000){this.detectedAt=Date.now();this.detecting=this.detect();}return this.detecting;}
  async suggested(runtime){if(!runtime.installed || !runtime.signedIn)return null;this.projectDetection ||= this.project(runtime.command,{signal:this.discoveryAbort.signal});return this.projectDetection;}
  async status(origin,room,member){
    const key=this.key(origin,room.id,member.id),record=this.records[key],run=this.running.get(key),runtime=await this.runtime();
    return {available:true,installed:runtime.installed,signedIn:runtime.signedIn,version:runtime.version,picker:await this.picker(),suggested:await this.suggested(runtime),state:run?.state || 'disconnected',message:run?.message || '',saved:record?{name:record.name,path:record.path,mode:record.mode}:null};
  }
  async select(origin,room,member,{path,mode='auto',signal}={}){
    if(this.picking)throw new Error('A folder picker is already open. Choose or cancel that folder first.');
    let selected=path;
    if(!selected){this.picking=true;try{selected=await this.pick({signal});}finally{this.picking=false;}}
    if(!selected || signal?.aborted)return {cancelled:true};
    const folder=await this.describe(selected,mode),id=randomBytes(24).toString('base64url');
    this.selections.set(id,{...folder,key:this.key(origin,room.id,member.id),expires:Date.now()+300000});
    for(const [token,value] of this.selections)if(value.expires<Date.now())this.selections.delete(token);
    if(this.selections.size>32)this.selections.delete(this.selections.keys().next().value);
    return {selection:id,...folder};
  }
  async start(origin,room,member,{selection,saved=false,project=false,check='',preview='',signal,retryCount=0}={}){
    const key=this.key(origin,room.id,member.id),existing=this.running.get(key);
    if(existing?.state==='connected'){if(selection)throw new Error('Disconnect your Codex before changing its folder.');return {connected:true};}
    if(['starting','reconnecting','stopping'].includes(existing?.state))throw new Error('Your connection is already starting or stopping.');
    if(room.personalBridges.has(member.id))throw new Error('Your Codex is already connected. Disconnect it before changing folders.');
    if(this.closing)throw new Error('Roundtable is shutting down.');
    if([...this.running.values()].filter(r=>['starting','connected','reconnecting','stopping'].includes(r.state)).length>=4)throw new Error('Four local connections are already active. Disconnect one first.');
    let record;
    if(saved){record=this.records[key];if(!record)throw new Error('Choose a folder first.');record={...record,...await this.describe(record.path,record.mode)};check=record.check;preview=record.preview;}
    else if(project){record=await this.suggested(await this.runtime());if(!record)throw new Error('Choose a folder; the launching Codex project is unavailable.');record={...record,...await this.describe(record.path,record.mode)};}
    else {const selected=this.selections.get(selection);if(!selected || selected.key!==key || selected.expires<Date.now())throw new Error('Choose the folder again; its selection expired.');this.selections.delete(selection);record={...selected};}
    for(const value of [check,preview])if(typeof value!=='string' || value.length>2000 || value.includes('\0'))throw new Error('Invalid advanced connection settings.');
    signal?.throwIfAborted();
    const runtime=await this.runtime();if(!runtime.installed)throw new Error('Install Codex, then try connecting again.');if(!runtime.signedIn)throw new Error('Sign in to Codex, then try connecting again.');
    signal?.throwIfAborted();
    // No await between the final ownership check and reserving the launch.
    if(this.closing || ['starting','connected','reconnecting','stopping'].includes(this.running.get(key)?.state) || room.personalBridges.has(member.id))throw new Error('Your connection changed. Try again.');
    if([...this.running.values()].filter(r=>['starting','connected','reconnecting','stopping'].includes(r.state)).length>=4)throw new Error('Four local connections are already active. Disconnect one first.');
    record={origin,room:room.id,ownerId:member.id,profile:profileRoot(),path:record.path,name:record.name,mode:record.mode,check,preview,enabled:false};
    const run={state:'starting',record,stopped:false,retries:retryCount};this.running.set(key,run);
    const token=this.workspace.pair(room,member.id);run.tokenHash=hash(token);
    if(member.chatMode===undefined)member.chatMode='mentions';
    const args=[origin+'/s/'+room.id,'--project',record.path,'--workspace-mode',record.mode,'--codex-bin',runtime.command];
    if(check)args.push('--check',check);if(preview)args.push('--preview-dir',preview);
    try{run.child=this.launch(args,{...process.env,ROUNDTABLE_PAIR_TOKEN:token});}catch{run.state='failed';throw new Error('The local bridge could not start.');}
    run.child.stdout?.resume();run.child.stderr?.resume();
    run.exited=new Promise(resolve=>run.child.once('close',()=>{run.state=run.stopped?'disconnected':'failed';resolve();this.cleanupGroup(run.child);if(!run.stopped && this.records[key]?.enabled && member.bridgeHash===run.tokenHash && !this.closing)this.retry(key,room,member);}));
    run.child.on('error',()=>{run.message='The local bridge could not start. Check Codex and try again.';});
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);run.child.removeListener('exit',exit);run.child.removeListener('error',exit);error?reject(error):resolve({connected:true,name:record.name,mode:record.mode});};
      const fail=async(message)=>{run.message=message;if(this.records[key]){this.records[key].enabled=false;await this.save().catch(()=>{});}await this.stop(key);run.state='failed';finish(new Error(message));};
      const abort=()=>void fail('Connection cancelled.');
      const exit=()=>finish(new Error(run.message || 'Codex could not connect. Check its sign-in and CLI version, then try again.'));
      const timer=setTimeout(()=>void fail('Codex took too long to connect. Check its local configuration and try again.'),this.readyTimeout);
      signal?.addEventListener('abort',abort,{once:true});run.child.once('exit',exit);run.child.once('error',exit);
      run.child.on('message',async message=>{
        if(message?.type==='roundtable-revoked'){run.stopped=true;record.enabled=false;if(this.records[key]){this.records[key].enabled=false;await this.save().catch(()=>{});}return;}
        if(message?.type==='roundtable-offline'){if(run.state==='connected')run.state='reconnecting';return;}
        if(message?.type!=='roundtable-ready' || message.room!==room.id || message.ownerId!==member.id || run.stopped)return;
        run.state='connected';run.message='';record.enabled=true;this.records[key]=record;
        try{await this.save();finish();}catch{void fail('Could not save your local connection settings.');}
      });
      if(signal?.aborted)abort();
    });
  }
  retry(key,room,member){
    const run=this.running.get(key);run.retries=(run.retries || 0)+1;if(run.retries>3){run.message='Reconnect your Codex to try again.';return;}
    const retries=run.retries;run.timer=setTimeout(()=>{if(this.closing || run.stopped || !this.records[key]?.enabled || room.personalBridges.has(member.id))return;this.start(run.record.origin,room,member,{saved:true,retryCount:retries}).catch(()=>{});},2000*retries);run.timer.unref();
  }
  cleanupGroup(child){if(process.platform!=='win32' && child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}}
  async stop(key){
    const run=this.running.get(key);if(!run)return;
    run.stopped=true;clearTimeout(run.timer);if(!run.child || run.child.exitCode!==null){run.state='disconnected';return;}
    run.state='stopping';run.child.kill('SIGTERM');
    const timer=setTimeout(()=>{this.cleanupGroup(run.child);run.child.kill('SIGKILL');},this.stopTimeout);
    try{await run.exited;}finally{clearTimeout(timer);run.state='disconnected';}
  }
  async revoke(roomId,ownerId){
    for(const record of Object.values(this.records))if(record.room===roomId && record.ownerId===ownerId)record.enabled=false;
    const stops=Promise.all([...this.running].filter(([,run])=>run.record.room===roomId && run.record.ownerId===ownerId).map(([key])=>this.stop(key)));
    try{await this.save();}finally{await stops;}
  }
  async restore(port){
    for(const record of Object.values(this.records)){
      if(this.closing)break;
      let url;try{url=new URL(record.origin);}catch{continue;}
      if(!record.enabled || record.profile!==profileRoot() || url.protocol!=='http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || Number(url.port || 80)!==port)continue;
      const room=this.rooms.get(record.room),member=room?.members?.find(m=>m.id===record.ownerId);if(!member)continue;
      await this.start(record.origin,room,member,{saved:true}).catch(()=>{});
    }
  }
  async signIn(){const runtime=await this.runtime();if(!runtime.installed)throw new Error('Install Codex first.');if(runtime.signedIn)return {signedIn:true};if(this.loginProcess)return {signingIn:true};const child=this.login(runtime.command);this.loginProcess=child;const clear=()=>{clearTimeout(timer);this.loginProcess=null;this.detecting=null;};const timer=setTimeout(()=>child.kill(),300000);child.once('exit',clear);child.once('error',clear);return {signingIn:true};}
  async close(){this.closing=true;this.discoveryAbort.abort();this.loginProcess?.kill();await Promise.all([...this.running.keys()].map(key=>this.stop(key)));await this.queue;}
}
