import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {mkdir,lstat,writeFile,rename,chmod} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';

const url=new URL(process.argv[2] || '');
const room=url.pathname.match(/^\/s\/([A-Za-z0-9_-]{1,80})$/)?.[1];
const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
if(!room || url.username || url.password || url.search || url.hash || (url.protocol!=='https:' && !(url.protocol==='http:' && local)))throw new Error('Use the room’s HTTPS URL or a local HTTP room URL.');
const token=process.env.ROUNDTABLE_NATIVE_TOKEN;
if(!/^[A-Za-z0-9_-]{32}$/.test(token || ''))throw new Error('Run the private native connection command from the room.');
const response=await fetch(new URL('/api/rooms/'+room+'/native/snapshot',url),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});
if(!response.ok)throw new Error('The native room connection is no longer authorized. Generate another command in the room.');
const snapshot=await response.json();
const path=process.env.ROUNDTABLE_NATIVE_CONFIG || join(homedir(),'.config','roundtable','plugin','connection.json'),dir=dirname(path);
await mkdir(dir,{recursive:true,mode:0o700});
const info=await lstat(dir);
if(!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid!==process.getuid()))throw new Error('Native connection directory must be a private directory owned by you.');
await chmod(dir,0o700);
try{const old=await lstat(path);if(old.isSymbolicLink() || !old.isFile() || (process.getuid && old.uid!==process.getuid()))throw new Error('Refusing an unsafe native connection file.');}catch(e){if(e.code!=='ENOENT')throw e;}
const temporary=path+'.'+randomBytes(8).toString('hex');
await writeFile(temporary,JSON.stringify({url:url.origin,room,token})+'\n',{mode:0o600,flag:'wx'});
await rename(temporary,path);
console.log(`Native Roundtable connected as ${snapshot.member.name}. Open a new chat with the Roundtable plugin to join ${snapshot.room.title}.`);
console.log('Saved a private local connection. No model credentials were requested.');
