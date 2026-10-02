import {EventEmitter} from 'node:events';
import {CodexAppServer} from './app-server.js';

// Credentials only enter the local child process. The room receives authMode,
// never an account identity, OAuth token, or private Codex thread identifier.
export const chatGPTPlanArgs = [
  'app-server','--listen','stdio://',
  '-c','model_provider="openai_chatgpt_plan"',
  '-c','model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
  '-c','model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
  '-c','model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
  '-c','model_providers.openai_chatgpt_plan.wire_api="responses"',
  '-c','model_providers.openai_chatgpt_plan.requires_openai_auth=false',
  '-c','model_providers.openai_chatgpt_plan.supports_websockets=false',
  // Native child-agent messages use agent_message input items, which SIWC
  // currently rejects. agents.enabled also overrides model-catalog V2 defaults;
  // the feature switches alone do not reliably disable that transport.
  '-c','agents.enabled=false',
  '-c','features.multi_agent=false',
  '-c','features.multi_agent_v2=false',
  '-c','shell_environment_policy.filters.ACCESS_TOKEN="exclude"',
];

export class ChatGPTPlanRuntime extends EventEmitter {
  constructor({auth,accountId,cwd,command='codex',createServer=options=>new CodexAppServer(options)}) {
    super();Object.assign(this,{auth,accountId,cwd,command,createServer});
    this.queue=Promise.resolve();this.active=0;this.idle=[];this.closed=false;
  }
  serialize(operation,signal) {
    signal?.throwIfAborted();
    const pending=this.queue.then(()=>{signal?.throwIfAborted();if(this.closed)throw new Error('The ChatGPT runtime is closed.');return operation();});
    this.queue=pending.catch(()=>{});
    if(!signal)return pending;
    // A task stopped behind another admission must settle immediately, even
    // when that admission is waiting for an unrelated active turn to finish.
    return new Promise((resolve,reject)=>{
      const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason || new Error('Stopped by owner'));};
      signal.addEventListener('abort',abort,{once:true});
      pending.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
      if(signal.aborted)abort();
    });
  }
  async waitForIdle(signal) {
    signal?.throwIfAborted();
    if(!this.active)return;
    await new Promise((resolve,reject)=>{
      const finish=error=>{signal?.removeEventListener('abort',abort);this.idle=this.idle.filter(fn=>fn!==finish);error?reject(error):resolve();};
      const abort=()=>finish(signal.reason || new Error('Stopped by owner'));
      this.idle.push(finish);signal?.addEventListener('abort',abort,{once:true});
    });
  }
  async ensureServer(signal) {
    signal?.throwIfAborted();
    let credential=await this.auth.getAccessToken({accountId:this.accountId,signal});
    if(this.server && this.accessToken===credential.accessToken)return this.server;
    // A rotating access token must not interrupt another specialist's turn.
    await this.waitForIdle(signal);signal?.throwIfAborted();
    if(this.closed)throw new Error('The ChatGPT runtime is closed.');
    // Waiting for a long task may itself have crossed another expiry boundary.
    credential=await this.auth.getAccessToken({accountId:this.accountId,signal});
    signal?.throwIfAborted();if(this.closed)throw new Error('The ChatGPT runtime is closed.');
    const old=this.server;this.server=null;old?.close();
    const server=this.createServer({command:this.command,args:[...chatGPTPlanArgs],cwd:this.cwd,env:{ACCESS_TOKEN:credential.accessToken}});
    this.server=server;this.accessToken=credential.accessToken;
    server.process.once('exit',code=>{if(this.server===server && !this.closed)this.emit('exit',code);});
    try {
      await server.initialize();
      if(this.projectOptions){const project=await server.useProject(this.projectOptions);this.projectId=project.id;}
      return server;
    }catch(error){this.server=null;this.accessToken=null;server.close();throw error;}
  }
  initialize(){return this.serialize(()=>this.ensureServer());}
  useProject(options){return this.serialize(async()=>{
    const server=await this.ensureServer();const project=await server.useProject(options);
    this.projectOptions={...options,projectId:project.id};this.projectId=project.id;return project;
  });}
  async run(params) {
    let admitted=false;
    try{
      const server=await this.serialize(async()=>{const server=await this.ensureServer(params.signal);params.signal?.throwIfAborted();this.active++;admitted=true;return server;},params.signal);
      return await server.run(params);
    }finally{if(admitted){this.active--;if(!this.active)for(const finish of [...this.idle])finish();}}
  }
  close(){this.closed=true;this.server?.close();this.server=null;this.accessToken=null;for(const finish of [...this.idle])finish(new Error('The ChatGPT runtime is closed.'));}
}
