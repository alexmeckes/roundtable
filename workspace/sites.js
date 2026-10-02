import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import express from 'express';

const hash=value=>createHash('sha256').update(value).digest('hex');
const failure=(message,status=403)=>Object.assign(new Error(message),{status});
const actions=new Set(['enroll','snapshot','publish','chat_send','chat_request','reply_start','reply_cancel','chat_mode','context_read','context_propose','task_save','task_review','task_claim','task_submit','event_list','event_subscribe','event_unsubscribe','event_stop_all','runtime_pair','runtime_disconnect','runtime_task_start','runtime_task_stop']);

// Sites authenticates people at its own boundary. Only its server-side gateway
// knows this service secret; browser fields never establish a person's identity.
export function createSitesGateway({rooms,getOrCreateRoom,initialize,operation,persist,events,runtimePair,runtimeDisconnect,runtimeTaskStart,runtimeTaskStop,runtimeAccess,secret=process.env.ROUNDTABLE_SITES_GATEWAY_SECRET || '',roomId=process.env.ROUNDTABLE_SITES_ROOM || 'sites-trial',now=Date.now,admissionMs=5*60_000,socketMs=30*60_000}){
  const enabled=!!secret,caps=new Map(),rates=new Map();
  if(enabled && (secret.length<32 || /[\r\n]/.test(secret)))throw new Error('ROUNDTABLE_SITES_GATEWAY_SECRET must contain at least 32 characters without line breaks.');
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(roomId))throw new Error('ROUNDTABLE_SITES_ROOM must be a valid room identifier.');
  const actor=member=>({id:member.id,name:member.name,isHost:member.sitesHost===true});
  const allowedRoom=id=>enabled && id===roomId;
  function identity(request,id){
    const bearer=request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const suppliedSecret=typeof bearer==='string'?Buffer.from(bearer):Buffer.alloc(0),expectedSecret=Buffer.from(secret);
    if(!allowedRoom(id) || request.headers.origin || suppliedSecret.length!==expectedSecret.length || !timingSafeEqual(suppliedSecret,expectedSecret))throw failure('Sites gateway access is not authorized.');
    const user=request.headers['x-roundtable-site-user-id'];
    if(typeof user!=='string' || !user.trim() || user.length>256 || /[^\x21-\x7e]/.test(user))throw failure('An authenticated Sites user is required.');
    let name;
    const supplied=request.headers['x-roundtable-site-user-name'];
    if(supplied!==undefined){
      if(typeof supplied!=='string' || supplied.length>512)throw failure('The Sites display name is invalid.',400);
      try{name=decodeURIComponent(supplied).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,24);}catch{throw failure('The Sites display name is invalid.',400);}
    }
    return {userHash:hash('sites:'+user),name};
  }
  function membership(room,principal,enroll=false){
    let member=room.members.find(member=>member.sitesUserHash===principal.userHash);
    if(!member){
      if(!enroll)throw failure('Join this room through Sites before using its tools.');
      if(room.members.length>=100)throw failure('This table has reached its participant limit.',409);
      member={id:randomBytes(24).toString('base64url'),name:principal.name || 'Room member',sitesUserHash:principal.userHash,sitesHost:!room.hostClaimed,sitesJoinedAt:now()};
      room.members.push(member);if(member.sitesHost)room.hostClaimed=true;persist();
    }else if(principal.name && member.name!==principal.name){member.name=principal.name;persist();}
    return member;
  }
  function authorization(room,member,human=false){
    const credentialHash=member.sitesUserHash;
    return {source:'sites',actor:actor(member),credentialHash,human,isCurrent:()=>allowedRoom(room.id) && room.members.includes(member) && member.sitesUserHash===credentialHash};
  }
  function session(room,member){
    for(const [key,cap] of caps)if(cap.expiresAt<=now() || !cap.room.members.includes(cap.member))caps.delete(key);
    if(caps.size>=1000)throw failure('Too many room connection requests. Try again shortly.',429);
    const token=randomBytes(24).toString('base64url'),expiresAt=now()+admissionMs;
    caps.set(hash(token),{room,member,credentialHash:member.sitesUserHash,expiresAt});
    return {...enrollment(room,member),browser:{token,expiresAt,socketLifetimeMs:socketMs,wsPath:'/'}};
  }
  const enrollment=(room,member)=>({room:{id:room.id,title:room.title},member:actor(member)});
  function browser(token,id,{consume=false}={}){
    if(!allowedRoom(id) || typeof token!=='string' || !/^[A-Za-z0-9_-]{32}$/.test(token))return null;
    const key=hash(token),cap=caps.get(key);
    if(!cap || cap.room.id!==id || cap.expiresAt<=now() || !cap.room.members.includes(cap.member) || cap.member.sitesUserHash!==cap.credentialHash){if(cap && cap.expiresAt<=now())caps.delete(key);return null;}
    if(consume)caps.delete(key);
    return {room:cap.room,member:cap.member,actor:actor(cap.member),expiresAt:now()+socketMs,credentialHash:cap.credentialHash};
  }
  const current=connection=>!!connection && allowedRoom(connection.room.id) && connection.expiresAt>now() && connection.room.members.includes(connection.member) && connection.member.sitesUserHash===connection.credentialHash;
  function authorizedRead(request,id){
    try{
      const principal=identity(request,id),room=rooms.get(id);
      if(!room)return false;
      return !!membership(room,principal);
    }catch{return false;}
  }
  function mount(app){
    app.post('/api/sites/rooms/:room/:action',(request,response,next)=>{
      try{
        const principal=identity(request,request.params.room),key=request.params.room+':'+principal.userHash,time=now(),rate=rates.get(key);
        if(!rate || time-rate.start>=30000)rates.set(key,{start:time,count:1});
        else if(++rate.count>120)throw failure('Sites request limit reached. Try again shortly.',429);
        if(request.params.action!=='session' && !actions.has(request.params.action))throw failure('Unknown Sites room operation.',400);
        if(request.headers['x-roundtable-site-client']!==undefined && request.headers['x-roundtable-site-client']!=='app')throw failure('Unknown Sites client.',400);
        request.sitesPrincipal=principal;response.setHeader('Cache-Control','no-store');next();
      }catch(error){response.status(error.status || 403).json({error:error.message});}
    },express.json({limit:'3mb'}),async(request,response)=>{
      try{
        const action=request.params.action,body=request.body,enroll=action==='session' || action==='enroll',existed=rooms.has(request.params.room);
        if(enroll && (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).length))throw failure('Session identity is set by Sites, not request fields.',400);
        const room=enroll?getOrCreateRoom(request.params.room):rooms.get(request.params.room);
        if(!room)throw failure('This room is unavailable.',404);
        if(enroll && !existed){room.title='Roundtable trial';persist();}
        events?.initialize(room);initialize(room);const member=membership(room,request.sitesPrincipal,enroll),auth=authorization(room,member,request.headers['x-roundtable-site-client']==='app');
        runtimeAccess?.(room,member,auth);
        let result;
        if(action.startsWith('runtime_')){
          if(!auth.human)throw failure('Connect or disconnect your runtime from the room controls.');
          const taskAction=action==='runtime_task_start' || action==='runtime_task_stop';
          if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(key=>!(taskAction?['id','version']:[]).includes(key)) || (taskAction && (typeof body.id!=='string' || !Number.isInteger(body.version))))throw failure('Runtime actions belong to the signed-in room member.',400);
          const handler={runtime_pair:runtimePair,runtime_disconnect:runtimeDisconnect,runtime_task_start:runtimeTaskStart,runtime_task_stop:runtimeTaskStop}[action];
          if(!handler)throw failure('Local runtime connections are unavailable.',503);
          result=await (taskAction?handler(room,member,body,auth):handler(room,member,auth));
        }
        else if(action.startsWith('event_')){if(!events)throw failure('Room events are unavailable.',400);result=await events.operation(room,member,action,body,auth);}
        else result=action==='enroll'?enrollment(room,member):action==='session'?session(room,member):await operation(room,member,action,body,auth);
        if(action==='chat_request' && events){const shared=room.replyRequests.find(reply=>reply.id===result.request.id);events.emit(room,member,shared,auth);result.delivery=events.deliveryState(room,shared);}
        if(action==='snapshot' && events){result.eventMonitoring=events.state(room,member,auth);const connected=events.presence(room);result.people=result.people.map(person=>({...person,aiConnected:connected[person.id]===true}));}
        response.json(result);
      }catch(error){response.status(error.status || 400).json({error:error.rpcError?.message || error.message,...(error.rpcError?{rpcError:error.rpcError}:{})});}
    });
  }
  return {enabled,roomId,allowedRoom,mount,browser,current,authorizedRead};
}
