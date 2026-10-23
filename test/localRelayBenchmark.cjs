// Local synthetic measurements only; no real Tor or end-to-end device claims.
const { startServer } = require('./serverFixture.cjs');
const { io } = require('socket.io-client');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const ack = (s, e, data) => data === undefined ? s.timeout(4000).emitWithAck(e) : s.timeout(4000).emitWithAck(e, data);
function event(s, name) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(name)), 4000); s.once(name, v => { clearTimeout(timer); resolve(v); }); }); }
(async () => {
  const server = await startServer(); const sockets = [];
  try {
    for (let i=0;i<2;i++) { const s=io(server.url,{transports:['websocket'],reconnection:false}); sockets.push(s); await event(s,'joined'); }
    const [a,b]=sockets; await ack(a,'find-random',{}); const matched=event(a,'matched'); await ack(b,'find-random',{}); await matched;
    const keyBundle=Buffer.concat([Buffer.from([7]),crypto.randomBytes(128)]).toString('base64');
    for(const s of sockets) { await ack(s,'key-exchange',{keyBundle,protocolVersion:7}); await ack(s,'key-confirm',{proof:'AAAA'}); }
    for(const s of sockets) await ack(s,'secure-channel-ready');
    const acks=[], deliveries=[];
    for(let batch=0;batch<5;batch++) {
      if(batch) await new Promise(r=>setTimeout(r,1100));
      for(let n=0;n<25;n++) {
        const start=performance.now();
        const received=event(b,'receive-encrypted').then(()=>deliveries.push(performance.now()-start));
        const result=await ack(a,'send-encrypted',{messageId:crypto.randomUUID(),encrypted:Buffer.alloc(256).toString('base64')});
        if(!result.ok) throw new Error('Benchmark rejected: '+result.error);
        acks.push(performance.now()-start); await received;
      }
    }
    const summarize=a=>{a.sort((x,y)=>x-y);return {samples:a.length,medianMs:a[Math.floor(a.length*.5)],p95Ms:a[Math.floor(a.length*.95)]};};
    const result={environment:'Windows local loopback; synthetic v7 WebSocket; 256 ciphertext bytes; 5 batches of 25',node:process.version,ack:summarize(acks),delivery:summarize(deliveries),notes:'Includes local client/network/event-loop time; not pure server duration or real Tor latency.'};
    fs.mkdirSync('benchmarks',{recursive:true}); fs.writeFileSync(process.argv[2]||'benchmarks/phase3-baseline.json',JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify(result));
  } finally { sockets.forEach(s=>s.disconnect()); server.stop(); }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
