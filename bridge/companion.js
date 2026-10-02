import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {realpath,stat,mkdir,lstat} from 'node:fs/promises';
import {isAbsolute,resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';

export const DEFAULT_COMPANION_PORT=4146;
export const DEFAULT_BACKEND_ORIGINS=['https://private-hybrid-backend-private-hybrid-trial.up.railway.app'];
export const DEFAULT_ROOM_ORIGINS=['https://roundtable-plugin-trial.ameckes.chatgpt.site'];
const TOKEN=/^[A-Za-z0-9_-]{32,256}$/;
const ID=/^[A-Za-z0-9_-]{1,80}$/;
const MAX_BODY=8192;
const ENV_KEYS=['PATH','HOME','USER','LOGNAME','SHELL','LANG','LC_ALL','LC_CTYPE','TZ','TMPDIR','TMP','TEMP','APPDATA','LOCALAPPDATA','SystemRoot','SYSTEMROOT','WINDIR','PATHEXT','PROGRAMFILES','CODEX_HOME'];
const failure=(status,message)=>Object.assign(new Error(message),{status});
const same=(left,right)=>typeof left==='string' && typeof right==='string' && Buffer.byteLength(left)===Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left),Buffer.from(right));
function object(value,keys,required=keys){
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!keys.includes(key)) || required.some(key=>!Object.hasOwn(value,key)))throw failure(400,'The room connection is invalid. Start again from Connect my AI in the room.');
}
function label(value,max){
  if(typeof value!=='string' || !value.trim() || value.length>max || /[\x00-\x1f\x7f]/.test(value))throw failure(400,'The room connection has invalid account details.');
  return value.trim();
}
function permittedOrigin(value,allowed){
  let url;try{url=new URL(value);}catch{throw failure(400,'The room backend address is invalid.');}
  const local=['127.0.0.1','localhost'].includes(url.hostname);
  if(typeof value!=='string' || url.origin!==value || url.username || url.password || (url.protocol!=='https:' && !(local && url.protocol==='http:')) || !allowed.includes(url.origin))throw failure(400,'This backend is not trusted by the local companion.');
  return url.origin;
}

// The fragment supplies a room-scoped grant, never a runtime credential or a
// command. Backend acceptance, rather than these labels, verifies membership.
export function validatePairPackage(value,{backendOrigins=DEFAULT_BACKEND_ORIGINS,roomOrigins=DEFAULT_ROOM_ORIGINS,now=Date.now}={}){
  object(value,['version','backendOrigin','room','member','pairToken','expiresAt']);
  object(value.room,['id','title','url'],['id','title']);object(value.member,['id','name']);
  if(value.version!==1 || typeof value.room.id!=='string' || !ID.test(value.room.id) || typeof value.member.id!=='string' || !ID.test(value.member.id) || typeof value.pairToken!=='string' || !TOKEN.test(value.pairToken))throw failure(400,'The room connection is invalid. Start again from Connect my AI in the room.');
  const time=now();if(!Number.isSafeInteger(value.expiresAt) || value.expiresAt<=time || value.expiresAt>time+30*60_000)throw failure(400,'This connection link expired. Create a new one in the room.');
  const backendOrigin=permittedOrigin(value.backendOrigin,backendOrigins);
  let roomUrl=new URL('/s/'+value.room.id,backendOrigin).href;
  if(value.room.url!==undefined){
    let url;try{url=new URL(value.room.url);}catch{throw failure(400,'The room link is invalid.');}
    permittedOrigin(url.origin,[...roomOrigins,...backendOrigins]);
    if(url.username || url.password || url.search || url.hash || url.pathname!=='/s/'+value.room.id)throw failure(400,'The room link is invalid.');
    roomUrl=url.href;
  }
  return {version:1,backendOrigin,room:{id:value.room.id,title:label(value.room.title,160),url:roomUrl},member:{id:value.member.id,name:label(value.member.name,120)},pairToken:value.pairToken,expiresAt:value.expiresAt};
}

