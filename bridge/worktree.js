import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, lstat, realpath, writeFile } from 'node:fs/promises';
import { resolve, join, relative, basename } from 'node:path';
import { safeAsset } from '../workspace/assets.js';
const exec = promisify(execFile);
const childEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>!['ROUNDTABLE_PAIR_TOKEN','ROUNDTABLE_BRIDGE_SECRET'].includes(key)));
const options = cwd => ({cwd,timeout:120_000,maxBuffer:4*1024*1024,env:childEnv()});
export async function git(cwd,...args) { return (await exec('git',args,options(cwd))).stdout.trimEnd(); }

export class WorktreeProject {
  constructor(project,{check='',preview='',root,execute}={}) {
    this.project=resolve(project); this.check=check; this.preview=preview;
    this.root=root; this.execute=execute; this.integrating=false;
  }
  async initialize() {
    this.project=await realpath(await git(this.project,'rev-parse','--show-toplevel'));
    this.root ||= resolve(this.project,'..','.'+basename(this.project)+'-roundtable');
    await mkdir(this.root,{recursive:true});
    // Require a committed baseline. Each friend starts from the same repository history.
    await git(this.project,'rev-parse','HEAD');
    return basename(this.project);
  }
  async worktree(id) {
    if(!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error('Invalid workspace ID');
    const baseCommit=await git(this.project,'rev-parse','HEAD');
    const branch='codex/roundtable-'+id;
    const cwd=join(this.root,id);
    await git(this.project,'worktree','add','-b',branch,cwd,baseCommit);
    return {cwd,baseCommit,branch};
  }
  async checks(cwd,signal) {
    if(!this.check) return 'Not configured — review and test this contribution before use.';
    return new Promise((resolve,reject)=>{
      signal?.throwIfAborted();
      const child=spawn(process.env.SHELL || '/bin/sh',['-c',this.check],{cwd,env:childEnv(),detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
      let output='',stopped=false;
      const stop=()=>{stopped=true;try{process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL');}catch{}};
      const timer=setTimeout(stop,5*60_000);
      const collect=chunk=>{output=(output+chunk).slice(-3500);};
      child.stdout.on('data',collect);child.stderr.on('data',collect);
      signal?.addEventListener('abort',stop,{once:true});
      if(signal?.aborted)stop();
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);};
      child.on('error',error=>{cleanup();reject(error);});
      child.on('close',code=>{cleanup();code===0 && !stopped?resolve('Passed: '+this.check+'\n'+output):reject(new Error(stopped?'Checks stopped or timed out.':'Checks failed: '+output));});
    });
  }

  async snapshot(tree) {
    await git(tree.cwd,'add','-A');
    const patch=await git(tree.cwd,'diff','--cached','--binary','--full-index',tree.baseCommit,'--');
    if(Buffer.byteLength(patch)>1024*1024) throw new Error('Patch exceeds 1 MB; split this task into smaller contributions.');
    const files=(await git(tree.cwd,'diff','--cached','--name-status',tree.baseCommit,'--')).split('\n').filter(Boolean);
    if(await git(tree.cwd,'diff','--cached','--name-only')) {
      await git(tree.cwd,'-c','user.name=Roundtable','-c','user.email=roundtable@localhost','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','commit','-m','Roundtable contribution');
    }
    return {patch:patch?patch+'\n':'',files,baseCommit:tree.baseCommit,headCommit:await git(tree.cwd,'rev-parse','HEAD'),branch:tree.branch};
  }
  async previewFiles(cwd) {
    if(!this.preview) return [];
    const dir=resolve(cwd,this.preview), rel=relative(cwd,dir);
    if(!rel || rel.startsWith('..') || rel.startsWith('/')) throw new Error('Preview must be a subdirectory of the workspace, such as dist.');
    // Resolve every directory to prevent a symlink in a parent component escaping.
    const actual=await realpath(dir);
    if(relative(cwd,actual).startsWith('..')) throw new Error('Preview escapes the workspace.');
    const result=[]; let bytes=0;
    const walk=async(base,prefix='')=>{
      for(const entry of await readdir(base,{withFileTypes:true})) {
        const path=prefix+entry.name, file=join(base,entry.name);
        if(entry.isSymbolicLink()) throw new Error('Preview cannot contain symlinks.');
        if(entry.isDirectory()) { await walk(file,path+'/'); continue; }
        if(!safeAsset(path)) continue;
        const stat=await lstat(file);
        bytes+=stat.size;
        if(bytes>5*1024*1024 || result.length>=100) throw new Error('Preview exceeds 5 MB or 100 files.');
        result.push({path,data:(await readFile(file)).toString('base64')});
      }
    };
    await walk(dir);
    if(!result.some(f=>f.path==='index.html')) throw new Error('Preview directory must contain index.html.');
    return result;
  }
  async run(job,{signal,progress=()=>{}}={}) {
    let tree;
    try {
      tree=await this.worktree(job.id);
      progress('Working on '+tree.branch);
      const summary=await this.execute({cwd:tree.cwd,job,signal,progress});
      signal?.throwIfAborted();
      progress('Running your checks…');
      const checks=await this.checks(tree.cwd,signal);
      signal?.throwIfAborted();
      const result=await this.snapshot(tree);
      let preview=[], message='Contribution ready for review.';
      try { preview=await this.previewFiles(tree.cwd); } catch(error) { message+=' Preview unavailable: '+error.message; }
      return {...result,status:'ready',summary,checks,preview,message};
    } catch(error) {
      return {status:signal?.aborted?'interrupted':'failed',branch:tree?.branch || '',baseCommit:tree?.baseCommit || '',message:String(error.message).slice(-500),checks:String(error.message).startsWith('Checks failed')?String(error.message).slice(-4000):'',summary:'Local work is retained in its worktree.'};
    }
  }
  async integrate(job,patch,{signal,progress=()=>{}}={}) {
    if(this.integrating) return {status:'failed',message:'Another integration is in progress on your project.'};
    this.integrating=true; let tree;
    try {
      if(await git(this.project,'status','--porcelain')) throw new Error('Your checkout has uncommitted changes. Commit or stash them before integrating.');
      const targetBranch=await git(this.project,'symbolic-ref','--short','HEAD');
      if(!/^[a-f0-9]{40,64}$/.test(job.baseCommit)) throw new Error('Contribution has no valid base commit.');
      await git(this.project,'merge-base','--is-ancestor',job.baseCommit,'HEAD');
      tree=await this.worktree(job.id);
      progress('Checking contribution against your current project…');
      const patchFile=join(this.root,job.id+'.diff'); await writeFile(patchFile,patch);
      try { await git(tree.cwd,'apply','--index','--3way',patchFile); }
      catch(error) { return {status:'conflict',branch:tree.branch,baseCommit:tree.baseCommit,message:'Changes conflict with your project. Your checkout is untouched; resolve the retained integration branch locally.',summary:String(error.stderr || error.message).slice(-3500)}; }
      const checks=await this.checks(tree.cwd,signal);
      // Checks must not silently add unrelated changes to the accepted patch.
      if(await git(tree.cwd,'diff','--name-only') || await git(tree.cwd,'ls-files','--others','--exclude-standard')) throw new Error('Checks changed tracked files or created untracked files. Inspect the integration worktree.');
      signal?.throwIfAborted();
      const result=await this.snapshot(tree);
      if(await git(this.project,'status','--porcelain') || await git(this.project,'rev-parse','HEAD')!==tree.baseCommit || await git(this.project,'symbolic-ref','--short','HEAD')!==targetBranch) throw new Error('Your checkout changed during integration. Prepared branch retained; checkout not updated.');
      progress('Fast-forwarding your checkout…');
      signal?.throwIfAborted();
      await git(this.project,'-c','core.hooksPath=/dev/null','merge','--ff-only',result.headCommit);
      let preview=[],message='Integrated into your local '+targetBranch+'. Push through your usual Git workflow to share repository history.';
      try { preview=await this.previewFiles(tree.cwd); } catch(error) { message+=' Preview unavailable: '+error.message; }
      return {...result,status:'integrated',checks,preview,message,summary:'Integrated '+job.sourceId+' into '+targetBranch};
    } catch(error) {
      return {status:signal?.aborted?'interrupted':'failed',branch:tree?.branch || '',message:String(error.stderr || error.message).slice(-500),summary:'Your local work is retained. Fetch the shared repository history if the contribution base is missing.'};
    } finally { this.integrating=false; }
  }
}
