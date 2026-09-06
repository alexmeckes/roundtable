import {realpath} from 'node:fs/promises';
import {basename,resolve} from 'node:path';
import {createHash} from 'node:crypto';

// Project identity controls the Codex sidebar. A task's cwd still controls
// execution and must remain its own worktree or output directory.
export async function resolveThreadProject(rpc,{cwd,projectId}) {
  if(projectId)return (await rpc('project/read',{projectId})).project;
  const path=await realpath(cwd);
  let cursor;
  do {
    const page=await rpc('project/list',{limit:100,...(cursor?{cursor}:{})});
    for(const project of page.data){
      for(const root of project.roots){
        const canonical=await realpath(root.path).catch(()=>resolve(root.path));
        if(canonical===path)return project;
      }
    }
    cursor=page.nextCursor;
  }while(cursor);
  const idempotencyKey='roundtable-'+createHash('sha256').update(path).digest('hex');
  return (await rpc('project/create',{name:basename(path) || 'Roundtable',roots:[{path}],idempotencyKey})).project;
}

export function threadName(job,conversation){
  const table=job.context?.title && job.context.title!=='Untitled table'?job.context.title:job.room || 'table';
  const task=conversation?'conversation':job.instructions || 'work';
  return `Roundtable · ${table} · ${job.agentName || 'Codex'} · ${task}`.replace(/\s+/g,' ').slice(0,180);
}
