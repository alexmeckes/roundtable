function createContextUI({send,roomId,getYou,canSpeak}){
  const $=id=>document.getElementById(id),labels={brief:'Brief',source:'Source',decision:'Decision',learning:'Learning',skill:'Skill'};
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,fn)=>{const b=node('button',text);b.type='button';b.disabled=!canSpeak();b.onclick=fn;return b;};
  let context={revision:0,entries:[],adoptions:{}},editing=null,origin=null,pending=null;
  function request(msg){const requestId=crypto.randomUUID();if(send({...msg,requestId}))return requestId;return null;}
  function edit(entry,seed={}){
    editing=entry?{id:entry.id,version:entry.version}:null;origin=seed.chatId || null;
    $('context-kind').value=entry?.kind || seed.kind || 'source';$('context-kind').disabled=!!entry;
    $('context-title').value=entry?.title || seed.title || '';
    $('context-body').value=entry?.body || seed.body || '';
    $('context-url').value=entry?.url || seed.url || '';
    $('context-refs').replaceChildren(...context.entries.filter(e=>e.status==='accepted' && e.id!==entry?.id).map(e=>{const o=node('option',labels[e.kind]+': '+e.title);o.value=e.id;o.selected=!!entry?.refs.includes(e.id);return o;}));
    $('context-form-title').textContent=entry?'Edit '+labels[entry.kind].toLowerCase():'Add shared context';
    $('context-form-error').textContent='';$('context-save').disabled=!canSpeak();
    $('context-dialog').showModal();$('context-title').focus();
  }
  function render(){
    $('context-add').disabled=!canSpeak();
    document.querySelectorAll('.context-save-chat').forEach(b=>b.disabled=!canSpeak());
    const filter=$('context-filter').value,query=$('context-search').value.toLowerCase(),retired=$('context-retired').checked;
    const selected=context.entries.filter(e=>(retired || e.status!=='retired') && (!filter || e.kind===filter) && (!query || (e.title+' '+e.body).toLowerCase().includes(query)));
    selected.sort((a,b)=>(a.status==='proposed'?-1:0)-(b.status==='proposed'?-1:0) || (a.kind==='brief'?-1:0)-(b.kind==='brief'?-1:0) || b.updatedAt-a.updatedAt);
    $('context-count').textContent=context.entries.filter(e=>e.status==='proposed').length+' awaiting review';
    $('context-empty').hidden=selected.length>0;
    $('context-items').replaceChildren(...selected.map(entry=>{
      const card=node('article',undefined,'context-card '+entry.status);
      card.append(node('p',labels[entry.kind]+' · '+(entry.status==='proposed'?'Proposed — needs review':entry.status==='accepted'?'Accepted':'Retired'),'context-meta'),node('h3',entry.title),node('p',entry.body,'context-body'));
      if(entry.url){const link=node('a','Open source');link.href=entry.url;link.target='_blank';link.rel='noopener noreferrer';card.append(link);}
      if(entry.refs.length)card.append(node('p','Evidence: '+entry.refs.map(id=>{const e=context.entries.find(e=>e.id===id),cited=entry.evidence?.find(ref=>ref.id===id);return e?e.title+(cited?' v'+cited.version:'')+(e.status!=='accepted'?' ('+e.status+')':cited && cited.version!==e.version?' (source now v'+e.version+')':''):id;}).join('; '),'context-meta'));
      const by=entry.createdBy;
      card.append(node('p','Added by '+by.name+(by.ownerName?' · '+by.ownerName+'’s agent':'')+' · v'+entry.version+' · Last updated by '+entry.updatedBy.name+' · '+new Date(entry.updatedAt).toLocaleString(),'context-meta'));
      if(entry.origin){const source=node('details'),summary=node('summary','Original conversation');source.append(summary,node('p',entry.origin.author+': '+entry.origin.text,'context-body'));card.append(source);}
      const actions=node('div',undefined,'context-actions');
      if(entry.status!=='retired'){
        actions.append(button('Edit',()=>edit(entry)));
        if(entry.status==='proposed')actions.append(button('Accept',()=>request({t:'context_status',id:entry.id,version:entry.version,status:'accepted'})));
        actions.append(button(entry.status==='proposed'?'Dismiss':'Retire',()=>request({t:'context_status',id:entry.id,version:entry.version,status:'retired'})));
        if(entry.kind==='skill' && entry.status==='accepted'){
          const adopted=context.adoptions[getYou()?.id]?.[entry.id]===entry.version;
          const b=button(adopted?'Stop using for my agents':'Use for my agents',()=>request({t:'context_skill',id:entry.id,version:entry.version,use:!adopted}));
          if(adopted)b.disabled=false;
          actions.append(b);card.append(node('p',adopted?'You opted into this version.':'Shared instructions. Review before opting in; nothing is installed.','context-meta'));
        }
      }
      card.append(actions);
      if(entry.history.length){const history=node('details');history.append(node('summary','History ('+entry.history.length+')'));
        for(const version of [...entry.history].reverse())history.append(node('p','v'+version.version+' · '+version.status+' · '+version.updatedBy.name+' · '+new Date(version.updatedAt).toLocaleString(),'context-meta'),node('p',version.title+'\n'+version.body+(version.url?'\n'+version.url:''),'context-body'));
        card.append(history);
      }
      return card;
    }));
  }
  $('context-add').onclick=()=>edit(null);
  for(const id of ['context-filter','context-search','context-retired'])$(id).addEventListener('input',render);
  $('context-close').onclick=()=>$('context-dialog').close();
  $('context-form').onsubmit=event=>{
    event.preventDefault();if(pending || !canSpeak())return;
    pending=request({t:'context_save',...editing,chatId:origin,kind:$('context-kind').value,title:$('context-title').value,body:$('context-body').value,url:$('context-url').value,refs:[...$('context-refs').selectedOptions].map(o=>o.value)});
    $('context-save').disabled=!!pending;
  };
  return {
    update(value=context){context=value;render();},
    result(msg){if(msg.t==='context_error'){$('context-notice').textContent=msg.message;if(pending===msg.requestId)$('context-form-error').textContent=msg.message;}else $('context-notice').textContent='';if(pending===msg.requestId){pending=null;$('context-save').disabled=!canSpeak();if(msg.t==='context_saved')$('context-dialog').close();}},
    disconnected(){pending=null;$('context-save').disabled=!canSpeak();},
    focus(id){const entry=context.entries.find(e=>e.id===id);if(entry){$('context-filter').value='';$('context-search').value=entry.title;$('context-retired').checked=entry.status==='retired';render();}},
    fromMessage(entry){edit(null,{kind:'learning',title:entry.text.replace(/\s+/g,' ').slice(0,80),body:entry.text.slice(0,6000),chatId:entry.id});},
    fromArtifact(job,file){edit(null,{kind:'source',title:file.path,body:'Deliverable from '+(job.agentName || job.ownerName)+': '+job.title+'\n'+(job.summary || ''),url:location.origin+'/api/rooms/'+encodeURIComponent(roomId)+'/work/'+encodeURIComponent(job.id)+'/deliverables/'+file.path.split('/').map(encodeURIComponent).join('/')});}
  };
}
