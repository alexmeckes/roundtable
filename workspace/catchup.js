export function catchupSummary(room,member,through=Date.now()){
  const since=member.lastSeenAt || through;
  const changed=entry=>entry.updatedAt>since && entry.updatedAt<=through;
  const tasks=(room.tasks || []).filter(changed).sort((a,b)=>b.updatedAt-a.updatedAt).map(({id,title,status,ownerId})=>({id,title,status,ownerId}));
  const context=(room.sharedContext?.entries || []).filter(changed).sort((a,b)=>b.updatedAt-a.updatedAt).map(({id,title,kind,status,version})=>({id,title,kind,status,version}));
  const messages=room.chat.filter(m=>m.ts>since && m.ts<=through && ['human','agent'].includes(m.kind));
  return {since,through,tasks:tasks.slice(0,20),context:context.slice(0,20),taskCount:tasks.length,contextCount:context.length,messageCount:messages.length,limitedHistory:room.chat.length>0 && room.chat[0].ts>since};
}
export function markSeen(member,through,deliveredThrough){
  if(!Number.isSafeInteger(through) || through<0 || through>deliveredThrough)return false;
  member.lastSeenAt=Math.max(member.lastSeenAt || 0,through);return true;
}
