import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readFile,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest,createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {ChatGPTAuth} from '../bridge/chatgpt-auth.js';

const issuer='https://auth.openai.com';
const endpoints={issuer,authorization_endpoint:issuer+'/api/accounts/authorize',token_endpoint:issuer+'/api/accounts/oauth/token',revocation_endpoint:issuer+'/api/accounts/oauth/revoke',jwks_uri:issuer+'/.well-known/jwks.json'};
const scopes='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const keyPromise=generateKeyPair('RS256');

async function fixture(t,overrides={}){
  const directory=await mkdtemp(join(tmpdir(),'rt-chatgpt-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const key=await keyPromise,jwk=await exportJWK(key.publicKey);jwk.kid='fixture';jwk.alg='RS256';
  const state={clock:Date.now(),clientId:'oaiapp_fixture',subject:'subject-one',email:'same@example.com',authorization:null,tokenCalls:[],revokeCalls:[],refreshCount:0,...overrides};
  const fetchImpl=async(url,options={})=>{
    assert.equal(options.redirect,'error');
    if(url===issuer+'/.well-known/openid-configuration')return Response.json({...endpoints,...state.discovery});
    if(url===endpoints.jwks_uri)return Response.json({keys:[jwk]});
    if(url===endpoints.token_endpoint){
      const body=new URLSearchParams(options.body);state.tokenCalls.push(Object.fromEntries(body));
      if(body.get('grant_type')==='refresh_token'){
        state.refreshCount++;if(state.refreshError)return Response.json({error:state.refreshError,error_description:'secret-server-diagnostic'}, {status:400});
        if(state.refreshNetworkError)throw new Error('private response secret');
        await new Promise(resolve=>setTimeout(resolve,10));
        return Response.json({access_token:'rotated-access-'+state.refreshCount,refresh_token:'rotated-refresh-'+state.refreshCount,token_type:'Bearer',expires_in:3600,scope:state.refreshScopes??scopes});
      }
      assert.equal(body.get('resource'),'https://api.openai.com/v1');
      assert.equal(body.get('redirect_uri'),state.authorization.searchParams.get('redirect_uri'));
      assert.equal(body.get('client_id'),state.clientId);
      assert.equal(state.authorization.searchParams.get('code_challenge'),(await import('node:crypto')).createHash('sha256').update(body.get('code_verifier')).digest('base64url'));
      const signingKey=state.badSignature?(await generateKeyPair('RS256')).privateKey:key.privateKey;
      const payload={sub:state.subject,email:state.email,name:'Fixture User',nonce:state.authorization.searchParams.get('nonce'),...state.claims};
      const token=await new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer(state.jwtIssuer??issuer).setAudience(state.jwtAudience??state.clientId).setIssuedAt(Math.floor(state.clock/1000)).setExpirationTime(Math.floor(state.clock/1000)+(state.expired?-60:3600)).sign(signingKey);
      return Response.json(state.identityOnly?{id_token:token,scope:'openid profile email'}:{access_token:'initial-access-secret',refresh_token:'initial-refresh-secret',id_token:token,token_type:'Bearer',expires_in:3600,scope:state.grantedScopes??scopes});
    }
    if(url===endpoints.revocation_endpoint){state.revokeCalls.push(Object.fromEntries(new URLSearchParams(options.body)));return new Response(null,{status:state.revokeStatus??200});}
    throw new Error('Unexpected fixture URL');
  };
  const openBrowser=async value=>{
    state.authorization=new URL(value);
    const callback=new URL(state.authorization.searchParams.get('redirect_uri'));
    state.callback=callback;
    if(state.beforeCallback)await state.beforeCallback(callback,state);
    if(state.noCallback)return;
    callback.search=new URLSearchParams({code:'one-time-code',state:state.authorization.searchParams.get('state'),...(state.callbackClientId===null?{}:{client_id:state.callbackClientId??state.clientId}),...state.callbackFields}).toString();
    const response=await fetch(callback);state.callbackStatus=response.status;await response.text();
  };
  const options={directory,fetchImpl,openBrowser,now:()=>state.clock,timeoutMs:state.timeoutMs??2000};
  const auth=new ChatGPTAuth(options);return {auth,state,directory,options};
}

test('OSS sign-in validates PKCE, saves protected credentials, and keeps public output secret-free',async t=>{
  const {auth,state,directory,options}=await fixture(t);const before=await auth.status();const account=await auth.login();
  const query=state.authorization.searchParams;
  assert.equal(query.get('client_id'),'dynamic_agent_client');assert.equal(query.get('agent_name_hint'),'roundtable-workspace');assert.equal(query.get('ext_agent_host_id'),before.hostId);assert.equal(query.get('scope'),scopes);
  assert.equal(query.get('code_challenge_method'),'S256');assert.equal(new URL(query.get('redirect_uri')).hostname,'127.0.0.1');
  assert.equal(account.signedIn,true);assert.equal(account.subject,'subject-one');assert.equal((await stat(directory)).mode&0o777,0o700);assert.equal((await stat(join(directory,'accounts.json'))).mode&0o777,0o600);
  const status=await new ChatGPTAuth(options).status();assert.equal(status.hostId,before.hostId);assert.equal(status.activeAccountId,account.id);assert.equal(status.accounts.length,1);
  assert.ok(!JSON.stringify(status).includes('secret'));assert.ok(!JSON.stringify(status).includes('idToken'));
  const access=await auth.getAccessToken();assert.equal(access.accessToken,'initial-access-secret');assert.deepEqual(Object.keys(access.account),['id','clientId','subject','email','name']);
  await assert.rejects(fetch(state.callback),/fetch failed/);
});

test('forged state, wrong origin, host, path and method cannot redeem a callback',async t=>{
  const {auth,state}=await fixture(t,{beforeCallback:async(callback,current)=>{
    const forged=new URL(callback);forged.search=new URLSearchParams({code:'forged',client_id:'oaiapp_bad',state:'wrong'}).toString();
    assert.equal((await fetch(forged)).status,400);
    const valid=new URL(callback);valid.search=new URLSearchParams({code:'forged',client_id:'oaiapp_bad',state:current.authorization.searchParams.get('state')}).toString();
    assert.equal((await fetch(valid,{headers:{Origin:'https://attacker.example'}})).status,400);
    const wrongHost=await new Promise((resolve,reject)=>{const request=httpRequest(valid,{headers:{Host:'attacker.example'}},response=>{response.resume();resolve(response.statusCode);});request.once('error',reject);request.end();});
    assert.equal(wrongHost,400);
    assert.equal((await fetch(valid,{method:'POST'})).status,400);
    valid.pathname='/wrong';assert.equal((await fetch(valid)).status,404);
    assert.equal(current.tokenCalls.length,0);
  }});
  await auth.login();assert.equal(state.tokenCalls.length,1);assert.equal(state.tokenCalls[0].code,'one-time-code');
});

for(const [name,overrides] of [
  ['nonce mismatch',{claims:{nonce:'spoofed'}}],
  ['invalid signature',{badSignature:true}],
  ['wrong audience',{jwtAudience:'oaiapp_attacker'}],
  ['wrong issuer',{jwtIssuer:'https://attacker.example'}],
  ['expired identity token',{expired:true}]
])test('sign-in rejects '+name+' without saving tokens',async t=>{
  const {auth}=await fixture(t,overrides);await assert.rejects(auth.login(),error=>error.code==='IDENTITY_FAILED');assert.deepEqual((await auth.status()).accounts,[]);
});

test('declined consent never exchanges a code and closes the callback server',async t=>{
  const {auth,state}=await fixture(t,{callbackFields:{error:'access_denied'}});await assert.rejects(auth.login(),error=>error.code==='CONSENT_DECLINED');assert.equal(state.tokenCalls.length,0);assert.deepEqual((await auth.status()).accounts,[]);await assert.rejects(fetch(state.callback));
});

test('missing issued client ID fails registration',async t=>{
  const {auth,state}=await fixture(t,{callbackClientId:null});await assert.rejects(auth.login(),error=>error.code==='REGISTRATION_FAILED');assert.equal(state.tokenCalls.length,0);
});

test('identity consent without plan scopes cannot start inference',async t=>{
  const {auth}=await fixture(t,{grantedScopes:'openid profile email offline_access resource.invoke'});await auth.login();await assert.rejects(auth.getAccessToken(),error=>error.code==='PLAN_PERMISSION_REQUIRED');
});

test('identity-only token result is retained and enabling plan use requests fresh consent',async t=>{
  const {auth,state}=await fixture(t,{identityOnly:true});const account=await auth.login();assert.equal(account.signedIn,true);await assert.rejects(auth.getAccessToken(),error=>error.code==='PLAN_PERMISSION_REQUIRED');
  state.identityOnly=false;await auth.login({accountId:account.id});assert.equal(state.authorization.searchParams.get('prompt'),'consent');assert.equal((await auth.getAccessToken()).accessToken,'initial-access-secret');
});

test('returning sign-in reuses host/client/account, retains hints, and rejects client or identity swaps',async t=>{
  const {auth,state}=await fixture(t);const account=await auth.login();const host=(await auth.status()).hostId;
  state.callbackClientId=null;const returned=await auth.login({accountId:account.id});assert.equal(returned.id,account.id);assert.equal(state.authorization.searchParams.get('client_id'),'oaiapp_fixture');assert.equal(state.authorization.searchParams.get('ext_agent_host_id'),host);assert.ok(state.authorization.searchParams.get('id_token_hint'));assert.equal(state.authorization.searchParams.get('agent_name_hint'),null);
  state.callbackClientId='oaiapp_attacker';await assert.rejects(auth.login({accountId:account.id}),error=>error.code==='REGISTRATION_FAILED');
  state.callbackClientId=null;state.subject='different-subject';await assert.rejects(auth.login({accountId:account.id}),error=>error.code==='IDENTITY_MISMATCH');assert.equal((await auth.status()).accounts[0].subject,'subject-one');
});

test('registrations with identical email remain separate and explicit selection survives restart',async t=>{
  const {auth,state,options}=await fixture(t);const first=await auth.login();state.clientId='oaiapp_workspace_two';const second=await auth.login();assert.notEqual(first.id,second.id);assert.equal(first.email,second.email);
  const status=await auth.status();assert.equal(status.accounts.length,2);assert.equal(status.activeAccountId,second.id);await auth.select(first.id);assert.equal((await new ChatGPTAuth(options).status()).activeAccountId,first.id);
});

test('two auth instances serialize token refresh and persist the rotating token atomically',async t=>{
  const {auth,state,options,directory}=await fixture(t);await auth.login();state.clock+=3590*1000;
  const second=new ChatGPTAuth(options);const results=await Promise.all([auth.getAccessToken(),second.getAccessToken()]);assert.equal(state.refreshCount,1);assert.equal(results[0].accessToken,'rotated-access-1');assert.equal(results[1].accessToken,'rotated-access-1');
  const saved=JSON.parse(await readFile(join(directory,'accounts.json'),'utf8'));assert.equal(saved.accounts[0].refreshToken,'rotated-refresh-1');assert.equal(saved.accounts[0].accessToken,'rotated-access-1');
  state.clock+=3590*1000;await second.getAccessToken();assert.equal(state.tokenCalls.at(-1).refresh_token,'rotated-refresh-1');
});

test('separate processes recover one stale lock and serialize rotating refresh tokens',async t=>{
  const {auth,state,directory}=await fixture(t);await auth.login();state.clock+=3590*1000;
  await writeFile(join(directory,'accounts.lock'),JSON.stringify({pid:2147483647,nonce:'stale-owner'}),{mode:0o600});
  const source=`
    import {ChatGPTAuth} from ${JSON.stringify(new URL('../bridge/chatgpt-auth.js',import.meta.url).href)};
    import {appendFile} from 'node:fs/promises';
    import {join} from 'node:path';
    const directory=process.argv[1],clock=Number(process.argv[2]);
    const config=${JSON.stringify(endpoints)};
    const fetchImpl=async(url,options)=>{
      if(url.endsWith('/openid-configuration'))return Response.json(config);
      if(url===config.token_endpoint){
        const body=new URLSearchParams(options.body);
        if(body.get('refresh_token')!=='initial-refresh-secret')throw new Error('Unexpected refresh token.');
        await appendFile(join(directory,'refresh-count.txt'),'refresh\\n');
        await new Promise(resolve=>setTimeout(resolve,150));
        return Response.json({access_token:'crossprocess-access',refresh_token:'crossprocess-refresh',expires_in:3600,token_type:'Bearer',scope:${JSON.stringify(scopes)}});
      }
      throw new Error('Unexpected endpoint.');
    };
    const auth=new ChatGPTAuth({directory,fetchImpl,now:()=>clock});
    process.once('message',async()=>{try{const result=await auth.getAccessToken();process.send({result:result.accessToken});}catch(error){process.send({error:error.code || 'FAILED'});process.exitCode=1;}finally{process.disconnect();}});
    process.send({ready:true});
  `;
  function launch(){
    const child=spawn(process.execPath,['--input-type=module','-e',source,directory,String(state.clock)],{stdio:['ignore','ignore','pipe','ipc']});
    t.after(()=>{if(child.exitCode===null)child.kill();});
    let markReady;const ready=new Promise(resolve=>{markReady=resolve;});let result,stderr='';child.stderr.on('data',data=>{stderr+=data;});
    child.on('message',message=>{if(message.ready)markReady();else result=message;});
    const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>{if(code===0)resolve(result);else reject(new Error('Auth child process failed: '+stderr));});});done.catch(()=>{});
    return {child,ready,done};
  }
  const children=[launch(),launch()];await Promise.all(children.map(child=>child.ready));children.forEach(({child})=>child.send('start'));
  const results=await Promise.all(children.map(child=>child.done));assert.deepEqual(results,[{result:'crossprocess-access'},{result:'crossprocess-access'}]);assert.equal(await readFile(join(directory,'refresh-count.txt'),'utf8'),'refresh\n');
  assert.equal((await auth.getAccessToken()).accessToken,'crossprocess-access');
  await assert.rejects(stat(join(directory,'accounts.lock')),error=>error.code==='ENOENT');await assert.rejects(stat(join(directory,'accounts.admission.lock')),error=>error.code==='ENOENT');
});

