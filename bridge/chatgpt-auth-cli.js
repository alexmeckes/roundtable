#!/usr/bin/env node
import {ChatGPTAuth} from './chatgpt-auth.js';

const [command='status',accountId,...extra]=process.argv.slice(2);
const auth=new ChatGPTAuth();
const controller=new AbortController();
process.once('SIGINT',()=>controller.abort(new Error('Sign-in cancelled.')));
process.once('SIGTERM',()=>controller.abort(new Error('Sign-in cancelled.')));
try {
  if(extra.length || !['status','accounts','login','select','logout'].includes(command))throw new Error('Usage: node bridge/chatgpt-auth-cli.js login|status|accounts|select <account-id>|logout [account-id]');
  if(command==='login') {
    console.log('Continue with ChatGPT in your system browser. Eligible requests use your ChatGPT plan.');
    const account=await auth.login({accountId:accountId || null,signal:controller.signal});
    console.log('Signed in: '+(account.email || account.name || account.id)+'. Credentials stay on this machine.');
    console.log('Manage usage: https://chatgpt.com/settings/usage');
  }else if(command==='select'){
    if(!accountId)throw new Error('Provide an account ID from the accounts command.');
    await auth.select(accountId);console.log('Selected ChatGPT account. Reconnect the bridge to use it.');
  }else if(command==='logout'){
    const result=await auth.logout({accountId:accountId || null});
    console.log(result.revoked?'Signed out and revoked the renewable session.':'Signed out locally. Remote revocation was not confirmed; disconnect Roundtable in ChatGPT Settings.');
    console.log('Stop any running Roundtable bridges for this account.');
  }else{
    const status=await auth.status();
    if(!status.accounts.length)console.log('No ChatGPT account connected. Run: node bridge/chatgpt-auth-cli.js login');
    for(const account of status.accounts)console.log((status.activeAccountId===account.id?'* ':'  ')+account.id+' · '+(account.email || account.name || 'ChatGPT account')+' · '+(account.signedIn?'signed in':'signed out'));
  }
}catch(error){console.error(error.message);process.exitCode=1;}
