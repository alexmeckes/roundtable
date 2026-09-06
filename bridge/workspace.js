#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import {FolderProject} from './folder.js';
import { WorktreeProject } from './worktree.js';
import { CodexAppServer } from './app-server.js';

const args=process.argv.slice(2);
function option(name,fallback='') {const i=args.indexOf(name);if(i<0)return fallback;const value=args[i+1];if(!value || value.startsWith('--'))throw new Error(name+' requires a value');args.splice(i,2);return value;}
const workspaceMode=option('--workspace-mode','git');
if(!['git','folder'].includes(workspaceMode))throw new Error('Workspace mode must be git or folder.');
const codexBin=option('--codex-bin','codex');
const codexProjectId=option('--codex-project-id');
const projectPath=option('--project'),check=option('--check'),preview=option('--preview-dir'),approachFile=option('--approach-file'),model=option('--model',null),effort=option('--effort',null);
const url=new URL(args[0] || 'http://invalid');
const room=url.pathname.match(/^\/s\/([A-Za-z0-9_-]{1,80})\/?$/)?.[1];
const token=process.env.ROUNDTABLE_PAIR_TOKEN;
if(!room || !projectPath || !token || !['http:','https:'].includes(url.protocol)) {
  console.error('Usage: ROUNDTABLE_PAIR_TOKEN=<from Connect my Codex> node bridge/workspace.js <room-url> --project /path/to/work [--workspace-mode folder|git] [--codex-project-id id] [--check "validation command"] [--preview-dir dist] [--approach-file path] [--model model] [--effort effort] [--codex-bin path]');process.exit(1);
}
const approach=approachFile?(await readFile(approachFile,'utf8')).slice(0,8000):'';
const codex=new CodexAppServer({cwd:projectPath,command:codexBin});
const Project=workspaceMode==='folder'?FolderProject:WorktreeProject;
const project=new Project(projectPath,{check,preview,execute:params=>codex.run({...params,approach,model,effort})});
const projectName=await project.initialize(); await codex.initialize();
try {
  const threadProject=await codex.useProject({cwd:project.project,projectId:codexProjectId});
  console.log('Local Codex project: '+threadProject.name+' ('+threadProject.id+')');
}catch(error){codex.close();throw error;}
const jobs=new Map(),chatJobs=new Map();let ws,stopping=false;const chatThreads=new Map();
let runStart=Date.now(),runs=0;
async function post(job,result) {
  const response=await fetch(url.origin+'/api/rooms/'+room+'/work/'+job.id+'/result',{method:'POST',headers:{Authorization:'Bearer '+token,'X-Run-Token':job.runToken,'Content-Type':'application/json'},body:JSON.stringify(result),signal:AbortSignal.timeout(30_000)});
  if(!response.ok)throw new Error('Could not publish result ('+response.status+'): '+await response.text());
}
function connect(){
  ws=new WebSocket(url.origin.replace(/^http/,'ws'));
  ws.on('open',()=>ws.send(JSON.stringify({t:'workspace_bridge_join',room,token,project:projectName,workspaceMode,approach:approach?'Custom approach + local Codex configuration':'Local Codex configuration'})));
  ws.on('message',async raw=>{
    let msg;try{msg=JSON.parse(raw);}catch{return;}
    if(!msg || msg.room!==room)return;
    if(msg.t==='workspace_connected'){console.log('Your Codex is connected to '+url.origin+'/s/'+room+' for '+projectName);return;}
    if(msg.t==='workspace_cancel'){jobs.get(msg.id)?.abort();return;}
    if(msg.t==='workspace_chat_cancel'){chatJobs.get(msg.id)?.abort();return;}
    if(msg.t==='workspace_chat'){
      const connection=ws;
      const reply=result=>{if(connection.readyState===1)connection.send(JSON.stringify({t:'workspace_chat_result',room,id:msg.id,...result}));};
      if(Date.now()-runStart>3600_000){runStart=Date.now();runs=0;}
      if(chatJobs.size>=5 || runs>=Number(process.env.ROUNDTABLE_BRIDGE_RUNS || 60)){reply({error:'Conversation busy or hourly budget exhausted.'});return;}
      runs++;const controller=new AbortController();chatJobs.set(msg.id,controller);
      try{
        const text=await codex.run({cwd:project.project,job:msg,signal:controller.signal,approach,model,effort,conversation:true,sessionId:chatThreads.get(msg.agentId || 'primary'),onThread:id=>{chatThreads.set(msg.agentId || 'primary',id);}});
        if(!controller.signal.aborted)reply({text});
      }catch(error){if(!controller.signal.aborted)reply({error:error.message});}
      finally{chatJobs.delete(msg.id);}return;
    }
    if(!['workspace_task','workspace_integrate'].includes(msg.t) || jobs.has(msg.id))return;
    if(Date.now()-runStart>3600_000){runStart=Date.now();runs=0;}
    if(jobs.size>=2 || runs>=Number(process.env.ROUNDTABLE_BRIDGE_RUNS || 60)) {
      await post(msg,{status:'failed',message:'Your bridge concurrency or hourly run budget is exhausted.'}).catch(console.error);return;
    }
    runs++;const controller=new AbortController();jobs.set(msg.id,controller);
    const connection=ws;
    let lastProgress=0;
    const progress=message=>{if(Date.now()-lastProgress<1000)return;lastProgress=Date.now();if(connection.readyState===1)connection.send(JSON.stringify({t:'workspace_progress',room,id:msg.id,message}));};
    try {
      let result;
      if(msg.t==='workspace_integrate') {
        if(!/^[A-Za-z0-9_-]{8,80}$/.test(msg.sourceId))throw new Error('Invalid contribution ID');
        const response=await fetch(url.origin+'/api/rooms/'+room+'/work/'+msg.sourceId+'/patch',{signal:controller.signal});
        if(!response.ok)throw new Error('Contribution patch is unavailable');
        const patch=await response.text();if(Buffer.byteLength(patch)>1024*1024)throw new Error('Patch too large');
        result=await project.integrate(msg,patch,{signal:controller.signal,progress});
      } else result=await project.run(msg,{signal:controller.signal,progress});
      // The room has already revoked this run's upload capability on Stop.
      // Cleanup still completes locally; publishing again only produces a 403.
      if(controller.signal.aborted){console.log(msg.id+': '+result.status+' '+result.message);return;}
      await post(msg,result);
      console.log(msg.id+': '+result.status+' '+(result.branch || ''));
    } catch(error) {
      console.error(msg.id+': '+error.message);
      await post(msg,{status:'failed',message:error.message}).catch(()=>{});
    } finally {jobs.delete(msg.id);}
  });
  ws.on('error',error=>console.error(error.message));
  ws.on('close',code=>{
    for(const controller of jobs.values())controller.abort();
    for(const controller of chatJobs.values())controller.abort();
    if(code===1008){console.error('Connection revoked or pairing invalid. Generate a new connection command in the room.');stop();return;}
    if(!stopping)setTimeout(connect,3000);
  });
}
function stop(){if(stopping)return;stopping=true;for(const c of [...jobs.values(),...chatJobs.values()])c.abort();ws?.close();codex.close();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
connect();
