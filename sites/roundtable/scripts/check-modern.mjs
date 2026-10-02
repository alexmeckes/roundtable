import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

export const MCP2_VERSION='2026-07-28';
export const MCP2_ENVELOPE={
  'io.modelcontextprotocol/protocolVersion':MCP2_VERSION,
  'io.modelcontextprotocol/clientInfo':{name:'roundtable-protocol-probe',version:'1'},
  'io.modelcontextprotocol/clientCapabilities':{},
};
let sequence=0;

// Synthetic Site principal headers are for the local Worker harness only.
export async function modernRpc(origin,method,params={},options={}){
  const {user,headers:overrides={},meta={},omitHeaders=[]}=options;
  if(user && !['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname))throw new Error('Synthetic principal headers require a local test server.');
  const headers=new Headers({
    'content-type':'application/json',accept:'application/json, text/event-stream',
    'MCP-Protocol-Version':MCP2_VERSION,'Mcp-Method':method,
    ...(method==='tools/call'?{'Mcp-Name':params.name}:{}),
    ...(method==='resources/read'?{'Mcp-Name':params.uri}:{}),
    ...(method==='prompts/get'?{'Mcp-Name':params.name}:{}),
    ...(user?{'oai-authenticated-user-id':user,'oai-authenticated-user-full-name':encodeURIComponent(user),'oai-authenticated-user-full-name-encoding':'percent-encoded-utf-8'}:{}),
    ...overrides,
  });
  for(const name of omitHeaders)headers.delete(name);
  const envelope={...MCP2_ENVELOPE,...meta};
  for(const key of options.omitMeta || [])delete envelope[key];
  const requestId=++sequence;
  const response=await fetch(origin+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:requestId,method,params:{...params,_meta:{...envelope,...params._meta}}})});
  const body=await response.json();
  if(body.jsonrpc==='2.0')assert.equal(body.id,requestId,'The response must retain the request ID.');
  return {status:response.status,body};
}

function complete(reply){
  assert.equal(reply.status,200,JSON.stringify(reply.body));
  assert(!reply.body.error,JSON.stringify(reply.body.error));
  assert.equal(reply.body.result.resultType,'complete');
  assert.equal(reply.body.result._meta?.['io.modelcontextprotocol/serverInfo']?.name,'roundtable');
  return reply.body.result;
}

export async function probeModern({origin='http://127.0.0.1:4144',user}={}){
  const discovered=complete(await modernRpc(origin,'server/discover'));
  assert(discovered.supportedVersions.includes(MCP2_VERSION));
  assert(discovered.capabilities.tools);
  assert.deepEqual(discovered.capabilities.events,{});
  assert.equal(discovered.ttlMs,0);
  assert.equal(discovered.cacheScope,'private');
  complete(await modernRpc(origin,'server/discover',{}, {omitMeta:['io.modelcontextprotocol/clientInfo']}));
  const tools=complete(await modernRpc(origin,'tools/list'));
  assert(tools.tools.some(tool=>tool.name==='roundtable_open'));
  const resource=complete(await modernRpc(origin,'resources/read',{uri:'ui://roundtable-sites/room-v1.html'}));
  assert(resource.contents[0].text.length>100);
  assert.equal((await modernRpc(origin,'tools/call',{name:'roundtable_read',arguments:{}})).status,401);
  assert.equal((await modernRpc(origin,'events/list')).status,401);

  const mismatch=await modernRpc(origin,'server/discover',{}, {headers:{'Mcp-Method':'Server/Discover'}});
  assert.equal(mismatch.status,400);
  assert.equal(mismatch.body.error.code,-32020);
  const missingHeader=await modernRpc(origin,'server/discover',{}, {omitHeaders:['MCP-Protocol-Version']});
  assert.equal(missingHeader.status,400);
  assert.equal(missingHeader.body.error.code,-32020);
  const missingCapabilities=await modernRpc(origin,'server/discover',{}, {omitMeta:['io.modelcontextprotocol/clientCapabilities']});
  assert.equal(missingCapabilities.status,400);
  assert.equal(missingCapabilities.body.error.code,-32602);
  const missingName=await modernRpc(origin,'resources/read',{uri:'ui://roundtable-sites/room-v1.html'},{omitHeaders:['Mcp-Name']});
  assert.equal(missingName.status,400);
  assert.equal(missingName.body.error.code,-32020);

  if(user){
    const events=complete(await modernRpc(origin,'events/list',{}, {user}));
    const requested=events.events.find(event=>event.name==='roundtable.ai_requested');
    assert(requested);
    assert(requested.delivery.includes('webhook'));
    assert(requested.inputSchema && requested.payloadSchema);
    // The SDK removes reserved envelope keys, but preserves ordinary metadata.
    complete(await modernRpc(origin,'events/list',{_meta:{progressToken:'probe-progress','com.example/probe':true}}, {user}));
    const room=complete(await modernRpc(origin,'tools/call',{name:'roundtable_read',arguments:{}},{user}));
    assert(!room.isError,room.content?.[0]?.text);
    assert(room.structuredContent.member);
  }
  return {modernDiscovery:true,authenticatedChecks:Boolean(user)};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  await probeModern({origin:process.argv[2] || 'http://127.0.0.1:4144',user:process.argv[3]});
  console.log('MCP 2.0 probe passed: discovery, tools, resource, auth denial, envelope and header validation'+(process.argv[3]?', authenticated event discovery, custom metadata and room read.':'.'));
}
