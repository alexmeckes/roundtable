import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {RoundtableClient} from '../plugins/roundtable/runtime/client.mjs';

const runtime=fileURLToPath(new URL('../plugins/roundtable/runtime/server.mjs',import.meta.url));
const token='private-native-credential-1234567',capability='private-run-capability';
const room='bound-room';
async function fixture(t,{configuration=false}={}){
  const requests=[];let rejectAuth=false;
  const task={id:'task-one',version:1,title:'Write a decision',details:'Use accepted evidence.',ownerId:'owner-one',agentId:'owner-one',status:'planned'};
  const run={id:'run-one',taskId:task.id,ownerId:'owner-one',status:'running',execution:'native'};
  const http=createServer(async(request,response)=>{
    let text='';for await(const part of request)text+=part;
    const body=JSON.parse(text),action=request.url.split('/').at(-1);
    requests.push({path:request.url,authorization:request.headers.authorization,body});
    const reply=(value,status=200)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
    if(rejectAuth)return reply({error:'Rejected '+token+' '+capability},403);
    assert.equal(request.headers.authorization,'Bearer '+token);
    assert.ok(request.url.startsWith('/api/rooms/'+room+'/native/'));
    if(action==='snapshot')return reply({room:{id:room,url:'/s/'+room},member:{id:'owner-one',name:'Owner'},tasks:[task],work:[run],context:[],chat:[]});
    if(action==='task_claim')return reply({task:{...task,version:2,status:'working'},run,runToken:capability,context:{shared:{},dependencies:[]},diagnostic:'Capability '+capability});
    if(action==='task_submit'){assert.equal(body.runToken,capability);return reply({run:{...run,status:'ready'},task:{...task,status:'needs_review'},runToken:capability,diagnostic:'Capability '+capability});}
    if(action==='publish')return reply({published:true});
    if(action==='chat_send')return reply({sent:true,message:{kind:'human',author:'Owner',ownerId:'owner-one',text:body.text}});
    if(action==='chat_mode')return reply({conversation:{canSend:true,canRequestBridge:body.mode!=='off',canSetOwnMode:true,agents:[]}});
    if(action==='context_read')return reply({entries:[{id:'context-one',title:'Evidence'}]});
    if(action==='context_propose')return reply({id:'proposed-one',status:'proposed'});
    if(action==='task_save')return reply({task});
    reply({error:'Unknown test action'},400);
  });
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  t.after(()=>{http.closeAllConnections();return new Promise(resolve=>http.close(resolve));});
  const url='http://127.0.0.1:'+http.address().port;
  let env={ROUNDTABLE_URL:url,ROUNDTABLE_ROOM:room,ROUNDTABLE_NATIVE_TOKEN:token};
  if(configuration){
    const directory=await mkdtemp(join(tmpdir(),'roundtable-native-config-'));await chmod(directory,0o700);
    t.after(()=>rm(directory,{recursive:true,force:true}));
    const path=join(directory,'connection.json');await writeFile(path,JSON.stringify({url,room,token}),{mode:0o600});
    env={ROUNDTABLE_NATIVE_CONFIG:path,ROUNDTABLE_NATIVE_TOKEN:'',ROUNDTABLE_URL:'',ROUNDTABLE_ROOM:''};
  }
  const transport=new StdioClientTransport({command:process.execPath,args:[runtime],env,stderr:'pipe'});
  let stderr='';transport.stderr.on('data',data=>{stderr+=data;});
  const client=new Client({name:'roundtable-test',version:'1.0.0'});
  t.after(async()=>{await client.close();assert.ok(!stderr.includes(token));assert.ok(!stderr.includes(capability));});
  await client.connect(transport);
  return {client,requests,url,reject:()=>{rejectAuth=true;}};
}

test('native MCP uses actual SDK stdio, strict tool schemas, and the configured identity/room',async t=>{
  const {client,requests}=await fixture(t),tools=(await client.listTools()).tools;
  assert.deepEqual(tools.map(tool=>tool.name).sort(),['roundtable_read','roundtable_publish','roundtable_chat_send','roundtable_chat_mode','roundtable_context_read','roundtable_context_propose','roundtable_create_task','roundtable_claim_task','roundtable_submit_result','roundtable_open'].sort());
  for(const tool of tools){assert.equal(tool.inputSchema.type,'object');assert.equal(tool.inputSchema.additionalProperties,false);assert.ok(!['ownerId','author','threadId','room','runToken'].some(field=>Object.hasOwn(tool.inputSchema.properties || {},field)));}
  const snapshot=await client.callTool({name:'roundtable_read',arguments:{}});
  assert.equal(snapshot.structuredContent.member.id,'owner-one');assert.deepEqual(snapshot.structuredContent.claimedRunIds,[]);
  assert.equal(requests.length,1);assert.deepEqual(requests[0].body,{});
  const rejected=await client.callTool({name:'roundtable_publish',arguments:{text:'Hello',ownerId:'another-person',room:'another-room'}});
  assert.equal(rejected.isError,true);assert.equal(requests.length,1);
  const published=await client.callTool({name:'roundtable_publish',arguments:{text:'  My contribution.  '}});
  assert.equal(published.structuredContent.published,true);assert.deepEqual(requests[1].body,{text:'My contribution.'});
  assert.equal(requests[1].path,'/api/rooms/'+room+'/native/publish');assert.equal(requests[1].authorization,'Bearer '+token);
});

