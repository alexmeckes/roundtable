import {createMcpHandler,isLegacyRequest,WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/server';
import panelHtml from './room.html?raw';
import fullRoomHtml from './full-room.html?raw';
import {createRoundtableServer} from './mcp';
import {principalFrom,SitesRoundtableClient,type RoundtableEnv} from './client';

const json=(data:object,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
const browserTools=new Set(['roundtable_read','roundtable_create_task','roundtable_claim_task','roundtable_submit_result','roundtable_chat_send','roundtable_chat_mode','roundtable_chat_request','roundtable_reply_cancel','roundtable_task_review','roundtable_monitor_stop','roundtable_runtime_pair','roundtable_runtime_disconnect','roundtable_runtime_task_start','roundtable_runtime_task_stop']);
async function readRpc(request:Request){
  const limit=4*1024*1024;
  if(Number(request.headers.get('content-length'))>limit)throw new Error('Request too large.');
  const reader=request.body?.getReader();if(!reader)throw new Error('Invalid JSON.');
  const chunks:Uint8Array[]=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new Error('Request too large.');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function roundtableRoute(request:Request,env:RoundtableEnv):Promise<Response|null>{
  const url=new URL(request.url),user=principalFrom(request),room=env.ROUNDTABLE_SITES_ROOM||'sites-trial';
  const client=()=>{if(!user)throw new Error('Sign in with ChatGPT to join this room.');return new SitesRoundtableClient(env,user,url.origin);};
  if(url.pathname==='/api/access'){
    if(request.method!=='POST')return json({error:'Use POST.'},405);
    if(!user)return json({error:'Sign in with ChatGPT to keep your AI connected.'},401);
    if(request.headers.get('origin')!==url.origin)return json({error:'Origin rejected.'},403);
    try{await client().enroll();return json({ok:true});}
    catch{return json({error:'Room access could not be renewed.'},503);}
  }
  if(url.pathname==='/mcp' || url.pathname==='/api/room'){
    const browser=url.pathname==='/api/room';
    if(request.method!=='POST')return json({error:'Use POST for MCP requests.'},405);
    if(browser && !user)return json({error:'Sign in with ChatGPT to access the room.'},401);
    if(browser && request.headers.get('origin')!==url.origin)return json({error:'Origin rejected.'},403);
    if(request.headers.get('origin') && request.headers.get('origin')!==url.origin)return json({error:'Origin rejected.'},403);
    if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return json({error:'Use application/json.'},415);
    let body:any;try{body=await readRpc(request);}catch(error){const large=error instanceof Error && error.message==='Request too large.';return json({error:large?'Request too large.':'Invalid JSON.'},large?413:400);}
    if(!body || Array.isArray(body))return json({error:'One MCP request is required.'},400);
    if(browser && body.method!=='tools/call')return json({error:'Unknown room request.'},400);
    if(browser && !browserTools.has(body.params?.name))return json({error:'Unknown room action.'},403);
    if(!user && !['initialize','notifications/initialized','server/discover','tools/list','resources/list','resources/read'].includes(body.method))return json({error:'Sign in with ChatGPT to access the room.'},401);
    if(!await isLegacyRequest(request,body)){
      const handler=createMcpHandler(()=>createRoundtableServer(user?client():null as any,panelHtml),{responseMode:'json',legacy:'reject'});
      try{return await handler.fetch(request,{parsedBody:body});}finally{await handler.close();}
    }
    const server=createRoundtableServer(user?client():null as any,panelHtml);
    const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    try{await server.connect(transport);return await transport.handleRequest(request,{parsedBody:body});}
    finally{await server.close();}
  }
  if(url.pathname==='/api/session'){
    if(request.method!=='POST')return json({error:'Use POST.'},405);
    if(!user)return json({error:'Sign in with ChatGPT to join.'},401);
    if(request.headers.get('origin') && request.headers.get('origin')!==url.origin)return json({error:'Origin rejected.'},403);
    try{const value=await client().session();const upstream=new URL(client().backendUrl(value.browser.wsPath));upstream.protocol=upstream.protocol==='https:'?'wss:':'ws:';value.browser.wsUrl=upstream.href;return json(value);}
    catch(error){return json({error:error instanceof Error?error.message:'The room is unavailable.'},503);}
  }
  const artifact='/api/rooms/'+encodeURIComponent(room)+'/work/';
  if(url.pathname.startsWith(artifact)){
    if(request.method!=='GET')return json({error:'Use GET.'},405);
    if(!user)return json({error:'Sign in with ChatGPT to read this result.'},401);
    if(!/^\/api\/rooms\/[^/]+\/work\/[A-Za-z0-9_-]+\/(?:deliverables\/[^?#]+|patch|preview(?:\/.*)?)$/.test(url.pathname))return json({error:'Unknown result.'},404);
    try{const c=client();await c.enroll();const response=await fetch(c.backendUrl(url.pathname),{headers:c.headers(),redirect:'manual',signal:AbortSignal.timeout(20000)});if(response.status>=300 && response.status<400)return json({error:'The result unexpectedly redirected.'},502);const headers=new Headers(response.headers);headers.set('cache-control','private, no-store');return new Response(response.body,{status:response.status,headers});}
    catch{return json({error:'The result could not be loaded. Please retry.'},503);}
  }
  if(url.pathname==='/' || url.pathname==='/s/'+encodeURIComponent(room) || url.pathname==='/s/'+encodeURIComponent(room)+'/manage'){
    if(request.method!=='GET')return new Response('Use GET.',{status:405});
    if(!user)return Response.redirect(url.origin+'/signin-with-chatgpt?return_to='+encodeURIComponent(url.pathname),302);
    return new Response(url.pathname.endsWith('/manage')?fullRoomHtml:panelHtml,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff'}});
  }
  return null;
}
