const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const {fixture,ack,event,secure,match}=require('./phase3Fixture.cjs');
const env={RESUME_ENABLED:'1',BINARY_RELAY_ENABLED:'1'};
async function client(f,circuit=null,capabilities={resume:1,binary:1}) {const s=await f.connect(circuit);assert.equal((await ack(s,'negotiate-capabilities',capabilities)).ok,true);return s;}
async function tokens(a,b){return [await ack(a,'resume-token'),await ack(b,'resume-token')];}
async function continuity(a,b,result) {
 const data={epoch:result.epoch,challenge:result.challenge,proof:'AAAA'};
 assert.equal((await ack(a,'resume-proof',data)).ok,true);assert.equal((await ack(b,'resume-proof',data)).ok,true);
 assert.equal((await ack(a,'resume-confirm',{...data,verified:true})).complete,false);
 assert.equal((await ack(b,'resume-confirm',{...data,verified:true})).complete,true);
}
test('negotiated reconnect restores a room only after both client continuity confirmations, with dedup and rotation',async t=>{
 const f=await fixture(t,env),a=await client(f),b=await client(f);await match(a,b);await secure(a,b);
 const [ta,tb]=await tokens(a,b);assert.equal(ta.ok,true);assert.notEqual(ta.token,tb.token);
 const payload={encrypted:'AAAA',messageId:crypto.randomUUID()};const received=event(b,'receive-encrypted');await ack(a,'send-encrypted',payload);await received;
 const waiting=event(b,'resume-waiting');a.disconnect();await waiting;
 const c=await client(f);const result=await ack(c,'resume-session',{token:ta.token,requestId:crypto.randomUUID()});assert.equal(result.ok,true);
 assert.equal((await ack(c,'resume-status')).challenge,result.challenge);
 assert.equal((await ack(c,'send-encrypted',{...payload,messageId:crypto.randomUUID()})).ok,false);
 assert.equal((await ack(b,'secure-channel-ready')).ok,false);
 await continuity(c,b,result);
 assert.equal((await ack(c,'send-encrypted',payload)).duplicate,true);
 const rotated=await ack(c,'resume-token');assert.equal(rotated.ok,true);assert.notEqual(rotated.token,ta.token);
 const attacker=await client(f);assert.equal((await ack(attacker,'resume-session',{token:ta.token,requestId:crypto.randomUUID()})).ok,false);
 assert.equal((await ack(c,'key-exchange',{protocolVersion:7,keyBundle:Buffer.concat([Buffer.from([7]),Buffer.alloc(128)]).toString('base64')})).ok,false);
 const ended=event(b,'chat-ended');await ack(c,'leave-room');await ended;
 assert.equal((await ack(attacker,'resume-session',{token:rotated.token,requestId:crypto.randomUUID()})).ok,false);
});
test('Tor resume passes fresh admission on a different circuit but rejects transport-mode switching',async t=>{
 const f=await fixture(t,env),a=await client(f,1),b=await client(f,2);await match(a,b);await secure(a,b);
 const [ta]=await tokens(a,b);const waiting=event(b,'resume-waiting');a.disconnect();await waiting;
 const standard=await client(f);assert.equal((await ack(standard,'resume-session',{token:ta.token,requestId:crypto.randomUUID()})).ok,false);
 const c=await client(f,3);const result=await ack(c,'resume-session',{token:ta.token,requestId:crypto.randomUUID()});assert.equal(result.ok,true);
 await continuity(c,b,result);
 const payload={encrypted:'AAAA',messageId:crypto.randomUUID()},received=event(b,'receive-encrypted');assert.equal((await ack(c,'send-encrypted',payload)).ok,true);await received;
});
test('binary Socket.IO chunks use recipient acknowledgments, reject malformed input and preserve v7 fallback',async t=>{
 const f=await fixture(t,env),a=await client(f),b=await client(f);await match(a,b);await secure(a,b);
 const [token]=await tokens(a,b),roomId=token.roomId,streamId=crypto.randomUUID();
 const data={roomId,kind:'media',streamId,sequence:0,messageId:crypto.randomUUID(),ciphertext:crypto.randomBytes(32768)};
 const received=event(b,'receive-envelope');assert.equal((await ack(a,'send-envelope',data)).ok,true);assert.deepEqual((await received).ciphertext,data.ciphertext);
 assert.equal((await ack(a,'send-envelope',data)).duplicate,true);
 assert.equal((await ack(b,'media-ack',{roomId,streamId,through:1})).ok,false);
 assert.equal((await ack(b,'media-ack',{roomId,streamId,through:0})).ok,true);
 assert.equal((await ack(b,'media-ack',{roomId,streamId,through:0})).duplicate,true);
 assert.equal((await ack(a,'send-envelope',{...data,messageId:crypto.randomUUID(),ciphertext:Buffer.alloc(32769)})).ok,false);
 assert.equal((await ack(a,'send-envelope',{...data,messageId:crypto.randomUUID(),ciphertext:'AAAA'})).ok,false);
 const legacy=event(a,'receive-encrypted');assert.equal((await ack(b,'send-encrypted',{messageId:crypto.randomUUID(),encrypted:'AAAA'})).ok,true);await legacy;
});
test('feature flags and both-peer negotiation preserve old immediate-disconnect behavior',async t=>{
 const f=await fixture(t,{RESUME_ENABLED:'0',BINARY_RELAY_ENABLED:'0'}),a=await f.connect(null),b=await f.connect(null);
 assert.deepEqual(await ack(a,'negotiate-capabilities',{resume:1,binary:1}),{ok:true,resume:false,binary:false});
 await match(a,b);await secure(a,b);assert.equal((await ack(a,'resume-token')).ok,false);
 assert.equal((await ack(a,'send-envelope',{})).ok,false);
 const ended=event(b,'chat-ended');a.disconnect();assert.equal((await ended).reasonCode,'peer_left');
});