test('human-send MCP tool is app-only, credential-bound, and separate from model publish',async t=>{
  const {client,requests}=await fixture(t),tool=(await client.listTools()).tools.find(tool=>tool.name==='roundtable_chat_send');
  assert.deepEqual(tool._meta.ui.visibility,['app']);assert.equal(tool.inputSchema.additionalProperties,false);
  const forged=await client.callTool({name:'roundtable_chat_send',arguments:{text:'Hi',author:'Someone else'}});assert.equal(forged.isError,true);assert.equal(requests.length,0);
  const sent=await client.callTool({name:'roundtable_chat_send',arguments:{text:'  @owner-codex Please compare.  '}});
  assert.equal(sent.structuredContent.sent,true);assert.equal(sent.structuredContent.message.kind,'human');
  assert.equal(requests[0].path,'/api/rooms/'+room+'/native/chat_send');assert.equal(requests[0].authorization,'Bearer '+token);assert.deepEqual(requests[0].body,{text:'@owner-codex Please compare.'});
  const suppressed=await client.callTool({name:'roundtable_chat_send',arguments:{text:'This question goes to my native AI.',requestReply:false}});
  assert.equal(suppressed.structuredContent.message.kind,'human');assert.deepEqual(requests[1].body,{text:'This question goes to my native AI.',requestReply:false});
  const invalidFlag=await client.callTool({name:'roundtable_chat_send',arguments:{text:'Hi',requestReply:'false'}});assert.equal(invalidFlag.isError,true);assert.equal(requests.length,2);
  await client.callTool({name:'roundtable_publish',arguments:{text:'The model’s contribution.'}});
  assert.equal(requests[2].path,'/api/rooms/'+room+'/native/publish');assert.ok(!JSON.stringify(sent).includes(token));
  const modeTool=(await client.listTools()).tools.find(tool=>tool.name==='roundtable_chat_mode');assert.deepEqual(modeTool._meta.ui.visibility,['app']);
  const wrongOwner=await client.callTool({name:'roundtable_chat_mode',arguments:{mode:'mentions',ownerId:'someone-else'}});assert.equal(wrongOwner.isError,true);assert.equal(requests.length,3);
  const enabled=await client.callTool({name:'roundtable_chat_mode',arguments:{mode:'mentions'}});assert.equal(enabled.structuredContent.conversation.canRequestBridge,true);
  assert.equal(requests[3].path,'/api/rooms/'+room+'/native/chat_mode');assert.deepEqual(requests[3].body,{mode:'mentions'});
});

test('native MCP panel metadata and resource are exposed through the SDK',async t=>{
  const {client}=await fixture(t),tool=(await client.listTools()).tools.find(tool=>tool.name==='roundtable_open');
  assert.equal(tool._meta.ui.resourceUri,'ui://roundtable/room.html');assert.deepEqual(tool._meta['openai/ui'].entrypoints,[{type:'thread'},{type:'global'}]);
  const resources=(await client.listResources()).resources;
  assert.equal(resources[0].uri,'ui://roundtable/room.html');assert.equal(resources[0].mimeType,'text/html;profile=mcp-app');
  const resource=await client.readResource({uri:resources[0].uri});assert.match(resource.contents[0].text,/<(?:!doctype|html)/i);
  const opened=await client.callTool({name:'roundtable_open',arguments:{}});assert.equal(opened.structuredContent.room.id,room);
});

test('native MCP claims and submits with a runtime-private capability while exposing only public run IDs',async t=>{
  const {client,requests}=await fixture(t);
  const unknown=await client.callTool({name:'roundtable_submit_result',arguments:{id:'unknown-run',summary:'Attempt'}});assert.equal(unknown.isError,true);assert.equal(requests.length,0);
  const claimed=await client.callTool({name:'roundtable_claim_task',arguments:{id:'task-one',version:1}});
  assert.equal(claimed.structuredContent.run.id,'run-one');assert.equal(claimed.structuredContent.task.status,'working');assert.ok(!JSON.stringify(claimed).includes(capability));assert.ok(!Object.hasOwn(claimed.structuredContent,'runToken'));
  const snapshot=await client.callTool({name:'roundtable_read',arguments:{}});assert.deepEqual(snapshot.structuredContent.claimedRunIds,['run-one']);
  const forged=await client.callTool({name:'roundtable_submit_result',arguments:{id:'run-one',summary:'Forged',runToken:'attacker-token'}});assert.equal(forged.isError,true);assert.equal(requests.length,2);
  const submitted=await client.callTool({name:'roundtable_submit_result',arguments:{id:'run-one',summary:'Ready for review.',deliverables:[{path:'decision.md',content:'# Decision\nUse accepted evidence.\n'}]}});
  assert.equal(submitted.structuredContent.run.status,'ready');assert.equal(submitted.structuredContent.task.status,'needs_review');assert.ok(!JSON.stringify(submitted).includes(capability));
  assert.equal(requests[2].body.runToken,capability);assert.deepEqual(requests[2].body.deliverables,[{path:'decision.md',content:'# Decision\nUse accepted evidence.\n'}]);
  const after=await client.callTool({name:'roundtable_read',arguments:{}});assert.deepEqual(after.structuredContent.claimedRunIds,[]);
  const repeated=await client.callTool({name:'roundtable_submit_result',arguments:{id:'run-one',summary:'Again'}});assert.equal(repeated.isError,true);assert.equal(requests.length,4);
});

