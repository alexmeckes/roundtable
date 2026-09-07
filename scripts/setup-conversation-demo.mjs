import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {git} from '../bridge/worktree.js';
const root=await mkdtemp(join(tmpdir(),'roundtable-conversation-'));
const original=join(root,'baseline');await mkdir(original);
const files={
 'package.json':JSON.stringify({type:'module',scripts:{test:'node --test test.mjs',build:'node build.mjs'}}),
 '.gitignore':'dist/\n',
 'AGENTS.md':'This is a disposable browser-game test fixture. Keep changes scoped to the requested feature. Do not use external services, install packages, or modify build.mjs, test.mjs, or AGENTS.md. Run npm test and npm run build.\n',
 'movement.js':`export const SPEED = 10;\nexport function step(position, action) { return position + SPEED; }\n`,
 'coins.js':`export function coinScore(position, alreadyCollected) { return 0; }\n`,
 'index.html':`<!doctype html><html><head><meta charset="utf-8"><title>Roundtable Test Game</title><style>body{font:18px system-ui;background:#142131;color:#eef6ff;padding:36px}button{font:inherit;padding:12px;margin:8px}#track{width:600px;height:100px;background:#253b55;position:relative;margin:24px 0}#player{width:24px;height:24px;background:#63e0b5;position:absolute;top:38px;left:0}#coin{position:absolute;left:100px;top:30px;color:#ffd469}output{display:block;margin:12px}</style></head><body><h1>Roundtable Test Game</h1><p>Move or dash to reach the coin at position 100.</p><div id="track"><div id="player"></div><span id="coin">●</span></div><button id="move">Move right</button><button id="dash">Dash right</button><button id="reset">Reset game</button><output id="position">Position: 0</output><output id="score">Coins: 0</output><script type="module" src="game.js"></script></body></html>`,
 'game.js':`import {step} from './movement.js';\nimport {coinScore} from './coins.js';\nlet position=0,score=0,collected=false;\nfunction draw(){document.getElementById('player').style.left=Math.min(position,575)+'px';document.getElementById('position').textContent='Position: '+position;document.getElementById('score').textContent='Coins: '+score;document.getElementById('coin').hidden=collected;}\nfunction act(action){position=step(position,action);const award=coinScore(position,collected);score+=award;if(award>0)collected=true;draw();}\ndocument.getElementById('move').onclick=()=>act('move');document.getElementById('dash').onclick=()=>act('dash');document.getElementById('reset').onclick=()=>{position=0;score=0;collected=false;draw();};\n`,
 'test.mjs':`import test from 'node:test';import assert from 'node:assert/strict';import {step,SPEED} from './movement.js';import {coinScore} from './coins.js';test('movement advances by its configured speed',()=>assert.equal(step(0,'move'),SPEED));test('score is numeric and collected coins cannot repeat',()=>{assert.equal(typeof coinScore(100,false),'number');assert.equal(coinScore(100,true),0);});\n`,
 'build.mjs':`import {mkdir,copyFile} from 'node:fs/promises';await mkdir('dist',{recursive:true});for(const f of ['index.html','game.js','movement.js','coins.js'])await copyFile(f,'dist/'+f);\n`
};
for(const [name,data] of Object.entries(files))await writeFile(join(original,name),data);
await git(original,'init');await git(original,'add','.');await git(original,'-c','user.name=Test','-c','user.email=test@localhost','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','commit','-m','Disposable game baseline');
for(const who of ['alice','bob'])await git(root,'clone',original,join(root,who));

await writeFile(join(root,'alice-approach.txt'),'Focus on deterministic movement and controls. Ask the other agent about edge cases. Keep chat concise; do not execute commands or edit files during discussion.');
await writeFile(join(root,'bob-approach.txt'),'Focus on collectibles, gameplay rules and testable edge cases. Build on the other agent’s ideas. Keep chat concise; do not execute commands or edit files during discussion.');
console.log(root);
