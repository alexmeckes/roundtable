/* Personal workspaces: the room shares progress; each owner controls execution. */
function createWorkspaceUI({send,roomId,getYou,canSpeak,requestReply,saveArtifact}) {
  const $=id=>document.getElementById(id);
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  let work=[],connections=[],roster=[],pairToken=null;
  let nativeToken=null;
  const mine=()=>connections.find(c=>c.ownerId===getYou()?.id);
  const action=(label,fn)=>{const b=node('button',label);b.type='button';b.addEventListener('click',fn);return b;};
  const url=job=>'/api/rooms/'+encodeURIComponent(roomId)+'/work/'+encodeURIComponent(job.id);
  const chatAgents=()=>roster.flatMap(c=>(c.agents || [{...c,name:c.name+"’s Codex"}]).map(a=>({...a,connected:c.connected!==false,ready:c.ready!==false,saved:c.savedConversations?.includes(a.agentId),chatMode:c.chatMode==='off'?'off':a.chatMode})));
  const available=a=>a.connected && a.ready && a.chatMode!=='off';
  const chatStatus=a=>!a.connected?'offline':!a.ready?'reconnecting':a.chatMode==='off'?'paused':a.chatBusy?'thinking…':'ready';
  function mention(handle){
    const input=$('chat-text');input.value+=(input.value && !input.value.endsWith(' ')?' ':'')+'@'+handle+' ';input.dispatchEvent(new Event('input'));input.focus();
  }
  function composer(){
    const agents=chatAgents(),own=mine(),button=$('chat-ask-ai');
    $('chat-mention').disabled=!canSpeak() || !agents.some(available);
    button.textContent=!own?'Connect my AI':own.chatMode==='off'?'Enable my AI':'Ask my AI';
    button.disabled=!canSpeak() || !!own && (own.ready===false || own.chatMode!=='off' && !$('chat-text').value.trim());
    button.title=!own?'Connect your Codex so its answers appear in this room.':own.chatMode==='off'?'Allow replies when you or a collaborator @mentions your AI.':'Send this message to @'+own.handle+' and show its answer here.';
    $('chat-ai-status').textContent=!canSpeak()?'View-only room':!own?agents.some(available)?'Mention an available AI for a reply here.':'Connect your AI to reply here.':own.ready===false?'Your AI is reconnecting…':own.chatMode==='off'?'Your AI is paused.':own.chatBusy?'Your AI is thinking…':'Replies here · @'+own.handle;
  }
  function render(){
    const usingPlan=mine()?.authMode==='chatgpt-plan';
    $('my-workspace').textContent=mine()?mine().project+(mine().ready===false?' · Restoring local sessions…':' · Your Codex is connected')+(usingPlan?' · Using ChatGPT plan':''):'Bring your Codex and a folder of work.';
    $('workspace-usage').hidden=!usingPlan;
    $('conversation-usage').hidden=!usingPlan;
    $('conversation-mode').disabled=!mine() || (!canSpeak() && mine().chatMode==='off');
    $('conversation-mode').value=mine()?.chatMode || 'off';
    $('conversation-help').textContent=!mine()?'Connect your AI using the button below the message box. Its replies appear in this conversation.':mine().chatMode==='off'?'Your AI is paused. Enable mentions to answer questions here.':'@mentions and Ask my AI get a reply here. Discussion is read-only. Pause here anytime; create a task when you want work done.';
    const agents=chatAgents();
    $('conversation-agents').hidden=!agents.length;
    $('conversation-agents').replaceChildren(...agents.map(c=>{
      const button=action(c.name+' · '+chatStatus(c),()=>mention(c.handle));
      button.disabled=!available(c) || !canSpeak();button.title='@'+c.handle+' · '+(c.ownerName || '')+' · '+(c.role || 'General collaborator')+(c.saved?' · Saved conversation':'');return button;
    }));
    $('chat-mention').replaceChildren(node('option','@ Mention AI'),...agents.map(a=>{const option=node('option',a.name+' · @'+a.handle+' · '+chatStatus(a));option.value=a.handle;option.disabled=!available(a);return option;}));
    $('chat-mention').options[0].value='';composer();
    $('specialist-add').disabled=!mine() || mine()?.ready===false || !canSpeak();
    const selected=$('workspace-agent').value;
    $('workspace-agent').replaceChildren(...(mine()?.agents || []).map(a=>{const o=node('option',a.name);o.value=a.agentId;return o;}));
    if([...( $('workspace-agent').options)].some(o=>o.value===selected))$('workspace-agent').value=selected;
    $('specialist-roster').replaceChildren(...(mine()?.agents || []).filter(a=>a.agentId!==getYou()?.id).map(a=>{
      const row=node('div',undefined,'work-actions');row.append(node('span',a.name+' · '+a.role),action('Retire '+a.name,()=>send({t:'workspace_specialist_retire',agentId:a.agentId})));return row;
    }));
    $('workspace-start').disabled=!mine() || mine()?.ready===false || !canSpeak();
    $('workspace-connect').disabled=!canSpeak();
    $('native-connect').disabled=!canSpeak();
    $('workspace-connect').textContent=mine()?'Reconnect my Codex':'Connect my Codex';
    $('workspace-disconnect').hidden=!mine();
    $('workspace-connections').replaceChildren(...roster.map(c=>node('span',c.name+' · '+c.project+' · '+(!c.connected?'Offline'+(c.lastDisconnectedAt?' · last connected '+new Date(c.lastDisconnectedAt).toLocaleString():''):c.ready===false?'Reconnecting':work.some(w=>w.ownerId===c.ownerId && ['running','integrating'].includes(w.status))?'Working':'Connected')+(c.savedConversations?.length?' · '+c.savedConversations.length+' saved conversation(s)':''),'workspace-person')));
    const cards=work.map(job=>{
      const card=node('article',undefined,'work-card');
      card.append(node('h3',job.title),node('p',(job.agentName || job.ownerName)+' · '+job.ownerName+' · '+job.status,'work-meta'));
      const progress=node('p',job.message || '', 'work-message');progress.dataset.workId=job.id;card.append(progress);
      if(job.summary)card.append(node('p',job.summary));
      if(job.branch)card.append(node('code',job.branch));
      if(job.files?.length)card.append(node('p',job.files.length+(job.deliverables?.length?' deliverable(s)':' file(s) changed'),'work-meta'));
      const buttons=node('div',undefined,'work-actions');
      if(job.hasPatch)buttons.append(action('Review changes',()=>review(job)));
      for(const file of job.deliverables || []){const link=node('a','Download '+file.path);link.href=url(job)+'/deliverables/'+file.path.split('/').map(encodeURIComponent).join('/');link.download=file.path.split('/').pop();buttons.append(link);if(saveArtifact)buttons.append(action('Save '+file.path+' to context',()=>saveArtifact(job,file)));}
      if(job.hasPreview)buttons.append(action('Open preview',()=>play(job)));
      const busy=['running','integrating'].includes(job.status);
      if(job.ownerId===getYou()?.id && (busy || canSpeak())) {
        if(busy || !job.taskId)buttons.append(action(busy?'Stop':'Archive',()=>send({t:busy?'workspace_cancel':'workspace_archive',id:job.id})));
      }
      card.append(buttons);return card;
    });
    $('workspace-cards').replaceChildren(...cards);
    $('workspace-empty').hidden=work.length>0;
  }
  async function review(job){
    const dialog=$('workspace-review');
    $('review-title').textContent=job.title+' — '+job.ownerName;
    $('review-summary').textContent=job.summary || '';
    $('review-checks').textContent=job.checks || 'No automated checks reported.';
    $('review-diff').textContent='Loading changes…';
    $('review-accept').checked=false;
    $('review-integrate').disabled=true;
    $('review-explanation').textContent=mine()?.workspaceMode==='folder'?'This connection uses an ordinary folder. Git integration requires a repository connection.':mine()?'Integration prepares a separate branch, runs your configured checks, then updates your clean local checkout. Conflicts leave your checkout unchanged.':'Connect your Codex to integrate this contribution into your local project.';
    let loaded=false;
    const eligible=()=>loaded && !!mine() && mine().workspaceMode!=='folder' && canSpeak() && ['ready','integrated'].includes(job.status);
    $('review-accept').onchange=()=>{$('review-integrate').disabled=!(eligible() && $('review-accept').checked);};
    $('review-integrate').onclick=()=>{if(!eligible() || !$('review-accept').checked)return;send({t:'workspace_integrate',id:job.id});dialog.close();};
    dialog.showModal();
    try {const response=await fetch(url(job)+'/patch');if(!response.ok)throw new Error('Contribution no longer available');$('review-diff').textContent=await response.text();loaded=true;$('review-integrate').disabled=!(eligible() && $('review-accept').checked);}
    catch(error){$('review-diff').textContent=error.message;}
  }
  function play(job){
    $('play-title').textContent=job.title+' · '+job.ownerName;
    $('workspace-preview').src=url(job)+'/preview/index.html';
    $('workspace-play').showModal();
  }
  $('specialist-add').addEventListener('click',()=>$('specialist-dialog').showModal());
  $('specialist-form').addEventListener('submit',event=>{
    event.preventDefault();if(send({t:'workspace_specialist_create',name:$('specialist-name').value,role:$('specialist-role').value})){
      $('specialist-dialog').close();$('specialist-name').value='';$('specialist-role').value='';
    }
  });
  $('conversation-mode').addEventListener('change',()=>send({t:'workspace_chat_mode',mode:$('conversation-mode').value}));
  $('chat-mention').addEventListener('change',()=>{const handle=$('chat-mention').value;if(handle)mention(handle);$('chat-mention').value='';});
  $('chat-ask-ai').addEventListener('click',()=>{
    if(!canSpeak())return;
    const own=mine();
    if(!own){$('workspace-connect').click();return;}
    if(own.ready===false)return;
    if(own.chatMode==='off'){send({t:'workspace_chat_mode',mode:'mentions'});return;}
    requestReply?.(own.handle);
  });
  $('workspace-play').addEventListener('close',()=>{$('workspace-preview').src='about:blank';});
  document.querySelectorAll('[data-close-workspace]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
  $('workspace-connect').addEventListener('click',()=>{
    pairToken=null;$('pair-copy').textContent='Copy command';
    $('pair-auth').value=mine()?.authMode || 'codex';authHelp();
    $('pair-command').textContent='Preparing your connection…';
    $('workspace-pair').showModal();send({t:'workspace_pair'});
  });
  $('workspace-disconnect').addEventListener('click',()=>send({t:'workspace_disconnect'}));
  $('native-connect').addEventListener('click',()=>{
    nativeToken=null;$('native-command').textContent='Preparing your connection…';$('native-copy').textContent='Copy command';
    $('native-pair').showModal();send({t:'workspace_native_pair'});
  });
  $('native-disconnect').addEventListener('click',()=>send({t:'workspace_native_disconnect'}));
  const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
  $('native-copy').addEventListener('click',async()=>{
    if(!nativeToken)return;
    try{await navigator.clipboard.writeText($('native-command').textContent);$('native-copy').textContent='Copied';}catch{$('native-copy').textContent='Select and copy the command above';}
  });
  function authHelp(){
    $('pair-auth-help').textContent=$('pair-auth').value==='chatgpt-plan'?'Uses eligible ChatGPT Plus or Pro plan usage (preview). If sign-in is needed, running this command opens Continue with ChatGPT in your system browser. Node and the local Codex runtime are still required.':'Uses your existing local Codex login, instructions, skills, and tools.';
  }
  function command(){
    if(!pairToken)return;
    const path=$('pair-project').value.trim() || '/path/to/work';
    let text='ROUNDTABLE_PAIR_TOKEN='+quote(pairToken)+' node bridge/workspace.js '+quote(location.origin+'/s/'+roomId)+' --project '+quote(path)+' --workspace-mode '+quote($('pair-mode').value);
    if($('pair-auth').value==='chatgpt-plan')text+=' --auth chatgpt-plan';
    if($('pair-check').value.trim())text+=' --check '+quote($('pair-check').value.trim());
    if($('pair-preview').value.trim())text+=' --preview-dir '+quote($('pair-preview').value.trim());
    $('pair-command').textContent=text;
  }
  ['pair-project','pair-check','pair-preview','pair-mode'].forEach(id=>$(id).addEventListener('input',command));
  $('pair-auth').addEventListener('change',()=>{authHelp();command();});
  $('pair-copy').addEventListener('click',async()=>{
    if(!pairToken)return;
    try{await navigator.clipboard.writeText($('pair-command').textContent);$('pair-copy').textContent='Copied';}catch{$('pair-copy').textContent='Select and copy the command above';}
  });
  $('workspace-form').addEventListener('submit',event=>{
    event.preventDefault();const instructions=$('workspace-task').value.trim();
    if(!instructions || !mine() || !canSpeak())return;
    if(send({t:'workspace_start',instructions,agentId:$('workspace-agent').value}))$('workspace-task').value='';
  });
  return {
    draftChanged:composer,
    isAgentHandle:handle=>chatAgents().some(a=>a.handle?.toLowerCase()===handle.toLowerCase()),
    update(nextWork=work,nextConnections=connections,nextRoster=roster){work=nextWork;connections=nextConnections;roster=nextRoster;render();},
    progress(id,message){const el=[...document.querySelectorAll('[data-work-id]')].find(n=>n.dataset.workId===id);if(el)el.textContent=message;const job=work.find(w=>w.id===id);if(job)job.message=message;},
    pair(token){pairToken=token;command();},
    nativePair(token){nativeToken=token;$('native-command').textContent='ROUNDTABLE_NATIVE_TOKEN='+quote(token)+' node scripts/connect-native.mjs '+quote(location.origin+'/s/'+roomId);},
    nativeDisconnected(){nativeToken=null;if($('native-pair').open)$('native-pair').close();},
  };
}