test('native MCP enforces selected text artifact bounds before making requests',async t=>{
  const {client,requests}=await fixture(t);
  for(const path of ['../secret.md','/absolute.txt','.hidden.txt','dir//file.json','node_modules/file.md','index.html']){
    const result=await client.callTool({name:'roundtable_submit_result',arguments:{id:'run-one',summary:'Review',deliverables:[{path,content:'Text'}]}});assert.equal(result.isError,true);
  }
  const duplicate=await client.callTool({name:'roundtable_submit_result',arguments:{id:'run-one',summary:'Review',deliverables:[{path:'a.md',content:'a'},{path:'a.md',content:'b'}]}});assert.equal(duplicate.isError,true);
  const unicode=await client.callTool({name:'roundtable_submit_result',arguments:{id:'run-one',summary:'Review',deliverables:[{path:'a.md',content:'é'.repeat(150_000)}]}});assert.equal(unicode.isError,true);
  assert.equal(requests.length,0);
});

test('native MCP auth failures never expose the configured credential or a held run capability',async t=>{
  const {client,reject}=await fixture(t);await client.callTool({name:'roundtable_claim_task',arguments:{id:'task-one',version:1}});reject();
  const result=await client.callTool({name:'roundtable_read',arguments:{}});assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes(token));assert.ok(!JSON.stringify(result).includes(capability));assert.match(result.content[0].text,/access was rejected/);
});

test('native MCP can load its host-owned protected connection file without manifest credentials',async t=>{
  const {client,requests}=await fixture(t,{configuration:true});const result=await client.callTool({name:'roundtable_read',arguments:{}});assert.equal(result.structuredContent.room.id,room);assert.equal(requests[0].authorization,'Bearer '+token);
});

test('native connection files reject symlinks and insecure permissions without changing them',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'roundtable-native-storage-'));await chmod(directory,0o700);t.after(()=>rm(directory,{recursive:true,force:true}));
  const target=join(directory,'target.json'),config=join(directory,'connection.json');await writeFile(target,JSON.stringify({url:'http://localhost:3132',room,token}),{mode:0o600});await symlink(target,config);
  await assert.rejects(RoundtableClient.fromEnvironment({env:{ROUNDTABLE_NATIVE_CONFIG:config}}),/protected native connection/);
  await rm(config);await writeFile(config,JSON.stringify({url:'http://localhost:3132',room,token}),{mode:0o644});await assert.rejects(RoundtableClient.fromEnvironment({env:{ROUNDTABLE_NATIVE_CONFIG:config}}),/permissions 0600/);
});

test('optional local HTTP mode uses the SDK transport and rejects untrusted browser origins',async t=>{
  const {url,requests}=await fixture(t),probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const child=spawn(process.execPath,[runtime,'--http','--port',String(port)],{env:{...process.env,ROUNDTABLE_URL:url,ROUNDTABLE_ROOM:room,ROUNDTABLE_NATIVE_TOKEN:token},stdio:['ignore','ignore','pipe']});
  let stderr='';let ready;const initialized=new Promise(resolve=>{ready=resolve;});child.stderr.on('data',data=>{stderr+=data;if(stderr.includes('Roundtable MCP ready at'))ready();});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  const client=new Client({name:'roundtable-http-test',version:'1.0.0'});
  t.after(async()=>{await client.close();child.kill();const force=setTimeout(()=>child.kill('SIGKILL'),1000);await exited;clearTimeout(force);assert.ok(!stderr.includes(token));});
  const timeout=setTimeout(()=>child.kill(),5000);await Promise.race([initialized,exited.then(()=>{throw new Error('HTTP runtime did not start.');})]);clearTimeout(timeout);
  const endpoint='http://127.0.0.1:'+port+'/mcp';
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  const result=await client.callTool({name:'roundtable_read',arguments:{}});assert.equal(result.structuredContent.room.id,room);
  const rejected=await fetch(endpoint,{method:'POST',headers:{Origin:'https://attacker.example','content-type':'application/json'},body:'{}'});assert.equal(rejected.status,403);assert.equal(requests.length,1);
});
