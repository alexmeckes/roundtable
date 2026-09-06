import {mkdir,realpath,lstat,readdir,readFile} from 'node:fs/promises';
import {resolve,join,basename} from 'node:path';
import {WorktreeProject} from './worktree.js';
import {safeDeliverable} from '../workspace/assets.js';

// Ordinary folders are input sources. Each task writes into a fresh sibling
// directory; outputs never automatically overwrite the owner's source files.
export class FolderProject extends WorktreeProject {
  async initialize(){
    this.project=await realpath(this.project);
    if(!(await lstat(this.project)).isDirectory())throw new Error('Project must be a folder.');
    this.root ||= resolve(this.project,'..','.'+basename(this.project)+'-roundtable');
    await mkdir(this.root,{recursive:true});return basename(this.project);
  }
  async run(job,{signal,progress=()=>{}}={}){
    let cwd;
    try{
      if(!/^[A-Za-z0-9_-]{8,80}$/.test(job.id))throw new Error('Invalid workspace ID');
      cwd=join(this.root,job.id);await mkdir(cwd);signal?.throwIfAborted();
      progress('Working in a separate output folder…');
      const summary=await this.execute({cwd,job:{...job,sourceDirectory:this.project,workspaceMode:'folder'},signal,progress});
      signal?.throwIfAborted();const checks=await this.checks(cwd,signal);signal?.throwIfAborted();
      const deliverables=await collectDeliverables(cwd);
      let preview=[],message='Results ready for review and download. Source folder unchanged by the bridge.';
      try{preview=await this.previewFiles(cwd);}catch(error){message+=' Preview unavailable: '+error.message;}
      return {status:'ready',summary,checks,deliverables,files:deliverables.map(f=>f.path),preview,message};
    }catch(error){return {status:signal?.aborted?'interrupted':'failed',message:String(error.message).slice(-500),summary:'Local output is retained in its task folder.'};}
  }
  async integrate(){return {status:'failed',message:'This connection uses a folder. Download the deliverable; Git integration requires a repository connection.'};}
}
export async function collectDeliverables(cwd){
  const result=[];let bytes=0;
  async function walk(dir,prefix=''){
    for(const entry of await readdir(dir,{withFileTypes:true})){
      if(entry.name.startsWith('.') || ['node_modules','__pycache__'].includes(entry.name))continue;
      const path=prefix+entry.name,file=join(dir,entry.name),stat=await lstat(file);
      if(stat.isSymbolicLink())throw new Error('Deliverables cannot contain symlinks.');
      if(stat.isDirectory()){await walk(file,path+'/');continue;}
      if(!stat.isFile() || !safeDeliverable(path))continue;
      bytes+=stat.size;if(bytes>5*1024*1024 || result.length>=100)throw new Error('Deliverables exceed 5 MB or 100 files. Local outputs are retained.');
      result.push({path,data:(await readFile(file)).toString('base64')});
    }
  }
  await walk(cwd);return result;
}
