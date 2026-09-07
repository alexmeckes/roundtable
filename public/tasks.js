/* Planning stays shared; starting an execution remains the owner's action. */
function createTasksUI({send,getYou,canSpeak,roomId}){
  const $=id=>document.getElementById(id),labels={planned:'Planned',working:'Working',blocked:'Blocked',needs_review:'Needs review',done:'Done'};
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  let tasks=[],people=[],agents=[],context=[],work=[],editing=null,origin=null,pending=null,chat=[];
  const request=msg=>{const requestId=crypto.randomUUID();return send({...msg,requestId})?requestId:null;};
  const option=(text,value,selected)=>{const n=node('option',text);n.value=value;n.selected=selected;return n;};
  const action=(text,fn,disabled=false)=>{const b=node('button',text);b.type='button';b.disabled=disabled;b.onclick=fn;return b;};
  function agentOptions(selected=''){
    $('task-agent').replaceChildren(option('No agent',''),...agents.filter(a=>a.ownerId===$('task-owner').value).map(a=>option(a.name,a.id,a.id===selected)));
  }
  function comments(){
    const messages=chat.filter(m=>editing && m.taskId===editing.id);
    $('task-comments').replaceChildren(...messages.map(m=>node('p',(m.author || 'Table')+': '+m.text,'context-body')));
  }
  function edit(task,seed={}){
    editing=task?{id:task.id,version:task.version}:null;origin=seed.chatId || null;
    $('task-dialog-title').textContent=task?'Task details':'New task';
    $('task-title').value=task?.title || seed.title || '';$('task-details').value=task?.details || seed.details || '';
    $('task-owner').replaceChildren(option('Unassigned',''),...people.map(p=>option(p.name,p.id,p.id===(task?task.ownerId:getYou()?.id))));
    agentOptions(task?.agentId);
    $('task-status').replaceChildren(...Object.entries(labels).map(([id,label])=>option(label,id,id===(task?.status || 'planned'))));
    $('task-status').querySelector('[value=working]').disabled=true;
    $('task-dependencies').replaceChildren(...tasks.filter(t=>t.id!==task?.id).map(t=>option(t.title,t.id,task?.dependencies.includes(t.id))));
    $('task-context').replaceChildren(...context.filter(e=>e.status==='accepted').map(e=>option(e.title,e.id,task?.contextIds.includes(e.id))));
    $('task-origin').textContent=task?.origin?'From '+task.origin.author+': '+task.origin.text:'';
    $('task-results').replaceChildren(...(task?.runIds || []).flatMap(id=>{const run=work.find(w=>w.id===id);if(!run)return [];const wrap=node('div');wrap.append(node('p',run.status+' · '+(run.summary || run.message || ''),'context-body'));for(const file of run.deliverables || []){const a=node('a','Download '+file.path);a.href='/api/rooms/'+encodeURIComponent(roomId)+'/work/'+encodeURIComponent(id)+'/deliverables/'+file.path.split('/').map(encodeURIComponent).join('/');wrap.append(a);}if(run.hasPatch){const a=node('a','Review patch');a.href='/api/rooms/'+encodeURIComponent(roomId)+'/work/'+encodeURIComponent(id)+'/patch';a.target='_blank';wrap.append(a);}return [wrap];}));
    $('task-comment-form').hidden=!task;comments();
    $('task-error').textContent='';$('task-save').disabled=!canSpeak() || task?.status==='working';
    $('task-dialog').showModal();
  }
  function render(){
    $('task-add').disabled=!canSpeak();
    $('task-board').replaceChildren(...Object.entries(labels).map(([status,label])=>{
      const section=node('section',undefined,'task-lane'),items=tasks.filter(t=>t.status===status);
      section.append(node('h3',label+' · '+items.length));
      if(!items.length)section.append(node('p','No tasks','context-meta'));
      for(const task of items){
        const card=node('article',undefined,'task-card');
        card.append(action(task.title,()=>edit(task)),node('p',(people.find(p=>p.id===task.ownerId)?.name || 'Unassigned')+' · '+(agents.find(a=>a.id===task.agentId)?.name || 'No agent'),'context-meta'));
        const waiting=task.dependencies.map(id=>tasks.find(t=>t.id===id)).filter(t=>t && t.status!=='done');
        if(waiting.length)card.append(node('p','Waiting for: '+waiting.map(t=>t.title).join(', '),'task-waiting'));
        const run=work.find(w=>w.id===task.runIds.at(-1));
        if(run && ['working','blocked'].includes(status)){card.append(node('p',run.message || 'Agent is working…','context-meta'));if(status==='working' && task.ownerId===getYou()?.id)card.append(action('Stop my agent',()=>request({t:'workspace_cancel',id:run.id})));}
        if(task.ownerId===getYou()?.id && ['planned','blocked'].includes(status))card.append(action('Start my agent',()=>request({t:'task_start',id:task.id,version:task.version}),!canSpeak() || !task.agentId || !!waiting.length));
        section.append(card);
      }return section;
    }));
  }
  $('task-add').onclick=()=>edit(null);$('task-close').onclick=()=>$('task-dialog').close();
  $('task-owner').onchange=()=>agentOptions();
  $('task-form').onsubmit=e=>{e.preventDefault();if(pending)return;pending=request({t:'task_save',...editing,chatId:origin,title:$('task-title').value,details:$('task-details').value,ownerId:$('task-owner').value,agentId:$('task-agent').value,status:$('task-status').value,dependencies:[...$('task-dependencies').selectedOptions].map(o=>o.value),contextIds:[...$('task-context').selectedOptions].map(o=>o.value)});$('task-save').disabled=!!pending;};
  $('task-comment-form').onsubmit=e=>{e.preventDefault();const text=$('task-comment').value.trim();if(text && editing && send({t:'chat',text,taskId:editing.id}))$('task-comment').value='';};
  return {
    update(value={}){if(value.tasks)tasks=value.tasks;if(value.taskPeople)people=value.taskPeople;if(value.taskAgents)agents=value.taskAgents;if(value.work)work=value.work;if(value.sharedContext)context=value.sharedContext.entries;render();},
    message(entry){if(!entry.id || !chat.some(m=>m.id===entry.id))chat.push(entry);if(chat.length>500)chat.shift();comments();},
    history(entries){chat=[...entries];comments();},
    result(m){if(m.t==='task_error'){$('task-notice').textContent=m.message;$('task-error').textContent=m.message;}else $('task-notice').textContent='';if(m.requestId===pending){pending=null;$('task-save').disabled=!canSpeak();if(m.t==='task_saved')$('task-dialog').close();}},
    disconnected(){pending=null;$('task-save').disabled=true;},
    open(id){const task=tasks.find(t=>t.id===id);if(task)edit(task);},
    fromMessage(m){edit(null,{title:m.text.replace(/\s+/g,' ').slice(0,120),details:m.text.slice(0,4000),chatId:m.id});}
  };
}
