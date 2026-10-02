import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import express from 'express';
import {initTasks,taskPeople,taskAgents,taskSummary,saveTask,validateTaskStart,currentTask,syncTaskRun} from './tasks.js';
import {createConversation} from './conversation.js';
import {initContext,contextSummary,readContext,createSharedContext} from './context.js';
import {readRoomHistory} from './history.js';

const key = () => randomBytes(24).toString('base64url');
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const short = (value, max = 2000) => String(value || '').slice(0, max);
const active = status => ['running', 'integrating'].includes(status);
export {safeAsset} from './assets.js';
import {safeAsset,safeDeliverable,MIME} from './assets.js';
import {createNativeParticipation} from './native.js';

export function createWorkspaces({rooms, broadcast, persist, tell, canSpeak, allowRun, say, dataDir,now=Date.now,pairingMs=5*60_000,runtimeAccessMs=5*60_000}) {
  const pending = new Map(),workspacePairs=new Map(),siteAccess=new WeakMap();
  if(!Number.isFinite(runtimeAccessMs) || runtimeAccessMs<1000 || runtimeAccessMs>5*60_000)throw new Error('Runtime access lifetime must be between one second and five minutes.');
  if(!Number.isFinite(pairingMs) || pairingMs<1000 || pairingMs>5*60_000)throw new Error('Workspace pairing lifetime must be between one second and five minutes.');
  const sharedContext=createSharedContext({broadcast,persist,tell,canSpeak,say});
  const artifactRoot = resolve(dataDir, 'workspaces');
  const native=createNativeParticipation({rooms,broadcast,persist,say,canSpeak,artifactRoot,
    onHumanMessage:(room,you,text)=>conversation.human(room,you,text),
    onChatMode:(room,you,mode)=>setChatMode(room,you,mode),
    conversationAgents:room=>roster(room).flatMap(bridge=>(bridge.agents || []).map(agent=>{
      const mode=bridge.chatMode==='off'?'off':agent.chatMode || 'off',connected=bridge.connected!==false && room.personalBridges.get(bridge.ownerId)?.ws.readyState===1,ready=connected && bridge.ready!==false;
      return {id:agent.agentId || agent.ownerId,ownerId:agent.ownerId,ownerName:agent.ownerName || bridge.name,name:agent.name || `${bridge.name}'s Codex`,handle:agent.handle,mode,connected,ready,busy:connected && !!agent.chatBusy,authMode:bridge.authMode==='chatgpt-plan'?'chatgpt-plan':'codex',
        available:connected && ready && mode!=='off' && bridgeAllowed(room,bridge)};
    })),
  });
  const init = room => {
    room.members ||= [];
    room.work ||= [];
    room.specialists ||= [];
    room.personalBridges ||= new Map();
    initContext(room);
    initTasks(room);
    native.initialize(room);
  };
  const publicWork = room => room.work.map(({runToken, ...work}) => work);
  const agentView=b=>({agentId:b.agentId || b.ownerId,ownerId:b.ownerId,ownerName:b.name,name:b.agentName || `${b.name}'s Codex`,role:b.role || '',handle:b.handle,chatBusy:b.chatBusy,chatMode:b.chatMode});
  const connections = room => [...room.personalBridges.values()].map(b=>({ownerId:b.ownerId,name:b.name,project:b.project,approach:b.approach,handle:b.handle,chatMode:b.chatMode,chatBusy:b.chatBusy,workspaceMode:b.workspaceMode,authMode:b.authMode,ready:b.ready!==false,supportsContinuity:!!b.supportsContinuity,resumableRuns:b.resumableRuns || [],savedConversations:b.savedConversations || [],agents:[agentView(b),...(b.specialists || []).map(agentView)]}));
  const roster=room=>room.members.filter(m=>m.workspaceProfile).map(m=>{
    const live=connections(room).find(c=>c.ownerId===m.id),profile=m.workspaceProfile;
    return live?{...live,connected:true,lastConnectedAt:profile.lastConnectedAt}:{ownerId:m.id,name:m.name,...profile,authMode:profile.authMode==='chatgpt-plan'?'chatgpt-plan':'codex',connected:false,ready:false,chatMode:'off',agents:taskAgents(room).filter(a=>a.ownerId===m.id).map(a=>({agentId:a.id,ownerId:m.id,ownerName:m.name,name:a.name,handle:a.handle,chatMode:'off'}))};
  });
  function ready(ws,room,msg){
    const bridge=[...room.personalBridges.values()].find(b=>b.ws===ws);if(!bridge?.supportsContinuity)return;
    const owned=[bridge.ownerId,...(bridge.specialists || []).map(a=>a.agentId)];
    bridge.savedConversations=Array.isArray(msg.savedConversations)?msg.savedConversations.filter(id=>owned.includes(id)).slice(0,5):[];
    bridge.resumableRuns=Array.isArray(msg.resumableRuns)?msg.resumableRuns.filter(id=>room.work.some(w=>w.id===id && w.ownerId===bridge.ownerId)).slice(-48):[];
    bridge.ready=true;
    const member=room.members.find(m=>m.id===bridge.ownerId);member.workspaceProfile.savedConversations=bridge.savedConversations;
    announce(room);
  }
  const announce = room => { room.lastActivity=Date.now(); broadcast(room, {t:'workspaces', work:publicWork(room), connections:connections(room),workspaceRoster:roster(room),tasks:room.tasks,taskPeople:taskPeople(room),taskAgents:taskAgents(room)}); persist(); };
  const conversation=createConversation({say,announce,allowRun,canParticipate:bridgeAllowed});
  function setChatMode(room,you,mode){
    if(!['off','mentions','auto'].includes(mode))throw new Error('Invalid conversation mode.');
    if(mode!=='off' && !canSpeak(room,you))throw new Error('This table is view-only.');
    const bridge=room.personalBridges.get(you.id),member=room.members.find(member=>member.id===you.id);
    if(!bridge || !member)throw new Error('Connect your Codex first.');
    if(mode==='off')conversation.stop(bridge);
    member.chatMode=bridge.chatMode=mode;announce(room);
    say(room,{kind:'system',text:mode==='off'?`${you.name} paused their Codex in chat.`:`${you.name} invited their Codex into the conversation. Mention @${bridge.handle}.`});
  }
  const artifactDir = (room, work) => join(artifactRoot, room.id, work.id);
  function joinMember(room, token, name) {
    init(room);
    let member = token && room.members.find(m => m.keyHash === hash(token));
    if (member) { member.name = name; return {member}; }
    if (room.members.length >= 100) throw new Error('This table has reached its participant limit.');
    const memberKey = key();
    member = {id:key(), name, keyHash:hash(memberKey)};
    room.members.push(member); persist();
    return {member, memberKey};
  }
  function authenticate(room, token) {
    return typeof token==='string' && room?.members?.find(m => m.bridgeHash === hash(token) && (m.sitesUserHash?(m.bridgeSource==='sites' && m.sitesUserHash===m.bridgeSourceHash && currentSiteAccess(m)):m.bridgeSource!=='sites'));
  }
  const currentSiteAccess=member=>!!member && siteAccess.get(member)?.credentialHash===member.sitesUserHash && siteAccess.get(member).expiresAt>now();
  // Only the authenticated Site gateway can renew access. A runtime credential,
  // persisted membership, or direct WebSocket traffic cannot extend this lease.
  function runtimeAccess(room,member,auth){
    if(auth?.source!=='sites' || auth.actor?.id!==member?.id || !auth.isCurrent?.() || !room.members.includes(member) || member.sitesUserHash!==auth.credentialHash)throw Object.assign(new Error('Current Site access is required.'),{status:403});
    siteAccess.set(member,{credentialHash:auth.credentialHash,expiresAt:now()+runtimeAccessMs});
  }
  function expireRuntimeAccess(){
    for(const room of rooms.values())for(const member of room.members || [])if(member.bridgeSource==='sites' && !currentSiteAccess(member)){
      revokeWorkspace(room,member);persist();
    }
  }
  function bridgeAllowed(room,agent){
    const bridge=room.personalBridges.get(agent.ownerId),member=room.members.find(m=>m.id===agent.ownerId);
    if(member?.sitesUserHash || bridge?.source==='sites')return currentSiteAccess(member) && bridge?.source==='sites' && member.sitesUserHash===bridge.credentialHash && member.bridgeHash===bridge.sessionHash && canSpeak(room,{id:member.id,name:member.name,isHost:member.sitesHost===true});
    return room.access!=='view' || [...room.people.values()].some(person=>person.id===agent.ownerId && person.isHost);
  }
  const pairingCurrent=grant=>grant.expiresAt>now() && currentSiteAccess(grant.member) && rooms.get(grant.room.id)===grant.room && grant.room.members.includes(grant.member) && grant.member.sitesUserHash===grant.credentialHash && canSpeak(grant.room,{id:grant.member.id,name:grant.member.name,isHost:grant.member.sitesHost===true});
  function runtimeOwner(room,member,auth){
    if(auth?.source!=='sites' || auth.human!==true || auth.actor?.id!==member?.id || !auth.isCurrent?.() || !room.members.includes(member) || member.sitesUserHash!==auth.credentialHash)throw Object.assign(new Error('An authenticated room owner must connect their own runtime.'),{status:403});
  }
  function revokeWorkspace(room,member){
    for(const [id,grant] of workspacePairs)if(grant.room===room && grant.member===member)workspacePairs.delete(id);
    delete member.bridgeHash;delete member.bridgeSource;delete member.bridgeSourceHash;
    const old=room.personalBridges.get(member.id);
    if(old){detach(old.ws);old.ws.close(1008,'connection revoked');}
  }
  function runtimePair(room,member,auth){
    init(room);runtimeOwner(room,member,auth);
    runtimeAccess(room,member,auth);
    if(!canSpeak(room,auth.actor))throw Object.assign(new Error('This table is view-only.'),{status:403});
    for(const [id,grant] of workspacePairs)if(!pairingCurrent(grant))workspacePairs.delete(id);
    if(workspacePairs.size>=1000)throw Object.assign(new Error('Too many runtime connection requests. Try again shortly.'),{status:429});
    revokeWorkspace(room,member);member.chatMode='mentions';
    const pairToken=key(),expiresAt=now()+pairingMs,grant={room,member,credentialHash:auth.credentialHash,expiresAt};
    workspacePairs.set(hash(pairToken),grant);
    try{persist({immediate:true});announce(room);}catch(error){workspacePairs.delete(hash(pairToken));throw error;}
    return {version:1,room:{id:room.id,title:room.title},member:{id:member.id,name:member.name},pairToken,expiresAt};
  }
  function runtimeDisconnect(room,member,auth){
    init(room);runtimeOwner(room,member,auth);revokeWorkspace(room,member);member.chatMode='off';persist({immediate:true});announce(room);
    return {disconnected:true};
  }
  function runtimeTaskStart(room,member,body,auth){
    init(room);runtimeOwner(room,member,auth);
    if(!canSpeak(room,auth.actor))throw Object.assign(new Error('This table is view-only.'),{status:403});
    const task=validateTaskStart(room,auth.actor,body);
    if(!bridgeAllowed(room,{ownerId:member.id}))throw Object.assign(new Error('Reconnect your own runtime before starting work.'),{status:403});
    const prior=task.runIds.length?retainedTaskRun(room,task):undefined;
    const run=dispatch(room,auth.actor,taskInstructions(task),undefined,task.agentId,task,prior);
    return {task,run};
  }
  function taskInstructions(task){
    const original=task.title+'\n'+task.details;
    return task.revision?original+'\n\nHuman review of the previous result:\n'+(task.revision.feedback || 'Continue the previous work using the current task instructions and shared feedback.')+'\n\nRevise the retained files and continue the saved task conversation. Preserve completed work that this feedback does not ask you to change.':original;
  }
  function retainedTaskRun(room,task){
    const bridge=room.personalBridges.get(task.ownerId);
    if(!bridge || bridge.ready===false || bridge.ws.readyState!==1)throw new Error('Reconnect your original computer, account, and folder to continue this task.');
    let prior=room.work.find(work=>work.id===task.runIds.at(-1));
    for(let attempt=0;attempt<48;attempt++){
      if(!prior || prior.taskId!==task.id || prior.ownerId!==task.ownerId || prior.agentId!==task.agentId || prior.sourceId || !['ready','failed','interrupted','conflict'].includes(prior.status))throw new Error('The previous task workspace cannot be continued by this agent. Reconnect its original owner and agent, or create a new task for separate work.');
      if(prior.execution==='native')throw new Error('This result was created in a native AI chat. Continue it there, or create a new task for your local AI.');
      if(bridge.resumableRuns?.includes(prior.id))return prior;
      if(!prior.resumeFromId)break;
      prior=room.work.find(work=>work.id===prior.resumeFromId);
    }
    throw new Error('Saved task work is unavailable on this connection. Reconnect the original computer, account, and folder to continue, or create a new task for separate work.');
  }
  function runtimeTaskStop(room,member,body,auth){
    init(room);runtimeOwner(room,member,auth);const task=currentTask(room,body);
    if(task.ownerId!==member.id)throw Object.assign(new Error('Only the task owner can stop their runtime.'),{status:403});
    const run=room.work.find(work=>work.id===task.runIds.at(-1));
    if(task.status!=='working' || !run || run.ownerId!==member.id || run.execution==='native' || !active(run.status) || !pending.has(run.id))throw new Error('This task has no active local runtime work.');
    const connection=pending.get(run.id);connection.ws.send(JSON.stringify({t:'workspace_cancel',room:room.id,id:run.id}));
    fail(room,run,'interrupted','Stopped by its owner. Local work retained.');return {task,run};
  }
  function fail(room, work, status, message) {
    const p = pending.get(work.id);
    if (p) clearTimeout(p.timer);
    pending.delete(work.id);
    work.status = status; work.message = message; work.updatedAt = Date.now();
    syncTaskRun(room,work);announce(room);
  }
  function detach(ws) {
    for (const room of rooms.values()) {
      init(room);
      for (const [id, bridge] of room.personalBridges) if (bridge.ws === ws) {conversation.stop(bridge);const member=room.members.find(m=>m.id===id);if(member?.workspaceProfile)member.workspaceProfile.lastDisconnectedAt=Date.now();room.personalBridges.delete(id);}
      let changed = false;
      for (const work of room.work) if (pending.get(work.id)?.ws === ws) {
        fail(room, work, 'interrupted', 'Connection lost. Reconnect the original machine and project to resume retained work.'); changed = true;
      }
      if (changed || ws.workspaceRoom === room.id) announce(room);
    }
  }
  function attach(ws, room, token, meta) {
    init(room);
    if(typeof token!=='string' || !meta || typeof meta!=='object' || Array.isArray(meta) || ws.readyState!==1)return false;
    const tokenHash=hash(token),grant=workspacePairs.get(tokenHash);
    if(grant && (grant.room!==room || !pairingCurrent(grant)))return false;
    const member = grant?.member || authenticate(room, token);
    if (!member) return false;
    const authMode=meta.authMode===undefined?'codex':meta.authMode;
    if(!['codex','chatgpt-plan'].includes(authMode))return false;
    if(member.bridgeSource==='sites' && !canSpeak(room,{id:member.id,name:member.name,isHost:member.sitesHost===true}))return false;
    let sessionToken;
    if(grant){
      sessionToken=key();member.bridgeHash=hash(sessionToken);member.bridgeSource='sites';member.bridgeSourceHash=grant.credentialHash;
      try{persist({immediate:true});}catch(error){delete member.bridgeHash;delete member.bridgeSource;delete member.bridgeSourceHash;throw error;}
    }
    const previous = room.personalBridges.get(member.id);
    if (previous) { detach(previous.ws); previous.ws.close(1008, 'replaced by your new connection'); }
    ws.workspaceRoom = room.id;
    if(!member.agentHandle){
      const base=(member.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,20)||'friend')+'-codex';
      member.agentHandle=room.members.some(m=>m.agentHandle===base) || room.specialists.some(a=>a.handle===base)?base+'-'+member.id.slice(0,4).toLowerCase():base;
    }
    member.workspaceProfile={...member.workspaceProfile,project:short(meta.project,80),workspaceMode:meta.workspaceMode==='folder'?'folder':'git',authMode,lastConnectedAt:Date.now()};
    room.personalBridges.set(member.id, {ws,ready:meta.supportsContinuity!==true,supportsContinuity:meta.supportsContinuity===true, ownerId:member.id, name:member.name, project:short(meta.project,80), workspaceMode:meta.workspaceMode==='folder'?'folder':'git', authMode,approach:short(meta.approach,500),handle:member.agentHandle,chatMode:member.chatMode||'off',chatBusy:false,...(member.bridgeSource==='sites'?{source:'sites',credentialHash:member.bridgeSourceHash,sessionHash:member.bridgeHash}:{})});
    const parent=room.personalBridges.get(member.id);
    parent.specialists=room.specialists.filter(s=>s.ownerId===member.id).map(s=>({...s,ws,name:member.name,chatMode:'mentions',chatBusy:false}));
    try{ws.send(JSON.stringify({t:'workspace_connected', room:room.id, ownerId:member.id,...(sessionToken?{sessionToken}:{})}));}
    catch(error){detach(ws);if(grant){delete member.bridgeHash;delete member.bridgeSource;delete member.bridgeSourceHash;persist({immediate:true});}throw error;}
    if(grant)workspacePairs.delete(tokenHash);
    announce(room); return true;
  }
  function dispatch(room, you, instructions, source, agentId, task, resumeFrom) {
    const bridge = room.personalBridges.get(you.id);
    if (!bridge || bridge.ws.readyState !== 1 || bridge.ready===false) throw new Error('Connect your Codex and project first.');
    if(!bridgeAllowed(room,bridge))throw new Error('Your runtime access expired or was revoked. Reconnect through the authenticated room.');
    const agent=agentId && agentId!==you.id?bridge.specialists?.find(a=>a.agentId===agentId):bridge;
    if(!agent)throw new Error('Choose one of your own active agents.');
    if(source && bridge.workspaceMode==='folder')throw new Error('Git integration requires a repository connection. Download the deliverable instead.');
    if (room.work.length >= 48) throw new Error('Archive a finished work card before starting another.');
    if (room.work.filter(w => w.ownerId === you.id && active(w.status)).length >= 2) throw new Error('Your two workspaces are busy. Other people can keep working.');
    if (!allowRun(room)) throw new Error('The table run limit has been reached. Try again later.');
    const work = {id:key(),resumeFromId:resumeFrom?.id || null,taskId:task?.id || null, ownerId:you.id, ownerName:you.name,agentId:agent.agentId || you.id,agentName:agent.agentName || `${you.name}'s Codex`, title:task?.title || short(instructions,80), instructions:task?instructions:short(instructions,4000), status:source?'integrating':'running', sourceId:source?.id || null, createdAt:Date.now(), updatedAt:Date.now(), message:source?'Preparing integration in your project…':'Starting your Codex…'};
    const runToken = key();
    const timer = setTimeout(() => {
      bridge.ws.send(JSON.stringify({t:'workspace_cancel',room:room.id,id:work.id}));
      fail(room,work,'interrupted','Task timed out. Local work is retained for inspection.');
    }, 30 * 60_000);
    timer.unref();
    pending.set(work.id, {ws:bridge.ws, runToken, timer});
    room.work.push(work);
    if(task){task.runIds.push(work.id);syncTaskRun(room,work);}
    announce(room);
    conversation.activity(room,you.id,source?'I’m integrating '+source.title+'.':(resumeFrom?'I’m resuming work: ':'I’m starting work: ')+work.instructions,work.agentId,work.taskId);
    bridge.ws.send(JSON.stringify({t:source?'workspace_integrate':'workspace_task', room:room.id, id:work.id, runToken,taskId:task?.id || null,resumeFromId:resumeFrom?.id || null,agentId:work.agentId,agentName:work.agentName,agentRole:agent.role || '', instructions:work.instructions, sourceId:source?.id, baseCommit:source?.baseCommit, context:{dependencies:(task?.dependencies || []).map(id=>{const predecessor=room.tasks.find(t=>t.id===id),run=room.work.find(w=>w.id===predecessor.runIds.at(-1));return {id,title:predecessor.title,room:room.id,runId:run?.id,summary:run?.summary || predecessor.details,deliverables:run?.deliverables || []};}).filter(d=>d.runId),tasks:taskSummary(room),task:task || null,shared:contextSummary(room,you.id),title:room.title, problem:room.problem, chat:room.chat.filter(m=>['human','agent'].includes(m.kind)).slice(-30).map(({author,text})=>({author,text})), others:room.work.filter(w=>w.id!==work.id).slice(-12).map(({ownerName,agentName,title,status})=>({ownerName,agentName,title,status}))}}));
    return work;
  }
  function handle(ws, room, you, msg) {
    if(['workspace_native_pair','workspace_native_disconnect'].includes(msg.t)){
      try{
        if(msg.t==='workspace_native_pair')ws.send(JSON.stringify({t:'workspace_native_pair',...native.pair(room,you)}));
        else {native.revoke(room,you);ws.send(JSON.stringify({t:'workspace_native_disconnected'}));}
      }catch(error){tell(ws,error.message);}
      return true;
    }
    if(msg.t?.startsWith('task_')){
      try{
        init(room);if(!canSpeak(room,you))throw new Error('This table is view-only.');
        if(msg.t==='task_save'){const task=saveTask(room,you,msg);announce(room);say(room,{kind:'system',taskId:task.id,text:`${you.name} updated task: ${task.title} — ${task.status.replaceAll('_',' ')}.`});}
        else if(msg.t==='task_start' || msg.t==='task_resume'){
          const task=validateTaskStart(room,you,msg);let prior;
          if(task.revision)prior=retainedTaskRun(room,task);
          if(msg.t==='task_resume'){
            const bridge=room.personalBridges.get(you.id);
            prior=room.work.find(w=>w.id===task.runIds.at(-1));
            for(let i=0;i<48 && prior?.resumeFromId && !bridge?.resumableRuns?.includes(prior.id);i++)prior=room.work.find(w=>w.id===prior.resumeFromId);
            if(task.status!=='blocked' || !prior || !['failed','interrupted'].includes(prior.status) || prior.ownerId!==you.id || prior.agentId!==task.agentId || prior.sourceId)throw new Error('Resume requires an interrupted run by the same owner and agent.');
            if(!bridge?.resumableRuns?.includes(prior.id))throw new Error('Reconnect the original machine and project to resume, or choose Start fresh.');
          }
          dispatch(room,you,taskInstructions(task),undefined,task.agentId,task,prior);
        }
        else throw new Error('Unknown task action.');
        ws.send(JSON.stringify({t:'task_saved',requestId:msg.requestId}));
      }catch(error){ws.send(JSON.stringify({t:'task_error',requestId:msg.requestId,message:error.message}));}
      return true;
    }
    if (!msg.t?.startsWith('workspace_')) return false;
    init(room);
    try {
      if (!['workspace_cancel','workspace_disconnect','workspace_specialist_retire'].includes(msg.t) && !(msg.t==='workspace_chat_mode' && msg.mode==='off') && !canSpeak(room,you)) throw new Error('This table is view-only.');
      const member = room.members.find(m => m.id === you.id);
      if (!member) throw new Error('Rejoin the table to connect your workspace.');
      if(msg.t==='workspace_specialist_create'){
        const bridge=room.personalBridges.get(you.id);if(!bridge || bridge.ready===false)throw new Error('Connect your Codex first.');
        const name=short(msg.name,40).trim(),role=short(msg.role,1000).trim();
        if(!name || !role)throw new Error('Give the specialist a name and a role.');
        if(bridge.specialists.length>=4 || room.specialists.length>=48)throw new Error('Specialist limit reached. Retire a specialist first.');
        const base=(name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,24)||'specialist');
        const handles=[...room.members.map(m=>m.agentHandle),...room.specialists.map(a=>a.handle)];
        let handle=base;while(handles.includes(handle))handle=base+'-'+key().slice(0,5).toLowerCase();
        const record={agentId:key(),ownerId:you.id,agentName:name,role,handle};room.specialists.push(record);
        bridge.specialists.push({...record,ws:bridge.ws,name:you.name,chatMode:'mentions',chatBusy:false});
        if(bridge.chatMode==='off')member.chatMode=bridge.chatMode='mentions';
        say(room,{kind:'system',text:`${name} joined — ${you.name}'s specialist. ${role} Mention @${handle}; its owner can assign work with /work @${handle} instructions.`});
        announce(room);conversation.human(room,you,`@${handle} Introduce your role briefly to the table.`);
      } else if(msg.t==='workspace_specialist_retire'){
        const bridge=room.personalBridges.get(you.id),agent=bridge?.specialists?.find(a=>a.agentId===msg.agentId);
        if(!agent)throw new Error('You can only retire your own connected specialist.');
        if(room.work.some(w=>w.agentId===agent.agentId && active(w.status)))throw new Error('Stop this specialist’s active work before retiring it.');
        conversation.stop(agent);bridge.specialists=bridge.specialists.filter(a=>a!==agent);room.specialists=room.specialists.filter(a=>a.agentId!==agent.agentId);
        say(room,{kind:'system',text:`${you.name} retired ${agent.agentName}. Its messages and results remain at the table.`});announce(room);
      } else if(msg.t==='workspace_chat_mode'){
        setChatMode(room,you,msg.mode);
      } else if (msg.t === 'workspace_pair' || msg.t === 'workspace_disconnect') {
        if(msg.t==='workspace_pair' && member.sitesUserHash)throw new Error('Connect your AI through the authenticated Site room controls. Legacy pairing is unavailable here.');
        revokeWorkspace(room,member);
        if (msg.t === 'workspace_pair') {
          const token = key(); member.bridgeHash = hash(token);
          ws.send(JSON.stringify({t:'workspace_pair',token}));
        }
        announce(room);
      } else if (msg.t === 'workspace_start') {
        if (!String(msg.instructions || '').trim()) throw new Error('Describe the work you want your Codex to do.');
        dispatch(room,you,msg.instructions,undefined,msg.agentId);
      } else if (msg.t === 'workspace_integrate') {
        const source = room.work.find(w=>w.id===msg.id && ['ready','integrated'].includes(w.status) && w.hasPatch);
        if (!source) throw new Error('This contribution is not ready to integrate.');
        dispatch(room,you,'Integrate '+source.title,source);
      } else if (msg.t === 'workspace_cancel' || msg.t === 'workspace_archive') {
        const work = room.work.find(w=>w.id===msg.id && w.ownerId===you.id);
        if (!work) throw new Error('You can only manage your own work.');
        if (msg.t === 'workspace_cancel' && active(work.status)) {
          pending.get(work.id)?.ws.send(JSON.stringify({t:'workspace_cancel',room:room.id,id:work.id}));
          fail(room,work,'interrupted','Stopped by its owner. Local branch retained.');
        } else if (msg.t === 'workspace_archive' && !active(work.status)) {
          if(work.taskId)throw new Error('Task deliverables are retained with their task.');
          room.work = room.work.filter(w=>w!==work);
          rm(artifactDir(room,work),{recursive:true,force:true}).catch(()=>{}); announce(room);
        }
      }
    } catch (error) { tell(ws,error.message); }
    return true;
  }
  function progress(ws, room, msg) {
    const work = room.work.find(w=>w.id===msg.id);
    if (!work || pending.get(work.id)?.ws !== ws || !active(work.status)) return;
    work.message = short(msg.message,300); work.updatedAt=Date.now();
    broadcast(room,{t:'workspace_progress',id:work.id,message:work.message});
  }
  function contextRequest(ws,room,msg){
    if(typeof msg.requestId!=='string' || msg.requestId.length>80)return;
    const reply=value=>ws.readyState===1 && ws.send(JSON.stringify({t:'workspace_context_result',room:room.id,requestId:msg.requestId,...value}));
    try{
      if(msg.room!==room.id)throw new Error('Context belongs to the connected table.');
      const chat=conversation.contextJob(ws,room,msg.id),work=room.work.find(w=>w.id===msg.id),task=work && pending.get(work.id);
      const job=chat || (task?.ws===ws && active(work.status)?task:null);
      if(!job)throw new Error('This agent run is no longer active.');
      const ownerId=chat?.bridge.ownerId || work.ownerId;
      if((job.contextCalls=(job.contextCalls || 0)+1)>32)throw new Error('Context request limit reached for this turn.');
      if(!bridgeAllowed(room,{ownerId}))throw new Error('This table is view-only or the runtime connection was revoked.');
      if(msg.action==='read')return reply({result:readContext(room,ownerId,msg.args)});
      if(msg.action==='history')return reply({result:readRoomHistory(room,msg.args)});
      if(msg.action!=='propose')throw new Error('Unknown context action.');
      if((job.contextProposals=(job.contextProposals || 0)+1)>4)throw new Error('Four proposals per turn is the limit.');
      const agent=chat?{id:chat.bridge.agentId || ownerId,name:chat.bridge.agentName || `${chat.bridge.name}'s Codex`,ownerName:chat.bridge.name}:{id:work.agentId,name:work.agentName,ownerName:work.ownerName};
      reply({result:sharedContext.propose(room,agent,msg.args)});
    }catch(error){reply({error:error.message});}
  }
  function mount(app) {
    native.mount(app);
    const route = '/api/rooms/:room/work/:id';
    // Authenticate before accepting the potentially large contribution body.
    app.post(route+'/result', (req,res,next) => {
      const room=rooms.get(req.params.room), member=authenticate(room,req.headers.authorization?.replace(/^Bearer /,''));
      const work=room?.work?.find(w=>w.id===req.params.id);
      const p=work && pending.get(work.id);
      if (!member || work?.ownerId!==member.id || !p || p.runToken!==req.headers['x-run-token']) return res.sendStatus(403);
      req.workspace={room,work,p}; next();
    }, express.json({limit:'20mb'}), async (req,res) => {
      const {room,work,p}=req.workspace;
      let stage,moved=false;
      const dir=artifactDir(room,work);
      const canPublish=()=>pending.get(work.id)===p && active(work.status) && authenticate(room,req.headers.authorization?.replace(/^Bearer /,''))?.id===work.ownerId && bridgeAllowed(room,{ownerId:work.ownerId});
      if(p.busy)return res.sendStatus(409);
      if(!canPublish())return res.sendStatus(403);
      p.busy=true;
      try {
        const body=req.body;
        if (!body || !['ready','integrated','failed','conflict','interrupted'].includes(body.status)) return res.sendStatus(400);
        const patch=String(body.patch || '');
        if (Buffer.byteLength(patch)>1024*1024) throw new Error('Contribution exceeds 1 MB patch limit.');
        const assets=Array.isArray(body.preview)?body.preview:[];
        if (assets.length>100) throw new Error('Preview has too many files.');
        let bytes=0; const seen=new Set();
        const decoded=assets.map(asset=>{
          if (!safeAsset(asset.path) || seen.has(asset.path)) throw new Error('Invalid preview asset path.');
          seen.add(asset.path);
          const buffer=Buffer.from(String(asset.data || ''),'base64'); bytes+=buffer.length;
          if (bytes>5*1024*1024) throw new Error('Preview exceeds 5 MB.');
          return {path:asset.path,buffer};
        });
        const outputs=Array.isArray(body.deliverables)?body.deliverables:[];
        if(outputs.length>100)throw new Error('Too many deliverables.');
        let outputBytes=0;const names=new Set();
        const deliverables=outputs.map(asset=>{
          if(!safeDeliverable(asset.path) || names.has(asset.path))throw new Error('Invalid deliverable path.');
          names.add(asset.path);const buffer=Buffer.from(String(asset.data || ''),'base64');outputBytes+=buffer.length;
          if(outputBytes>5*1024*1024)throw new Error('Deliverables exceed 5 MB.');
          return {path:asset.path,buffer};
        });
        stage=join(artifactRoot,room.id,'.runtime-'+work.id+'-'+key());
        await mkdir(stage,{recursive:true});
        await writeFile(join(stage,'patch.diff'),patch);
        for (const asset of decoded) {
          const file=join(stage,'preview',asset.path); await mkdir(resolve(file,'..'),{recursive:true}); await writeFile(file,asset.buffer);
        }
        for(const asset of deliverables){const file=join(stage,'deliverables',asset.path);await mkdir(resolve(file,'..'),{recursive:true});await writeFile(file,asset.buffer);}
        if(!canPublish())return res.sendStatus(403);
        await rename(stage,dir);moved=true;
        if(!canPublish()){await rm(dir,{recursive:true,force:true});moved=false;return res.sendStatus(403);}
        Object.assign(work,{status:body.status,summary:short(body.summary,4000),message:short(body.message,500),branch:short(body.branch,120),baseCommit:short(body.baseCommit,64),headCommit:short(body.headCommit,64),files:Array.isArray(body.files)?body.files.slice(0,200).map(f=>short(f,240)):[],checks:short(body.checks,4000),deliverables:deliverables.map(a=>({path:a.path,bytes:a.buffer.length})),hasPatch:!!patch,hasPreview:seen.has('index.html'),updatedAt:Date.now()});
        conversation.activity(room,work.ownerId,`${work.title} — ${work.status}. ${work.summary || work.message}`,work.agentId,work.taskId);
        clearTimeout(p.timer); pending.delete(work.id); syncTaskRun(room,work);announce(room); res.json({ok:true});
      } catch(error) { res.status(400).json({error:error.message}); }
      finally {p.busy=false;if(stage && !moved)await rm(stage,{recursive:true,force:true}).catch(()=>{});}
    });
    app.get(route+'/deliverables/*',async(req,res)=>{
      const room=rooms.get(req.params.room),work=room?.work?.find(w=>w.id===req.params.id),path=req.params[0];
      if(!safeDeliverable(path) || !work?.deliverables?.some(a=>a.path===path))return res.sendStatus(404);
      try{
        res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");
        res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(path.split('/').pop()));
        res.type('application/octet-stream').send(await readFile(join(artifactDir(room,work),'deliverables',path)));
      }catch{res.sendStatus(404);}
    });
    app.get(route+'/patch',async(req,res)=>{
      const room=rooms.get(req.params.room), work=room?.work?.find(w=>w.id===req.params.id && w.hasPatch);
      if (!work) return res.sendStatus(404);
      try { res.type('text/plain').send(await readFile(join(artifactDir(room,work),'patch.diff'))); } catch { res.sendStatus(404); }
    });
    app.get(route+'/preview/*',async(req,res)=>{
      const room=rooms.get(req.params.room), work=room?.work?.find(w=>w.id===req.params.id && w.hasPreview);
      const path=req.params[0] || 'index.html';
      if (!work || !safeAsset(path)) return res.sendStatus(404);
      try {
        const data=await readFile(join(artifactDir(room,work),'preview',path));
        const host=new URL('http://'+req.headers.host).host;
        const prefix='/api/rooms/'+encodeURIComponent(room.id)+'/work/'+encodeURIComponent(work.id)+'/preview/';
        res.setHeader('Content-Security-Policy',"sandbox allow-scripts allow-pointer-lock; default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src http://"+host+prefix+" https://"+host+prefix+"; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
        res.setHeader('Access-Control-Allow-Origin','*');
        res.type(MIME[extname(path).toLowerCase()]).send(data);
      } catch { res.sendStatus(404); }
    });
  }
  function command(ws,room,you,text){
    if(!/^\/(specialist|work)\b/.test(text))return false;
    const create=text.match(/^\/specialist\s+([^|]+)\|\s*(.+)$/s),work=text.match(/^\/work\s+@([a-z0-9_-]+)\s+(.+)$/is);
    if(!create && !work){tell(ws,'Use /specialist Name | role, or /work @handle instructions.');return true;}
    if(create)handle(ws,room,you,{t:'workspace_specialist_create',name:create[1],role:create[2]});
    else {
      const bridge=room.personalBridges.get(you.id),agent=bridge && [bridge,...bridge.specialists].find(a=>a.handle.toLowerCase()===work[1].toLowerCase());
      if(!agent){tell(ws,'You can assign work only to your own connected agents.');return true;}
      handle(ws,room,you,{t:'workspace_start',agentId:agent.agentId || you.id,instructions:work[2]});
    }
    return true;
  }
  return {ready,roster,announce,init,joinMember,attach,detach,handle,progress,mount,publicWork,connections,conversation,command,sharedContext,contextRequest,nativeOperation:native.operation,runtimePair,runtimeDisconnect,runtimeTaskStart,runtimeTaskStop,runtimeAccess,expireRuntimeAccess,
    authorizedRoomRead:(room,token)=>!!(authenticate(room,token) || native.authorize(room,token)),
  };
}
