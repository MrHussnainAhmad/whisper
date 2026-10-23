const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
process.env.PERF_DIAGNOSTICS='1';process.env.RESUME_ENABLED='1';process.env.BINARY_RELAY_ENABLED='1';
const sessions=require('../sessions'),mm=require('../matchmaking'),resume=require('../sessionResume'),binary=require('../binaryRelay');
function fixture(t) {
 const map=new Map(),ids=[],rooms=[];const io={sockets:{sockets:map}};
 const socket=()=>{const id=crypto.randomUUID(),sessionId=crypto.randomUUID();ids.push(sessionId);sessions.addSession(sessionId,id);sessions.getSession(sessionId).capabilities={resume:true,binary:true};const s={id,sessionId,connected:true,chatVerified:true,request:{socket:{remoteAddress:'127.0.0.1'}},data:{sourceKey:crypto.randomUUID(),recentMessageIds:new Set()},events:[],conn:{writeBuffer:[],transport:{writable:true}},emit(e,d){this.events.push([e,d]);},disconnect(){this.connected=false;}};map.set(id,s);return s;};
 const a=socket(),b=socket(),roomId=crypto.randomUUID();mm._setRoom(roomId,{session1:{sessionId:a.sessionId,socketId:a.id},session2:{sessionId:b.sessionId,socketId:b.id}});mm.lockRoomSecureChannel(roomId);rooms.push(roomId);
 for(const s of[a,b]){sessions.setSessionPublicKey(s.sessionId,'public');sessions.setSessionKeyConfirmed(s.sessionId);}
 t.after(()=>{rooms.forEach(mm.destroyRoom);ids.forEach(sessions.removeSession);});
 return {io,a,b,roomId,room:mm.getRoom(roomId),socket};
}
function confirm(f,c,result) {
 const data={epoch:result.epoch,challenge:result.challenge,proof:'AAAA'};
 assert.equal(resume.proof(f.io,c,data).ok,true);assert.equal(resume.proof(f.io,f.b,data).ok,true);
 assert.equal(resume.confirm(f.io,c,{...data,verified:true}).complete,false);
 assert.equal(resume.confirm(f.io,f.b,{...data,verified:true}).complete,true);
}
test('resume tokens separate participants, consume once, rotate, and freeze delivery until both proofs confirm',t=>{
 const f=fixture(t),ta=resume.issue(f.io,f.a),tb=resume.issue(f.io,f.b);assert.notEqual(ta.token,tb.token);assert.equal(ta.token.length,64);
 assert.equal(JSON.stringify(f.room.resumeState).includes(ta.token),false);
 const c=f.socket(),d=f.socket();c.request.socket.remoteAddress='203.0.113.9';
 const result=resume.resume(f.io,c,{token:ta.token,requestId:crypto.randomUUID()});assert.equal(result.ok,true);
 assert.equal(resume.owns(f.a),false);assert.equal(f.a.connected,false);assert.equal(resume.active(f.room),false);
 assert.equal(resume.resume(f.io,d,{token:ta.token,requestId:crypto.randomUUID()}).ok,false);
 assert.equal(resume.issue(f.io,c).ok,false);
 assert.equal(resume.confirm(f.io,c,{...result,verified:true}).ok,false);
 assert.equal(resume.proof(f.io,c,{...result,epoch:0,proof:'AAAA'}).ok,false);
 confirm(f,c,result);assert.equal(resume.active(f.room),true);
 assert.equal(resume.confirm(f.io,c,{...result,verified:true}).complete,true);
 const rotated=resume.issue(f.io,c);assert.equal(rotated.ok,true);assert.notEqual(rotated.token,ta.token);
 assert.equal(resume.resume(f.io,d,{token:ta.token,requestId:crypto.randomUUID()}).ok,false);
 assert.equal(resume.suspend(f.io,f.a),true);assert.equal(resume.active(f.room),true);
});
test('resume grace expiry tears down room, credentials and detached sessions',t=>{
 const f=fixture(t),token=resume.issue(f.io,f.a);resume.issue(f.io,f.b);
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
 assert.equal(resume.suspend(f.io,f.a),true);assert.equal(resume.suspend(f.io,f.b),true);
 assert.equal(mm.getRoomCount(),1);t.mock.timers.tick(90001);
 assert.equal(mm.getRoom(f.roomId),undefined);assert.equal(sessions.getSession(f.a.sessionId),undefined);
 const c=f.socket();assert.equal(resume.resume(f.io,c,{token:token.token,requestId:crypto.randomUUID()}).ok,false);
});
test('concurrent candidates and both-participant reconnects cannot reuse credentials or old proof epochs',t=>{
 const f=fixture(t),aToken=resume.issue(f.io,f.a),bToken=resume.issue(f.io,f.b),c=f.socket(),d=f.socket();
 resume.suspend(f.io,f.a);resume.suspend(f.io,f.b);
 const first=resume.resume(f.io,c,{token:aToken.token,requestId:crypto.randomUUID()});
 const second=resume.resume(f.io,d,{token:bToken.token,requestId:crypto.randomUUID()});assert.equal(second.ok,true);
 assert.equal(resume.proof(f.io,c,{...first,proof:'AAAA'}).ok,false);
 assert.equal(resume.proof(f.io,c,{...second,proof:'AAAA'}).ok,true);
 assert.equal(resume.proof(f.io,d,{...second,proof:'AAAA'}).ok,true);
 assert.equal(resume.confirm(f.io,c,{...second,verified:true}).complete,false);
 assert.equal(resume.confirm(f.io,d,{...second,verified:true}).complete,true);
 mm.destroyRoom(f.roomId);assert.equal(resume.issue(f.io,c).ok,false);
});
function envelope(f,kind,extra={}){return {roomId:f.roomId,messageId:crypto.randomUUID(),kind,ciphertext:Buffer.alloc(kind==='media'?32768:16),...extra};}
test('binary scheduler prioritizes bounded control, preserves media order and enforces cumulative window',async t=>{
 const f=fixture(t),streamId=crypto.randomUUID(),results=[];
 const send=data=>new Promise(resolve=>binary.send(f.io,f.a,data,result=>{results.push(result);resolve(result);}));
 const m0=send(envelope(f,'media',{streamId,sequence:0})),m1=send(envelope(f,'media',{streamId,sequence:1})),control=send(envelope(f,'control'));
 await Promise.all([m0,m1,control]);const received=f.b.events.filter(([e])=>e==='receive-envelope').map(([,d])=>d);
 assert.equal(received[0].kind,'control');assert.deepEqual(received.filter(d=>d.kind==='media').map(d=>d.sequence),[0,1]);
 for(let sequence=2;sequence<8;sequence++)assert.equal((await send(envelope(f,'media',{streamId,sequence}))).ok,true);
 let ninth;binary.send(f.io,f.a,envelope(f,'media',{streamId,sequence:8}),r=>{ninth=r;});
 await new Promise(r=>setTimeout(r,20));assert.equal(ninth,undefined);
 assert.equal(binary.receipt(f.io,f.b,{roomId:f.roomId,streamId,through:8}).ok,false);
 assert.equal(binary.receipt(f.io,f.b,{roomId:f.roomId,streamId,through:3}).ok,true);
 assert.equal(binary.receipt(f.io,f.b,{roomId:f.roomId,streamId,through:3}).duplicate,true);
 await new Promise(r=>setTimeout(r,20));assert.equal(ninth.ok,true);
 assert.equal(binary.receipt(f.io,f.b,{roomId:f.roomId,streamId,through:8}).ok,true);
 assert.equal(binary.stats().reservedBytes,0);
});
test('malformed binary, oversized controls, wrong membership and slow-peer queue limits fail without silent success',async t=>{
 const f=fixture(t);const send=data=>new Promise(resolve=>binary.send(f.io,f.a,data,resolve));
 assert.equal((await send(envelope(f,'control',{ciphertext:'AAAA'}))).ok,false);
 assert.equal((await send(envelope(f,'control',{ciphertext:Buffer.alloc(4097)}))).ok,false);
 assert.equal((await send(envelope(f,'media',{streamId:crypto.randomUUID(),sequence:-1}))).ok,false);
 assert.equal((await send(envelope(f,'control',{roomId:crypto.randomUUID()}))).ok,false);
 f.b.conn.transport.writable=false;
 const streamId=crypto.randomUUID(),pending=[];
 for(let i=0;i<8;i++)pending.push(send(envelope(f,'media',{streamId,sequence:i})));
 assert.equal((await send(envelope(f,'media',{streamId,sequence:8}))).ok,false);
 mm.destroyRoom(f.roomId);assert.ok((await Promise.all(pending)).every(r=>r.ok===false));assert.equal(binary.stats().reservedBytes,0);
});