test('terminal refresh clears unusable tokens while temporary network failure preserves them',async t=>{
  const {auth,state}=await fixture(t);await auth.login();state.clock+=3590*1000;state.refreshNetworkError=true;await assert.rejects(auth.getAccessToken(),error=>error.code==='NETWORK_FAILED' && !error.message.includes('secret'));assert.equal((await auth.status()).accounts[0].signedIn,true);
  state.refreshNetworkError=false;state.refreshError='invalid_grant';await assert.rejects(auth.getAccessToken(),error=>error.code==='SIGN_IN_REQUIRED');assert.equal((await auth.status()).accounts[0].signedIn,false);
});

test('a stalled real HTTP token body times out, preserves credentials, and releases both locks',async t=>{
  const {auth,state,directory}=await fixture(t);await auth.login();state.clock+=3590*1000;
  const server=createServer((request,response)=>{request.resume();response.writeHead(200,{'content-type':'application/json'});response.write('{"access_token":');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.close();server.closeAllConnections();});
  const fixtureFetch=auth.fetch;auth.requestTimeoutMs=40;
  auth.fetch=(url,options)=>url===endpoints.token_endpoint?fetch('http://127.0.0.1:'+server.address().port,options):fixtureFetch(url,options);
  const before=await readFile(join(directory,'accounts.json'),'utf8');
  await assert.rejects(auth.getAccessToken(),error=>error.code==='NETWORK_FAILED');
  assert.equal(await readFile(join(directory,'accounts.json'),'utf8'),before);assert.equal((await auth.status()).accounts[0].signedIn,true);
  await assert.rejects(stat(join(directory,'accounts.lock')),error=>error.code==='ENOENT');await assert.rejects(stat(join(directory,'accounts.admission.lock')),error=>error.code==='ENOENT');
  auth.fetch=fixtureFetch;assert.equal((await auth.getAccessToken()).accessToken,'rotated-access-1');
});

