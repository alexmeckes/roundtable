import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {chatGPTPlanArgs} from '../bridge/chatgpt-runtime.js';

// Exercise the installed runtime with an intentionally invalid credential.
// No sign-in, inference, or thread creation occurs. This script never reads
// the user's credentials or displays process environment values.
const command=process.argv[2] || 'codex';
const child=spawn(command,[...chatGPTPlanArgs,
  '-c','shell_environment_policy.inherit="all"',
  '-c','shell_environment_policy.ignore_default_excludes=true',
],{
  cwd:process.cwd(),
  env:Object.fromEntries(Object.entries({...process.env,ACCESS_TOKEN:'roundtable-preflight-invalid-token',ROUNDTABLE_RUNTIME_PREFLIGHT_CONTROL:'present'}).filter(([key])=>!['ROUNDTABLE_PAIR_TOKEN','ROUNDTABLE_BRIDGE_SECRET'].includes(key))),
  stdio:['pipe','pipe','ignore'],
});
let nextId=1,stage='initialize';
const pending=new Map();
const fail=()=>{
  for(const request of pending.values())request.reject(new Error('Runtime check failed at '+stage+'. Check the Codex executable and local configuration.'));
  pending.clear();
};
child.once('error',fail);child.stdin.on('error',fail);
child.once('exit',fail);
const exited=new Promise(resolve=>child.once('close',resolve));
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{
  let message;try{message=JSON.parse(line);}catch{return;}
  const request=pending.get(message.id);if(!request)return;
  pending.delete(message.id);
  if(message.error)request.reject(new Error('Runtime check failed at '+stage+'. Check the Codex executable and local configuration.'));
  else request.resolve(message.result);
});
function rpc(method,params){
  return new Promise((resolve,reject)=>{
    const id=nextId++;pending.set(id,{resolve,reject});
    child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
}
const deadline=setTimeout(()=>{fail();child.kill();},25_000);
try{
  await rpc('initialize',{clientInfo:{name:'roundtable-workspace',title:'Roundtable',version:'0.2.0'},capabilities:{experimentalApi:true}});
  child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
  stage='project/list';const projects=await rpc('project/list',{limit:1});
  if(!Array.isArray(projects?.data))throw new Error('The installed Codex does not support project/list.');
  stage='command/exec';
  const result=await rpc('command/exec',{
    command:[process.execPath,'-e','process.stdout.write(JSON.stringify({tokenExcluded:!Object.hasOwn(process.env,"ACCESS_TOKEN"),controlPreserved:process.env.ROUNDTABLE_RUNTIME_PREFLIGHT_CONTROL==="present"}))'],
    cwd:process.cwd(),sandboxPolicy:{type:'readOnly'},timeoutMs:10_000,outputBytesCap:1024,
  });
  let environment;try{environment=JSON.parse(result.stdout);}catch{throw new Error('Runtime environment check did not return a valid result.');}
  const checks={initialized:true,projectListingAvailable:true,commandSucceeded:result.exitCode===0,tokenExcluded:environment.tokenExcluded===true,controlPreserved:environment.controlPreserved===true};
  console.log(JSON.stringify(checks));
  if(Object.values(checks).some(value=>!value))process.exitCode=1;
}catch(error){
  console.error(error.message);process.exitCode=1;
}finally{
  clearTimeout(deadline);child.kill();
  const force=setTimeout(()=>child.kill('SIGKILL'),2000);
  await exited;clearTimeout(force);lines.close();
}
