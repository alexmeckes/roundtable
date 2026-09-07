import {randomBytes} from 'node:crypto';

export const TASK_STATUSES=['planned','working','blocked','needs_review','done'];
export const initTasks=room=>room.tasks ||= [];
export const taskPeople=room=>(room.members || []).map(({id,name})=>({id,name}));
export const taskAgents=room=>[
  ...(room.members || []).filter(m=>m.agentHandle).map(m=>({id:m.id,ownerId:m.id,name:`${m.name}'s Codex`,handle:m.agentHandle})),
  ...(room.specialists || []).map(a=>({id:a.agentId,ownerId:a.ownerId,name:a.agentName,handle:a.handle})),
];
export const taskSummary=room=>initTasks(room).filter(t=>t.status!=='done').map(({id,title,ownerId,agentId,status,dependencies,contextIds})=>({id,title,ownerId,agentId,status,dependencies,contextIds}));
export function currentTask(room,msg){
  const task=initTasks(room).find(t=>t.id===msg.id);
  if(!task || task.version!==msg.version)throw new Error('This task changed. Reopen it before saving or starting.');
  return task;
}
export function saveTask(room,you,msg){
  const tasks=initTasks(room),old=msg.id?currentTask(room,msg):null;
  if(old?.status==='working')throw new Error('Stop the active run before editing this task.');
  const clean=(v,max)=>{if(typeof v!=='string' || v.length>max)throw new Error('Task text is missing or too long.');return v.trim();};
  const title=clean(msg.title,120),details=clean(msg.details,4000),status=msg.status || 'planned';
  if(!title || !TASK_STATUSES.includes(status) || status==='working')throw new Error('Choose a title and a task status. Working is set when its owner starts a run.');
  const ownerId=msg.ownerId || null,agentId=msg.agentId || null;
  if(ownerId && !taskPeople(room).some(p=>p.id===ownerId))throw new Error('Choose a person from this table.');
  if(agentId && !taskAgents(room).some(a=>a.id===agentId && a.ownerId===ownerId))throw new Error('Choose an agent belonging to the task owner.');
  const ids=(value,allowed)=>{if(!Array.isArray(value) || value.length>10 || value.some(id=>!allowed.includes(id)))throw new Error('Choose up to ten references from this table.');return [...new Set(value)];};
  const dependencies=ids(msg.dependencies || [],tasks.filter(t=>t.id!==old?.id).map(t=>t.id));
  const contextIds=ids(msg.contextIds || [],(room.sharedContext?.entries || []).filter(e=>e.status==='accepted').map(e=>e.id));
  const reaches=(id,seen=new Set())=>{if(id===old?.id)return true;if(seen.has(id))return false;seen.add(id);return tasks.find(t=>t.id===id)?.dependencies.some(next=>reaches(next,seen));};
  if(dependencies.some(id=>reaches(id)))throw new Error('Dependencies cannot form a cycle.');
  if(['done','needs_review'].includes(status) && dependencies.some(id=>tasks.find(t=>t.id===id).status!=='done'))throw new Error('Finish prerequisite tasks first.');
  if(old?.status==='done' && status!=='done' && tasks.some(t=>t.dependencies.includes(old.id) && ['working','needs_review','done'].includes(t.status)))throw new Error('Reopen dependent tasks first.');
  if(!old && tasks.length>=100)throw new Error('This table has reached its 100 task limit.');
  const origin=msg.chatId && room.chat.find(m=>m.id===msg.chatId && ['human','agent'].includes(m.kind));
  if(msg.chatId && !origin)throw new Error('The original message is no longer available.');
  const task=old || {id:randomBytes(12).toString('base64url'),createdAt:Date.now(),createdBy:you.id,version:0,runIds:[],...(origin?{origin:{chatId:origin.id,author:origin.author,text:origin.text}}:{})};
  Object.assign(task,{title,details,ownerId,agentId,status,dependencies,contextIds,version:task.version+1,updatedAt:Date.now(),updatedBy:you.id});
  if(!old)tasks.push(task);
  return task;
}
export function validateTaskStart(room,you,msg){
  const task=currentTask(room,msg);
  if(task.ownerId!==you.id)throw new Error('Only the task owner can start their Codex.');
  if(!task.agentId)throw new Error('Assign one of your agents first.');
  if(!['planned','blocked'].includes(task.status))throw new Error('Only planned or blocked tasks can start. Reopen reviewed work to run it again.');
  if(task.dependencies.some(id=>room.tasks.find(t=>t.id===id)?.status!=='done'))throw new Error('Finish prerequisite tasks before starting.');
  return task;
}
export function syncTaskRun(room,work){
  const task=initTasks(room).find(t=>t.id===work.taskId);
  if(!task || task.runIds.at(-1)!==work.id)return;
  task.status=['running','integrating'].includes(work.status)?'working':['ready','integrated'].includes(work.status)?'needs_review':'blocked';
  task.version++;task.updatedAt=Date.now();
}
