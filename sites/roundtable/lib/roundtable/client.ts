export type SitePrincipal = {id:string; name:string};
export type RoundtableEnv = {DB?:D1Database; ROUNDTABLE_BACKEND_URL?:string; ROUNDTABLE_SITES_GATEWAY_SECRET?:string; ROUNDTABLE_SITES_ROOM?:string};
export class RoundtableRpcError extends Error {
  constructor(readonly rpcError:{code:number;message:string;data?:object}){super(rpcError.message);}
}

export function principalFrom(request:Request):SitePrincipal|null {
  const id=request.headers.get('oai-authenticated-user-id');
  if(!id || id.length>256)return null;
  let name='Room member';
  const raw=request.headers.get('oai-authenticated-user-full-name');
  if(raw)try{name=decodeURIComponent(raw).replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,24)||name;}catch{}
  return {id,name};
}

function publicResult(value:any):any {
  if(Array.isArray(value))return value.map(publicResult);
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:token|hash|secret|key)$/i.test(key)).map(([key,item])=>[key,publicResult(item)]));
  return value;
}

export class SitesRoundtableClient {
  readonly room:string;
  private enrolled=false;
  constructor(private env:RoundtableEnv,private user:SitePrincipal,private origin:string){this.room=env.ROUNDTABLE_SITES_ROOM||'sites-trial';}
  private db(){if(!this.env.DB)throw new Error('Roundtable storage is unavailable. Please retry shortly.');return this.env.DB;}
  headers(human=false){
    if(!this.env.ROUNDTABLE_SITES_GATEWAY_SECRET)throw new Error('The room connection is not configured yet.');
    return {'authorization':'Bearer '+this.env.ROUNDTABLE_SITES_GATEWAY_SECRET,'content-type':'application/json','x-roundtable-site-user-id':this.user.id,'x-roundtable-site-user-name':encodeURIComponent(this.user.name),...(human?{'x-roundtable-site-client':'app'}:{})};
  }
  backendUrl(path:string){
    if(!this.env.ROUNDTABLE_BACKEND_URL)throw new Error('The room connection is not configured yet.');
    const base=new URL(this.env.ROUNDTABLE_BACKEND_URL);
    if(base.protocol!=='https:' && !['localhost','127.0.0.1'].includes(base.hostname))throw new Error('The room connection requires HTTPS.');
    return new URL(path,base).href;
  }
  private async request(action:string,args:object,signal?:AbortSignal,human=false){
    const timeout=AbortSignal.timeout(20000);
    const response=await fetch(this.backendUrl('/api/sites/rooms/'+encodeURIComponent(this.room)+'/'+action),{method:'POST',headers:this.headers(human),body:JSON.stringify(args),redirect:'manual',signal:signal?AbortSignal.any([signal,timeout]):timeout});
    if(response.status>=300 && response.status<400)throw new Error('The room connection unexpectedly redirected.');
    const data:any=await response.json();
    if(!response.ok){if(data.rpcError && Number.isInteger(data.rpcError.code))throw new RoundtableRpcError(data.rpcError);throw new Error(typeof data.error==='string'?data.error:'The room could not complete this action.');}
    return data;
  }
  async enroll(signal?:AbortSignal){if(!this.enrolled){await this.request('enroll',{},signal);this.enrolled=true;}}
  async session(){return this.request('session',{});}
  async runtimePair({signal}:{signal?:AbortSignal}={}){
    await this.enroll(signal);
    const value=await this.request('runtime_pair',{},signal,true);
    return {...value,backendOrigin:new URL(this.backendUrl('/')).origin,room:{...value.room,url:this.origin+'/s/'+encodeURIComponent(this.room)}};
  }
  private visible(data:any){const result=publicResult(data);if(result.room)result.room.url=this.origin+'/s/'+encodeURIComponent(this.room);return result;}
  async snapshot({signal}:{signal?:AbortSignal}={}){
    await this.enroll(signal);
    const result=this.visible(await this.request('snapshot',{},signal));
    const rows=await this.db().prepare('SELECT run_id FROM run_capabilities WHERE user_id=? AND room_id=? AND expires_at>?').bind(this.user.id,this.room,Date.now()).all<{run_id:string}>();
    const active=new Set((result.work || []).filter((run:any)=>run.status==='running' && run.ownerId===result.member.id).map((run:any)=>run.id));
    return {...result,claimedRunIds:rows.results.map(row=>row.run_id).filter(id=>active.has(id))};
  }
  async act(action:string,args:object,{signal}:{signal?:AbortSignal}={}){await this.enroll(signal);return this.visible(await this.request(action,args,signal));}
  async events(action:'event_list'|'event_subscribe'|'event_unsubscribe',args:object,{signal}:{signal?:AbortSignal}={}){
    await this.enroll(signal);return this.request(action,action==='event_subscribe'?{...args,_siteOrigin:this.origin}:args,signal);
  }
  async actHuman(action:string,args:object,{signal}:{signal?:AbortSignal}={}){
    await this.enroll(signal);const result=await this.request(action,args,signal,true);
    if(result.stoppedRunId)await this.db().prepare('DELETE FROM run_capabilities WHERE user_id=? AND room_id=? AND run_id=?').bind(this.user.id,this.room,result.stoppedRunId).run();
    return this.visible(result);
  }
  async claim(args:object,{signal}:{signal?:AbortSignal}={}){
    const db=this.db();await db.prepare('SELECT 1 FROM run_capabilities LIMIT 1').all();
    await this.enroll(signal);const result=await this.request('task_claim',args,signal);
    if(!result.run?.id || !result.runToken)throw new Error('The room did not return a usable claim.');
    try{await db.prepare('INSERT INTO run_capabilities (user_id,room_id,run_id,token,expires_at) VALUES (?,?,?,?,?)').bind(this.user.id,this.room,result.run.id,result.runToken,Date.now()+30*60*1000).run();}
    catch{throw new Error('The task started but its claim could not be saved. Stop and reopen it in Tasks, then claim it again.');}
    return this.visible(result);
  }
  async submit(args:{id:string;summary:string;deliverables?:object[]},{signal}:{signal?:AbortSignal}={}){
    await this.enroll(signal);const db=this.db(),now=Date.now(),lockId=crypto.randomUUID();
    const locked=await db.prepare('UPDATE run_capabilities SET lock_id=?,locked_until=? WHERE user_id=? AND room_id=? AND run_id=? AND expires_at>? AND (locked_until IS NULL OR locked_until<?) RETURNING token').bind(lockId,now+60000,this.user.id,this.room,args.id,now,now).first<{token:string}>();
    if(!locked)throw new Error('Claim this task as yourself before submitting, or wait for the current submission to finish.');
    try{
      const result=await this.request('task_submit',{...args,runToken:locked.token},signal);
      await db.prepare('DELETE FROM run_capabilities WHERE user_id=? AND room_id=? AND run_id=? AND lock_id=?').bind(this.user.id,this.room,args.id,lockId).run();
      return this.visible(result);
    }finally{
      await db.prepare('UPDATE run_capabilities SET lock_id=NULL,locked_until=NULL WHERE user_id=? AND room_id=? AND run_id=? AND lock_id=?').bind(this.user.id,this.room,args.id,lockId).run();
    }
  }
}