test('logout revokes renewable session, removes credentials, retains registration/host and omits old hints',async t=>{
  const {auth,state,directory}=await fixture(t);const account=await auth.login();const host=(await auth.status()).hostId;const result=await auth.logout();assert.equal(result.revoked,true);assert.equal(result.account.signedIn,false);
  assert.deepEqual(state.revokeCalls,[{token:'initial-refresh-secret',token_type_hint:'refresh_token',client_id:'oaiapp_fixture'}]);const saved=await readFile(join(directory,'accounts.json'),'utf8');assert.ok(!saved.includes('secret'));assert.ok(!saved.includes('idToken'));assert.equal((await auth.status()).hostId,host);
  await assert.rejects(auth.getAccessToken(),error=>error.code==='SIGN_IN_REQUIRED');await auth.login({accountId:account.id});assert.equal(state.authorization.searchParams.get('id_token_hint'),null);assert.equal(state.authorization.searchParams.get('client_id'),account.clientId);
});

test('failed remote revocation is reported while local sign-out still clears all tokens',async t=>{
  const {auth}=await fixture(t,{revokeStatus:503});await auth.login();const result=await auth.logout();assert.equal(result.revoked,false);assert.equal(result.account.signedIn,false);await assert.rejects(auth.getAccessToken(),error=>error.code==='SIGN_IN_REQUIRED');
});

