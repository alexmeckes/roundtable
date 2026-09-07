/* The local launcher is authenticated separately from the shared room socket. */
function createLocalConnectionUI({roomId,getMemberKey,manual}){
  const $=id=>document.getElementById(id),dialog=$('local-connect');let controller,busy=false,current,poll;
  async function request(action,body={}){
    const active=controller;
    const response=await fetch('/api/local/rooms/'+encodeURIComponent(roomId)+'/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Roundtable-Member':getMemberKey() || ''},body:JSON.stringify(body),signal:active?.signal});
    active?.signal.throwIfAborted();
    if(response.status===404)return {available:false};
    const result=await response.json();active?.signal.throwIfAborted();if(!response.ok)throw new Error(result.error || 'Could not connect to the local manager.');return result;
  }
  function message(text,error=false){$('local-message').textContent=text;$('local-message').classList.toggle('error',error);}
  function render(){
    const ready=current?.installed && current?.signedIn;
    $('local-runtime').textContent=!current?'Checking Codex on this machine…':!current.installed?'Codex is not installed yet.':!current.signedIn?'Codex '+current.version+' · Sign-in needed':'Codex '+current.version+' · Signed in';
    $('local-choose').disabled=busy || !ready;$('local-reconnect').disabled=busy || !ready;
    $('local-current').hidden=!current?.suggested || current.saved?.path===current.suggested.path;$('local-current').disabled=busy || !ready;$('local-current').textContent='Use '+(current?.suggested?.name || 'Codex project');
    $('local-reconnect').hidden=!current?.saved;$('local-reconnect').textContent='Reconnect '+(current?.saved?.name || '');
    $('local-saved').textContent=current?.saved?'Last used: '+current.saved.name+' · '+(current.saved.mode==='git'?'Git repository':'Folder'):'';
    $('local-login').hidden=!current?.installed || current.signedIn;$('local-login').disabled=busy;
    $('local-install').hidden=!current || current.installed;$('local-refresh').disabled=busy;
    $('local-choose').textContent=busy?'Connecting…':current?.picker?'Choose a folder & connect':'Connect this folder';
    if(current && !current.picker)$('local-advanced').open=true;
  }
  async function refresh(){current=await request('status');render();return current;}
  async function connect(saved=false,project=false){
    if(busy)return;const active=controller;busy=true;message(saved?'Reconnecting your agents…':project?'Connecting your Codex project…':'Choose a folder in the dialog on your computer.');render();
    try{
      let selection;
      if(!saved && !project){const picked=await request('choose',{path:$('local-path').value.trim() || undefined,mode:$('local-mode').value});if(picked.cancelled){message('No folder selected. Choose a folder whenever you’re ready.');return;}if(!picked.selection)throw new Error('The local connection manager is unavailable.');selection=picked.selection;message('Connecting '+picked.name+'…');}
      const result=await request('start',{selection,saved,project,check:$('local-check').value.trim(),preview:$('local-preview').value.trim()});
      if(!result.connected)throw new Error('Could not connect your agents.');dialog.close();
    }catch(error){if(error.name!=='AbortError')message(error.message,true);}finally{if(active===controller){busy=false;if(dialog.open)render();}}
  }
  $('local-current').onclick=()=>connect(false,true);
  $('local-choose').onclick=()=>connect();$('local-reconnect').onclick=()=>connect(true);
  $('local-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{if(!dialog.open){controller?.abort();clearInterval(poll);}});
  $('local-manual').onclick=()=>{dialog.close();manual();};
  $('local-refresh').onclick=async()=>{try{await refresh();message(current.signedIn?'Ready to connect.':'Finish installing or signing in, then check again.');}catch(e){message(e.message,true);}};
  $('local-login').onclick=async()=>{try{await request('login');message('Finish signing in in your browser. This screen will update when you’re ready.');}catch(e){message(e.message,true);}};
  return {async open({autoConnect=true}={}){
    if(dialog.open)return true;
    controller?.abort();clearInterval(poll);controller=new AbortController();current=null;busy=false;message('');render();dialog.showModal();
    try{
      current=await refresh();if(!dialog.open)return true;
      if(!current.available){dialog.close();return false;}
      if(current.state==='connected' && autoConnect){dialog.close();return true;}
      poll=setInterval(()=>{if(!busy && dialog.open)refresh().catch(()=>{});},3000);
      if(autoConnect && current.installed && current.signedIn){if(current.saved)void connect(true);else if(current.suggested)void connect(false,true);else if(current.picker)void connect();}
      return true;
    }catch(error){if(error.name!=='AbortError')message(error.message,true);return true;}
  }};
}
