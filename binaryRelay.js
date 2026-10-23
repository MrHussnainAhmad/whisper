const { getSession } = require('./sessions');
const { getRoomBySessionId } = require('./matchmaking');
const { allowAction, MAX_CONNECTIONS_GLOBAL } = require('./abuseLimiter');
const { allowRoomResource } = require('./roomLimiter');
const { isValidMessageId } = require('./validation');
const { active, owns } = require('./sessionResume');
const config = require('./phase3Config');
const metrics = require('./performanceMetrics');
const WINDOW = 256 * 1024, CHUNK = 32 * 1024, GLOBAL = 16 * 1024 * 1024;
let reservedBytes = 0;
function buffered(socket) {
  const transport=socket.conn?.transport?.socket;
  let bytes=Math.max(transport?.bufferedAmount || 0,transport?._socket?.writableLength || 0);
  for(const packet of socket.conn?.writeBuffer || []) bytes+=typeof packet.data==='string' ? Buffer.byteLength(packet.data) : packet.data?.byteLength || 0;
  return bytes;
}
function eligible(io,socket) {
  const current=getRoomBySessionId(socket.sessionId);
  if(!config.binary || !owns(socket) || !socket.chatVerified || !current?.room.secureChannelLocked || !active(current.room)) return null;
  const members=[current.room.session1,current.room.session2];
  if(members.some(m=>!getSession(m.sessionId)?.capabilities?.binary)) return null;
  const index=members.findIndex(m=>m.sessionId===socket.sessionId);
  const peer=io.sockets.sockets.get(getSession(members[1-index].sessionId)?.socketId);
  return peer?.connected && peer.chatVerified ? {...current,members,index,peer} : null;
}
function createDirection() {
  return {control:[],media:[],pending:new Set(),recent:new Map(),queuedBytes:0,outstanding:new Map(),outstandingBytes:0,
    streamId:null,next:0,lastSent:-1,lastAck:-1,usedStreams:new Set(),timer:null,burst:0};
}
function stateFor(io,current) {
  const room=current.room;
  if(room.binaryState) return room.binaryState;
  const state={directions:[createDirection(),createDirection()],closed:false}; room.binaryState=state;
  function cancel(reason) {
    for(const d of state.directions) {
      clearTimeout(d.timer); d.timer=null;
      for(const item of [...d.control,...d.media]) {
        reservedBytes-=item.bytes;
        item.ack({ok:false,error:reason,retryable:true});
      }
      for(const item of d.outstanding.values()) {
        reservedBytes-=item.bytes;
        d.recent.delete(item.messageId);
        const sender=io.sockets.sockets.get(getSession(item.sender)?.socketId);
        sender?.emit('envelope-failed',{messageId:item.messageId,reason});
      }
      d.control=[];d.media=[];d.pending.clear();d.queuedBytes=0;d.outstanding.clear();d.outstandingBytes=0;
      d.streamId=null;d.next=0;d.lastSent=-1;d.lastAck=-1;
    }
  }
  room.cancelQueued=cancel;
  room.cleanupCallbacks ||= new Set();
  room.cleanupCallbacks.add(()=>{state.closed=true;cancel('Chat ended');delete room.binaryState;delete room.cancelQueued;});
  return state;
}
function schedule(io,current,d) {
  const hasWork = d.control.length || d.media.length;
  if(d.timer && !(hasWork && d.idleWait)) return;
  if(d.timer) clearTimeout(d.timer);
  d.idleWait = !hasWork;
  const peer=io.sockets.sockets.get(getSession(current.members[1-current.index].sessionId)?.socketId);
  const congested = peer && (peer.conn?.transport?.writable===false || buffered(peer)>64*1024);
  const delay = hasWork ? (congested ? 25 : 5) : 1000;
  d.timer=setTimeout(()=>{d.timer=null;drain(io,current,d);},delay);d.timer.unref();
}
function drain(io,current,d) {
  const state=current.room.binaryState;
  if(!state || state.closed) return;
  const sender=io.sockets.sockets.get(getSession(current.members[current.index].sessionId)?.socketId);
  const peer=io.sockets.sockets.get(getSession(current.members[1-current.index].sessionId)?.socketId);
  if(!sender?.connected || !peer?.connected || !active(current.room)) { current.room.cancelQueued('Connection unavailable');return; }
  const now=metrics.now();
  // A recipient that stops acknowledging cannot hold data indefinitely.
  if([...d.outstanding.values()].some(item=>now-item.sentAt>=30000) || [...d.control,...d.media].some(item=>now-item.started>=10000)) {
    current.room.cancelQueued('Recipient timeout');return;
  }
  let emitted=0;
  while(emitted<5 && (d.control.length || d.media.length)) {
    const pending=buffered(peer); metrics.record('pendingBytes',pending);
    if(pending>64*1024 || peer.conn?.transport?.writable===false) {metrics.record('contention',1);break;}
    const mediaReady=d.media.length && d.outstandingBytes+d.media[0].bytes<=WINDOW && d.outstanding.size<128;
    const useControl=d.control.length && (d.burst<4 || !mediaReady);
    if(!useControl && !mediaReady) break;
    const item=(useControl?d.control:d.media).shift();
    d.burst=useControl?d.burst+1:0;
    d.queuedBytes-=item.bytes;d.pending.delete(item.data.messageId);
    if(useControl) reservedBytes-=item.bytes;
    else {
      d.lastSent=item.data.sequence;d.outstandingBytes+=item.bytes;
      d.outstanding.set(item.data.sequence,{bytes:item.bytes,sentAt:metrics.now(),messageId:item.data.messageId,sender:sender.sessionId});
    }
    d.recent.set(item.data.messageId,{streamId:item.data.streamId,sequence:item.data.sequence});
    if(d.recent.size>200) d.recent.delete(d.recent.keys().next().value);
    metrics.record('queueMs',metrics.now()-item.started);
    peer.emit('receive-envelope',item.data);
    item.ack({ok:true,messageId:item.data.messageId,duplicate:false});
    metrics.record('forwardMs',metrics.now()-item.started);
    emitted++;
  }
  if(d.control.length || d.media.length || d.outstanding.size) schedule(io,current,d);
}
function send(io,socket,data,ack) {
  const current=eligible(io,socket);
  if(!current) {ack({ok:false,error:'Binary relay not negotiated or confirmed'});return;}
  if(data?.roomId!==current.roomId || !isValidMessageId(data?.messageId) || !['control','media'].includes(data?.kind) ||
    !Buffer.isBuffer(data?.ciphertext) || data.ciphertext.length<1 || data.ciphertext.length>(data.kind==='control'?4096:CHUNK) ||
    (data.kind==='media' && (!isValidMessageId(data.streamId) || !Number.isSafeInteger(data.sequence) || data.sequence<0 || data.sequence>1000000))) {
    ack({ok:false,error:'Invalid binary envelope'});return;
  }
  const state=stateFor(io,current),d=state.directions[current.index],bytes=data.ciphertext.length;
  if(d.recent.has(data.messageId)) {ack({ok:true,messageId:data.messageId,duplicate:true});return;}
  if(d.pending.has(data.messageId)) {ack({ok:false,error:'Envelope pending',retryable:true});return;}
  if(d.queuedBytes+bytes>WINDOW || reservedBytes+bytes>GLOBAL || d.control.length+d.media.length>=128) {
    metrics.record('contention',1);ack({ok:false,error:'Queue full',retryable:true});return;
  }
  if(data.kind==='media') {
    if(data.streamId!==d.streamId) {
      if(d.media.length || d.outstanding.size || data.sequence!==0 || d.usedStreams.has(data.streamId)) {ack({ok:false,error:'Transfer busy or reused'});return;}
    } else if(data.sequence!==d.next) {ack({ok:false,error:'Unexpected sequence'});return;}
  }
  const scale=MAX_CONNECTIONS_GLOBAL/5000;
  if(!allowAction(socket,'message-count',{limit:40,sourceLimit:false,windowMs:1000}) ||
     !allowAction(socket,'message-bytes',{limit:8*1024*1024,sourceLimit:false,windowMs:1000,cost:bytes}) ||
     !allowRoomResource(current.room,'messages',Math.max(1,Math.round(4000*scale)),1000,1,80) ||
     !allowRoomResource(current.room,'bytes',Math.max(1,Math.round(64*1024*1024*scale))*10,10000,bytes,16*1024*1024)) {
    ack({ok:false,error:'Room capacity reached',retryable:true});return;
  }
  if(data.kind==='media') {
    if(data.streamId!==d.streamId) {
      d.streamId=data.streamId;d.next=0;d.lastSent=-1;d.lastAck=-1;d.usedStreams.add(data.streamId);
      if(d.usedStreams.size>32)d.usedStreams.delete(d.usedStreams.values().next().value);
    }
    d.next++;
  }
  const envelope={roomId:current.roomId,messageId:data.messageId,kind:data.kind,ciphertext:data.ciphertext};
  if(data.kind==='media'){envelope.streamId=data.streamId;envelope.sequence=data.sequence;}
  const item={data:envelope,bytes,ack,started:metrics.now()};
  (data.kind==='control'?d.control:d.media).push(item);d.pending.add(data.messageId);
  d.queuedBytes+=bytes;reservedBytes+=bytes;
  schedule(io,current,d);
}
function receipt(io,socket,data) {
  const current=eligible(io,socket), state=current?.room.binaryState;
  if(!state || data?.roomId!==current.roomId) return {ok:false,error:'Invalid receipt'};
  const d=state.directions[1-current.index];
  if(data.streamId!==d.streamId || !Number.isSafeInteger(data.through) || data.through<0 || data.through>d.lastSent || data.through<d.lastAck) return {ok:false,error:'Invalid receipt'};
  if(data.through===d.lastAck)return {ok:true,duplicate:true};
  for(const [sequence,item] of d.outstanding) if(sequence<=data.through) {
    reservedBytes-=item.bytes;d.outstandingBytes-=item.bytes;d.outstanding.delete(sequence);
    metrics.record('recipientAckMs',metrics.now()-item.sentAt);
  }
  d.lastAck=data.through;
  current.peer.emit('media-credit',{roomId:current.roomId,streamId:d.streamId,through:d.lastAck,availableBytes:WINDOW-d.outstandingBytes});
  return {ok:true,availableBytes:WINDOW-d.outstandingBytes};
}
module.exports={send,receipt,buffered,stats:()=>({reservedBytes}),WINDOW,CHUNK};
