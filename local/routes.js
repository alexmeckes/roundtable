import express from 'express';
import {allowedLocalRequest,localMember} from './access.js';
export function mountLocalConnections(app,{manager,rooms,canSpeak,enabled=true}){
  app.use('/api/local',(req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    if(!allowedLocalRequest(req,{enabled}))return res.status(404).json({available:false});
    next();
  });
  const json=express.json({limit:'8kb'});
  for(const action of ['status','choose','start','login'])app.post('/api/local/rooms/:room/'+action,json,async(req,res)=>{
    const identity=localMember(req,rooms,canSpeak);if(!identity)return res.status(403).json({error:'Join this table with permission to connect your Codex first.'});
    const {room,member}=identity,origin=req.headers.origin,controller=new AbortController();
    res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    try{
      let result;
      if(action==='status')result=await manager.status(origin,room,member);
      if(action==='choose')result=await manager.select(origin,room,member,{path:req.body?.path,mode:req.body?.mode,signal:controller.signal});
      if(action==='start')result=await manager.start(origin,room,member,{selection:req.body?.selection,saved:req.body?.saved===true,project:req.body?.project===true,check:req.body?.check,preview:req.body?.preview,signal:controller.signal});
      if(action==='login')result=await manager.signIn();
      if(!controller.signal.aborted)res.json(result);
    }catch(error){if(!controller.signal.aborted)res.status(400).json({error:error.code==='ENOENT'?'That folder is no longer available. Choose another folder.':error.message});}
  });
}
