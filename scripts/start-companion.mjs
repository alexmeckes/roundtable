#!/usr/bin/env node
import {createCompanion,DEFAULT_BACKEND_ORIGINS,DEFAULT_ROOM_ORIGINS,DEFAULT_COMPANION_PORT} from '../bridge/companion.js';
import {spawnSync} from 'node:child_process';

const args=process.argv.slice(2);let port=Number(process.env.ROUNDTABLE_COMPANION_PORT || DEFAULT_COMPANION_PORT);
if(args.length===1 && ['--help','-h'].includes(args[0])){
  console.log('Usage: roundtable-connect [--port 4146] [--check]\n\nStart your local Roundtable connector, then open Connect my AI in your room.\n--check verifies Node.js and the installed Codex CLI without signing in or starting an agent.');process.exit(0);
}
const check=args.length===1 && args[0]==='--check';
if(!check && args.length){if(args.length!==2 || args[0]!=='--port' || !/^\d+$/.test(args[1]))throw new Error('Usage: roundtable-connect [--port 4146] [--check]');port=Number(args[1]);}
if(Number(process.versions.node.split('.')[0])<20)throw new Error('Roundtable requires Node.js 20 or newer.');
if(check){
  const result=spawnSync('codex',['--version'],{encoding:'utf8',timeout:10000});
  if(result.error || result.status!==0){console.error('Codex CLI is unavailable. Install Codex, then run roundtable-connect --check again.');process.exit(1);}
  console.log('Node.js '+process.versions.node+'; '+result.stdout.trim()+'. Ready to start the connector.');process.exit(0);
}
const configured=name=>process.env[name]?.split(',').map(value=>value.trim()).filter(Boolean);
const companion=createCompanion({port,backendOrigins:configured('ROUNDTABLE_COMPANION_ALLOWED_BACKENDS') || DEFAULT_BACKEND_ORIGINS,roomOrigins:configured('ROUNDTABLE_COMPANION_ALLOWED_ROOMS') || DEFAULT_ROOM_ORIGINS});
const url=await companion.listen();
console.log('Roundtable local companion: '+url);
console.log('Open Connect my AI in your Roundtable room. Connecting requires your confirmation in the browser.');
let closing=false;
async function close(){if(closing)return;closing=true;await companion.close();}
process.on('SIGINT',close);process.on('SIGTERM',close);
