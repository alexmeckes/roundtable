import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FolderProject,collectDeliverables} from '../bridge/folder.js';

test('ordinary folders support parallel document work without modifying source inputs',async t=>{
  const root=await mkdtemp(join(tmpdir(),'roundtable-folder-')),source=join(root,'inputs');await mkdir(source);await writeFile(join(source,'brief.md'),'Source brief');
  t.after(()=>rm(root,{recursive:true,force:true}));
  const calls=[];const project=new FolderProject(source,{execute:async({cwd,job})=>{calls.push(cwd);assert.equal(job.sourceDirectory,await realpath(source));await writeFile(join(cwd,job.instructions+'.md'),'Result for '+job.agentName);return 'Done';}});
  await project.initialize();
  const [a,b]=await Promise.all([project.run({id:'document-one',instructions:'proposal',agentName:'Mira'}),project.run({id:'document-two',instructions:'analysis',agentName:'Sol'})]);
  assert.equal(a.status,'ready');assert.equal(b.status,'ready');assert.notEqual(calls[0],calls[1]);assert.notEqual(calls[0],source);
  assert.equal(a.deliverables[0].path,'proposal.md');assert.equal(Buffer.from(a.deliverables[0].data,'base64').toString(),'Result for Mira');
  assert.equal(await readFile(join(source,'brief.md'),'utf8'),'Source brief');
  assert.equal((await project.integrate()).status,'failed');
});

test('deliverables exclude private files and reject symlinks and oversized outputs',async t=>{
  const root=await mkdtemp(join(tmpdir(),'roundtable-outputs-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'.env'),'secret');await writeFile(join(root,'report.md'),'public report');
  assert.deepEqual((await collectDeliverables(root)).map(f=>f.path),['report.md']);
  await symlink(join(root,'report.md'),join(root,'alias.md'));await assert.rejects(collectDeliverables(root),/symlinks/);await rm(join(root,'alias.md'));
  await writeFile(join(root,'big.bin'),Buffer.alloc(5*1024*1024));await assert.rejects(collectDeliverables(root),/exceed/);
});
