import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ChatGPTPlanRuntime,chatGPTPlanArgs} from '../bridge/chatgpt-runtime.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(){
  let token='first-token';const servers=[],requests=[];
  const auth={async getAccessToken(params){requests.push(params);return {accessToken:token,account:{id:'owner'}};}};
  const createServer=options=>{
    const server={options,process:new EventEmitter(),runs:[],closed:false,async initialize(){},async useProject(params){server.projectOptions=params;return {id:params.projectId || 'local-project'};},run(params){const pending=deferred();server.runs.push({params,...pending});return pending.promise;},close(){server.closed=true;server.process.emit('exit',0);}};
    servers.push(server);return server;
  };
  const runtime=new ChatGPTPlanRuntime({auth,accountId:'owner',cwd:'/work',createServer});
  return {runtime,servers,requests,rotate:()=>{token='renewed-token';}};
}
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('Expected asynchronous state was not reached');}

test('plan tasks disable native delegation while retaining local task execution and independent specialists',async t=>{
  const {runtime,servers}=fixture();t.after(()=>runtime.close());
  const jobs=[
    {cwd:'/work/output-one',conversation:false,job:{instructions:'Write the report'},sessionId:null},
    {cwd:'/work/output-two',conversation:false,job:{instructions:'Review the report'},sessionId:'saved-reviewer'},
  ];
  const runs=jobs.map(job=>runtime.run(job));
  await until(()=>servers[0]?.runs.length===2);
  const overrides=new Map(servers[0].options.args.flatMap((arg,i,args)=>arg==='-c'?[args[i+1].split(/=(.*)/s).slice(0,2)]:[]));
  // A model advertising V2 can override feature defaults; the agents switch
  // must disable delegation as well as the explicit V2 feature override.
  assert.equal(overrides.get('agents.enabled'),'false');
  assert.equal(overrides.get('features.multi_agent_v2'),'false');
  assert.equal(overrides.get('features.multi_agent'),'false');
  assert.equal(overrides.has('features.shell_tool'),false);
  assert.equal(overrides.has('features.unified_exec'),false);
  assert.equal(overrides.has('mcp_servers'),false);
  assert.equal(servers[0].runs[0].params,jobs[0]);
  assert.equal(servers[0].runs[1].params,jobs[1]);
  servers[0].runs[0].resolve('written');servers[0].runs[1].resolve('reviewed');
  assert.deepEqual(await Promise.all(runs),['written','reviewed']);
});

test('ChatGPT provider uses its local OAuth token and preserves project and thread identity after renewal',async t=>{
  const {runtime,servers,requests,rotate}=fixture();t.after(()=>runtime.close());
  await runtime.initialize();await runtime.useProject({cwd:'/work'});
  const first=runtime.run({sessionId:'saved-specialist',job:{instructions:'Discuss'}});
  await until(()=>servers[0].runs.length===1);servers[0].runs[0].resolve('first reply');assert.equal(await first,'first reply');
  rotate();const resumed=runtime.run({sessionId:'saved-specialist',job:{instructions:'Continue'}});
  await until(()=>servers.length===2 && servers[1].runs.length===1);
  assert.equal(servers[0].closed,true);assert.equal(servers[1].options.env.ACCESS_TOKEN,'renewed-token');
  assert.deepEqual(servers[1].options.args,chatGPTPlanArgs);assert.deepEqual(servers[1].projectOptions,{cwd:'/work',projectId:'local-project'});
  assert.equal(servers[1].runs[0].params.sessionId,'saved-specialist');assert.equal(runtime.projectId,'local-project');
  assert.ok(requests.every(request=>request.accountId==='owner'));
  servers[1].runs[0].resolve('remembered reply');assert.equal(await resumed,'remembered reply');
});

test('rotating credentials waits for all active siblings instead of interrupting their work',async t=>{
  const {runtime,servers,rotate}=fixture();t.after(()=>runtime.close());let exits=0;runtime.on('exit',()=>exits++);
  await runtime.initialize();
  const first=runtime.run({sessionId:'one',job:{}}),second=runtime.run({sessionId:'two',job:{}});
  await until(()=>servers[0].runs.length===2);rotate();
  const third=runtime.run({sessionId:'three',job:{}});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(servers.length,1);assert.equal(servers[0].closed,false);
  servers[0].runs[0].resolve('one');await first;
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(servers.length,1);
  servers[0].runs[1].resolve('two');await second;
  await until(()=>servers.length===2 && servers[1].runs.length===1);
  assert.equal(exits,0);servers[1].runs[0].resolve('three');await third;
});

test('owner cancellation while waiting for renewal leaves a sibling runtime alive',async t=>{
  const {runtime,servers,rotate}=fixture();t.after(()=>runtime.close());await runtime.initialize();
  const active=runtime.run({job:{}});await until(()=>servers[0].runs.length===1);rotate();
  const controller=new AbortController(),queued=runtime.run({job:{},signal:controller.signal});
  await new Promise(resolve=>setTimeout(resolve,10));controller.abort(new Error('Stopped by owner'));
  await assert.rejects(queued,/Stopped by owner/);assert.equal(servers.length,1);assert.equal(servers[0].closed,false);
  servers[0].runs[0].resolve('completed');assert.equal(await active,'completed');
});

test('credential failures never silently switch to existing Codex login',async t=>{
  const {runtime,servers}=fixture();t.after(()=>runtime.close());await runtime.initialize();
  runtime.auth.getAccessToken=async()=>{throw new Error('ChatGPT plan usage is unavailable. Manage usage in ChatGPT Settings.');};
  await assert.rejects(runtime.run({job:{}}),/plan usage is unavailable/);assert.equal(servers[0].runs.length,0);assert.equal(servers.length,1);
});

test('a stopped admission behind a pending rotation settles before unrelated work finishes',async t=>{
  const {runtime,servers,rotate}=fixture();t.after(()=>runtime.close());await runtime.initialize();
  const active=runtime.run({job:{instructions:'Unrelated active work'}});await until(()=>servers[0].runs.length===1);rotate();
  const waiting=runtime.run({job:{instructions:'Wait for renewal'}});
  await until(()=>runtime.idle.length===1);
  const controller=new AbortController(),cancelled=runtime.run({job:{instructions:'Never start'},signal:controller.signal});
  controller.abort(new Error('Stopped by owner'));
  await assert.rejects(cancelled,/Stopped by owner/);
  assert.equal(servers[0].closed,false);assert.equal(runtime.active,1);
  servers[0].runs[0].resolve('Active completed');await active;
  await until(()=>servers.length===2 && servers[1].runs.length===1);
  servers[1].runs[0].resolve('Waiting completed');await waiting;
  await runtime.queue;assert.equal(servers[1].runs.length,1);assert.equal(runtime.active,0);
});

test('closing during credential preparation cannot spawn a child after shutdown',async()=>{
  const {runtime,servers}=fixture(),credentials=deferred();let calls=0;
  runtime.auth.getAccessToken=async()=>++calls===1?{accessToken:'first-token'}:credentials.promise;
  const start=runtime.initialize();await until(()=>calls===2);runtime.close();credentials.resolve({accessToken:'first-token'});
  await assert.rejects(start,/closed/);assert.equal(servers.length,0);
});
