import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {mkdir,open,rename,rm,lstat,chmod,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createLocalJWKSet,jwtVerify} from 'jose';

const ISSUER='https://auth.openai.com';
const DISCOVERY=ISSUER+'/.well-known/openid-configuration';
const RESOURCE='https://api.openai.com/v1';
const SCOPES='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const ENDPOINTS={authorization_endpoint:ISSUER+'/api/accounts/authorize',token_endpoint:ISSUER+'/api/accounts/oauth/token',revocation_endpoint:ISSUER+'/api/accounts/oauth/revoke',jwks_uri:ISSUER+'/.well-known/jwks.json'};
const TERMINAL_REFRESH=new Set(['invalid_grant','invalid_refresh_token','token_expired','refresh_token_expired','refresh_token_invalidated','refresh_token_reused']);
const NOFOLLOW=constants.O_NOFOLLOW || 0;

function failure(code,message){const error=new Error(message);error.name='ChatGPTAuthError';error.code=code;return error;}
function checkAbort(signal){if(signal?.aborted)throw failure('ABORTED','ChatGPT sign-in was cancelled.');}
function safeEqual(a,b){if(typeof a!=='string' || typeof b!=='string')return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length && timingSafeEqual(left,right);}
function random(){return randomBytes(32).toString('base64url');}
function summary(account){return {id:account.id,clientId:account.clientId,subject:account.subject,email:account.email??null,name:account.name??null,signedIn:Boolean(account.idToken || (account.accessToken && account.refreshToken)),expiresAt:account.expiresAt??null};}
function identity(account){const {id,clientId,subject,email,name}=summary(account);return {id,clientId,subject,email,name};}
function hasPlan(account){return account.scopes?.includes('resource.invoke') && account.scopes?.includes('chatgpt.tokens.use.direct');}
function delay(ms,signal){return new Promise((resolve,reject)=>{checkAbort(signal);const done=()=>{signal?.removeEventListener('abort',cancel);resolve();};const timer=setTimeout(done,ms);const cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(failure('ABORTED','ChatGPT sign-in was cancelled.'));};signal?.addEventListener('abort',cancel,{once:true});});}

async function systemBrowser(url){
  const command=process.platform==='darwin'?'open':process.platform==='win32'?'rundll32':'xdg-open';
  const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
  await new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:'ignore',windowsHide:true});child.once('error',()=>reject(failure('BROWSER_FAILED','Could not open your browser. Check your default browser and try signing in again.')));child.once('exit',code=>code===0?resolve():reject(failure('BROWSER_FAILED','Could not open your browser. Check your default browser and try signing in again.')));});
}

// OAuth credentials remain on the participant's host. Public methods never return
// refresh/ID tokens, and getAccessToken is only for the local app-server process.
export class ChatGPTAuth {
  constructor({directory=join(homedir(),'.config','roundtable','chatgpt'),fetchImpl=globalThis.fetch,openBrowser=systemBrowser,now=Date.now,timeoutMs=10*60*1000,requestTimeoutMs=30000}={}){
    this.directory=directory;this.fetch=fetchImpl;this.openBrowser=openBrowser;this.now=now;this.timeoutMs=timeoutMs;this.requestTimeoutMs=requestTimeoutMs;
    this.file=join(directory,'accounts.json');this.lock=join(directory,'accounts.lock');this.guard=join(directory,'accounts.admission.lock');
    this.discovery=null;this.jwks=null;this.loginPending=false;
  }

  async _prepare(){
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const info=await lstat(this.directory);
    if(!info.isDirectory() || info.isSymbolicLink())throw failure('UNSAFE_STORAGE','ChatGPT credential storage must be a private local directory, not a symbolic link.');
    await chmod(this.directory,0o700);
  }

  async _read(){
    let handle;
    try{
      handle=await open(this.file,constants.O_RDONLY|NOFOLLOW);
      if(!(await handle.stat()).isFile())throw failure('UNSAFE_STORAGE','ChatGPT credential storage is not a regular file.');
      await handle.chmod(0o600);
      const data=JSON.parse(await handle.readFile('utf8'));
      if(data.version!==1 || !/^urn:uuid:[0-9a-f-]{36}$/i.test(data.hostId) || !Array.isArray(data.accounts) || data.accounts.some(a=>!a || typeof a.id!=='string' || typeof a.clientId!=='string' || typeof a.subject!=='string'))throw failure('INVALID_STORAGE','ChatGPT credential storage is invalid. Restore its protected backup or use a new credential directory.');
      return data;
    }catch(error){if(error.code==='ENOENT')return {version:1,hostId:'urn:uuid:'+randomUUID(),activeAccountId:null,accounts:[]};if(error.name==='ChatGPTAuthError')throw error;throw failure('INVALID_STORAGE','Could not read protected ChatGPT credentials. Check the local credential directory permissions.');}
    finally{await handle?.close();}
  }

