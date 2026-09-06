/* Personal workspaces: the room shares progress; each owner controls execution. */
function createWorkspaceUI({send,roomId,getYou,canSpeak,saveArtifact}) {
  const $=id=>document.getElementById(id);
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  let work=[],connections=[],pairToken=null;
  const mine=()=>connections.find(c=>c.ownerId===getYou()?.id);
  const action=(label,fn)=>{const b=node('button',label);b.type='button';b.addEventListener('click',fn);return b;};
  const url=job=>'/api/rooms/'+encodeURIComponent(roomId)+'/work/'+encodeURIComponent(job.id);
  function render(){
    $('my-workspace').textContent=mine()?mine().project+' · Your Codex is connected':'Bring your Codex and a folder of work.';
    $('conversation-mode').disabled=!mine() || (!canSpeak() && mine().chatMode==='off');
    $('conversation-mode').value=mine()?.chatMode || 'off';
    $('conversation-help').textContent=!mine()?'Connect your Codex in Workspaces to bring it to the table.':mine().chatMode==='off'?'Your agents are paused. Joining lets everyone in this room talk with your Codex.':'Room messages use your Codex. Replies are bounded; pause here anytime. Discussion is read-only. Assign work with /work @handle instructions or choose an agent in Workspaces.';
    $('conversation-agents').replaceChildren(...connections.flatMap(c=>(c.agents || [{...c,name:c.name+"’s Codex"}]).map(a=>({...a,chatMode:c.chatMode==='off'?'off':a.chatMode}))).map(c=>{
      const button=action(c.name+(c.agentId!==c.ownerId?" · "+c.ownerName+"’s agent":"")+" · "+(c.chatMode==='off'?'paused':c.chatBusy?'thinking…':c.chatMode==='mentions'?'@'+c.handle:'at the table'),()=>{
        const input=$('chat-text');input.value+=(input.value && !input.value.endsWith(' ')?' ':'')+'@'+c.handle+' ';input.dispatchEvent(new Event('input'));input.focus();
      });button.disabled=c.chatMode==='off' || !canSpeak();button.title='@'+c.handle+' · '+(c.ownerName || '')+' · '+(c.role || 'General collaborator');return button;
    }));
    $('specialist-add').disabled=!mine() || !canSpeak();
    const selected=$('workspace-agent').value;
    $('workspace-agent').replaceChildren(...(mine()?.agents || []).map(a=>{const o=node('option',a.name);o.value=a.agentId;return o;}));
    if([...( $('workspace-agent').options)].some(o=>o.value===selected))$('workspace-agent').value=selected;
    $('specialist-roster').replaceChildren(...(mine()?.agents || []).filter(a=>a.agentId!==getYou()?.id).map(a=>{
      const row=node('div',undefined,'work-actions');row.append(node('span',a.name+' · '+a.role),action('Retire '+a.name,()=>send({t:'workspace_specialist_retire',agentId:a.agentId})));return row;
    }));
    $('workspace-start').disabled=!mine() || !canSpeak();
    $('workspace-connect').disabled=!canSpeak();
    $('workspace-connect').textContent=mine()?'Reconnect my Codex':'Connect my Codex';
    $('workspace-disconnect').hidden=!mine();
    $('workspace-connections').replaceChildren(...connections.map(c=>node('span',c.name+' · '+c.project,'workspace-person')));
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
        buttons.append(action(busy?'Stop':'Archive',()=>send({t:busy?'workspace_cancel':'workspace_archive',id:job.id})));
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
  $('workspace-play').addEventListener('close',()=>{$('workspace-preview').src='about:blank';});
  document.querySelectorAll('[data-close-workspace]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
  $('workspace-connect').addEventListener('click',()=>{
    pairToken=null;$('pair-copy').textContent='Copy command';
    $('pair-command').textContent='Preparing your connection…';
    $('workspace-pair').showModal();send({t:'workspace_pair'});
  });
  $('workspace-disconnect').addEventListener('click',()=>send({t:'workspace_disconnect'}));
  const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
  function command(){
    if(!pairToken)return;
    const path=$('pair-project').value.trim() || '/path/to/work';
    let text='ROUNDTABLE_PAIR_TOKEN='+quote(pairToken)+' node bridge/workspace.js '+quote(location.origin+'/s/'+roomId)+' --project '+quote(path)+' --workspace-mode '+quote($('pair-mode').value);
    if($('pair-check').value.trim())text+=' --check '+quote($('pair-check').value.trim());
    if($('pair-preview').value.trim())text+=' --preview-dir '+quote($('pair-preview').value.trim());
    $('pair-command').textContent=text;
  }
  ['pair-project','pair-check','pair-preview','pair-mode'].forEach(id=>$(id).addEventListener('input',command));
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
    update(nextWork=work,nextConnections=connections){work=nextWork;connections=nextConnections;render();},
    progress(id,message){const el=[...document.querySelectorAll('[data-work-id]')].find(n=>n.dataset.workId===id);if(el)el.textContent=message;const job=work.find(w=>w.id===id);if(job)job.message=message;},
    pair(token){pairToken=token;command();},
  };
}