test('active-socket replacement revokes old authority; concurrent token attempts have one winner',async t=>{
 const f=await fixture(t,env),a=await client(f),b=await client(f);await match(a,b);await secure(a,b);
 const [ta]=await tokens(a,b),c=await client(f),d=await client(f);
 const disconnected=event(a,'disconnect');
 const results=await Promise.all([c,d].map(s=>ack(s,'resume-session',{token:ta.token,requestId:crypto.randomUUID()})));
 assert.equal(results.filter(r=>r.ok).length,1);await disconnected;
 const winner=results[0].ok?c:d,result=results.find(r=>r.ok);await continuity(winner,b,result);
 assert.equal((await ack(b,'resume-status')).pending,false);
 const payload={encrypted:'AAAA',messageId:crypto.randomUUID()},received=event(b,'receive-encrypted');
 assert.equal((await ack(winner,'send-encrypted',payload)).ok,true);await received;
});
test('one unsupported peer prevents resume and binary negotiation for its room',async t=>{
 const f=await fixture(t,env),a=await client(f),b=await f.connect(null);await match(a,b);await secure(a,b);
 assert.equal((await ack(a,'resume-token')).ok,false);
 assert.equal((await ack(a,'send-envelope',{})).ok,false);
 const ended=event(b,'chat-ended');a.disconnect();await ended;
});

test('controlled binary transfer relays 768 KiB with interleaved control and cumulative receipts',async t=>{
 const f=await fixture(t,env),a=await client(f),b=await client(f);await match(a,b);await secure(a,b);
 const [token]=await tokens(a,b),roomId=token.roomId,streamId=crypto.randomUUID();
 const sequence=[],receiptPromises=[],digests=new Map();let controls=0;
 b.on('receive-envelope',data=>{
   if(data.kind==='control'){controls++;return;}
   sequence.push(data.sequence);
   assert.equal(crypto.createHash('sha256').update(data.ciphertext).digest('hex'),digests.get(data.sequence));
   receiptPromises.push(ack(b,'media-ack',{roomId,streamId,through:data.sequence}));
 });
 for(let batch=0;batch<6;batch++){
   const pending=[];
   for(let offset=0;offset<4;offset++){
     const index=batch*4+offset,ciphertext=crypto.randomBytes(32768);
     digests.set(index,crypto.createHash('sha256').update(ciphertext).digest('hex'));
     pending.push(ack(a,'send-envelope',{roomId,streamId,sequence:index,kind:'media',ciphertext,messageId:crypto.randomUUID()}));
   }
   assert.ok((await Promise.all(pending)).every(r=>r.ok));
   const messageId=crypto.randomUUID();
   const received=new Promise(resolve=>{const handler=data=>{if(data.messageId===messageId){b.off('receive-envelope',handler);resolve();}};b.on('receive-envelope',handler);});
   assert.equal((await ack(a,'send-envelope',{roomId,kind:'control',ciphertext:Buffer.alloc(32),messageId})).ok,true);await received;
 }
 assert.deepEqual(sequence,Array.from({length:24},(_,i)=>i));assert.equal(controls,6);
 assert.ok((await Promise.all(receiptPromises)).every(r=>r.ok));
});
