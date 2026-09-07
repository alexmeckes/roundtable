function createCatchupUI({send,openTask,openContext,isReading=()=>true}){
  const $=id=>document.getElementById(id);
  let through=0,pending=false,joined=false,away=false;
  function seen(){if(joined && !pending && isReading() && document.visibilityState==='visible' && document.hasFocus() && through)send({t:'catchup_seen',through});}
  $('catchup-dismiss').onclick=()=>{if(send({t:'catchup_seen',through})) {pending=false;$('catchup-panel').hidden=true;}};
  function visibility(){if(document.visibilityState!=='visible' || !document.hasFocus()){away=true;return;}if(away && joined){away=false;send({t:'catchup_request'});}}
  document.addEventListener('visibilitychange',visibility);window.addEventListener('blur',visibility);window.addEventListener('focus',visibility);setInterval(seen,15000);
  return {
    welcome(value){joined=true;through=value.through;pending=!!(value.taskCount || value.contextCount || value.messageCount);$('catchup-panel').hidden=!pending;
      $('catchup-summary').textContent=`Since your last visit: ${value.taskCount} task update${value.taskCount===1?'':'s'}, ${value.contextCount} context update${value.contextCount===1?'':'s'}, ${value.messageCount}${value.limitedHistory?'+':''} message${value.messageCount===1 && !value.limitedHistory?'':'s'}.`;
      const items=[];
      for(const task of value.tasks){const b=document.createElement('button');b.textContent=task.title+' · '+task.status.replaceAll('_',' ');b.onclick=()=>openTask(task.id);items.push(b);}
      for(const entry of value.context){const b=document.createElement('button');b.textContent=entry.kind+': '+entry.title+' · '+entry.status;b.onclick=()=>openContext(entry.id);items.push(b);}
      $('catchup-items').replaceChildren(...items);if(!pending)seen();
    },
    delivered(asOf){if(Number.isSafeInteger(asOf))through=Math.max(through,asOf);},
    disconnected(){joined=false;}
  };
}