  async _write(data){
    const temporary=this.file+'.'+randomUUID()+'.tmp';let handle;
    try{handle=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|NOFOLLOW,0o600);await handle.writeFile(JSON.stringify(data));await handle.sync();await handle.close();handle=null;await rename(temporary,this.file);}
    finally{await handle?.close();await rm(temporary,{force:true});}
  }

  async _admission(operation,signal){
    const nonce=randomUUID(),deadline=Date.now()+35000;let owned=false;
    try{
      for(;;){
        checkAbort(signal);let handle;
        try{handle=await open(this.guard,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|NOFOLLOW,0o600);owned=true;await handle.writeFile(JSON.stringify({pid:process.pid,nonce}));await handle.close();handle=null;break;}
        catch(error){await handle?.close();if(error.code!=='EEXIST')throw failure('STORAGE_FAILED','Could not lock protected ChatGPT credentials. Check the credential directory permissions.');}
        try{
          const info=await lstat(this.guard);if(info.isSymbolicLink() || !info.isFile())throw failure('STORAGE_LOCKED','The ChatGPT admission lock is not a regular file. Check the credential directory.');
          const existing=JSON.parse(await readFile(this.guard,'utf8'));
          if(Number.isSafeInteger(existing.pid) && existing.pid>0){try{process.kill(existing.pid,0);}catch(error){if(error.code==='ESRCH')throw failure('STORAGE_LOCKED','A stopped Roundtable process left an admission lock. Confirm no bridge is updating credentials, remove '+this.guard+', and retry.');}}
        }catch(error){if(error.name==='ChatGPTAuthError')throw error;/* A new guard may not have finished writing its owner yet. */}
        if(Date.now()>=deadline)throw failure('STORAGE_LOCKED','Another Roundtable process is updating ChatGPT credentials. Retry after it finishes.');
        await delay(50,signal);
      }
      return await operation();
    }finally{if(owned)await rm(this.guard,{force:true});}
  }

  async _locked(operation,signal){
    checkAbort(signal);await this._prepare();const nonce=randomUUID(),deadline=Date.now()+35000;let owned=false;
    try{
      for(;;){
        // Every admission and stale-owner check uses this short-lived guard.
        // A waiter can never delete a new owner's lock from an old observation.
        owned=await this._admission(async()=>{
          let existing;
          try{const info=await lstat(this.lock);if(info.isSymbolicLink() || !info.isFile())throw new Error();existing=JSON.parse(await readFile(this.lock,'utf8'));if(!Number.isSafeInteger(existing.pid) || existing.pid<=0 || typeof existing.nonce!=='string')throw new Error();}
          catch(error){if(error.code!=='ENOENT')throw failure('STORAGE_LOCKED','The ChatGPT credential lock is unreadable. Check the local credential directory before retrying.');}
          if(existing){let alive=true;try{process.kill(existing.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}if(alive)return false;await rm(this.lock);}
          let handle;
          try{handle=await open(this.lock,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|NOFOLLOW,0o600);await handle.writeFile(JSON.stringify({pid:process.pid,nonce}));return true;}
          finally{await handle?.close();}
        },signal);
        if(owned)break;
        if(Date.now()>=deadline)throw failure('STORAGE_LOCKED','Another Roundtable process is updating ChatGPT credentials. Retry after it finishes.');
        await delay(50,signal);
      }
      const data=await this._read();
      // Persist even empty state once so status and abandoned sign-in attempts do
      // not replace the stable host identifier on the next launch.
      await this._write(data);
      return await operation(data);
    }finally{if(owned){try{await this._admission(async()=>{const current=JSON.parse(await readFile(this.lock,'utf8'));if(current.nonce===nonce)await rm(this.lock,{force:true});});}catch{}}}
  }

  async _request(url,options={},signal,{readJson=true}={}){
    checkAbort(signal);const controller=new AbortController(),cancel=()=>controller.abort();
    const timer=setTimeout(cancel,this.requestTimeoutMs);signal?.addEventListener('abort',cancel,{once:true});
    try{
      const response=await this.fetch(url,{...options,redirect:'error',signal:controller.signal});
      // Keep cancellation and the deadline alive until JSON is fully consumed:
      // fetch resolves at headers, while a stalled body otherwise holds the lock.
      const body=readJson?await response.json():null;
      if(!readJson)await response.body?.cancel();
      return {ok:response.ok,status:response.status,body};
    }
    catch{checkAbort(signal);throw failure('NETWORK_FAILED','Could not reach OpenAI. Check your connection and retry; your saved ChatGPT credentials are preserved.');}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  }

  async _configuration(signal){
    if(this.discovery)return this.discovery;
    const response=await this._request(DISCOVERY,{},signal);let config;
    try{if(!response.ok || !response.body || typeof response.body!=='object')throw new Error();config=response.body;}catch{throw failure('DISCOVERY_FAILED','Could not load OpenAI sign-in configuration. Retry later.');}
    if(config.issuer!==ISSUER || Object.entries(ENDPOINTS).some(([field,value])=>config[field]!==value))throw failure('UNTRUSTED_DISCOVERY','OpenAI sign-in configuration did not match the trusted OpenAI endpoints. Sign-in was stopped.');
    this.discovery=config;return config;
  }

  async _keySet(config,signal,force=false){
    if(this.jwks && !force)return this.jwks;
    const response=await this._request(config.jwks_uri,{},signal);
    try{if(!response.ok)throw new Error();this.jwks=createLocalJWKSet(response.body);return this.jwks;}
    catch{throw failure('IDENTITY_FAILED','Could not load OpenAI identity verification keys. Retry signing in later.');}
  }

  async _verify(idToken,clientId,nonce,config,signal){
    if(typeof idToken!=='string')throw failure('IDENTITY_FAILED','OpenAI did not return a verifiable identity. Try signing in again.');
    try{
      const options={issuer:ISSUER,audience:clientId,requiredClaims:['sub','exp','iat','nonce'],algorithms:['RS256'],clockTolerance:5,currentDate:new Date(this.now())};
      let result;
      try{result=await jwtVerify(idToken,await this._keySet(config,signal),options);}
      catch(error){if(error.code!=='ERR_JWKS_NO_MATCHING_KEY')throw error;result=await jwtVerify(idToken,await this._keySet(config,signal,true),options);}
      if(!safeEqual(result.payload.nonce,nonce) || typeof result.payload.sub!=='string' || !result.payload.sub)throw new Error();
      return result.payload;
    }catch(error){checkAbort(signal);throw failure('IDENTITY_FAILED','ChatGPT identity verification failed. Try signing in again.');}
  }

  _tokens(tokens,existingScopes=[]){
    if(typeof tokens.access_token!=='string' || !tokens.access_token || typeof tokens.refresh_token!=='string' || !tokens.refresh_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in<=0 || tokens.token_type?.toLowerCase()!=='bearer')throw failure('TOKEN_FAILED','OpenAI did not return a usable renewable session. Try signing in again.');
    return {accessToken:tokens.access_token,refreshToken:tokens.refresh_token,expiresAt:this.now()+tokens.expires_in*1000,scopes:typeof tokens.scope==='string'?tokens.scope.split(/\s+/).filter(Boolean):existingScopes};
  }

  async _exchange(config,body,signal){
    const response=await this._request(config.token_endpoint,{method:'POST',headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)},signal);
    const tokens=response.body;if(!tokens || typeof tokens!=='object')throw failure('TOKEN_FAILED','OpenAI could not complete sign-in. Try signing in again.');
    if(!response.ok){const code=TERMINAL_REFRESH.has(tokens?.error)?tokens.error:tokens?.error==='invalid_client'?'invalid_client':'TOKEN_FAILED';throw failure(code,code==='invalid_client'?'The ChatGPT client registration was rejected. Try signing in again.':'OpenAI could not renew this session. Sign in again if the problem continues.');}
    return tokens;
  }

  async status(){return this._locked(async data=>({hostId:data.hostId,activeAccountId:data.activeAccountId,accounts:data.accounts.map(summary)}));}

  async select(accountId){return this._locked(async data=>{const account=data.accounts.find(a=>a.id===accountId);if(!account)throw failure('ACCOUNT_NOT_FOUND','Choose a saved ChatGPT account or sign in to add one.');data.activeAccountId=account.id;await this._write(data);return summary(account);});}

  async login({accountId=null,signal}={}){
    if(this.loginPending)throw failure('SIGN_IN_PENDING','ChatGPT sign-in is already open. Finish or cancel that attempt before starting another.');
    this.loginPending=true;let server,timer,cancel,callback;
    const outerSignal=signal,controller=new AbortController(),cancelOuter=()=>controller.abort();
    this.loginController=controller;outerSignal?.addEventListener('abort',cancelOuter,{once:true});if(outerSignal?.aborted)controller.abort();signal=controller.signal;
    try{
      checkAbort(signal);const snapshot=await this._locked(async data=>{const existing=accountId?data.accounts.find(a=>a.id===accountId):null;if(accountId && !existing)throw failure('ACCOUNT_NOT_FOUND','Choose a saved ChatGPT account or sign in to add one.');return {hostId:data.hostId,existing:existing?structuredClone(existing):null};},signal);
      const config=await this._configuration(signal),state=random(),nonce=random(),verifier=random();
      let resolveCallback,rejectCallback;callback=new Promise((resolve,reject)=>{resolveCallback=resolve;rejectCallback=reject;});callback.catch(()=>{});
      let redirectUri;
      server=createServer((request,response)=>{
        const rejectRequest=(status,message)=>{response.writeHead(status,{'content-type':'text/plain','cache-control':'no-store'});response.end(message);};
        const host=new URL(redirectUri).host;
        if(request.method!=='GET' || request.headers.host!==host || request.socket.remoteAddress!=='127.0.0.1' || (request.headers.origin && request.headers.origin!==new URL(redirectUri).origin)){rejectRequest(400,'Invalid sign-in callback.');return;}
        let url;try{url=new URL(request.url,redirectUri);}catch{rejectRequest(400,'Invalid sign-in callback.');return;}
        if(url.origin!==new URL(redirectUri).origin || url.pathname!=='/auth/callback'){rejectRequest(404,'Not found.');return;}
        if(url.searchParams.getAll('state').length!==1 || !safeEqual(url.searchParams.get('state'),state)){rejectRequest(400,'Sign-in could not be verified.');return;}
        if(url.searchParams.has('error')){rejectRequest(400,'ChatGPT sign-in was not authorized. You can close this window.');rejectCallback(failure('CONSENT_DECLINED','ChatGPT sign-in was not authorized. Try again when you want to connect your plan.'));return;}
        const code=url.searchParams.get('code'),issuedClient=url.searchParams.get('client_id');
        if(url.searchParams.getAll('code').length!==1 || !code || url.searchParams.getAll('client_id').length>1 || (!snapshot.existing && (!issuedClient || !/^oaiapp_[A-Za-z0-9_-]+$/.test(issuedClient))) || (snapshot.existing && issuedClient && issuedClient!==snapshot.existing.clientId)){rejectRequest(400,'Sign-in registration could not be verified.');rejectCallback(failure('REGISTRATION_FAILED','ChatGPT returned an unexpected client registration. Try signing in again.'));return;}
        response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; frame-ancestors 'none'"});response.end('<!doctype html><title>Roundtable</title><p>ChatGPT returned to Roundtable. You can close this window and return to the Roundtable companion. It will update when your AI is connected.</p>');
        resolveCallback({code,clientId:snapshot.existing?.clientId || issuedClient});
      });
      await new Promise((resolve,reject)=>{server.once('error',()=>reject(failure('CALLBACK_FAILED','Could not start the local ChatGPT callback. Check local networking and retry.')));server.listen(0,'127.0.0.1',resolve);});
      redirectUri='http://127.0.0.1:'+server.address().port+'/auth/callback';
      timer=setTimeout(()=>rejectCallback(failure('SIGN_IN_TIMEOUT','ChatGPT sign-in timed out. Start sign-in again.')),this.timeoutMs);
      cancel=()=>rejectCallback(failure('ABORTED','ChatGPT sign-in was cancelled.'));signal?.addEventListener('abort',cancel,{once:true});checkAbort(signal);
      const authorization=new URL(config.authorization_endpoint);
      authorization.search=new URLSearchParams({client_id:snapshot.existing?.clientId || 'dynamic_agent_client',ext_agent_host_id:snapshot.hostId,response_type:'code',redirect_uri:redirectUri,scope:SCOPES,resource:RESOURCE,state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')}).toString();
      if(!snapshot.existing)authorization.searchParams.set('agent_name_hint','roundtable-workspace');
      else{if(snapshot.existing.idToken)authorization.searchParams.set('id_token_hint',snapshot.existing.idToken);if(snapshot.existing.email)authorization.searchParams.set('login_hint',snapshot.existing.email);if(!hasPlan(snapshot.existing))authorization.searchParams.set('prompt','consent');}
      // Never log this URL: returning sign-in may include the retained ID token.
      const browser=Promise.resolve().then(()=>this.openBrowser(authorization.toString())).catch(()=>{throw failure('BROWSER_FAILED','Could not open your browser. Check your default browser and try signing in again.');});
      const result=await Promise.race([callback,browser.then(()=>callback)]);checkAbort(signal);
      server.close();server.closeAllConnections?.();
      const tokens=await this._exchange(config,{grant_type:'authorization_code',client_id:result.clientId,code:result.code,code_verifier:verifier,redirect_uri:redirectUri,resource:RESOURCE},signal);
      const verified=await this._verify(tokens.id_token,result.clientId,nonce,config,signal);
      if(snapshot.existing && verified.sub!==snapshot.existing.subject)throw failure('IDENTITY_MISMATCH','The returned ChatGPT account did not match the selected account. Sign-in was stopped.');
      const grantedScopes=typeof tokens.scope==='string'?tokens.scope.split(/\s+/).filter(Boolean):[];
      const planEnabled=hasPlan({scopes:grantedScopes});
      const tokenRecord=planEnabled || tokens.access_token || tokens.refresh_token?this._tokens(tokens):{scopes:grantedScopes,expiresAt:null};
      return await this._locked(async data=>{
        checkAbort(signal);
        let account=data.accounts.find(a=>a.clientId===result.clientId && a.subject===verified.sub);
        if(data.accounts.some(a=>a.clientId===result.clientId && a.subject!==verified.sub))throw failure('IDENTITY_MISMATCH','This ChatGPT registration is already associated with another identity. Sign-in was stopped.');
        if(!account){account={id:randomUUID(),clientId:result.clientId,subject:verified.sub};data.accounts.push(account);}
        for(const key of ['accessToken','refreshToken','idToken','expiresAt','scopes'])delete account[key];
        Object.assign(account,tokenRecord,{idToken:tokens.id_token,email:typeof verified.email==='string'?verified.email:null,name:typeof verified.name==='string'?verified.name:null});
        data.activeAccountId=account.id;await this._write(data);return summary(account);
      },signal);
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);outerSignal?.removeEventListener('abort',cancelOuter);if(server?.listening){server.close();server.closeAllConnections?.();}this.loginPending=false;this.loginController=null;}
  }

  async getAccessToken({accountId=null,signal}={}){
    return this._locked(async data=>{
      const account=data.accounts.find(a=>a.id===(accountId || data.activeAccountId));
      if(!account || !summary(account).signedIn)throw failure('SIGN_IN_REQUIRED','Sign in with ChatGPT before starting a task.');
      if(!hasPlan(account))throw failure('PLAN_PERMISSION_REQUIRED','Enable ChatGPT plan usage by signing in again and approving plan access before starting a task.');
      if(!account.accessToken || !account.refreshToken)throw failure('SIGN_IN_REQUIRED','Sign in with ChatGPT before starting a task.');
      if(account.expiresAt<=this.now()+60000){
        const config=await this._configuration(signal);let tokens;
        try{tokens=await this._exchange(config,{grant_type:'refresh_token',client_id:account.clientId,refresh_token:account.refreshToken,resource:RESOURCE},signal);}
        catch(error){if(TERMINAL_REFRESH.has(error.code)){for(const key of ['accessToken','refreshToken','idToken','expiresAt','scopes'])delete account[key];await this._write(data);throw failure('SIGN_IN_REQUIRED','Your ChatGPT session ended. Sign in again before starting a task.');}throw error;}
        Object.assign(account,this._tokens(tokens,account.scopes));await this._write(data);
        if(!hasPlan(account))throw failure('PLAN_PERMISSION_REQUIRED','ChatGPT plan permission is no longer enabled. Sign in again and approve plan access.');
      }
      return {accessToken:account.accessToken,expiresAt:account.expiresAt,account:identity(account)};
    },signal);
  }

  async logout({accountId=null}={}){
    this.loginController?.abort();
    return this._locked(async data=>{
      const account=data.accounts.find(a=>a.id===(accountId || data.activeAccountId));
      if(!account)throw failure('ACCOUNT_NOT_FOUND','Choose a saved ChatGPT account before signing out.');
      let revoked=!account.refreshToken;
      if(account.refreshToken){try{const config=await this._configuration();const response=await this._request(config.revocation_endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:account.refreshToken,token_type_hint:'refresh_token',client_id:account.clientId})},undefined,{readJson:false});revoked=response.status===200;}catch{revoked=false;}}
      for(const key of ['accessToken','refreshToken','idToken','expiresAt','scopes'])delete account[key];
      await this._write(data);return {revoked,account:summary(account)};
    });
  }
}