test('destroying a room with detached participants frees retained sessions and tokens immediately',t=>{
 const f=fixture(t);const token=resume.issue(f.io,f.a);resume.issue(f.io,f.b);resume.suspend(f.io,f.a);
 mm.destroyRoom(f.roomId);assert.equal(sessions.getSession(f.a.sessionId),undefined);
 const fresh=f.socket();assert.equal(resume.resume(f.io,fresh,{token:token.token,requestId:crypto.randomUUID()}).ok,false);
});
test('recipient timeout reports accepted media failure and releases all window credits',t=>{
 const f=fixture(t);t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
 const metrics=require('../performanceMetrics');let time=0;t.mock.method(metrics,'now',()=>time);
 const data=envelope(f,'media',{streamId:crypto.randomUUID(),sequence:0});let ack;
 binary.send(f.io,f.a,data,r=>{ack=r;});t.mock.timers.tick(5);assert.equal(ack.ok,true);
 time=31000;t.mock.timers.tick(1000);
 assert.ok(f.a.events.some(([event,value])=>event==='envelope-failed' && value.messageId===data.messageId));
 assert.equal(binary.stats().reservedBytes,0);
});
test('binary priority does not starve media and both directional windows remain independent',async t=>{
 const f=fixture(t);const streamId=crypto.randomUUID(),results=[];
 for(let i=0;i<6;i++)results.push(new Promise(resolve=>binary.send(f.io,f.a,envelope(f,'control'),resolve)));
 results.push(new Promise(resolve=>binary.send(f.io,f.a,envelope(f,'media',{streamId,sequence:0}),resolve)));
 results.push(new Promise(resolve=>binary.send(f.io,f.b,envelope(f,'media',{streamId:crypto.randomUUID(),sequence:0}),resolve)));
 await Promise.all(results);
 const peer=f.b.events.filter(([event])=>event==='receive-envelope').map(([,data])=>data.kind);
 assert.ok(peer.indexOf('media')<=4);assert.ok(f.a.events.some(([event])=>event==='receive-envelope'));
});


test('diagnostics expose only bounded aggregate metrics and process memory',()=>{
 const metrics=require('../performanceMetrics');metrics.record('forwardMs',1);metrics.record('secret-user-id',123);
 const snapshot=metrics.snapshot();assert.equal(snapshot.enabled,true);assert.ok(snapshot.memory.rss>0);
 assert.equal(snapshot.metrics['secret-user-id'],undefined);
 assert.ok(Object.keys(snapshot.metrics).every(k=>['forwardMs','queueMs','recipientAckMs','contention','pendingBytes'].includes(k)));
});
