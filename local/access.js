import {createHash} from 'node:crypto';
export const localAddress=value=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(value);
export function allowedLocalRequest(req,{enabled=true}={}){
  if(!enabled || !localAddress(req.socket.remoteAddress))return false;
  if(['forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto','x-real-ip'].some(key=>req.headers[key]))return false;
  try{
    const origin=new URL(req.headers.origin);
    return origin.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname) && origin.origin===req.headers.origin && origin.host===req.headers.host && Number(origin.port || 80)===req.socket.localPort && req.headers['content-type']?.split(';')[0]==='application/json';
  }catch{return false;}
}
export function localMember(req,rooms,canSpeak){
  const room=rooms.get(req.params.room),token=req.headers['x-roundtable-member'];
  if(typeof token!=='string' || token.length>256)return null;
  const hash=createHash('sha256').update(token).digest('hex');
  const member=room?.members?.find(m=>m.keyHash===hash);
  const you=member && [...room.people.values()].find(p=>p.id===member.id);
  return you && canSpeak(room,you)?{room,member}:null;
}
