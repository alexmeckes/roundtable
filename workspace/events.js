import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {lookup as dnsLookup} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';

const hash=value=>createHash('sha256').update(value).digest('hex');
const eventError=(code,message,data,status=400)=>Object.assign(new Error(message),{status,rpcError:{code,message,...(data?{data}:{})}});
const invalid=message=>eventError(-32602,message);
const forbidden=()=>eventError(-32012,'Event access is no longer authorized.',undefined,403);
const endpointError=reason=>eventError(-32015,'The event callback could not be verified.',{reason});
const nonce=prefix=>prefix+randomBytes(24).toString('base64url');
const fields=(body,allowed)=>{if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(key=>!allowed.includes(key)))throw invalid('Unexpected event parameters.');};
const canonical=value=>JSON.stringify(value && typeof value==='object' && !Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(canonical(value[key]))])):value);

export const AI_REQUESTED_EVENT={
  name:'roundtable.ai_requested',description:'A person explicitly requested a reply from their own AI in a Roundtable room. Only requests owned by the connected person are delivered.',delivery:['webhook'],
  inputSchema:{type:'object',properties:{room_id:{type:'string',description:'The connected Roundtable room ID.'}},required:['room_id'],additionalProperties:false},
  payloadSchema:{type:'object',properties:Object.fromEntries(['room_id','request_id','message_id','owner_id','text','url'].map(name=>[name,{type:'string'}])),required:['room_id','request_id','message_id','owner_id','text','url'],additionalProperties:false},
};

export function webhookKey(secret){
  if(typeof secret!=='string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))throw invalid('A valid whsec_ signing secret is required.');
  const encoded=secret.slice(6),decoded=Buffer.from(encoded,'base64');
  if(encoded.length%4===1 || encoded.includes('=') && encoded.length%4!==0 || decoded.length<24 || decoded.length>64 || decoded.toString('base64').replace(/=+$/,'')!==encoded.replace(/=+$/,''))throw invalid('The signing secret must encode 24–64 bytes.');
  return decoded;
}
export function signedWebhookHeaders(id,body,secrets,now=Date.now()){
  if(Buffer.byteLength(body)>256*1024)throw invalid('The event payload exceeds 256 KiB.');
  const timestamp=String(Math.floor(now/1000)),signed=id+'.'+timestamp+'.'+body;
  return {'content-type':'application/json','webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':secrets.map(secret=>'v1,'+createHmac('sha256',webhookKey(secret)).update(signed).digest('base64')).join(' ')};
}
export function publicAddress(address){
  if(isIP(address)===4){
    const [a,b,c]=address.split('.').map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 || a===100 && b>=64 && b<=127 || a===169 && b===254 || a===172 && b>=16 && b<=31 || a===192 && (b===168 || b===0 && (c===0 || c===2) || b===88 && c===99) || a===198 && (b===18 || b===19 || b===51 && c===100) || a===203 && b===0 && c===113);
  }
  if(isIP(address)===6){
    const parts=address.toLowerCase().split(':');
    const first=parseInt(parts[0] || '0',16),second=parseInt(parts[1] || '0',16);
    // Allow only global unicast, excluding special-purpose, documentation and
    // transition ranges. Mapped/NAT64/ULA/local addresses never enter this set.
    return first>=0x2000 && first<=0x3fff && !(first===0x2001 && (second<=0x1ff || second===0xdb8)) && first!==0x2002 && first!==0x3fff;
  }
  return false;
}
export function callbackUrl(value){
  let url;try{url=new URL(value);}catch{throw invalid('A valid HTTPS callback URL is required.');}
  if(typeof value!=='string' || value.length>2048 || url.protocol!=='https:' || url.username || url.password || url.hash || !url.hostname || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname))throw invalid('A public HTTPS callback URL is required.');
  const hostname=url.hostname.replace(/^\[|\]$/g,'');
  if(isIP(hostname) && !publicAddress(hostname))throw invalid('A public HTTPS callback URL is required.');
  return url;
}

