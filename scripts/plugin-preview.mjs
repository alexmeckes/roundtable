import express from 'express';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';

// A localhost development host for the real MCP resource and tool protocol.
// This previews the panel; it is not a ChatGPT sidebar installation.
const port=Number(process.env.ROUNDTABLE_PREVIEW_PORT || 4142),origin=`http://localhost:${port}`;
const runtime=fileURLToPath(new URL('../plugins/roundtable/runtime/server.mjs',import.meta.url));
const client=new Client({name:'roundtable-local-preview',version:'0.1.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[runtime],env:{PATH:process.env.PATH,...(process.env.ROUNDTABLE_NATIVE_CONFIG?{ROUNDTABLE_NATIVE_CONFIG:process.env.ROUNDTABLE_NATIVE_CONFIG}:{})},stderr:'inherit'});
await client.connect(transport);
const {tools}=await client.listTools(),allowed=new Set(tools.map(t=>t.name));
const app=express();
app.use((req,res,next)=>{
  if(req.headers.host!==`localhost:${port}` && req.headers.host!==`127.0.0.1:${port}`)return res.sendStatus(403);
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'");next();
});
app.get('/panel',async(_req,res)=>{
  try{const data=await client.readResource({uri:'ui://roundtable/room.html'});res.type('html').send(data.contents[0].text);}catch{res.status(503).send('Roundtable panel is still being built. Reload shortly.');}
});
app.post('/call',(req,res,next)=>{
  if(req.headers.origin!==origin || !req.is('application/json'))return res.sendStatus(403);next();
},express.json({limit:'3mb'}),async(req,res)=>{
  if(!allowed.has(req.body?.name))return res.sendStatus(400);
  try{res.json(await client.callTool({name:req.body.name,arguments:req.body.arguments || {}}));}catch{res.status(400).json({error:'The MCP tool request failed.'});}
});
app.get('/',(_req,res)=>res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Roundtable — plugin preview</title><style>
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:#f6f7fb;color:#1c2333;font:13px ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;grid-template-rows:44px minmax(0,1fr)}.host-bar{display:flex;align-items:center;gap:12px;padding:0 20px;background:#fff;border-bottom:1px solid #e4e7ef;position:relative;z-index:2}.host-brand{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:650;letter-spacing:-.01em}.host-mark{width:16px;height:16px;border:4px solid #3158e7;border-radius:50%}.badge{font-size:10px;font-weight:550;padding:3px 7px;border:1px solid #e4e7ef;background:#f6f7fb;border-radius:5px;color:#657087}.host-note{font-size:11px;color:#778196;margin-left:auto}.host-details{margin-left:6px}.host-details summary{list-style:none;cursor:pointer;font-size:11px;color:#58647d;border:1px solid #e4e7ef;border-radius:6px;padding:5px 8px}.host-details summary::-webkit-details-marker{display:none}.host-details summary:hover,.host-details[open] summary{color:#3158e7;background:#f2f5ff;border-color:#d9e1ff}.host-details summary:focus-visible{outline:2px solid #3158e7;outline-offset:3px}.dev-panel{position:absolute;top:53px;right:16px;width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 70px);overflow:auto;padding:20px;background:#fff;border:1px solid #e4e7ef;border-radius:12px;box-shadow:0 12px 40px #1c23331a}.dev-panel h2{font-size:13px;font-weight:650;letter-spacing:-.015em;margin:0 0 8px}.dev-panel p{font-size:12px;color:#657087;line-height:1.65;margin:0 0 16px}.dev-panel h3{font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:650;color:#778196;margin:20px 0 8px}#prompt{font-size:11px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:#f6f7fb;border:1px solid #e4e7ef;border-radius:8px;color:#4c5970}#context{padding-top:12px;border-top:1px solid #e4e7ef;margin:14px 0 0;font-size:11px}main{min-width:0;min-height:0}iframe{display:block;width:100%;height:100%;border:0;background:#f6f7fb}@media(max-width:520px){.host-bar{padding:0 12px;gap:8px}.host-note{display:none}.host-details{margin-left:auto}}
</style><header class="host-bar"><div class="host-brand"><span class="host-mark" aria-hidden="true"></span>Roundtable</div><span class="badge">Preview</span><span class="host-note">Real MCP · local host</span><details class="host-details" id="host-details"><summary>Host details</summary><section class="dev-panel" aria-label="Preview host details"><h2>Local extension preview</h2><p>The panel loads the actual MCP resource and scoped room tools. Native ChatGPT panel placement still needs host verification.</p><p>Native chat requests are recorded here. This preview does not start a native assistant. Connected room AIs can answer through their local bridge.</p><h3>Requested chat message</h3><div id="prompt">No message requested.</div><p id="context">No task context selected.</p></section></details></header><main><iframe id="panel" title="Roundtable workspace" src="/panel" sandbox="allow-scripts allow-same-origin allow-popups"></iframe></main><script>
const frame=document.getElementById('panel');
document.addEventListener('keydown',event=>{if(event.key==='Escape')document.getElementById('host-details').open=false;});
window.addEventListener('message',async event=>{
  if(event.source!==frame.contentWindow || event.origin!==location.origin)return;
  const m=event.data;if(!m || m.jsonrpc!=='2.0')return;
  const reply=(result,error)=>m.id!==undefined && frame.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,...(error?{error:{code:-32000,message:error}}:{result})},location.origin);
  try{
    if(m.method==='ui/initialize')reply({protocolVersion:m.params?.protocolVersion || '2026-01-26',hostInfo:{name:'Roundtable local preview',version:'0.1.0'},hostCapabilities:{},hostContext:{displayMode:'fullscreen',locale:'en-US'}});
    else if(m.method==='tools/call'){const r=await fetch('/call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(m.params)});if(!r.ok)throw Error('MCP tool failed');reply(await r.json());}
    else if(m.method==='ui/update-model-context'){const c=m.params?.structuredContent;document.getElementById('context').textContent=c?.task?'Selected: '+c.task.title+' · '+(c.acceptedContext || []).length+' accepted context item(s).':'Shared context updated for this host.';reply({});}
    else if(m.method==='ui/message'){document.getElementById('prompt').textContent=(m.params?.content || []).map(c=>c.text || '').join('\\n') || JSON.stringify(m.params);reply({});}
    else if(m.method==='ping')reply({});
    else if(m.id!==undefined)reply({});
  }catch(e){reply(null,e.message);}
});
</script></html>`));
const server=app.listen(port,'127.0.0.1',()=>console.log(`Roundtable MCP panel preview: ${origin}`));
const close=async()=>{server.close();server.closeAllConnections();await client.close();};
process.once('SIGINT',close);process.once('SIGTERM',close);
