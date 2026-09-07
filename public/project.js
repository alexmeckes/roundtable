/* Project navigation uses shared server state. Local tabs never start an agent. */
function createProjectUI({send,getYou,canSpeak,openTaskEditor,taskCard,openContext}){
  const $=id=>document.getElementById(id),node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(label,fn,cls='project-button')=>{const b=node('button',label,cls);b.type='button';b.onclick=fn;return b;};
  let data={tasks:[],taskPeople:[],people:[],taskAgents:[],work:[],workspaceRoster:[],connections:[],chat:[],sharedContext:{entries:[]}},active='conversation',tabs=['conversation'];
  const drafts=new Map(),scrolls=new Map(),expandedViews=new Map();let detailView=null;
  const detailBody=node('div',undefined,'detail-body'),threadForm=node('form',undefined,'thread-composer'),threadInput=node('textarea');
  threadInput.placeholder='Discuss this task with people and @agents…';threadInput.setAttribute('aria-label','Message this task');threadInput.rows=2;
  threadInput.oninput=()=>drafts.set(active,threadInput.value);
  const threadSend=node('button','Send to task');threadSend.type='submit';threadForm.append(threadInput,threadSend);$('project-detail').append(detailBody,threadForm);
  threadForm.onsubmit=e=>{e.preventDefault();const taskId=active.slice(5),text=threadInput.value.trim();if(active.startsWith('task:') && text && canSpeak() && send({t:'chat',taskId,text})){drafts.delete(active);threadInput.value='';}};
  const allAgents=()=>data.workspaceRoster.flatMap(c=>(c.agents || []).map(a=>({...a,connected:c.connected!==false,ready:c.ready!==false,chatMode:c.chatMode==='off'?'off':a.chatMode})));
  const task=id=>data.tasks.find(t=>t.id===id);
  const agent=id=>allAgents().find(a=>a.agentId===id);
  function title(key){return {conversation:'The table',tasks:'Tasks',context:'Shared context',outputs:'Outputs',canvas:'Canvas'}[key] || (key.startsWith('task:')?task(key.slice(5))?.title:key.startsWith('agent:')?agent(key.slice(6))?.name:key.startsWith('file:')?key.split(':').slice(2).join(':'):null) || 'Unavailable';}
  function open(key){
    if(key==='conversation' && active!=='conversation' && getYou()?.id)send({t:'catchup_request'});
    scrolls.set(active,$('project-detail').scrollTop);if(key!==active)fileView=null;
    if(!tabs.includes(key))tabs.push(key);active=key;
    renderTabs();renderNavigation();renderView();
    $('project-detail').scrollTop=scrolls.get(key) || 0;
    document.body.classList.remove('sidebar-open');$('project-menu').setAttribute('aria-expanded','false');
    $('project-tabs').querySelector('[aria-selected=true]')?.scrollIntoView({block:'nearest',inline:'nearest'});
  }
  function renderTabs(){
    $('project-tabs').replaceChildren(...tabs.map(key=>{
      const wrap=node('div',undefined,'project-tab'+(key===active?' selected':''));
      const tab=button(title(key),()=>open(key),'tab-select');tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(key===active));tab.tabIndex=key===active?0:-1;
      tab.onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();let i=tabs.indexOf(key);i=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length;open(tabs[i]);$('project-tabs').querySelector('[aria-selected=true]').focus();}};
      wrap.append(tab);
      if(key!=='conversation')wrap.append(button('×',()=>{tabs=tabs.filter(t=>t!==key);open(active===key?'conversation':active);},'tab-close'));wrap.lastChild.setAttribute('aria-label',key==='conversation'?'The table':'Close '+title(key));
      return wrap;
    }));
  }
  function renderNavigation(){
    for(const [id,key] of Object.entries({'nav-conversation':'conversation','btn-tasks':'tasks','btn-context':'context','btn-workspaces':'outputs','btn-doc':'canvas'})){$(id).classList.toggle('selected',active===key);$(id).setAttribute('aria-current',active===key?'page':'false');}
    $('nav-task-count').textContent=data.tasks.filter(t=>t.status!=='done').length;
    const people=new Map(data.taskPeople.map(p=>[p.id,p]));for(const p of data.people)if(p.id)people.set(p.id,p);
    for(const c of data.workspaceRoster)if(!people.has(c.ownerId))people.set(c.ownerId,{id:c.ownerId,name:c.name});
    $('project-people').replaceChildren(...[...people.values()].map(p=>{
      const group=node('div',undefined,'project-person'),online=data.people.some(x=>x.id===p.id);
      group.append(node('div',(online?'● ':'○ ')+p.name+(p.id===getYou()?.id?' · you':''),'person-name'));
      for(const a of allAgents().filter(a=>a.ownerId===p.id)){
        const busy=data.work.some(w=>w.agentId===a.agentId && ['running','integrating'].includes(w.status));
        const status=!a.connected?'offline':!a.ready?'reconnecting':busy?'working':a.chatBusy?'thinking':a.chatMode==='off'?'paused':'available';
        const b=button(a.name,()=>open('agent:'+a.agentId),'agent-nav'+(active==='agent:'+a.agentId?' selected':''));b.append(node('span',status,'agent-status '+status));group.append(b);
      }return group;
    }));
    if(!people.size)$('project-people').append(node('p','People and agents appear here.','sidebar-empty'));
    const threads=data.tasks.filter(t=>t.status!=='done').concat(data.tasks.filter(t=>t.status==='done')).slice(0,30);
    $('project-threads').replaceChildren(...threads.map(t=>{const b=button(t.title,()=>open('task:'+t.id),'thread-nav'+(active==='task:'+t.id?' selected':''));b.append(node('span',t.status.replaceAll('_',' '),'agent-status'));return b;}));
    if(data.tasks.length>30)$('project-threads').append(button('View all tasks',()=>open('tasks'),'thread-nav'));
    if(!threads.length)$('project-threads').append(node('p','Tasks become shared work threads.','sidebar-empty'));
    const entries=data.sharedContext.entries.filter(e=>e.status!=='retired').slice(0,12);
    $('project-resources').replaceChildren(...entries.map(e=>button(e.title,()=>openContext(e.id),'resource-nav')));
    if(!entries.length)$('project-resources').append(button('+ Add a brief or source',()=>open('context'),'resource-nav'));
  }
  function renderView(){
    if(detailView?.startsWith('task:'))expandedViews.set(detailView,[...detailBody.querySelectorAll('.task-inspector,.task-outputs')].map(el=>el.open));
    const conversation=active==='conversation',detail=/^(task|agent|file):/.test(active);
    document.querySelector('.chat').hidden=!conversation;$('doc').hidden=conversation || detail;$('project-detail').hidden=!detail;
    $('doc').classList.remove('closed');
    for(const [id,key] of Object.entries({'tasks-panel':'tasks','context-panel':'context','workspace-panel':'outputs','canvas-panel':'canvas'}))$(id).hidden=active!==key;
    $('panel-heading').textContent=title(active);
    $('conversation-new-task').disabled=!canSpeak();
    $('conversation-empty').hidden=data.chat.some(m=>['human','agent'].includes(m.kind));
    threadForm.hidden=!active.startsWith('task:');threadInput.disabled=!canSpeak();threadSend.disabled=!canSpeak();
    if(!detail)return;
    if(active.startsWith('file:')){detailView=active;renderFile();return;}
    const parts=[];
    if(active.startsWith('agent:')){
      const a=agent(active.slice(6));
      if(!a){detailBody.replaceChildren(node('p','This agent is no longer in the project.'));return;}
      parts.push(node('span','AGENT','eyebrow'),node('h1',a.name),node('p',(a.ownerName || 'Project member')+'’s agent · @'+a.handle,'detail-meta'),node('p',a.role || 'General collaborator','agent-role'));
      const mention=button('Mention in the table',()=>{open('conversation');const input=$('chat-text');input.value+=(input.value?' ':'')+'@'+a.handle+' ';input.dispatchEvent(new Event('input'));input.focus();});mention.disabled=!a.connected || !a.ready || a.chatMode==='off' || !canSpeak();parts.push(mention);
      parts.push(node('h2','Work threads'));
      const assigned=data.tasks.filter(t=>t.agentId===a.agentId);
      parts.push(...assigned.map(t=>button(t.title+' · '+t.status.replaceAll('_',' '),()=>open('task:'+t.id),'detail-task-link')));
      if(!assigned.length)parts.push(node('p','No assigned tasks yet. Create a task and choose this agent.','detail-meta'));
      parts.push(node('p',a.connected?'Discuss with this agent in the table. Its assigned work stays linked here.':'This agent is offline. Its previous conversations and outputs remain available.','detail-meta'));
    }else{
      const t=task(active.slice(5));
      if(!t){detailBody.replaceChildren(node('p','This task is no longer available.'));threadForm.hidden=true;return;}
      parts.push(node('span','WORK THREAD','eyebrow'),node('h1',t.title));
      const card=taskCard(t.id);if(card){card.querySelector('button')?.remove();parts.push(card);}
      const edit=button('Edit task & assignment',()=>openTaskEditor(t.id));edit.disabled=!canSpeak();parts.push(edit);
      const brief=node('details',undefined,'task-inspector');brief.append(node('summary','Task brief & linked context'));if(t.details)brief.append(node('p',t.details,'task-brief'));
      const sources=t.contextIds.map(id=>data.sharedContext.entries.find(e=>e.id===id)).filter(Boolean);
      if(sources.length)brief.append(...sources.map(e=>button(e.title,()=>openContext(e.id),'detail-task-link')));parts.push(brief);
      const outputs=node('details',undefined,'task-outputs');outputs.append(node('summary','Outputs & attempts · '+t.runIds.length));
      if(!t.runIds.length)outputs.append(node('p','Your agent’s progress and outputs will appear here after you start the task.','detail-meta'));
      for(const id of t.runIds){const run=data.work.find(w=>w.id===id);if(!run)continue;const result=node('article',undefined,'result-card');result.append(node('p',run.status+' · '+(run.agentName || run.ownerName),'detail-meta'),node('p',run.summary || run.message || '','task-brief'));
        for(const f of run.deliverables || [])result.append(button('Open '+f.path,()=>open('file:'+run.id+':'+f.path),'detail-task-link'));
        if(run.hasPatch || run.hasPreview)result.append(button('Review changes & preview',()=>open('outputs')));if(id!==t.runIds.at(-1)){const previous=node('details');previous.append(node('summary','Earlier attempt · '+run.status),result);outputs.append(previous);}else outputs.append(result);
      }
      parts.push(outputs);
      const latest=data.work.find(w=>w.id===t.runIds.at(-1));for(const f of latest?.deliverables || [])parts.push(button('Output · '+f.path,()=>open('file:'+latest.id+':'+f.path),'detail-task-link'));
      parts.push(node('h2','Conversation'));
      const messages=data.chat.filter(m=>m.taskId===t.id);
      for(const m of messages){const message=node('article',undefined,'thread-message');message.append(node('strong',m.author || 'Table'),node('p',m.text));parts.push(message);}
      if(!messages.length)parts.push(node('p','Discuss this task here. Messages also appear in the shared table.','detail-meta'));
      if(document.activeElement!==threadInput)threadInput.value=drafts.get(active) || '';
    }
    detailBody.replaceChildren(...parts);detailView=active;
    [...detailBody.querySelectorAll('.task-inspector,.task-outputs')].forEach((el,i)=>{el.open=!!expandedViews.get(active)?.[i];});
  }
  let fileView=null;
  function renderFile(){
    if(fileView===active)return;fileView=active;
    const [,runId,...pathParts]=active.split(':'),path=pathParts.join(':'),run=data.work.find(w=>w.id===runId),file=run?.deliverables?.find(f=>f.path===path);
    if(!file){detailBody.replaceChildren(node('p','This output is no longer available.'));return;}
    const url='/api/rooms/'+encodeURIComponent(location.pathname.split('/').pop())+'/work/'+encodeURIComponent(runId)+'/deliverables/'+path.split('/').map(encodeURIComponent).join('/');
    const link=node('a','Download file','project-button');link.href=url;link.download=path.split('/').pop();
    const content=node('pre','Loading…','file-content');detailBody.replaceChildren(node('span','OUTPUT','eyebrow'),node('h1',path),node('p',run.title+' · '+(run.agentName || run.ownerName),'detail-meta'),link,content);
    if(run.taskId)detailBody.insertBefore(button('Back to task',()=>open('task:'+run.taskId)),content);
    if(/\.(txt|md|csv|json|js|ts|py|css|html|yaml|yml|xml|log)$/i.test(path)){
      const selected=active;fetch(url).then(async response=>{if(!response.ok)throw new Error('Could not load this output.');const blob=await response.blob();if(blob.size>1024*1024)throw new Error('Download this file to view it; it is too large for the inline viewer.');return blob.text();}).then(text=>{if(active===selected)content.textContent=text;}).catch(e=>{if(active===selected)content.textContent=e.message;});
    }else content.textContent='Download this file to open it in your preferred app.';
  }
  return {open,notice(message){$('project-notice').textContent=message || '';$('project-notice').hidden=!message;},update(value){for(const key of Object.keys(data))if(value[key]!==undefined)data[key]=value[key];if(!active.startsWith('file:'))fileView=null;renderNavigation();renderTabs();renderView();},message(entry){if(entry.id && data.chat.some(m=>m.id===entry.id))return;data.chat=[...data.chat,entry].slice(-500);renderView();}};
}
