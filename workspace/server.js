import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import express from 'express';
import {createConversation} from './conversation.js';
import {initContext,contextSummary,readContext,createSharedContext} from './context.js';

const key = () => randomBytes(24).toString('base64url');
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const short = (value, max = 2000) => String(value || '').slice(0, max);
const active = status => ['running', 'integrating'].includes(status);
export {safeAsset} from './assets.js';
import {safeAsset,safeDeliverable,MIME} from './assets.js';

export function createWorkspaces({rooms, broadcast, persist, tell, canSpeak, allowRun, say, dataDir}) {
  const pending = new Map();
  const sharedContext=createSharedContext({broadcast,persist,tell,canSpeak,say});
  const artifactRoot = resolve(dataDir, 'workspaces');
  const init = room => {
    room.members ||= [];
    room.work ||= [];
    room.specialists ||= [];
    room.personalBridges ||= new Map();
    initContext(room);
  };
  const publicWork = room => room.work.map(({runToken, ...work}) => work);
  const agentView=b=>({agentId:b.agentId || b.ownerId,ownerId:b.ownerId,ownerName:b.name,name:b.agentName || `${b.name}'s Codex`,role:b.role || '',handle:b.handle,chatBusy:b.chatBusy,chatMode:b.chatMode});
  const connections = room => [...room.personalBridges.values()].map(b=>({ownerId:b.ownerId,name:b.name,project:b.project,approach:b.approach,handle:b.handle,chatMode:b.chatMode,chatBusy:b.chatBusy,workspaceMode:b.workspaceMode,agents:[agentView(b),...(b.specialists || []).map(agentView)]}));
  const announce = room => { room.lastActivity=Date.now(); broadcast(room, {t:'workspaces', work:publicWork(room), connections:connections(room)}); persist(); };
  const conversation=createConversation({say,announce,allowRun});
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
    return token && room?.members?.find(m => m.bridgeHash === hash(token));
  }
  function fail(room, work, status, message) {
    const p = pending.get(work.id);
    if (p) clearTimeout(p.timer);
    pending.delete(work.id);
    work.status = status; work.message = message; work.updatedAt = Date.now();
    announce(room);
  }
  function detach(ws) {
    for (const room of rooms.values()) {
      init(room);
      for (const [id, bridge] of room.personalBridges) if (bridge.ws === ws) {conversation.stop(bridge);room.personalBridges.delete(id);}
      let changed = false;
      for (const work of room.work) if (pending.get(work.id)?.ws === ws) {
        fail(room, work, 'interrupted', 'Connection lost. Local work is retained on its branch; start a new task when reconnected.'); changed = true;
      }
      if (changed || ws.workspaceRoom === room.id) announce(room);
    }
  }
  function attach(ws, room, token, meta) {
    init(room);
    const member = authenticate(room, token);
    if (!member) return false;
    const previous = room.personalBridges.get(member.id);
    if (previous) { detach(previous.ws); previous.ws.close(1008, 'replaced by your new connection'); }
    ws.workspaceRoom = room.id;
    if(!member.agentHandle){
      const base=(member.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,20)||'friend')+'-codex';
      member.agentHandle=room.members.some(m=>m.agentHandle===base) || room.specialists.some(a=>a.handle===base)?base+'-'+member.id.slice(0,4).toLowerCase():base;
    }
    room.personalBridges.set(member.id, {ws, ownerId:member.id, name:member.name, project:short(meta.project,80), workspaceMode:meta.workspaceMode==='folder'?'folder':'git', approach:short(meta.approach,500),handle:member.agentHandle,chatMode:member.chatMode||'off',chatBusy:false});
    const parent=room.personalBridges.get(member.id);
    parent.specialists=room.specialists.filter(s=>s.ownerId===member.id).map(s=>({...s,ws,name:member.name,chatMode:'mentions',chatBusy:false}));
    ws.send(JSON.stringify({t:'workspace_connected', room:room.id, ownerId:member.id}));
    announce(room); return true;
  }
  function dispatch(room, you, instructions, source, agentId) {
    const bridge = room.personalBridges.get(you.id);
    if (!bridge || bridge.ws.readyState !== 1) throw new Error('Connect your Codex and project first.');
    const agent=agentId && agentId!==you.id?bridge.specialists?.find(a=>a.agentId===agentId):bridge;
    if(!agent)throw new Error('Choose one of your own active agents.');
    if(source && bridge.workspaceMode==='folder')throw new Error('Git integration requires a repository connection. Download the deliverable instead.');
    if (room.work.length >= 48) throw new Error('Archive a finished work card before starting another.');
    if (room.work.filter(w => w.ownerId === you.id && active(w.status)).length >= 2) throw new Error('Your two workspaces are busy. Other people can keep working.');
    if (!allowRun(room)) return;
    const work = {id:key(), ownerId:you.id, ownerName:you.name,agentId:agent.agentId || you.id,agentName:agent.agentName || `${you.name}'s Codex`, title:short(instructions,80), instructions:short(instructions,4000), status:source?'integrating':'running', sourceId:source?.id || null, createdAt:Date.now(), updatedAt:Date.now(), message:source?'Preparing integration in your project…':'Starting your Codex…'};
    const runToken = key();
    const timer = setTimeout(() => {
      bridge.ws.send(JSON.stringify({t:'workspace_cancel',room:room.id,id:work.id}));
      fail(room,work,'interrupted','Task timed out. Local work is retained for inspection.');
    }, 30 * 60_000);
    timer.unref();
    pending.set(work.id, {ws:bridge.ws, runToken, timer});
    room.work.push(work); announce(room);
    conversation.activity(room,you.id,source?'I’m integrating '+source.title+'.':'I’m starting work: '+work.instructions,work.agentId);
    bridge.ws.send(JSON.stringify({t:source?'workspace_integrate':'workspace_task', room:room.id, id:work.id, runToken,agentId:work.agentId,agentName:work.agentName,agentRole:agent.role || '', instructions:work.instructions, sourceId:source?.id, baseCommit:source?.baseCommit, context:{shared:contextSummary(room,you.id),title:room.title, problem:room.problem, chat:room.chat.filter(m=>['human','agent'].includes(m.kind)).slice(-30).map(({author,text})=>({author,text})), others:room.work.filter(w=>w.id!==work.id).slice(-12).map(({ownerName,agentName,title,status})=>({ownerName,agentName,title,status}))}}));
  }
  function handle(ws, room, you, msg) {
    if (!msg.t?.startsWith('workspace_')) return false;
    init(room);
    try {
      if (!['workspace_cancel','workspace_disconnect','workspace_specialist_retire'].includes(msg.t) && !(msg.t==='workspace_chat_mode' && msg.mode==='off') && !canSpeak(room,you)) throw new Error('This table is view-only.');
      const member = room.members.find(m => m.id === you.id);
      if (!member) throw new Error('Rejoin the table to connect your workspace.');
      if(msg.t==='workspace_specialist_create'){
        const bridge=room.personalBridges.get(you.id);if(!bridge)throw new Error('Connect your Codex first.');
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
        if(!['off','mentions','auto'].includes(msg.mode))throw new Error('Invalid conversation mode.');
        const bridge=room.personalBridges.get(you.id);if(!bridge)throw new Error('Connect your Codex first.');
        if(msg.mode==='off')conversation.stop(bridge);
        member.chatMode=bridge.chatMode=msg.mode;announce(room);
        say(room,{kind:'system',text:msg.mode==='off'?`${you.name} paused their Codex in chat.`:`${you.name} invited their Codex into the conversation. Mention @${bridge.handle}.`});
      } else if (msg.t === 'workspace_pair' || msg.t === 'workspace_disconnect') {
        const old = room.personalBridges.get(you.id);
        if (old) { detach(old.ws); old.ws.close(1008,'connection revoked'); }
        delete member.bridgeHash;
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
      if(msg.action==='read')return reply({result:readContext(room,ownerId,msg.args)});
      if(msg.action!=='propose')throw new Error('Unknown context action.');
      if(room.access==='view' && ![...room.people.values()].some(p=>p.id===ownerId && p.isHost))throw new Error('This table is view-only.');
      if((job.contextProposals=(job.contextProposals || 0)+1)>4)throw new Error('Four proposals per turn is the limit.');
      const agent=chat?{id:chat.bridge.agentId || ownerId,name:chat.bridge.agentName || `${chat.bridge.name}'s Codex`,ownerName:chat.bridge.name}:{id:work.agentId,name:work.agentName,ownerName:work.ownerName};
      reply({result:sharedContext.propose(room,agent,msg.args)});
    }catch(error){reply({error:error.message});}
  }
  function mount(app) {
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
        const dir=artifactDir(room,work);
        await mkdir(dir,{recursive:true});
        await writeFile(join(dir,'patch.diff'),patch);
        for (const asset of decoded) {
          const file=join(dir,'preview',asset.path); await mkdir(resolve(file,'..'),{recursive:true}); await writeFile(file,asset.buffer);
        }
        for(const asset of deliverables){const file=join(dir,'deliverables',asset.path);await mkdir(resolve(file,'..'),{recursive:true});await writeFile(file,asset.buffer);}
        if (pending.get(work.id)!==p) return res.sendStatus(409);
        Object.assign(work,{status:body.status,summary:short(body.summary,4000),message:short(body.message,500),branch:short(body.branch,120),baseCommit:short(body.baseCommit,64),headCommit:short(body.headCommit,64),files:Array.isArray(body.files)?body.files.slice(0,200).map(f=>short(f,240)):[],checks:short(body.checks,4000),deliverables:deliverables.map(a=>({path:a.path,bytes:a.buffer.length})),hasPatch:!!patch,hasPreview:seen.has('index.html'),updatedAt:Date.now()});
        conversation.activity(room,work.ownerId,`${work.title} — ${work.status}. ${work.summary || work.message}`,work.agentId);
        clearTimeout(p.timer); pending.delete(work.id); announce(room); res.json({ok:true});
      } catch(error) { res.status(400).json({error:error.message}); }
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
  return {init,joinMember,attach,detach,handle,progress,mount,publicWork,connections,conversation,command,sharedContext,contextRequest};
}
