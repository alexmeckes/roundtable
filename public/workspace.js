/* Personal workspaces: the room shares progress; each owner controls execution. */
function createWorkspaceUI({send,roomId,getYou,canSpeak}) {
  const $=id=>document.getElementById(id);
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  let work=[],connections=[],pairToken=null;
  const mine=()=>connections.find(c=>c.ownerId===getYou()?.id);
  const action=(label,fn)=>{const b=node('button',label);b.type='button';b.addEventListener('click',fn);return b;};
  const url=job=>'/api/rooms/'+encodeURIComponent(roomId)+'/work/'+encodeURIComponent(job.id);
  function render(){
    $('my-workspace').textContent=mine()?mine().project+' · Your Codex is connected':'Bring your Codex and a local clone of the game.';
    $('workspace-start').disabled=!mine() || !canSpeak();
    $('workspace-connect').disabled=!canSpeak();
    $('workspace-connect').textContent=mine()?'Reconnect my Codex':'Connect my Codex';
    $('workspace-disconnect').hidden=!mine();
    $('workspace-connections').replaceChildren(...connections.map(c=>node('span',c.name+' · '+c.project,'workspace-person')));
    const cards=work.map(job=>{
      const card=node('article',undefined,'work-card');
      card.append(node('h3',job.title),node('p',job.ownerName+' · '+job.status,'work-meta'));
      const progress=node('p',job.message || '', 'work-message');progress.dataset.workId=job.id;card.append(progress);
      if(job.summary)card.append(node('p',job.summary));
      if(job.branch)card.append(node('code',job.branch));
      if(job.files?.length)card.append(node('p',job.files.length+' file(s) changed','work-meta'));
      const buttons=node('div',undefined,'work-actions');
      if(job.hasPatch)buttons.append(action('Review changes',()=>review(job)));
      if(job.hasPreview)buttons.append(action('Play build',()=>play(job)));
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
    $('review-explanation').textContent=mine()?'Integration prepares a separate branch, runs your configured checks, then updates your clean local checkout. Conflicts leave your checkout unchanged.':'Connect your Codex to integrate this contribution into your local project.';
    let loaded=false;
    const eligible=()=>loaded && !!mine() && canSpeak() && ['ready','integrated'].includes(job.status);
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
    const path=$('pair-project').value.trim() || '/path/to/game';
    let text='ROUNDTABLE_PAIR_TOKEN='+quote(pairToken)+' node bridge/workspace.js '+quote(location.origin+'/s/'+roomId)+' --project '+quote(path);
    if($('pair-check').value.trim())text+=' --check '+quote($('pair-check').value.trim());
    if($('pair-preview').value.trim())text+=' --preview-dir '+quote($('pair-preview').value.trim());
    $('pair-command').textContent=text;
  }
  ['pair-project','pair-check','pair-preview'].forEach(id=>$(id).addEventListener('input',command));
  $('pair-copy').addEventListener('click',async()=>{
    if(!pairToken)return;
    try{await navigator.clipboard.writeText($('pair-command').textContent);$('pair-copy').textContent='Copied';}catch{$('pair-copy').textContent='Select and copy the command above';}
  });
  $('workspace-form').addEventListener('submit',event=>{
    event.preventDefault();const instructions=$('workspace-task').value.trim();
    if(!instructions || !mine() || !canSpeak())return;
    if(send({t:'workspace_start',instructions}))$('workspace-task').value='';
  });
  return {
    update(nextWork=work,nextConnections=connections){work=nextWork;connections=nextConnections;render();},
    progress(id,message){const el=[...document.querySelectorAll('[data-work-id]')].find(n=>n.dataset.workId===id);if(el)el.textContent=message;const job=work.find(w=>w.id===id);if(job)job.message=message;},
    pair(token){pairToken=token;command();},
  };
}
