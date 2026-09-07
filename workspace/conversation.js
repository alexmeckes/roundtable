import {randomBytes} from 'node:crypto';

const id=()=>randomBytes(18).toString('base64url');
const label=bridge=>`${bridge.name}'s Codex`;
const mention=(text,handle)=>new RegExp('(^|\\s)@'+handle+'(?=$|[^a-z0-9_-])','i').test(text);

// Each personal bridge gets its own conversation queue. A human message grants
// at most four replies, including agent-to-agent follow-ups; no global turn lock.
export function createConversation({say,announce,allowRun}) {
  const pending=new Map(),queues=new Map();
  function enabled(room){return [...room.personalBridges.values()].filter(b=>b.chatMode && b.chatMode!=='off' && b.ws.readyState===1 && (room.access!=='view' || [...room.people.values()].some(p=>p.id===b.ownerId && p.isHost)));}
  function stop(bridge){
    queues.delete(bridge.ws);
    for(const [key,job] of pending)if(job.bridge===bridge){clearTimeout(job.timer);pending.delete(key);if(bridge.ws.readyState===1)bridge.ws.send(JSON.stringify({t:'workspace_chat_cancel',room:job.room.id,id:key}));}
    bridge.chatBusy=false;
  }
  function drain(room,bridge){
    if(bridge.chatBusy || !enabled(room).includes(bridge))return;
    const queue=queues.get(bridge.ws),next=queue?.shift();if(!next)return;
    if(!allowRun(room)){queues.delete(bridge.ws);return;}
    const key=id();bridge.chatBusy=true;
    const timer=setTimeout(()=>{
      pending.delete(key);bridge.chatBusy=false;
      if(bridge.ws.readyState===1)bridge.ws.send(JSON.stringify({t:'workspace_chat_cancel',room:room.id,id:key}));
      say(room,{kind:'system',text:label(bridge)+' timed out while responding.'});announce(room);drain(room,bridge);
    },3*60_000);timer.unref();
    pending.set(key,{room,bridge,...next,timer});announce(room);
    bridge.ws.send(JSON.stringify({t:'workspace_chat',room:room.id,id:key,agentName:label(bridge),handle:bridge.handle,trigger:next.text,
      context:{title:room.title,problem:room.problem,participants:enabled(room).map(b=>({name:label(b),handle:b.handle,approach:b.approach})),chat:room.chat.filter(m=>['human','agent'].includes(m.kind)).slice(-40).map(({author,text,kind})=>({author,text,kind})),work:room.work.slice(-12).map(({ownerName,title,status,summary})=>({ownerName,title,status,summary}))}}));
  }
  function enqueue(room,bridge,text,chain){
    if(chain.remaining<=0 || (chain.visits.get(bridge.ownerId)||0)>=2)return;
    const queue=queues.get(bridge.ws)||[];if(queue.length>=8){say(room,{kind:'system',text:label(bridge)+' has a full reply queue. Please ask again shortly.'});return;}
    chain.remaining--;chain.visits.set(bridge.ownerId,(chain.visits.get(bridge.ownerId)||0)+1);
    queue.push({text,chain});queues.set(bridge.ws,queue);drain(room,bridge);
  }
  function human(room,you,text){
    const agents=enabled(room),direct=[...room.personalBridges.values()].filter(b=>mention(text,b.handle));
    const targets=direct.length?direct.filter(b=>agents.includes(b)):agents.filter(b=>b.chatMode==='auto').slice(0,2);
    const chain={remaining:4,visits:new Map()};for(const b of targets)enqueue(room,b,`${you.name}: ${text}`,chain);
    return room.personalBridges.size>0;
  }
  function result(ws,room,msg){
    const job=pending.get(msg.id);if(!job || job.room!==room || job.bridge.ws!==ws)return;
    clearTimeout(job.timer);pending.delete(msg.id);const bridge=job.bridge;bridge.chatBusy=false;
    if(!enabled(room).includes(bridge)){queues.delete(bridge.ws);announce(room);return;}
    const text=String(msg.text||'').trim().slice(0,6000);
    if(msg.error)say(room,{kind:'system',text:label(bridge)+' could not respond: '+String(msg.error).slice(0,300)});
    else if(text && text!=='[SILENT]'){
      say(room,{kind:'agent',author:label(bridge),text,color:'#7c6bc4',workspaceOwnerId:bridge.ownerId,handle:bridge.handle});
      for(const other of enabled(room))if(other!==bridge && mention(text,other.handle))enqueue(room,other,`${label(bridge)}: ${text}`,job.chain);
    }
    announce(room);drain(room,bridge);
  }
  function activity(room,ownerId,text){
    const bridge=room.personalBridges.get(ownerId);if(!bridge || bridge.chatMode==='off')return;
    say(room,{kind:'agent',author:label(bridge),text,color:'#7c6bc4',workspaceOwnerId:ownerId,handle:bridge.handle,activity:true});
  }
  function reconcile(room){
    const allowed=enabled(room);
    for(const bridge of room.personalBridges.values())if(!allowed.includes(bridge))stop(bridge);
    announce(room);
  }
  return {human,result,stop,activity,reconcile};
}
