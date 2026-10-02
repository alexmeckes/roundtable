import WebSocket from 'ws';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';

const url=process.env.ROUNDTABLE_URL || 'http://localhost:3132',room=process.env.ROUNDTABLE_DEMO_ROOM || 'plugin-trial-'+randomBytes(4).toString('hex');
if(!/^[A-Za-z0-9_-]{1,80}$/.test(room))throw new Error('Use a valid fictional demo room ID.');
if(!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw new Error('This fictional demo only runs against a local Roundtable service.');
async function participant(name){
  const ws=new WebSocket(url.replace(/^http/,'ws')),waiting=new Map();
  ws.on('message',bytes=>{const m=JSON.parse(bytes);const wait=waiting.get(m.t);if(wait){waiting.delete(m.t);wait(m);}});
  const wait=type=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Demo connection timed out.')),5000);waiting.set(type,value=>{clearTimeout(timer);resolve(value);});});
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const welcomePromise=wait('welcome');ws.send(JSON.stringify({t:'join',room,name}));const welcome=await welcomePromise;
  const pairPromise=wait('workspace_native_pair');ws.send(JSON.stringify({t:'workspace_native_pair'}));const pair=await pairPromise;
  return {ws,wait,welcome,token:pair.token};
}
const alex=await participant('Alex'),peer=await participant('Reviewer (fixture)');
try{
  alex.ws.send(JSON.stringify({t:'edit_title',text:'Plugin extension trial'}));
  alex.ws.send(JSON.stringify({t:'set_auto',on:false}));
  const saved=alex.wait('context_saved');
  alex.ws.send(JSON.stringify({t:'context_save',kind:'brief',title:'Fictional plan comparison',body:'Choose the lowest monthly cost for six people with exports. Atlas: monthly cost 30, seats 6, exports yes. Beacon: cost 20, seats 6, exports no. Cedar: cost 45, seats 10, exports yes. The numbers have no stated currency. Use only these fictional inputs.'}));await saved;
  const call=async(token,action,body)=>{const response=await fetch(url+'/api/rooms/'+room+'/native/'+action,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw new Error('Could not prepare the fictional room.');return response.json();};
  const state=await call(alex.token,'snapshot',{});
  const task=await call(alex.token,'task_save',{title:'Compare the fictional plans',details:'Use the accepted fictional plan comparison brief. Choose the cheapest eligible plan for six people who require exports. Submit a concise decision-brief.md and comparison.csv. Do not use external services or publish other local files.',contextIds:state.context.map(e=>e.id)});
  const dir=join('data','native-plugin');await mkdir(dir,{recursive:true,mode:0o700});
  await writeFile(join(dir,'peer.json'),JSON.stringify({url,room,token:peer.token})+'\n',{mode:0o600});
  await writeFile(join(dir,'trial.json'),JSON.stringify({room,taskId:task.task.id,ownerId:state.member.id,peerId:peer.welcome.you.id})+'\n',{mode:0o600});
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['scripts/connect-native.mjs',url+'/s/'+room],{stdio:'inherit',env:{...process.env,ROUNDTABLE_NATIVE_TOKEN:alex.token}});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Could not save the local plugin connection.')));
  });
  console.log('Prepared a fictional room, one owner task, and a separate reviewer fixture. This is a single-machine trial.');
}finally{alex.ws.close();peer.ws.close();}
