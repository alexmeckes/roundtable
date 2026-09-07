#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import WebSocket from 'ws';
import {SessionStore} from './session-store.js';
import {loadTaskInputs} from './task-inputs.js';
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
process.on('exit',()=>codex.close());
const Project=workspaceMode==='folder'?FolderProject:WorktreeProject;
const project=new Project(projectPath,{check,preview,execute:params=>codex.run({...params,sessionId:params.job.localResume?.threadId,approach,model,effort,onThread:async threadId=>{await sessions.saveRun(params.job.id,{threadId});publishSessions();},contextTool:(name,args)=>requestContext(params.job,name,args,params.signal)})});
const projectName=await project.initialize(); await codex.initialize();
try {
  const threadProject=await codex.useProject({cwd:project.project,projectId:codexProjectId});
  console.log('Local Codex project: '+threadProject.name+' ('+threadProject.id+')');
}catch(error){codex.close();throw error;}
const notify=message=>{if(process.connected)process.send(message,()=>{});};
const jobs=new Map(),chatJobs=new Map();let ws,stopping=false;let sessions,sessionOwner,sessionReady=Promise.resolve();
codex.process.once('exit',()=>{if(!stopping){console.error('Codex runtime exited. Reconnect to restore saved sessions.');stop();}});
const contextRequests=new Map();
function requestContext(job,name,args,signal){
  signal?.throwIfAborted();
  if(ws?.readyState!==1)return Promise.reject(new Error('The table is disconnected.'));
  const requestId=randomBytes(12).toString('base64url');
  return new Promise((resolve,reject)=>{
    const finish=(error,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);contextRequests.delete(requestId);error?reject(error):resolve(value);};
    const abort=()=>finish(new Error('Stopped by owner'));
    const timer=setTimeout(()=>finish(new Error('Shared context request timed out.')),20_000);
    contextRequests.set(requestId,finish);signal?.addEventListener('abort',abort,{once:true});
    ws.send(JSON.stringify({t:'workspace_context_request',room,id:job.id,requestId,action:name==='roundtable_context_read'?'read':'propose',args}));
  });
}
let runStart=Date.now(),runs=0;
async function post(job,result) {
  const response=await fetch(url.origin+'/api/rooms/'+room+'/work/'+job.id+'/result',{method:'POST',headers:{Authorization:'Bearer '+token,'X-Run-Token':job.runToken,'Content-Type':'application/json'},body:JSON.stringify(result),signal:AbortSignal.timeout(30_000)});
  if(!response.ok)throw new Error('Could not publish result ('+response.status+'): '+await response.text());
}
function publishSessions(){if(sessions && ws?.readyState===1)ws.send(JSON.stringify({t:'workspace_ready',room,savedConversations:Object.keys(sessions.data.conversations),resumableRuns:Object.keys(sessions.data.runs)}));}
function connect(){
  ws=new WebSocket(url.origin.replace(/^http/,'ws'));
  ws.on('open',()=>ws.send(JSON.stringify({t:'workspace_bridge_join',room,token,project:projectName,workspaceMode,supportsContinuity:true,approach:approach?'Custom approach + local Codex configuration':'Local Codex configuration'})));
  ws.on('message',async raw=>{
    let msg;try{msg=JSON.parse(raw);}catch{return;}
    if(!msg || msg.room!==room)return;
    if(msg.t==='workspace_context_result'){contextRequests.get(msg.requestId)?.(msg.error?new Error(msg.error):null,msg.result);return;}
    if(msg.t==='workspace_connected'){
      sessionReady=(async()=>{
        if(sessionOwner && sessionOwner!==msg.ownerId)throw new Error('Table owner changed; restart this bridge.');
        sessionOwner=msg.ownerId;
        sessions ||= await SessionStore.open({origin:url.origin,room,ownerId:msg.ownerId,project:project.project,workspaceMode,projectId:codex.projectId});
        if(stopping){await sessions.close();return;}
        publishSessions();notify({type:'roundtable-ready',room,ownerId:msg.ownerId});console.log('Your Codex is connected to '+url.origin+'/s/'+room+' for '+projectName+'. Saved conversations: '+Object.keys(sessions.data.conversations).length);
      })();
      try{await sessionReady;}catch(error){console.error(error.message);stop();}return;
    }
    if(msg.t==='workspace_cancel'){jobs.get(msg.id)?.abort();return;}
    if(msg.t==='workspace_chat_cancel'){chatJobs.get(msg.id)?.abort();return;}
    if(msg.t==='workspace_chat'){
      const connection=ws;
      const reply=result=>{if(connection.readyState===1)connection.send(JSON.stringify({t:'workspace_chat_result',room,id:msg.id,...result}));};
      if(Date.now()-runStart>3600_000){runStart=Date.now();runs=0;}
      if(chatJobs.size>=5 || runs>=Number(process.env.ROUNDTABLE_BRIDGE_RUNS || 60)){reply({error:'Conversation busy or hourly budget exhausted.'});return;}
      runs++;const controller=new AbortController();controller.finished=new Promise(resolve=>{controller.finish=resolve;});chatJobs.set(msg.id,controller);
      try{
        await sessionReady;
        const text=await codex.run({cwd:project.project,job:msg,signal:controller.signal,approach,model,effort,conversation:true,sessionId:sessions.conversation(msg.agentId || 'primary'),onThread:async id=>{await sessions.saveConversation(msg.agentId || 'primary',id);publishSessions();},contextTool:(name,args)=>requestContext(msg,name,args,controller.signal)});
        if(!controller.signal.aborted)reply({text});
      }catch(error){if(!controller.signal.aborted)reply({error:error.message});}
      finally{chatJobs.delete(msg.id);controller.finish();}return;
    }
    if(!['workspace_task','workspace_integrate'].includes(msg.t) || jobs.has(msg.id))return;
    if(Date.now()-runStart>3600_000){runStart=Date.now();runs=0;}
    if(jobs.size>=2 || runs>=Number(process.env.ROUNDTABLE_BRIDGE_RUNS || 60)) {
      await post(msg,{status:'failed',message:'Your bridge concurrency or hourly run budget is exhausted.'}).catch(console.error);return;
    }
    runs++;const controller=new AbortController();controller.finished=new Promise(resolve=>{controller.finish=resolve;});jobs.set(msg.id,controller);
    const connection=ws;
    let lastProgress=0;
    const progress=message=>{if(Date.now()-lastProgress<1000)return;lastProgress=Date.now();if(connection.readyState===1)connection.send(JSON.stringify({t:'workspace_progress',room,id:msg.id,message}));};
    try {
      await sessionReady;
      delete msg.localResume;
      if(msg.resumeFromId){
        const saved=sessions.checkpoint(msg.resumeFromId);
        if(!saved || saved.agentId!==msg.agentId || saved.taskId!==msg.taskId)throw new Error('Saved work is unavailable here. Reconnect the original machine and project, or choose Start fresh.');
        if([...jobs].some(([id])=>id!==msg.id && sessions.checkpoint(id)?.cwd===saved.cwd))throw new Error('The previous local run is still stopping. Try Resume again shortly.');
        msg.localResume={...saved};
      }
      let result;
      if(msg.t==='workspace_integrate') {
        if(!/^[A-Za-z0-9_-]{8,80}$/.test(msg.sourceId))throw new Error('Invalid contribution ID');
        const response=await fetch(url.origin+'/api/rooms/'+room+'/work/'+msg.sourceId+'/patch',{signal:controller.signal});
        if(!response.ok)throw new Error('Contribution patch is unavailable');
        const patch=await response.text();if(Buffer.byteLength(patch)>1024*1024)throw new Error('Patch too large');
        result=await project.integrate(msg,patch,{signal:controller.signal,progress});
      } else {msg.context=await loadTaskInputs(msg.context,url.origin,{signal:controller.signal});result=await project.run(msg,{signal:controller.signal,progress,checkpoint:async tree=>{await sessions.saveRun(msg.id,{...tree,agentId:msg.agentId,taskId:msg.taskId || null,...(msg.localResume?.threadId?{threadId:msg.localResume.threadId}:{})});publishSessions();}});}
      // The room has already revoked this run's upload capability on Stop.
      // Cleanup still completes locally; publishing again only produces a 403.
      if(controller.signal.aborted){console.log(msg.id+': '+result.status+' '+result.message);return;}
      await post(msg,result);
      console.log(msg.id+': '+result.status+' '+(result.branch || ''));
    } catch(error) {
      console.error(msg.id+': '+error.message);
      await post(msg,{status:'failed',message:error.message}).catch(()=>{});
    } finally {jobs.delete(msg.id);controller.finish();}
  });
  ws.on('error',error=>console.error(error.message));
  ws.on('close',code=>{
    notify({type:code===1008?'roundtable-revoked':'roundtable-offline',room});
    for(const finish of [...contextRequests.values()])finish(new Error('The table disconnected.'));
    for(const controller of jobs.values())controller.abort();
    for(const controller of chatJobs.values())controller.abort();
    if(code===1008){console.error('Connection revoked or pairing invalid. Generate a new connection command in the room.');stop();return;}
    if(!stopping)setTimeout(connect,3000);
  });
}
async function stop(){
  if(stopping)return;stopping=true;const active=[...jobs.values(),...chatJobs.values()];for(const c of active)c.abort();ws?.close();
  const timeout=setTimeout(()=>codex.close(),35000);
  try{await Promise.allSettled(active.map(c=>c.finished));await sessionReady.catch(()=>{});}finally{clearTimeout(timeout);codex.close();await sessions?.close().catch(console.error);if(process.connected)process.disconnect();}
}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
process.on('disconnect',()=>{stop();});
connect();
