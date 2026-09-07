import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {access,realpath,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {join,basename} from 'node:path';
import {CodexAppServer} from '../bridge/app-server.js';
const exec=promisify(execFile);
export const profileRoot=()=>process.env.CODEX_HOME || join(homedir(),'.codex');
const cleanEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>!['ROUNDTABLE_PAIR_TOKEN','ROUNDTABLE_BRIDGE_SECRET'].includes(key)));
export async function detectCodex(){
  const candidates=process.env.ROUNDTABLE_CODEX_BIN?[process.env.ROUNDTABLE_CODEX_BIN]:['codex',join(homedir(),'.local','bin','codex'),'/opt/homebrew/bin/codex','/usr/local/bin/codex'];
  for(const command of candidates){
    try{
      const {stdout}=await exec(command,['--version'],{timeout:10000,env:cleanEnv()});
      const version=stdout.trim().match(/codex(?:-cli)?\s+([\w.+-]+)/)?.[1];if(!version)continue;
      let signedIn=false;try{await exec(command,['login','status'],{timeout:10000,env:cleanEnv()});signedIn=true;}catch{}
      return {installed:true,signedIn,version,command};
    }catch{}
  }
  return {installed:false,signedIn:false};
}
export async function pickerAvailable(platform=process.platform){
  if(platform==='darwin' || platform==='win32')return true;
  try{await exec('which',['zenity'],{timeout:2000});return !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;}catch{return false;}
}
export async function chooseFolder({signal}={}){
  const options={timeout:120000,maxBuffer:16384,signal,env:cleanEnv()};
  try{
    let result;
    if(process.platform==='darwin')result=await exec('/usr/bin/osascript',['-l','JavaScript','-e',`ObjC.import('AppKit');function run(){const app=$.NSApplication.sharedApplication;app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);app.activateIgnoringOtherApps(true);const panel=$.NSOpenPanel.openPanel;panel.canChooseDirectories=true;panel.canChooseFiles=false;panel.allowsMultipleSelection=false;panel.prompt='Connect';panel.message='Choose a folder for your Roundtable agents';return Number(panel.runModal)===1?ObjC.unwrap(panel.URL.path):'';}`],options);
    else if(process.platform==='win32')result=await exec('powershell.exe',['-NoProfile','-STA','-Command',"Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = 'Choose a folder for your Roundtable agents'; if ($picker.ShowDialog() -eq 'OK') { $picker.SelectedPath }; $picker.Dispose()"],options);
    else result=await exec('zenity',['--file-selection','--directory','--title=Choose a folder for your Roundtable agents'],options);
    return result.stdout.trim() || null;
  }catch(error){if(signal?.aborted || (process.platform==='linux' && error.code===1))return null;throw new Error('The folder picker could not open. Enter the folder path under Advanced instead.');}
}
export async function describeFolder(path,mode='auto'){
  if(typeof path!=='string' || !path || path.length>4096 || path.includes('\0'))throw new Error('Choose a local folder.');
  const canonical=await realpath(path);if(!(await stat(canonical)).isDirectory())throw new Error('Choose a folder, not a file.');
  await access(canonical,constants.R_OK);
  if(!['auto','folder','git'].includes(mode))throw new Error('Choose a folder type.');
  let gitRoot;
  try{const {stdout}=await exec('git',['-C',canonical,'rev-parse','--show-toplevel'],{timeout:5000,env:cleanEnv()});gitRoot=await realpath(stdout.trim());await exec('git',['-C',canonical,'rev-parse','--verify','HEAD'],{timeout:5000,env:cleanEnv()});}catch{gitRoot=null;}
  if(mode==='git' && !gitRoot)throw new Error('This Git repository needs a first commit. Choose folder mode or commit its initial files.');
  const workspaceMode=mode==='auto'?(gitRoot===canonical?'git':'folder'):mode;
  const project=workspaceMode==='git'?gitRoot:canonical;
  return {path:project,name:basename(project),mode:workspaceMode};
}
export function beginLogin(command){return spawn(command,['login'],{env:cleanEnv(),stdio:'ignore'});}

// Reuse the launching Codex thread's cwd, never the CLI installation directory.
// Standalone launchers can provide the same context explicitly.
export async function discoverProject(command,{path=process.env.ROUNDTABLE_PROJECT,threadId=process.env.CODEX_THREAD_ID,signal,client=()=>new CodexAppServer({command})}={}){
  if(path)return describeFolder(path).catch(()=>null);
  if(!threadId)return null;
  if(signal?.aborted)return null;
  const codex=client(),abort=()=>codex.close();signal?.addEventListener('abort',abort,{once:true});
  try{await codex.initialize();const {thread}=await codex.rpc('thread/read',{threadId,includeTurns:false});return await describeFolder(thread?.cwd);}
  catch{return null;}finally{signal?.removeEventListener('abort',abort);codex.close();}
}