export function companionChildEnvironment(token,source=process.env){
  return {...Object.fromEntries(ENV_KEYS.filter(key=>typeof source[key]==='string').map(key=>[key,source[key]])),ROUNDTABLE_PAIR_TOKEN:token};
}
function publicPackage(value){return {backendOrigin:value.backendOrigin,room:{...value.room},member:{...value.member},expiresAt:value.expiresAt};}
function jsonScript(value){return JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');}
function page({csrf,projectPath,nonce}){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect your AI · Roundtable</title><style nonce="${nonce}">
  :root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#21252f;background:#f7f8fb;font-size:16px}*{box-sizing:border-box}body{margin:0;padding:36px 20px}main{max-width:580px;margin:auto;background:white;border:1px solid #e1e4ee;border-radius:20px;padding:30px;box-shadow:0 12px 38px #222b4110}.brand{font-weight:650;color:#465ee7;font-size:14px;margin:0 0 26px}h1{font-size:29px;letter-spacing:-1px;line-height:1.2;margin:0 0 12px}p{line-height:1.55;margin:10px 0;color:#667086}.details{padding:16px;background:#f7f8fb;border-radius:12px;margin:22px 0}.details strong{display:block;font-size:17px;margin-bottom:6px}.details p{font-size:14px;margin:4px 0;overflow-wrap:anywhere}.auth-choice{display:block;padding:14px;border:1px solid #e1e4ee;border-radius:11px;margin:9px 0;cursor:pointer}.auth-choice:has(input:checked){border-color:#465ee7;background:#f6f7ff}.auth-choice input{margin-right:8px}.auth-choice small{display:block;margin:7px 0 0 25px;color:#667086;font-size:13px}button,.return{font:inherit;display:block;width:100%;padding:13px 16px;border-radius:10px;margin:12px 0;border:1px solid #e1e4ee;background:white;color:#313b50;font-weight:600;cursor:pointer;text-align:center;text-decoration:none}button.primary{background:#465ee7;color:white;border-color:#465ee7}button:disabled{opacity:.55;cursor:default}.fine{font-size:13px;color:#7a8496}details{margin:22px 0}summary{font-size:14px;cursor:pointer;color:#566176}label.project{display:block;font-size:14px;margin:13px 0 6px}input[type=text]{width:100%;font:inherit;font-size:14px;padding:10px;border:1px solid #e1e4ee;border-radius:8px}.status{border-top:1px solid #e1e4ee;margin-top:24px;padding-top:16px}.status strong{font-size:15px}.status p{font-size:14px}.status.error strong{color:#b64242}[hidden]{display:none!important}@media(max-width:520px){body{padding:14px}main{padding:23px 20px}h1{font-size:26px}}
  </style></head><body><main><p class="brand">Roundtable · Local companion</p><h1>Bring your AI to the room</h1><p id="intro">Confirm your room and account, then connect your AI. Replies appear in the shared conversation.</p><section id="connection" class="details" hidden><strong id="room-title"></strong><p id="member"></p><p id="backend"></p></section><section id="choices"><label class="auth-choice"><input type="radio" name="auth" value="chatgpt-plan" checked>Continue with ChatGPT<small>Use your ChatGPT plan. Sign in opens your system browser when needed.</small></label><label class="auth-choice"><input type="radio" name="auth" value="codex">Use my Codex login<small>Use the ChatGPT account already signed in to Codex on this computer.</small></label><details><summary>Local project access</summary><label for="project" class="project">Folder for assigned tasks</label><input id="project" type="text" autocomplete="off" spellcheck="false"><p class="fine">Conversation replies use shared room context only. Assigned tasks work in this folder after a separate action in the room.</p></details><button id="connect" class="primary" disabled>Connect with ChatGPT</button><p class="fine">This connects your own local AI runtime. It does not import your private ChatGPT conversations.</p></section><section id="status" class="status" role="status" aria-live="polite"><strong id="phase">Waiting for a room</strong><p id="message">Open Connect my AI in your Roundtable room to continue.</p></section><a id="return" class="return" hidden target="_blank" rel="noopener noreferrer">Return to the room</a><button id="stop" hidden>Disconnect my AI</button></main><script nonce="${nonce}">
  const boot=${jsonScript({csrf,projectPath})};
  const $=id=>document.getElementById(id);let pair=null,busy=false,active=false,stopping=false,projectChosen=false,occupied=false;
  $('project').value=boot.projectPath;
  const requestedAuth=new URLSearchParams(location.search).get('auth');if(['chatgpt-plan','codex'].includes(requestedAuth))document.querySelector('[name=auth][value="'+requestedAuth+'"]').checked=true;
  function show(phase,message,error=false){$('phase').textContent=phase;$('message').textContent=message;$('status').classList.toggle('error',error);}
  async function api(path,body){const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'x-roundtable-csrf':boot.csrf,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();if(!response.ok)throw new Error(data.error || 'The local companion could not continue.');return data;}
  function controls(){const auth=document.querySelector('[name=auth]:checked').value;$('connect').textContent=auth==='codex'?'Connect with Codex':'Connect with ChatGPT';$('connect').disabled=!pair || busy || active;for(const input of document.querySelectorAll('#choices input'))input.disabled=busy || active;$('stop').hidden=occupied || (!active && !busy);$('stop').disabled=stopping;}
  function render(state){occupied=state.phase==='occupied';active=['connected','starting','signing_in','connecting','stopping'].includes(state.phase);busy=occupied || ['starting','signing_in','connecting','stopping'].includes(state.phase);const names={idle:'Ready to connect',occupied:'Another window is connected',starting:'Starting your AI',signing_in:'Continue in your browser',connecting:'Joining the room',connected:'Your AI is connected',stopping:'Disconnecting',stopped:'Your AI is disconnected',failed:'Connection did not finish'};show(names[state.phase] || 'Ready to connect',state.message,state.phase==='failed');if(state.projectPath && !projectChosen)$('project').value=state.projectPath;if(state.connection){$('connection').hidden=false;$('room-title').textContent=state.connection.room.title;$('member').textContent='Connecting as '+state.connection.member.name;$('backend').textContent='Backend: '+new URL(state.connection.backendOrigin).hostname;if(state.phase==='connected'){$('member').textContent='Connected as '+state.connection.member.name;$('return').href=state.connection.room.url;$('return').hidden=false;}}if(state.phase!=='connected')$('return').hidden=true;controls();}
  const fragment=location.hash.slice(1);if(fragment)history.replaceState(null,'',location.pathname);
  async function prepare(){if(!fragment)return;try{if(fragment.length>14000)throw new Error('This connection link is too large.');let encoded=decodeURIComponent(fragment),text;if(encoded.startsWith('{'))text=encoded;else{if(!/^[A-Za-z0-9_-]+$/.test(encoded))throw new Error('This connection link is invalid.');const binary=atob(encoded.replace(/-/g,'+').replace(/_/g,'/')),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}pair=JSON.parse(text);const state=await api('/api/prepare',{package:pair});render(state);if(state.phase==='idle')show('Confirm room and account','Select your login and click Connect. No AI has started yet.');}catch(error){pair=null;show('Connection link unavailable',error.message,true);}controls();}
  $('connect').addEventListener('click',async()=>{if(!pair || busy || active)return;busy=true;controls();show('Starting your AI','Checking the local folder and starting your selected runtime…');try{const state=await api('/api/connect',{package:pair,authMode:document.querySelector('[name=auth]:checked').value,projectPath:$('project').value});render(state);pair=null;}catch(error){busy=false;show('Connection did not finish',error.message,true);controls();}});
  $('stop').addEventListener('click',async()=>{if(stopping)return;stopping=true;controls();try{render(await api('/api/stop',{}));}catch(error){show('Could not disconnect',error.message,true);}finally{stopping=false;controls();}});
  for(const radio of document.querySelectorAll('[name=auth]'))radio.addEventListener('change',controls);
  $('project').addEventListener('input',()=>{projectChosen=true;});
  async function refresh(){try{const state=await api('/api/status');if(state.phase!=='idle' || active || busy)render(state);}catch(error){if(active || busy)show('Local companion unavailable','The local companion stopped. Restart it and create a new connection in the room.',true);}}
  prepare();setInterval(refresh,1500);
  </script></body></html>`;
}

export function createCompanion({projectPath=null,projectRoot=join(homedir(),'Documents','Roundtable'),backendOrigins=DEFAULT_BACKEND_ORIGINS,roomOrigins=DEFAULT_ROOM_ORIGINS,spawnBridge=spawn,environment=process.env,now=Date.now,port=DEFAULT_COMPANION_PORT}={}){
  if(!Number.isInteger(port) || port<0 || port>65535)throw new Error('Companion port must be a valid local port.');
  for(const origin of backendOrigins)permittedOrigin(origin,backendOrigins);
  const sessions=new Map();let child=null,owner=null,generation=0,phase='idle',message='Choose a room connection to bring your AI into the conversation.',connection=null,selectedProject=null,closed=false,savedConversationCount=null,hasConnected=false;
  let rateStart=now(),mutations=0,connects=0;
  const defaultProject=room=>projectPath || join(projectRoot,room);
  const bridgeFile=fileURLToPath(new URL('./workspace.js',import.meta.url));
  let listeningPort=port;
  const cookieName=()=> 'roundtable_companion_'+listeningPort;
  function session(req){
    const cookie=req.headers.cookie?.split(';').map(value=>value.trim()).find(value=>value.startsWith(cookieName()+'='))?.slice(cookieName().length+1);
    // The owner's existing secret cookie remains valid while its runtime is
    // alive, even after the tab has been closed for an hour. A different cookie
    // cannot reclaim the child; Origin and cookie-bound CSRF remain required.
    const value=sessions.get(cookie),ownsRuntime=cookie===owner && (child || ['starting','signing_in','connecting','stopping'].includes(phase));
    if(value && (value.expiresAt>now() || ownsRuntime)){if(cookie===owner)value.expiresAt=now()+60*60_000;return {id:cookie,...value};}return null;
  }
  function issue(req,res){
    for(const [id,value] of sessions)if(value.expiresAt<=now() && id!==owner)sessions.delete(id);
    let current=session(req);if(current)return current;
    if(sessions.size>=32){const discard=[...sessions.keys()].find(id=>id!==owner);if(discard)sessions.delete(discard);}
    const id=randomBytes(24).toString('base64url'),csrf=randomBytes(24).toString('base64url'),expiresAt=now()+60*60_000;
    // Site → localhost is a cross-site top-level GET. Lax preserves the existing
    // control session on that navigation; mutating APIs still require Origin +
    // the cookie-bound CSRF token and cannot run from a foreign page.
    sessions.set(id,{csrf,expiresAt});res.setHeader('set-cookie',cookieName()+'='+id+'; HttpOnly; SameSite=Lax; Path=/');return {id,csrf,expiresAt};
  }
  function view(current){
    if(owner && current?.id!==owner && (child || ['starting','signing_in','connecting','stopping'].includes(phase)))return {phase:'occupied',message:'Another browser session owns this local AI connection. Use the window where it was connected.'};
    if(owner && current?.id!==owner)return {phase:'idle',message:'Choose a room connection to bring your AI into the conversation.'};
    return {phase,message,projectPath:selectedProject || (connection?defaultProject(connection.room.id):projectPath),...(connection?{connection:structuredClone(connection)}:{}),...(savedConversationCount!==null?{savedConversationCount}:{})};
  }
  function send(res,status,value){res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
  function trusted(req,res){
    const hosts=['127.0.0.1:'+listeningPort,'localhost:'+listeningPort];
    if(!hosts.includes(req.headers.host) || !['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)){send(res,403,{error:'This companion accepts only local requests.'});return false;}
    const origin='http://'+req.headers.host;
    if(req.headers.origin && req.headers.origin!==origin){send(res,403,{error:'Open this page in the local companion to continue.'});return false;}
    return true;
  }
  function protect(req,res){
    const current=session(req),origin='http://'+req.headers.host;
    if(req.headers['sec-fetch-site']==='cross-site' || (req.method==='POST' && req.headers.origin!==origin) || !current || !same(current.csrf,req.headers['x-roundtable-csrf'])){send(res,403,{error:'This local session could not be verified. Reload the companion and try again.'});return null;}
    return current;
  }
  async function body(req){
    if(req.headers['content-type']?.split(';')[0]!=='application/json')throw failure(415,'The companion requires a JSON request.');
    const declared=Number(req.headers['content-length']);if(Number.isFinite(declared) && declared>MAX_BODY)throw failure(413,'The connection request is too large.');
    const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>MAX_BODY)throw failure(413,'The connection request is too large.');chunks.push(chunk);}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw failure(400,'The connection request is invalid.');}
  }
  function stop(){
    if(child){phase='stopping';message='Stopping your local AI connection…';child.kill('SIGTERM');}
    else {generation++;phase='stopped';message='Your AI is disconnected. Create a new connection from the room to reconnect.';}
  }
  function consumeOutput(stream,myGeneration,readyPrefix,acceptReadiness=false){
    let buffer='';stream?.on('data',chunk=>{
      // Runtime output can include untrusted project text and private errors.
      // Recognize only fixed lifecycle notices; never expose raw logs.
      const text=chunk.toString('utf8');if(text.length>8192){buffer='';return;}buffer+=text;
      if(buffer.length>16384){buffer='';return;}
      for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);if(myGeneration!==generation || phase==='stopping')continue;
        if(line.startsWith('Continue with ChatGPT in your system browser.')){phase='signing_in';message='Finish ChatGPT sign-in in your system browser. This page will update when your AI is ready.';}
        else if(line.startsWith('Using your ChatGPT plan.')){phase='connecting';message='Your ChatGPT plan is authorized. Joining the shared room…';}
        else if(line.startsWith('Local Codex project: ')){phase='connecting';message='Your local runtime is ready. Waiting for the room to accept this connection…';}
        else if(line==='Roundtable connection interrupted. Reconnecting…'){phase='connecting';message='The room connection was interrupted. Your local AI is reconnecting…';}
        else if(acceptReadiness && line.startsWith(readyPrefix)){
          const match=line.slice(readyPrefix.length).match(/^.{1,256}\. Saved conversations: (0|[1-9]\d{0,4})$/);
          if(match && Number(match[1])<=10000){savedConversationCount=Number(match[1]);hasConnected=true;phase='connected';message=(savedConversationCount?savedConversationCount+' saved room conversation'+(savedConversationCount===1?' is':'s are')+' ready to continue. ':'')+'Your AI is ready for read-only conversation replies in the room. Keep this companion running.';}
        }
        else if(line==='Codex runtime exited. Reconnect to restore saved sessions.'){phase='failed';message='The local AI runtime stopped. Create a new connection in the room to reconnect.';}
        else if(line==='Connection revoked or pairing invalid. Generate a new connection command in the room.'){phase=hasConnected?'stopped':'failed';message=hasConnected?'Your AI is disconnected from the room. Saved room conversations are kept on this computer. Create a new connection in the room to reconnect.':'The room rejected this connection. Create a new connection in the room.';}
        else if(/spawn codex ENOENT/.test(line)){phase='failed';message='Codex is unavailable on this computer. Install or sign in to Codex, then reconnect from the room.';}
        else if(line.includes('Sign in to Codex with your ChatGPT account, or use Continue with ChatGPT. API-key authentication cannot connect this runtime.')){phase='failed';message='Sign in to Codex with your ChatGPT account, or reconnect using Continue with ChatGPT.';}
      }
    });
  }
  const server=createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');
    if(!trusted(req,res))return;
    let url;try{url=new URL(req.url,'http://'+req.headers.host);}catch{send(res,400,{error:'Invalid local request.'});return;}
    const pageRequest=req.method==='GET' && ['/', '/connect'].includes(url.pathname);
    const authQuery=pageRequest && [...url.searchParams.keys()].every(key=>key==='auth') && url.searchParams.getAll('auth').length===1 && ['chatgpt-plan','codex'].includes(url.searchParams.get('auth'));
    if((url.search && !authQuery) || url.hash || url.origin!=='http://'+req.headers.host){send(res,400,{error:'Connection grants belong in the URL fragment, not request parameters.'});return;}
    if(req.method==='GET' && ['/', '/connect'].includes(url.pathname)){
      const current=issue(req,res),nonce=randomBytes(18).toString('base64url');
      res.setHeader('content-security-policy',"default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'nonce-"+nonce+"'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(page({csrf:current.csrf,projectPath:projectPath || '',nonce}));return;
    }
    if(!['/api/status','/api/prepare','/api/connect','/api/stop'].includes(url.pathname)){send(res,404,{error:'Not found.'});return;}
    if((url.pathname==='/api/status' && req.method!=='GET') || (url.pathname!=='/api/status' && req.method!=='POST')){send(res,405,{error:'Method not allowed.'});return;}
    const current=protect(req,res);if(!current)return;
    try{
      if(url.pathname==='/api/status'){send(res,200,view(current));return;}
      if(now()-rateStart>=60_000){rateStart=now();mutations=0;connects=0;}
      if(++mutations>60 || (url.pathname==='/api/connect' && ++connects>6))throw failure(429,'Too many connection attempts. Wait a minute before trying again.');
      const input=await body(req);
      if(url.pathname==='/api/prepare'){
        object(input,['package']);const pairing=validatePairPackage(input.package,{backendOrigins,roomOrigins,now});
        if(child || ['starting','signing_in','connecting','stopping'].includes(phase)){send(res,200,view(current));return;}
        send(res,200,{phase:'idle',message:'Confirm the room and account, then click Connect.',projectPath:defaultProject(pairing.room.id),connection:publicPackage(pairing)});return;
      }
      if(url.pathname==='/api/stop'){
        object(input,[]);if(owner && owner!==current.id)throw failure(403,'Only the browser session that connected this AI can disconnect it.');stop();send(res,200,view(current));return;
      }
      object(input,['package','authMode','projectPath'],['package','authMode']);
      if(child || ['starting','signing_in','connecting','stopping'].includes(phase))throw failure(409,'This companion already has an AI connection. Disconnect it before connecting another room.');
      if(!['chatgpt-plan','codex'].includes(input.authMode))throw failure(400,'Choose Continue with ChatGPT or Use my Codex login.');
      const pairing=validatePairPackage(input.package,{backendOrigins,roomOrigins,now});
      const requestedPath=input.projectPath || defaultProject(pairing.room.id);
      if(typeof requestedPath!=='string' || requestedPath.length>4096 || !isAbsolute(requestedPath) || /[\x00-\x1f]/.test(requestedPath))throw failure(400,'Choose an absolute local folder path.');
      // Reserve the connection before asynchronous folder validation.
      owner=current.id;phase='starting';message='Checking your local folder and starting your AI…';connection=publicPackage(pairing);selectedProject=null;savedConversationCount=null;hasConnected=false;const myGeneration=++generation;
      let localProject;try{
        if(!projectPath && requestedPath===defaultProject(pairing.room.id)){
          await mkdir(projectRoot,{recursive:true,mode:0o700});const base=await lstat(projectRoot);if(!base.isDirectory() || base.isSymbolicLink())throw new Error();
          await mkdir(requestedPath,{recursive:true,mode:0o700});const folder=await lstat(requestedPath);if(!folder.isDirectory() || folder.isSymbolicLink())throw new Error();
        }
        localProject=await realpath(requestedPath);if(!(await stat(localProject)).isDirectory())throw new Error();
      }catch{if(generation===myGeneration){phase='failed';message='The selected local folder is unavailable. Choose an existing folder and try again.';}throw failure(400,'The selected local folder is unavailable. Choose an existing folder and try again.');}
      if(closed || generation!==myGeneration)throw failure(409,'This connection attempt was cancelled.');
      selectedProject=localProject;const roomUrl=new URL('/s/'+pairing.room.id,pairing.backendOrigin).href;
      try{child=spawnBridge(process.execPath,[bridgeFile,roomUrl,'--project',localProject,'--workspace-mode','folder','--auth',input.authMode,'--expected-owner',pairing.member.id],{cwd:resolve(localProject),env:companionChildEnvironment(pairing.pairToken,environment),stdio:['ignore','pipe','pipe'],windowsHide:true});}
      catch{phase='failed';message='The local AI runtime could not start. Create a new connection in the room and retry.';throw failure(500,message);}
      const running=child,readyPrefix='Your Codex is connected to '+roomUrl+' for ';
      consumeOutput(running.stdout,myGeneration,readyPrefix,true);consumeOutput(running.stderr,myGeneration,readyPrefix);
      running.once('error',()=>{if(generation!==myGeneration)return;child=null;phase='failed';message='The local AI runtime could not start. Check that Codex is available, then reconnect from the room.';});
      running.once('exit',()=>{if(generation!==myGeneration)return;child=null;if(phase==='stopping' || phase==='stopped'){phase='stopped';message='Your AI is disconnected. Saved room conversations are kept on this computer. Create a new connection from the room to reconnect.';}else if(phase!=='failed'){phase='failed';message='The local AI runtime stopped before or during the connection. Create a new connection in the room to retry.';}});
      send(res,202,view(current));
    }catch(error){send(res,error.status || 500,{error:error.status?error.message:'The local companion could not complete this request.'});}
  });
  server.requestTimeout=15_000;server.headersTimeout=10_000;server.maxHeadersCount=40;
  return {server,async listen(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});listeningPort=server.address().port;return 'http://127.0.0.1:'+listeningPort;},async close(){closed=true;stop();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));},get state(){return {phase,message};}};
}