test('sign-out cancels a pending sign-in so it cannot restore credentials',async t=>{
  const {auth,state}=await fixture(t);await auth.login();state.noCallback=true;
  const pending=auth.login({accountId:(await auth.status()).activeAccountId});const rejected=assert.rejects(pending,error=>error.code==='ABORTED');
  await new Promise(resolve=>setTimeout(resolve,20));await auth.logout();await rejected;assert.equal((await auth.status()).accounts[0].signedIn,false);await assert.rejects(fetch(state.callback));
});

for(const [field,value] of [['issuer','https://attacker.example'],['token_endpoint','https://attacker.example/steal'],['jwks_uri',issuer+'/redirect'],['revocation_endpoint',issuer+'/api/accounts/oauth/revoke?redirect=bad']])test('discovery rejects untrusted '+field,async t=>{
  const {auth,state}=await fixture(t,{discovery:{[field]:value}});await assert.rejects(auth.login(),error=>error.code==='UNTRUSTED_DISCOVERY');assert.equal(state.authorization,null);assert.equal(state.tokenCalls.length,0);
});

test('aborted and timed out sign-ins close their listeners without changing saved identity',async t=>{
  const {auth,state}=await fixture(t,{noCallback:true,timeoutMs:30});await assert.rejects(auth.login(),error=>error.code==='SIGN_IN_TIMEOUT');await assert.rejects(fetch(state.callback));
  const controller=new AbortController();const pending=auth.login({signal:controller.signal});setTimeout(()=>controller.abort(),10);await assert.rejects(pending,error=>error.code==='ABORTED');await assert.rejects(fetch(state.callback));assert.deepEqual((await auth.status()).accounts,[]);
});

test('credential reads refuse symbolic links without modifying their target',async t=>{
  const {auth,directory}=await fixture(t);const target=join(directory,'external.json');await writeFile(target,'private-target',{mode:0o644});await symlink(target,join(directory,'accounts.json'));await assert.rejects(auth.status(),error=>error.code==='INVALID_STORAGE');assert.equal(await readFile(target,'utf8'),'private-target');assert.equal((await stat(target)).mode&0o777,0o644);
});
