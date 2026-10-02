import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import vm from 'node:vm';

const root=new URL('../',import.meta.url);
const sitePath=new URL('sites-trial/lib/roundtable/room.html',root);
// Sites source has its own repository and may not accompany a standalone checkout.
const site=existsSync(sitePath)?readFileSync(sitePath,'utf8'):null;
const plugin=readFileSync(new URL('plugins/roundtable/ui/room.html',root),'utf8');
const between=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function element(tag='div',text){
  return {tag,textContent:text || '',children:[],dataset:{},listeners:{},value:'',required:false,
    append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},
    get childElementCount(){return this.children.length;},addEventListener(name,fn){this.listeners[name]=fn;},
    showModal(){this.open=true;},close(){this.open=false;},focus(){this.focused=true;},reset(){this.resetCalled=true;}};
}
function harness(){
  const nodes=new Map(),calls=[];
  const context={snapshot:{room:{id:'room',url:'https://example.test/s/room'},member:{id:'owner',isHost:false},tasks:[{id:'task',version:1,title:'Decision brief',details:'Compare options',ownerId:'owner',status:'planned',runIds:[]}],work:[],conversation:{canSend:true,canRequestBridge:false,agents:[]}},selectedId:'task',lastSelectedSignature:null,revisionTask:null,claimed:new Set(),resultDrafts:new Map(),
    $:id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},el:element,
    button:(text,fn)=>{const n=element('button',text);n.listeners.click=fn;return n;},
    writeButton:(text,fn)=>{const n=element('button',text);n.dataset.write='true';n.listeners.click=fn;return n;},
    taskOwner:()=> 'Owner',statusName:status=>status,deliverableUrl:()=>null,
    call:async(name,args)=>{calls.push({name,args:JSON.parse(JSON.stringify(args))});return {task:{}};},
    mutate:async(fn)=>fn(),window:{matchMedia:()=>({matches:false})},render(){},notice(){}};
  context.window.parent=context.window;
  vm.createContext(context);
  vm.runInContext(between(site,'  const conversation=','  const notice='),context);
  vm.runInContext(between(site,'  function requestChanges(task){','  function openLinkedTask(){'),context);
  const all=()=>{const result=[];function visit(node){result.push(node);for(const child of node.children)visit(child);}visit(context.$('selected-task'));return result;};
  return {context,nodes,calls,all,labels:()=>all().map(n=>n.textContent)};
}
function connect(context,{paused=false}={}){
  context.snapshot.conversation={canSend:true,canRequestBridge:!paused,agents:[{id:'owner',ownerId:'owner',handle:'owner-ai',connected:true,ready:true,available:!paused,mode:paused?'off':'mentions'}]};
}

test('selected task updates when runtime connects or disconnects without changing the task',{skip:!site},()=>{
  const h=harness();h.context.renderSelected();
  assert.ok(h.labels().includes('Connect your AI to work on this task.'));
  connect(h.context);h.context.renderSelected();assert.ok(h.labels().includes('Work with my AI'));
  h.context.snapshot.conversation.agents=[];h.context.renderSelected();
  assert.ok(!h.labels().includes('Work with my AI'));
});

test('pausing discussion still permits owner-started work and revision continuation',{skip:!site},()=>{
  const h=harness();connect(h.context,{paused:true});h.context.renderSelected();
  assert.ok(h.labels().includes('Work with my AI'));
  const task=h.context.snapshot.tasks[0];task.runIds=['previous'];task.revision={feedback:'Add evidence for costs.'};
  h.context.renderSelected();assert.ok(h.labels().includes('Continue with my AI'));assert.ok(h.labels().includes(task.revision.feedback));
});

test('host cannot stop another owner’s local run but can review native runs',{skip:!site},()=>{
  const h=harness();h.context.snapshot.member.isHost=true;h.context.snapshot.tasks[0].ownerId='other';h.context.snapshot.tasks[0].status='working';
  h.context.snapshot.work=[{id:'run',taskId:'task',ownerId:'other',status:'running'}];h.context.renderSelected();
  assert.ok(!h.labels().includes('Stop this run'));
  h.context.snapshot.work[0].execution='native';h.context.renderSelected();assert.ok(h.labels().includes('Stop this run'));
});

test('request changes requires feedback and sends it with the displayed task version',{skip:!site},async()=>{
  const h=harness(),task=h.context.snapshot.tasks[0];task.status='needs_review';task.version=4;
  h.context.requestChanges(task);assert.equal(h.context.$('revision-dialog').open,true);
  await h.context.submitRevision({preventDefault(){}});assert.equal(h.calls.length,0);
  h.context.$('revision-feedback').value='  Add a comparison table.  ';
  await h.context.submitRevision({preventDefault(){}});
  assert.deepEqual(h.calls,[{name:'roundtable_task_review',args:{id:'task',version:4,decision:'reopen',feedback:'Add a comparison table.'}}]);
  assert.equal(h.context.$('revision-dialog').open,false);
});

test('task links open the matching task in the room and ignore unknown task ids',{skip:!site},()=>{
  const h=harness(),views=[];h.context.selectedId=null;h.context.location={hash:'#task=task'};h.context.tab=view=>views.push(view);
  vm.runInContext(between(site,'  function openLinkedTask(){',"  window.addEventListener('hashchange'"),h.context);
  h.context.openLinkedTask();assert.equal(h.context.selectedId,'task');assert.deepEqual(views,['board']);
  h.context.location.hash='#task=not-in-this-room';h.context.openLinkedTask();assert.deepEqual(views,['board']);
});

test('settings access denial closes the socket and stops renewal',{skip:!site},async()=>{
  const full=readFileSync(new URL('sites-trial/lib/roundtable/full-room.html',root),'utf8'),nodes=new Map();let closed=0,cleared=0;
  const context={accessEnded:false,renewingAccess:false,accessRenewal:1,ws:{close(){closed++;}},fetch:async()=>({status:403}),AbortSignal,
    clearInterval:()=>cleared++,setConnected(){},$:id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);}};
  vm.createContext(context);vm.runInContext(between(full,'async function renewRoomAccess(){','const accessRenewal='),context);
  await context.renewRoomAccess();assert.equal(context.accessEnded,true);assert.equal(closed,1);assert.equal(cleared,1);
  await context.renewRoomAccess();assert.equal(closed,1);assert.match(context.$('hint').textContent,/sign in/);
});

test('local plugin asks only an available room runtime and never dispatches a host chat turn',async()=>{
  const nodes=new Map(),calls=[];let bridge=null;
  const context={$:id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},ownBridge:()=>bridge,notice(){},clearDraft(){},mutate:async fn=>fn(),call:async(name,args)=>{calls.push({name,args});return {};}};
  vm.createContext(context);
  vm.runInContext(between(plugin,"  $('ask-ai').addEventListener('click',async()=>{","  $('contribution').addEventListener('input'"),context);
  context.$('contribution').value='What did we decide?';await context.$('ask-ai').listeners.click();assert.equal(calls.length,0);
  bridge={handle:'my-ai'};await context.$('ask-ai').listeners.click();
  assert.equal(calls.length,1);assert.equal(calls[0].name,'roundtable_chat_send');assert.equal(calls[0].args.text,'@my-ai What did we decide?');
  assert.ok(!site?.includes("request('ui/message'"));assert.ok(!plugin.includes("request('ui/message'"));
});