// Resolve every attempt and use a dedicated connection pinned to a validated
// address. TLS still verifies the original URL hostname; redirects are errors.
export async function secureWebhookPost(value,{body,headers,signal,beforeConnect=()=>true,timeoutMs=10_000,lookup=dnsLookup,request=httpsRequest,maxResponseBytes=16*1024}={}){
  const url=callbackUrl(value),hostname=url.hostname.replace(/^\[|\]$/g,'');
  if(typeof body!=='string' || Buffer.byteLength(body)>256*1024)throw invalid('The event payload exceeds 256 KiB.');
  const controller=new AbortController(),abort=()=>controller.abort();
  if(signal?.aborted)controller.abort();else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const addresses=await Promise.race([
      isIP(hostname)?Promise.resolve([{address:hostname,family:isIP(hostname)}]):lookup(hostname,{all:true,verbatim:true}),
      new Promise((_,reject)=>{if(controller.signal.aborted)reject(endpointError('timeout'));else controller.signal.addEventListener('abort',()=>reject(endpointError('timeout')),{once:true});}),
    ]);
    if(!Array.isArray(addresses) || !addresses.length || addresses.some(result=>!publicAddress(result.address) || result.family!==isIP(result.address)))throw endpointError('connection_refused');
    if(controller.signal.aborted)throw endpointError('timeout');
    if(!beforeConnect())throw forbidden();
    const destination=addresses[0];
    return await new Promise((resolve,reject)=>{
      const req=request(url,{method:'POST',agent:false,rejectUnauthorized:true,...(!isIP(hostname)?{servername:hostname}:{}),signal:controller.signal,headers:{...headers,'content-length':Buffer.byteLength(body)},maxHeaderSize:16*1024,
        lookup:(_hostname,options,callback)=>options.all?callback(null,[destination]):callback(null,destination.address,destination.family)},response=>{
        const status=response.statusCode || 0;
        if(status>=300 && status<400){response.destroy();reject(endpointError('http_4xx'));return;}
        let bytes=0;const chunks=[];
        response.on('error',()=>reject(endpointError('connection_refused')));response.on('aborted',()=>reject(endpointError('connection_refused')));
        if(Number(response.headers['content-length'])>maxResponseBytes){response.destroy();reject(endpointError('challenge_failed'));return;}
        response.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxResponseBytes){response.destroy();reject(endpointError('challenge_failed'));}else chunks.push(chunk);});
        response.on('end',()=>resolve({status,body:Buffer.concat(chunks).toString('utf8')}));
      });
      req.on('error',error=>reject(endpointError(controller.signal.aborted?'timeout':String(error.code || '').includes('CERT') || ['ERR_TLS_CERT_ALTNAME_INVALID','EPROTO'].includes(error.code)?'tls_error':'connection_refused')));
      req.end(body);
    });
  }catch(error){if(error.rpcError)throw error;throw endpointError(controller.signal.aborted?'timeout':'connection_refused');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

export function createRoomEvents({rooms,persist,canSpeak,allowedRoom=()=>true,siteOrigins=(process.env.ROUNDTABLE_ALLOWED_ORIGINS || '').split(',').map(value=>value.trim()).filter(Boolean),now=Date.now,post=secureWebhookPost,autostart=true,defaultTtlMs=60*60_000,maxTtlMs=24*60*60_000,minTtlMs=60_000,rotationMs=5*60_000,retryMs=1000,maxAttempts=6}){
  const verified=new Map(),verificationInFlight=new Map(),verificationAttempts=new Map(),inFlight=new Map(),pendingSubscriptions=new Map();let pumping=false,timer;
  const initialize=room=>{room.eventSubscriptions ||= [];room.eventOutbox ||= [];room.eventPauses ||= [];};
  const current=(room,subscription)=>{
    const member=room.members?.find(member=>member.id===subscription.ownerId);
    return !!member && allowedRoom(room.id) && subscription.source==='sites' && member.sitesUserHash===subscription.credentialHash && siteOrigins.includes(subscription.siteOrigin) && canSpeak(room,{id:member.id,name:member.name,isHost:member.sitesHost===true}) && subscription.expiresAt>now() && subscription.active!==false;
  };
  const save=()=>persist();
  const cleanup=room=>{
    initialize(room);const count=room.eventSubscriptions.length+room.eventOutbox.length+room.eventPauses.length;let changed=false;
    room.eventSubscriptions=room.eventSubscriptions.filter(subscription=>current(room,subscription));
    for(const subscription of room.eventSubscriptions)if(subscription.previousSecret && subscription.rotationUntil<=now()){delete subscription.previousSecret;delete subscription.rotationUntil;changed=true;}
    room.eventPauses=room.eventPauses.filter(pause=>room.members?.some(member=>member.id===pause.ownerId && member.sitesUserHash===pause.credentialHash));
    room.eventOutbox=room.eventOutbox.filter(delivery=>room.eventSubscriptions.some(subscription=>subscription.id===delivery.subscriptionId) && room.replyRequests?.some(request=>request.id===delivery.requestId && request.attempt===delivery.attempt && request.status==='requested' && request.expiresAt>now()));
    for(const request of room.replyRequests || [])if(request.status==='requested' && request.expiresAt>now() && request.eventDelivery?.attempt===request.attempt && request.eventDelivery.mode==='events' && !request.eventDelivery.accepted && !room.eventOutbox.some(delivery=>delivery.requestId===request.id && delivery.attempt===request.attempt)){
      request.status='failed';request.failure='Monitoring stopped before your AI received this request. Ask again or reconnect monitoring.';request.updatedAt=now();changed=true;
    }
    if(changed || count!==room.eventSubscriptions.length+room.eventOutbox.length+room.eventPauses.length)save();
  };
  const state=(room,member,auth)=>{
    cleanup(room);return {supported:true,paused:room.eventPauses.some(pause=>pause.ownerId===member.id && pause.source===auth.source && pause.credentialHash===auth.credentialHash),subscriptions:room.eventSubscriptions.filter(subscription=>subscription.ownerId===member.id && subscription.source===auth.source && subscription.credentialHash===auth.credentialHash).map(subscription=>({id:subscription.id,refreshBefore:new Date(subscription.expiresAt).toISOString(),active:subscription.active!==false,pendingDeliveries:room.eventOutbox.filter(delivery=>delivery.subscriptionId===subscription.id).length}))};
  };
  const deliveryState=(room,request)=>request?.eventDelivery?.attempt===request?.attempt && request.eventDelivery.mode==='events' && (request.eventDelivery.accepted || room.eventOutbox?.some(delivery=>delivery.requestId===request.id && delivery.attempt===request.attempt))?{mode:'events',queued:true}:{mode:'host',queued:false};
  const presence=room=>{cleanup(room);return Object.fromEntries((room.members || []).map(member=>[member.id,room.eventSubscriptions.some(subscription=>subscription.ownerId===member.id && current(room,subscription))]));};
  function subscriptionInput(room,member,body,auth,subscribe){
    if(!auth?.isCurrent() || auth.source!=='sites')throw forbidden();
    fields(body,subscribe?['name','arguments','delivery','cursor','maxAgeMs','ttlMs','_siteOrigin']:['name','arguments','delivery']);
    if(body.name!==AI_REQUESTED_EVENT.name)throw eventError(-32011,'Unknown Roundtable event.',{kind:'event'});
    fields(body.arguments,['room_id']);if(body.arguments.room_id!==room.id)throw forbidden();
    fields(body.delivery,subscribe?['mode','url','secret']:['mode','url']);
    if(body.delivery.mode!=='webhook')throw invalid('Only webhook event delivery is supported.');
    const url=callbackUrl(body.delivery.url).href;
    if(subscribe){
      if(!canSpeak(room,auth.actor))throw forbidden();webhookKey(body.delivery.secret);
      if(body.cursor!==undefined && body.cursor!==null && typeof body.cursor!=='string')throw invalid('Invalid event cursor.');
      if(body.maxAgeMs!==undefined && (!Number.isSafeInteger(body.maxAgeMs) || body.maxAgeMs<0))throw invalid('Invalid event maximum age.');
      if(body.ttlMs!==undefined && body.ttlMs!==null && (!Number.isSafeInteger(body.ttlMs) || body.ttlMs<0))throw invalid('Invalid subscription lifetime.');
      let origin;try{origin=new URL(body._siteOrigin);}catch{throw invalid('A trusted Site origin is required.');}
      if(origin.protocol!=='https:' || origin.origin!==body._siteOrigin || !siteOrigins.includes(origin.origin))throw invalid('A trusted Site origin is required.');
    }
    const id='sub_'+hash(canonical({principal:member.id,room:room.id,source:auth.source,url,name:body.name,arguments:body.arguments}));
    return {id,url};
  }
  async function verify(id,url,secret,principal,auth){
    const key=hash(principal+'\0'+url+'\0'+secret),time=now();
    for(const [key,value] of verified)if(value<=time)verified.delete(key);
    if(verified.get(key)>time)return;
    if(verificationInFlight.has(key))return verificationInFlight.get(key);
    const attemptKey=hash(principal+'\0'+url);
    for(const [key,time] of verificationAttempts)if(time+30_000<=now())verificationAttempts.delete(key);
    if(verificationAttempts.get(attemptKey)+30_000>time)throw endpointError('challenge_failed');
    if(verificationAttempts.size>=512)throw eventError(-32013,'Too many callback verification requests.',undefined,429);
    verificationAttempts.set(attemptKey,time);
    const pending=(async()=>{
      const challenge=nonce('challenge_'),messageId=nonce('verification_'),body=JSON.stringify({type:'verification',challenge});
      const response=await post(url,{body,headers:{...signedWebhookHeaders(messageId,body,[secret],now()),'x-mcp-subscription-id':id},beforeConnect:auth.isCurrent});
      if(response.status<200 || response.status>=300)throw endpointError(response.status>=500?'http_5xx':'http_4xx');
      let echoed;try{echoed=JSON.parse(response.body)?.challenge;}catch{}
      const left=Buffer.from(challenge),right=typeof echoed==='string'?Buffer.from(echoed):Buffer.alloc(0);
      if(left.length!==right.length || !timingSafeEqual(left,right) || now()>time+30_000)throw endpointError('challenge_failed');
      if(!auth.isCurrent())throw forbidden();
      if(verified.size>=512)verified.delete(verified.keys().next().value);verified.set(key,now()+5*60_000);
      verificationAttempts.delete(attemptKey);
    })();verificationInFlight.set(key,pending);
    try{await pending;}finally{if(verificationInFlight.get(key)===pending)verificationInFlight.delete(key);}
  }
  async function operation(room,member,action,body,auth){
    initialize(room);cleanup(room);
    if(!auth?.isCurrent() || auth.source!=='sites')throw forbidden();
    if(action==='event_stop_all'){
      fields(body,[]);if(!auth.human)throw forbidden();
      const ids=new Set(room.eventSubscriptions.filter(subscription=>subscription.ownerId===member.id && subscription.source===auth.source && subscription.credentialHash===auth.credentialHash).map(subscription=>subscription.id));
      for(const [id,pending] of pendingSubscriptions)if(pending.ownerId===member.id && pending.source===auth.source){pending.generation++;ids.add(id);}
      for(const id of ids)if(!room.eventPauses.some(pause=>pause.id===id)){if(room.eventPauses.length>=128)throw eventError(-32013,'The room monitoring pause limit was reached.',undefined,429);room.eventPauses.push({id,ownerId:member.id,source:auth.source,credentialHash:auth.credentialHash,createdAt:now()});}
      for(const pending of inFlight.values())if(ids.has(pending.subscriptionId))pending.controller.abort();
      room.eventSubscriptions=room.eventSubscriptions.filter(subscription=>!ids.has(subscription.id));room.eventOutbox=room.eventOutbox.filter(delivery=>!ids.has(delivery.subscriptionId));save();return {eventMonitoring:state(room,member,auth)};
    }
    if(action==='event_list'){fields(body,['cursor']);if(body.cursor!==undefined && body.cursor!==null)throw invalid('This event catalog has no next page.');return {events:[AI_REQUESTED_EVENT]};}
    const subscribe=action==='event_subscribe';if(!subscribe && action!=='event_unsubscribe')throw invalid('Unknown event operation.');
    const {id,url}=subscriptionInput(room,member,body,auth,subscribe);
    if(!subscribe){
      if(pendingSubscriptions.has(id))pendingSubscriptions.get(id).generation++;
      room.eventPauses=room.eventPauses.filter(pause=>pause.id!==id);
      for(const [key,pending] of inFlight)if(pending.subscriptionId===id)pending.controller.abort();
      room.eventSubscriptions=room.eventSubscriptions.filter(subscription=>subscription.id!==id);room.eventOutbox=room.eventOutbox.filter(delivery=>delivery.subscriptionId!==id);save();return {};
    }
    if(room.eventPauses.some(pause=>pause.id===id))throw eventError(-32012,'Monitoring is paused. Stop this monitor in ChatGPT before creating it again.',undefined,403);
    if(!room.eventSubscriptions.some(subscription=>subscription.id===id) && (room.eventSubscriptions.length+room.eventPauses.length+pendingSubscriptions.size>=128 || room.eventSubscriptions.filter(subscription=>subscription.ownerId===member.id).length+[...pendingSubscriptions.values()].filter(pending=>pending.ownerId===member.id).length>=2 && !pendingSubscriptions.has(id)))throw eventError(-32013,'Roundtable event subscription limit reached.',undefined,429);
    let fence=pendingSubscriptions.get(id);if(!fence){fence={ownerId:member.id,source:auth.source,generation:0,count:0};pendingSubscriptions.set(id,fence);}const generation=fence.generation;fence.count++;
    try{
    await verify(id,url,body.delivery.secret,member.id+'\0'+auth.source,auth);
    if(fence.generation!==generation)throw forbidden();
    if(!auth.isCurrent() || !canSpeak(room,auth.actor))throw forbidden();
    // Recheck capacity after the asynchronous callback handshake.
    let subscription=room.eventSubscriptions.find(subscription=>subscription.id===id);
    if(!subscription && (room.eventSubscriptions.length+room.eventPauses.length>=128 || room.eventSubscriptions.filter(subscription=>subscription.ownerId===member.id).length>=2))throw eventError(-32013,'Roundtable event subscription limit reached.',undefined,429);
    const ttl=Math.max(minTtlMs,Math.min(maxTtlMs,body.ttlMs ?? defaultTtlMs)),time=now();
    const previous=subscription?{...subscription}:null;
    if(!subscription){subscription={id,ownerId:member.id,source:auth.source,credentialHash:auth.credentialHash,name:body.name,arguments:body.arguments,url,createdAt:time};room.eventSubscriptions.push(subscription);}
    if(subscription.secret && subscription.secret!==body.delivery.secret){subscription.previousSecret=subscription.secret;subscription.rotationUntil=time+rotationMs;}
    Object.assign(subscription,{secret:body.delivery.secret,siteOrigin:body._siteOrigin,expiresAt:time+ttl,updatedAt:time,active:true});
    try{save();}catch(error){if(previous){for(const key of Object.keys(subscription))delete subscription[key];Object.assign(subscription,previous);}else room.eventSubscriptions=room.eventSubscriptions.filter(item=>item!==subscription);throw error;}
    return {id,refreshBefore:new Date(subscription.expiresAt).toISOString(),cursor:null,truncated:false};
    }finally{fence.count--;if(fence.count===0 && pendingSubscriptions.get(id)===fence)pendingSubscriptions.delete(id);}
  }
  function emit(room,member,request,auth){
    initialize(room);cleanup(room);
    if(auth.source!=='sites' || !auth.human || !auth.isCurrent() || request.ownerId!==member.id || request.status!=='requested' || request.lastEmittedAttempt===request.attempt)return;
    const subscriptions=room.eventSubscriptions.filter(subscription=>subscription.ownerId===member.id && subscription.source===auth.source && subscription.credentialHash===auth.credentialHash && current(room,subscription));
    if(room.eventOutbox.length+subscriptions.length>256)throw eventError(-32013,'The room event delivery queue is full.',undefined,429);
    const eventId='evt_'+hash(canonical({room:room.id,owner:member.id,request:request.id,attempt:request.attempt})),previous=room.eventOutbox.slice(),oldMarker=request.lastEmittedAttempt,oldDelivery=request.eventDelivery;
    for(const subscription of subscriptions){
      const event={eventId,name:AI_REQUESTED_EVENT.name,timestamp:new Date(request.updatedAt).toISOString(),data:{room_id:room.id,request_id:request.id,message_id:request.messageId,owner_id:request.ownerId,text:request.text,url:new URL('/s/'+encodeURIComponent(room.id)+'#reply='+encodeURIComponent(request.id),subscription.siteOrigin).href},cursor:null};
      room.eventOutbox.push({id:subscription.id+':'+eventId,subscriptionId:subscription.id,requestId:request.id,attempt:request.attempt,event,attempts:0,nextAttemptAt:now()});
    }
    request.lastEmittedAttempt=request.attempt;
    request.eventDelivery={attempt:request.attempt,mode:subscriptions.length?'events':'host',accepted:false};
    try{save();}catch(error){room.eventOutbox=previous;if(oldMarker===undefined)delete request.lastEmittedAttempt;else request.lastEmittedAttempt=oldMarker;if(oldDelivery===undefined)delete request.eventDelivery;else request.eventDelivery=oldDelivery;throw error;}
  }
  async function deliver(room,delivery){
    const subscription=room.eventSubscriptions.find(subscription=>subscription.id===delivery.subscriptionId),request=room.replyRequests?.find(request=>request.id===delivery.requestId);
    const valid=()=>!!subscription && room.eventSubscriptions.includes(subscription) && current(room,subscription) && room.eventOutbox.includes(delivery) && request?.status==='requested' && request.attempt===delivery.attempt && request.expiresAt>now();
    if(!valid())return;
    delivery.attempts++;delivery.nextAttemptAt=now()+Math.min(300_000,retryMs*2**(delivery.attempts-1));save();
    const controller=new AbortController();inFlight.set(delivery.id,{subscriptionId:subscription.id,controller});
    try{
      const body=JSON.stringify(delivery.event),secrets=[subscription.secret,...(subscription.previousSecret && subscription.rotationUntil>now()?[subscription.previousSecret]:[])];
      const response=await post(subscription.url,{body,headers:{...signedWebhookHeaders(delivery.event.eventId,body,secrets,now()),'x-mcp-subscription-id':subscription.id},signal:controller.signal,beforeConnect:valid});
      if(response.status>=200 && response.status<300){if(request?.eventDelivery?.attempt===delivery.attempt)request.eventDelivery.accepted=true;room.eventOutbox=room.eventOutbox.filter(item=>item!==delivery);}
      else if(response.status===410){room.eventSubscriptions=room.eventSubscriptions.filter(item=>item!==subscription);room.eventOutbox=room.eventOutbox.filter(item=>item.subscriptionId!==subscription.id);}
      else if(response.status===413 || response.status>=400 && response.status<500 && ![408,429].includes(response.status)){room.eventOutbox=room.eventOutbox.filter(item=>item!==delivery);subscription.active=false;}
      else if(delivery.attempts>=maxAttempts){room.eventOutbox=room.eventOutbox.filter(item=>item!==delivery);subscription.active=false;}
    }catch(error){if(delivery.attempts>=maxAttempts){room.eventOutbox=room.eventOutbox.filter(item=>item!==delivery);if(subscription)subscription.active=false;}}
    finally{
      inFlight.delete(delivery.id);
      if(request?.status==='requested' && request.attempt===delivery.attempt && !request.eventDelivery?.accepted && !room.eventOutbox.some(item=>item.requestId===request.id && item.attempt===request.attempt)){
        request.status='failed';request.failure='Your AI could not receive this request. Ask again or reconnect monitoring.';request.updatedAt=now();
      }
      save();
    }
  }
  async function pump(){
    if(pumping)return;pumping=true;
    try{
      const due=[];for(const room of rooms.values()){cleanup(room);for(const delivery of room.eventOutbox)if(delivery.nextAttemptAt<=now() && !inFlight.has(delivery.id) && due.length<4)due.push([room,delivery]);}
      await Promise.allSettled(due.map(([room,delivery])=>deliver(room,delivery)));
    }finally{pumping=false;}
  }
  for(const room of rooms.values())initialize(room);
  if(autostart){timer=setInterval(()=>{pump().catch(()=>{});},1000);timer.unref();}
  const close=()=>{clearInterval(timer);for(const {controller} of inFlight.values())controller.abort();};
  return {initialize:cleanup,operation,emit,state,deliveryState,presence,pump,close};
}
