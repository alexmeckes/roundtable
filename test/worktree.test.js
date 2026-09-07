import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorktreeProject,git} from '../bridge/worktree.js';

async function repositories(t){
  const dir=await mkdtemp(join(tmpdir(),'roundtable-project-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const original=join(dir,'original');await mkdir(original);
  await git(original,'init');await git(original,'config','user.name','Test');await git(original,'config','user.email','test@localhost');
  await writeFile(join(original,'player.js'),'speed = 1;\n');await writeFile(join(original,'enemy.js'),'health = 1;\n');
  await writeFile(join(original,'.gitignore'),'dist/\n');
  await git(original,'add','.');await git(original,'commit','-m','Initial game');
  const alice=join(dir,'alice'),bob=join(dir,'bob');
  await git(dir,'clone',original,alice);await git(dir,'clone',original,bob);
  return {dir,alice,bob};
}
const job=(id,instructions='Implement game feature')=>({id,instructions,context:{}});

test('two independent Codex workspaces contribute different features into one game',async t=>{
  const {alice,bob}=await repositories(t);
  let started=0,release;const bothStarted=new Promise(r=>release=r);
  const execute=(file,content)=>async({cwd})=>{if(++started===2)release();await bothStarted;await writeFile(join(cwd,file),content);return 'Implemented '+file;};
  const a=new WorktreeProject(alice,{execute:execute('player.js','speed = 3;\n'),check:'node --check player.js'});
  const b=new WorktreeProject(bob,{execute:execute('enemy.js','health = 5;\n'),check:'node --check enemy.js'});
  await a.initialize();await b.initialize();
  const [ar,br]=await Promise.all([a.run(job('alicework123')),b.run(job('bobwork12345'))]);
  assert.equal(ar.status,'ready');assert.equal(br.status,'ready');
  assert.equal(await readFile(join(alice,'player.js'),'utf8'),'speed = 1;\n');
  assert.equal(await readFile(join(bob,'enemy.js'),'utf8'),'health = 1;\n');
  const first=await a.integrate({...job('integrate123'),baseCommit:ar.baseCommit,sourceId:'alicework123'},ar.patch);
  assert.equal(first.status,'integrated',first.message);
  const second=await a.integrate({...job('integrate456'),baseCommit:br.baseCommit,sourceId:'bobwork12345'},br.patch);
  assert.equal(second.status,'integrated',second.message);
  assert.equal(await readFile(join(alice,'player.js'),'utf8'),'speed = 3;\n');
  assert.equal(await readFile(join(alice,'enemy.js'),'utf8'),'health = 5;\n');
  assert.equal(await git(alice,'status','--porcelain'),'');
});

test('conflicting contributions retain an integration branch without modifying the receiving checkout',async t=>{
  const {alice,bob}=await repositories(t);
  const a=new WorktreeProject(alice,{execute:async({cwd})=>{await writeFile(join(cwd,'player.js'),'speed = 2;\n');return 'A';}});
  const b=new WorktreeProject(bob,{execute:async({cwd})=>{await writeFile(join(cwd,'player.js'),'speed = 9;\n');return 'B';}});
  await a.initialize();await b.initialize();
  const ar=await a.run(job('featureaaaa')),br=await b.run(job('featurebbbb'));
  assert.equal((await a.integrate({...job('acceptaaaaa'),baseCommit:ar.baseCommit},ar.patch)).status,'integrated');
  const before=await git(alice,'rev-parse','HEAD');
  const conflict=await a.integrate({...job('acceptbbbbb'),baseCommit:br.baseCommit},br.patch);
  assert.equal(conflict.status,'conflict');assert.ok(conflict.branch);
  assert.equal(await git(alice,'rev-parse','HEAD'),before);
  assert.equal(await readFile(join(alice,'player.js'),'utf8'),'speed = 2;\n');
});

test('failed checks and dirty target checkouts prevent integration',async t=>{
  const {alice,bob}=await repositories(t);
  const a=new WorktreeProject(alice,{execute:async({cwd})=>{await writeFile(join(cwd,'player.js'),'speed = 3;\n');return 'A';}});
  const b=new WorktreeProject(bob,{check:'exit 1'});await a.initialize();await b.initialize();
  const result=await a.run(job('featureabcd'));
  const before=await git(bob,'rev-parse','HEAD');
  assert.equal((await b.integrate({...job('failedcheck1'),baseCommit:result.baseCommit},result.patch)).status,'failed');
  assert.equal(await git(bob,'rev-parse','HEAD'),before);
  await writeFile(join(bob,'player.js'),'local change\n');
  const dirty=await b.integrate({...job('dirtycheck12'),baseCommit:result.baseCommit},result.patch);
  assert.equal(dirty.status,'failed');assert.match(dirty.message,/uncommitted/);
  assert.equal(await readFile(join(bob,'player.js'),'utf8'),'local change\n');
});

test('new files and self-contained preview assets travel with a contribution',async t=>{
  const {alice}=await repositories(t);
  const a=new WorktreeProject(alice,{preview:'dist',execute:async({cwd})=>{
    await writeFile(join(cwd,'level.json'),'{}\n');await mkdir(join(cwd,'dist'));await writeFile(join(cwd,'dist','index.html'),'<canvas>Game</canvas>');return 'New level';
  }});await a.initialize();const result=await a.run(job('newlevel123'));
  assert.equal(result.status,'ready');assert.ok(result.files.some(f=>f.includes('level.json')));
  assert.ok(!result.files.some(f=>f.includes('dist')));assert.equal(result.preview[0].path,'index.html');
  const integrated=await a.integrate({...job('newlevel456'),baseCommit:result.baseCommit},result.patch);
  assert.equal(integrated.status,'integrated');assert.equal(await readFile(join(alice,'level.json'),'utf8'),'{}\n');
});

test('preview collection refuses symlinks and task failure retains local work',async t=>{
  const {alice,dir}=await repositories(t);
  const a=new WorktreeProject(alice,{preview:'dist',execute:async({cwd})=>{
    await mkdir(join(cwd,'dist'));await symlink(join(dir,'outside.html'),join(cwd,'dist','index.html'));return 'A';
  }});await writeFile(join(dir,'outside.html'),'private');await a.initialize();
  const result=await a.run(job('symlinktest1'));
  assert.equal(result.status,'ready');assert.deepEqual(result.preview,[]);assert.match(result.message,/symlinks/);
  const failed=new WorktreeProject(alice,{execute:async({cwd})=>{await writeFile(join(cwd,'enemy.js'),'work in progress');throw new Error('Model failed');}});
  await failed.initialize();const error=await failed.run(job('failuretest1'));
  assert.equal(error.status,'failed');assert.match(error.branch,/failuretest1/);
  assert.equal(await readFile(join(failed.root,'failuretest1','enemy.js'),'utf8'),'work in progress');
});

test('owner cancellation just before integration leaves the target checkout unchanged',async t=>{
  const {alice}=await repositories(t);
  const project=new WorktreeProject(alice,{execute:async({cwd})=>{await writeFile(join(cwd,'player.js'),'speed = 8;\n');return 'Faster player';}});
  await project.initialize();const result=await project.run(job('cancelfeature'));
  const before=await git(alice,'rev-parse','HEAD'),controller=new AbortController();
  const integration=await project.integrate({...job('cancelaccept'),baseCommit:result.baseCommit},result.patch,{
    signal:controller.signal,progress:message=>{if(message.startsWith('Fast-forwarding'))controller.abort();},
  });
  assert.equal(integration.status,'interrupted');
  assert.equal(await git(alice,'rev-parse','HEAD'),before);
  assert.equal(await readFile(join(alice,'player.js'),'utf8'),'speed = 1;\n');
});

test('resume keeps the original Git branch, baseline, and interrupted changes',async t=>{
  const {alice}=await repositories(t);let record;
  const first=new WorktreeProject(alice,{execute:async({cwd})=>{await writeFile(join(cwd,'player.js'),'speed = 7;\n');throw new Error('Interrupted');}});await first.initialize();
  assert.equal((await first.run(job('resume-first'),{checkpoint:async tree=>{record=tree;}})).status,'failed');
  const resumed=new WorktreeProject(alice,{execute:async({cwd})=>{assert.equal(await readFile(join(cwd,'player.js'),'utf8'),'speed = 7;\n');await writeFile(join(cwd,'enemy.js'),'health = 9;\n');return 'Continued';}});await resumed.initialize();
  const result=await resumed.run({...job('resume-second'),localResume:record});assert.equal(result.status,'ready');assert.equal(result.branch,record.branch);assert.equal(result.baseCommit,record.baseCommit);assert.equal(result.files.length,2);
  assert.equal(await readFile(join(alice,'player.js'),'utf8'),'speed = 1;\n');
  const invalid=await resumed.run({...job('resume-invalid'),localResume:{...record,branch:'another-branch'}});assert.equal(invalid.status,'failed');
});
