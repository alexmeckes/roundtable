import {lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';

const ACTIONS=new Set(['snapshot','publish','chat_send','chat_mode','context_read','context_propose','task_save','task_claim','task_submit']);
const PRIVATE_FIELDS=new Set(['runToken','nativeToken','accessToken','refreshToken','idToken','authorization']);

export class RoundtableError extends Error {
  constructor(message,status=0){super(message);this.name='RoundtableError';this.status=status;}
}

// The configured room and credential bind every request to one participant.
// Tools cannot provide another room, author, owner, or run capability.
export class RoundtableClient {
  #token;#runTokens=new Map();#submitting=new Set();#requests=new Set();
  constructor({url=process.env.ROUNDTABLE_URL || 'http://localhost:3132',room=process.env.ROUNDTABLE_ROOM || 'plugin-trial',token=process.env.ROUNDTABLE_NATIVE_TOKEN,fetchImpl=fetch,timeoutMs=30_000}={}){
    let base;try{base=new URL(url);}catch{throw new RoundtableError('Set ROUNDTABLE_URL to a complete Roundtable HTTP or HTTPS address.');}
    if(!['http:','https:'].includes(base.protocol) || base.username || base.password)throw new RoundtableError('ROUNDTABLE_URL must be an HTTP or HTTPS address without credentials.');
    if(typeof room!=='string' || !/^[A-Za-z0-9_-]{1,80}$/.test(room))throw new RoundtableError('ROUNDTABLE_ROOM must be a valid room identifier.');
    if(typeof token!=='string' || !token.trim() || /[\r\n]/.test(token))throw new RoundtableError('Set ROUNDTABLE_NATIVE_TOKEN to the private credential supplied by Roundtable.');
    this.base=base;this.room=room;this.#token=token;this.fetch=fetchImpl;this.timeoutMs=timeoutMs;
  }
  static async fromEnvironment({env=process.env,fetchImpl=fetch}={}){
    if(env.ROUNDTABLE_NATIVE_TOKEN)return new RoundtableClient({url:env.ROUNDTABLE_URL || 'http://localhost:3132',room:env.ROUNDTABLE_ROOM || 'plugin-trial',token:env.ROUNDTABLE_NATIVE_TOKEN,fetchImpl});
    const path=env.ROUNDTABLE_NATIVE_CONFIG || join(homedir(),'.config','roundtable','plugin','connection.json');
    let handle;
    try{
      const directory=await lstat(dirname(path));
      if(!directory.isDirectory() || directory.isSymbolicLink() || (process.getuid && (directory.uid!==process.getuid() || (directory.mode&0o777)!==0o700)))throw new RoundtableError('The native connection directory must be owned by you with permissions 0700 and cannot be a symbolic link.');
      if((await lstat(path)).isSymbolicLink())throw new RoundtableError('The protected native connection cannot be a symbolic link.');
      handle=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const file=await handle.stat();
      if(!file.isFile() || file.size>8192 || (process.getuid && (file.uid!==process.getuid() || (file.mode&0o777)!==0o600)))throw new RoundtableError('The native connection file must be owned by you with permissions 0600.');
      let config;try{config=JSON.parse(await handle.readFile('utf8'));}catch{throw new RoundtableError('The native connection file is invalid. Reconnect Roundtable.');}
      if(!config || Array.isArray(config) || typeof config!=='object' || Object.keys(config).some(key=>!['url','room','token'].includes(key)) || ['url','room','token'].some(key=>typeof config[key]!=='string'))throw new RoundtableError('The native connection file is invalid. Reconnect Roundtable.');
      return new RoundtableClient({url:env.ROUNDTABLE_URL || config.url,room:env.ROUNDTABLE_ROOM || config.room,token:config.token,fetchImpl});
    }catch(error){
      if(error instanceof RoundtableError)throw error;
      if(error.code==='ENOENT')throw new RoundtableError('Connect Roundtable first with scripts/connect-native.mjs, or set ROUNDTABLE_NATIVE_TOKEN, ROUNDTABLE_URL, and ROUNDTABLE_ROOM.');
      throw new RoundtableError('Could not read the protected native connection. Check its ownership, permissions, and file type.');
    }finally{await handle?.close();}
  }
  #redact(text){
    let clean=String(text);
    for(const secret of [this.#token,...this.#runTokens.values()])if(secret)clean=clean.split(secret).join('[redacted]');
    return clean;
  }
  #public(value){
    if(typeof value==='string')return this.#redact(value);
    if(Array.isArray(value))return value.map(item=>this.#public(item));
    if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!PRIVATE_FIELDS.has(key) && key!=='token').map(([key,item])=>[key,this.#public(item)]));
    return value;
  }
  async #request(action,args,signal){
    if(!ACTIONS.has(action))throw new RoundtableError('This Roundtable action is unavailable.');
    signal?.throwIfAborted();
    const controller=new AbortController(),abort=()=>controller.abort();
    this.#requests.add(controller);signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,this.timeoutMs);
    try{
      const endpoint=new URL('/api/rooms/'+encodeURIComponent(this.room)+'/native/'+action,this.base);
      const response=await this.fetch(endpoint,{method:'POST',headers:{authorization:'Bearer '+this.#token,'content-type':'application/json',accept:'application/json'},body:JSON.stringify(args),redirect:'error',signal:controller.signal});
      const text=await response.text();
      if(Buffer.byteLength(text)>4*1024*1024)throw new RoundtableError('Roundtable returned too much data. Narrow the request and try again.');
      if(response.status===401 || response.status===403)throw new RoundtableError('Roundtable access was rejected. Reconnect your native credential with the room owner.',response.status);
      let data;try{data=JSON.parse(text);}catch{throw new RoundtableError('Roundtable returned an invalid response.',response.status);}
      if(!response.ok){
        const message=typeof data.error==='string'?data.error:typeof data.message==='string'?data.message:'Roundtable could not complete this action.';
        throw new RoundtableError(this.#redact(message).slice(0,600),response.status);
      }
      if(!data || Array.isArray(data) || typeof data!=='object')throw new RoundtableError('Roundtable returned an invalid result.');
      return data;
    }catch(error){
      if(error instanceof RoundtableError)throw error;
      if(signal?.aborted)throw new RoundtableError('The Roundtable action was cancelled.');
      if(controller.signal.aborted)throw new RoundtableError('Roundtable timed out. Check the connection and retry.');
      throw new RoundtableError('Could not reach Roundtable. Check ROUNDTABLE_URL and your connection.');
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.#requests.delete(controller);}
  }
  async snapshot({signal}={}){
    const result=this.#public(await this.#request('snapshot',{},signal));
    return {...result,claimedRunIds:[...this.#runTokens.keys()]};
  }
  async act(action,args,{signal}={}){
    if(['snapshot','task_claim','task_submit'].includes(action))throw new RoundtableError('Use the dedicated Roundtable action.');
    return this.#public(await this.#request(action,args,signal));
  }
  async claim(args,{signal}={}){
    const result=await this.#request('task_claim',args,signal);
    if(typeof result.run?.id!=='string' || !result.run.id || typeof result.runToken!=='string' || !result.runToken)throw new RoundtableError('Roundtable did not return a usable task claim.');
    this.#runTokens.set(result.run.id,result.runToken);
    return this.#public(result);
  }
  async submit({id,summary,deliverables=[]},{signal}={}){
    const runToken=this.#runTokens.get(id);
    if(!runToken)throw new RoundtableError('Claim this task in the current Roundtable runtime before submitting its result.');
    if(this.#submitting.has(id))throw new RoundtableError('This result is already being submitted.');
    this.#submitting.add(id);
    try{
      const result=await this.#request('task_submit',{id,runToken,summary,deliverables},signal);
      const visible=this.#public(result);this.#runTokens.delete(id);return visible;
    }finally{this.#submitting.delete(id);}
  }
  close(){for(const request of this.#requests)request.abort();this.#runTokens.clear();this.#submitting.clear();}
}
