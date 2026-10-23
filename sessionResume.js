const crypto = require('node:crypto');
const config = require('./phase3Config');
const { getSession, removeSession, SESSION_TTL_MS } = require('./sessions');
const { getRoomBySessionId, getRoom, destroyRoom, leaveQueue } = require('./matchmaking');
const { cancelInvite } = require('./invites');
const { isOnionRequest } = require('./torProxy');
const { isValidBase64, isValidMessageId } = require('./validation');
const hashes = new Map();
let resumableRooms = 0;
const hash = token => crypto.createHash('sha256').update(token).digest();
const mode = socket => isOnionRequest(socket.request) ? 'onion' : 'standard';
const members = room => [room.session1, room.session2];
function owns(socket) { return !!socket.sessionId && getSession(socket.sessionId)?.socketId === socket.id; }
function active(room) { return !room.resumeState?.pending; }
function cleanup(room) {
  const state = room.resumeState;
  if (!state) return;
  clearTimeout(state.timer);
  for (const slot of state.slots) if (slot.hash) hashes.delete(slot.hash.toString('hex'));
  delete room.resumeState;
  resumableRooms--;
}
function stateFor(io, roomId, room) {
  if (room.resumeState) return room.resumeState;
  if (!config.resume || !room.secureChannelLocked || resumableRooms >= 512) return null;
  const slots = members(room).map(member => {
    const session = getSession(member.sessionId), socket = io.sockets.sockets.get(session?.socketId);
    return socket?.connected && socket.chatVerified && session?.capabilities?.resume
      ? { sessionId: member.sessionId, generation: 0, mode: mode(socket), hash: null } : null;
  });
  if (slots.some(s=>!s)) return null;
  const state = { slots, pending: false, deadline: 0, timer: null, epoch: 0, proofs: new Set(), confirmations: new Set() };
  room.resumeState = state; resumableRooms++;
  room.cleanupCallbacks ||= new Set(); room.cleanupCallbacks.add(()=>cleanup(room));
  return state;
}
function issue(io, socket) {
  const current = getRoomBySessionId(socket.sessionId);
  if (!owns(socket) || !current || !socket.chatVerified) return { ok:false, error:'Not eligible' };
  const state = stateFor(io, current.roomId, current.room);
  if (!state || state.pending) return { ok:false, error:'Resume not ready' };
  const slot = state.slots.find(s=>s.sessionId===socket.sessionId);
  if (slot.hash) hashes.delete(slot.hash.toString('hex'));
  const token = crypto.randomBytes(32).toString('hex'); slot.generation++;
  slot.hash = hash(token);
  hashes.set(slot.hash.toString('hex'), { roomId:current.roomId, slot, generation:slot.generation });
  return { ok:true, token, roomId:current.roomId, generation:slot.generation, slot:state.slots.indexOf(slot), graceMs:config.graceMs };
}
function notify(io, room, event, data) {
  for(const member of members(room)) {
    const socket = io.sockets.sockets.get(getSession(member.sessionId)?.socketId);
    if(socket?.connected) socket.emit(event,data);
  }
}
function pause(io, roomId, room) {
  const state = room.resumeState;
  if (!state.pending) {
    state.pending = true; state.deadline = Date.now()+config.graceMs;
    state.timer=setTimeout(()=>{
      notify(io,room,'chat-ended',{reasonCode:'resume_expired'});
      destroyRoom(roomId);
      for(const member of members(room)) if(!getSession(member.sessionId)?.socketId) removeSession(member.sessionId);
    },config.graceMs); state.timer.unref();
  }
  // No accepted work is retained offline. Pending work receives explicit failure.
  room.cancelQueued?.('Session continuity pending');
}
function suspend(io, socket) {
  if(!owns(socket)) return true; // A superseded disconnect has no authority.
  const current=getRoomBySessionId(socket.sessionId), state=current?.room.resumeState;
  if(!state || !state.slots.every(s=>s.hash || state.pending)) return false;
  pause(io,current.roomId,current.room);
  const session=getSession(socket.sessionId);
  session.recentMessageIds=socket.data.recentMessageIds;
  session.rateCounters=socket.data.rateCounters;
  session.socketId=null;
  const member=members(current.room).find(s=>s.sessionId===socket.sessionId); member.socketId=null;
  socket.chatVerified=false;
  notify(io,current.room,'resume-waiting',{roomId:current.roomId,deadline:state.deadline});
  return true;
}
function resume(io,socket,data) {
  const fresh=getSession(socket.sessionId);
  if(!config.resume || !owns(socket) || !fresh?.capabilities?.resume || fresh.roomId ||
     !isValidMessageId(data?.requestId) || typeof data?.token!=='string' || !/^[a-f0-9]{64}$/.test(data.token)) return {ok:false,error:'Resume rejected'};
  const digest=hash(data.token), entry=hashes.get(digest.toString('hex'));
  const room=entry && getRoom(entry.roomId), state=room?.resumeState, slot=entry?.slot;
  const original=slot && getSession(slot.sessionId);
  if(!state || (!state.pending && !state.slots.every(s=>s.hash)) || !original || fresh.capabilities.binary!==original.capabilities?.binary || original.roomId!==entry.roomId || !slot.hash ||
     !crypto.timingSafeEqual(digest,slot.hash) || entry.generation!==slot.generation || slot.mode!==mode(socket) ||
     Date.now()-original.createdAt>=SESSION_TTL_MS || (state.pending && Date.now()>=state.deadline)) return {ok:false,error:'Resume rejected'};
  // Synchronous ownership transfer: no handler yields across this mutation.
  hashes.delete(slot.hash.toString('hex')); slot.hash=null;
  const previous=io.sockets.sockets.get(original.socketId);
  const temporaryId=socket.sessionId;
  leaveQueue(temporaryId); cancelInvite(temporaryId); removeSession(temporaryId);
  pause(io,entry.roomId,room);
  original.socketId=socket.id; socket.sessionId=slot.sessionId;
  const member=members(room).find(m=>m.sessionId===slot.sessionId); member.socketId=socket.id;
  socket.data.publicKey=original.publicKey; socket.data.keyConfirmationSent=original.keyConfirmed;
  socket.data.recentMessageIds=original.recentMessageIds || previous?.data.recentMessageIds || new Set();
  socket.data.rateCounters=original.rateCounters || previous?.data.rateCounters || socket.data.rateCounters;
  socket.chatVerified=false;
  if(previous && previous!==socket) { previous.chatVerified=false; previous.disconnect(true); }
  state.epoch++; state.challenge=crypto.randomBytes(32).toString('hex');
  state.proofs.clear(); state.confirmations.clear();
  const challenge={roomId:entry.roomId,epoch:state.epoch,challenge:state.challenge,generations:state.slots.map(s=>s.generation),deadline:state.deadline};
  notify(io,room,'resume-challenge',challenge);
  return {ok:true,...challenge};
}
function proof(io,socket,data) {
  const current=getRoomBySessionId(socket.sessionId), state=current?.room.resumeState;
  if(!owns(socket) || !state?.pending || Date.now()>=state.deadline || data?.epoch!==state.epoch ||
     data?.challenge!==state.challenge || !isValidBase64(data?.proof,16384)) return {ok:false,error:'Invalid resume proof'};
  const peer=members(current.room).find(m=>m.sessionId!==socket.sessionId);
  const target=io.sockets.sockets.get(getSession(peer.sessionId)?.socketId);
  if(!target?.connected) return {ok:false,error:'Peer unavailable',retryable:true};
  if(state.proofs.has(socket.sessionId)) return {ok:true,duplicate:true};
  state.proofs.add(socket.sessionId);
  target.emit('resume-peer-proof',{roomId:current.roomId,epoch:state.epoch,challenge:state.challenge,proof:data.proof});
  return {ok:true};
}
function confirm(io,socket,data) {
  const current=getRoomBySessionId(socket.sessionId), state=current?.room.resumeState;
  if (owns(socket) && state && !state.pending && data?.epoch===state.epoch && data?.challenge===state.challenge && state.confirmations.has(socket.sessionId)) return {ok:true,complete:true};
  if(!owns(socket) || !state?.pending || Date.now()>=state.deadline || data?.epoch!==state.epoch ||
     data?.challenge!==state.challenge || data?.verified!==true || state.proofs.size!==2) return {ok:false,error:'Continuity not confirmed'};
  if(members(current.room).some(m=>!io.sockets.sockets.get(getSession(m.sessionId)?.socketId)?.connected)) return {ok:false,error:'Peer unavailable'};
  state.confirmations.add(socket.sessionId);
  if(state.confirmations.size===2) {
    state.pending=false; clearTimeout(state.timer); state.timer=null;
    for(const member of members(current.room)) io.sockets.sockets.get(getSession(member.sessionId).socketId).chatVerified=true;
    notify(io,current.room,'resume-complete',{roomId:current.roomId,epoch:state.epoch});
  }
  return {ok:true,complete:!state.pending};
}
module.exports={owns,active,issue,suspend,resume,proof,confirm,cleanup};
