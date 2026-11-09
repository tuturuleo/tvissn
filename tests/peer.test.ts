import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {encodePairing,decodePairing} from '../extension/src/pairing';
import {LocalRoom} from '../extension/src/room';
const person=(name:string)=>({id:crypto.randomUUID(),name,status:'ready' as const});
test('pairing codes validate type, expiry and corruption; room deduplicates equal-right commands',()=>{
 const offer={v:1 as const,kind:'offer' as const,pair:crypto.randomUUID(),expires:Date.now()+60000,sdp:'example'};
 assert.deepEqual(decodePairing(encodePairing(offer),'offer'),offer);
 assert.throws(()=>decodePairing(encodePairing(offer),'answer'));
 assert.throws(()=>decodePairing(encodePairing({...offer,expires:Date.now()-11*60000})));
 assert.deepEqual(decodePairing(encodePairing({...offer,expires:Date.now()-60000})).kind,'offer');
 assert.throws(()=>decodePairing(encodePairing({...offer,expires:Date.now()+45*60000})));
 assert.throws(()=>decodePairing('tvissn-p2p:bad'));
 const a=person('A'),b=person('B'),room=new LocalRoom(a);
 const load={type:'loadExternal',commandId:crypto.randomUUID(),url:'https://example.com/watch'};
 room.apply(load,b);room.apply(load,b);assert.equal(room.playback.mediaRevision,1);
 room.apply({type:'play',commandId:crypto.randomUUID(),mediaRevision:1},a);
 room.apply({type:'seek',commandId:crypto.randomUUID(),mediaRevision:1,position:50},b);
 assert.equal(room.playback.position,50);assert.equal(room.playback.updatedBy,'B');
 assert.throws(()=>room.apply({type:'seek',commandId:crypto.randomUUID(),mediaRevision:0,position:0},a));
});
// Exercise both complete offscreen runtimes with an in-memory RTC transport, including the Chrome RPC boundary.
test('two offscreen peers exchange codes, commands and snapshots independently of popup; disconnect fails closed',async()=>{
 class Channel {
  label='tvissn-v1';readyState='connecting';bufferedAmount=0;other!:Channel;
  onopen:any;onmessage:any;onclose:any;onerror:any;
  send(data:string){queueMicrotask(()=>this.other.onmessage?.({data}));}
  close(){if(this.readyState==='closed')return;this.readyState='closed';queueMicrotask(()=>this.onclose?.());if(this.other&&this.other.readyState!=='closed')this.other.close();}
 }
 const pcs=new Map<string,PC>();
 class PC {
  id=crypto.randomUUID();localDescription:any;remote:any;iceGatheringState='complete';connectionState='new';ondatachannel:any;onconnectionstatechange:any;channel?:Channel;
  constructor(){pcs.set(this.id,this);}
  createDataChannel(){return this.channel=new Channel();}
  async createOffer(){return {type:'offer',sdp:this.id};}
  async createAnswer(){return {type:'answer',sdp:this.id};}
  async setLocalDescription(d:any){this.localDescription=d;}
  async setRemoteDescription(d:any){this.remote=d;if(d.type==='answer'){
   const other=pcs.get(d.sdp)!;const ch=new Channel();other.channel=ch;this.channel!.other=ch;ch.other=this.channel!;
   other.ondatachannel({channel:ch});setTimeout(()=>{this.channel!.readyState=ch.readyState='open';this.channel!.onopen?.();ch.onopen?.();},0);
  }}
  close(){this.channel?.close();this.connectionState='closed';}
 }
 const bundle=(await build({entryPoints:['extension/src/offscreen.ts'],bundle:true,format:'iife',write:false,platform:'browser'})).outputFiles[0].text;
 const timers:any[]=[];
 // In-memory ntfy: POST appends to a topic, GET /json streams its history and then live messages.
 const topics=new Map<string,{list:string[],live:Set<(line:string)=>void>}>();
 const topicOf=(name:string)=>{let t=topics.get(name);if(!t)topics.set(name,t={list:[],live:new Set()});return t;};
 let posted=0;
 const fetch=async(url:string,init:any={})=>{
  const u=new URL(url);assert.equal(u.origin,'https://relay.test');
  if(init.method==='POST'){posted++;const t=topicOf(u.pathname.slice(1));const line=JSON.stringify({id:crypto.randomUUID(),event:'message',message:init.body})+'\n';t.list.push(line);for(const f of t.live)f(line);return new Response('{}');}
  const t=topicOf(u.pathname.slice(1,-5));let push:(l:string)=>void;
  const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(JSON.stringify({event:'open'})+'\n'));for(const l of t.list)c.enqueue(new TextEncoder().encode(l));push=l=>c.enqueue(new TextEncoder().encode(l));t.live.add(push);init.signal?.addEventListener('abort',()=>{t.live.delete(push);try{c.error(new Error('aborted'));}catch{}});}});
  return new Response(body);
 };
 const create=()=>{
  let listener:any;let last:any;
  const chrome={runtime:{id:'test',getURL:(p:string)=>'chrome-extension://test/'+p,onMessage:{addListener:(fn:any)=>{listener=fn;}},sendMessage:async(m:any)=>{last=m.state;}}};
  runInNewContext(bundle,{chrome,RTCPeerConnection:PC,crypto,TextEncoder,TextDecoder,TextDecoderStream,ReadableStream,Response,Blob,CompressionStream,DecompressionStream,AbortController,queueMicrotask,fetch,btoa,atob,URL,console,setTimeout,clearTimeout,setInterval:(fn:any,ms:number)=>{const t=setInterval(fn,ms);timers.push(t);return t;},clearInterval});
  return {rpc:(type:string,data:any={})=>new Promise<any>((resolve,reject)=>listener({target:'peer',type,...data},{id:'test',url:'chrome-extension://test/background.js'},(r:any)=>r.ok?resolve(r.result):reject(Error(r.error)))),get state(){return last;}};
 };
 const a=create(),b=create();
 try{
  const offer=await a.rpc('CREATE',{name:'Alice'});assert.equal(offer.phase,'offer');
  const answer=await b.rpc('JOIN',{name:'Bob',code:offer.code});assert.equal(answer.phase,'answer');
  await assert.rejects(a.rpc('ANSWER',{code:encodePairing({...decodePairing(answer.code),pair:crypto.randomUUID()})}));
  await a.rpc('ANSWER',{code:answer.code});await new Promise(r=>setTimeout(r,30));
  assert.equal(a.state.connected,true);assert.equal(b.state.connected,true);assert.equal(b.state.snapshot.participants.length,2);
  await b.rpc('COMMAND',{command:{type:'loadExternal',commandId:crypto.randomUUID(),url:'https://example.com/watch'}});
  await a.rpc('COMMAND',{command:{type:'play',commandId:crypto.randomUUID(),mediaRevision:1}});
  await b.rpc('COMMAND',{command:{type:'seek',commandId:crypto.randomUUID(),mediaRevision:1,position:15}});
  await new Promise(r=>setTimeout(r,10));assert.equal(a.state.snapshot.playback.position,15);assert.equal(b.state.snapshot.playback.playing,true);
  await a.rpc('CLOSE');await new Promise(r=>setTimeout(r,10));assert.equal(b.state.connected,false);assert.equal(b.state.phase,'disconnected');assert.equal(b.state.diagnostics.reason,'channel-closed');assert.equal(b.state.diagnostics.everConnected,true);
  await assert.rejects(b.rpc('COMMAND',{command:{type:'pause',commandId:crypto.randomUUID(),mediaRevision:1}}));
  // Relay mode: one short room code replaces the manual answer, and the server only ever sees ciphertext.
  await a.rpc('CREATE',{name:'Alice',server:'relay.test'});
  for(let i=0;i<50&&!a.state.invite;i++)await new Promise(r=>setTimeout(r,10));
  assert.match(a.state.invite,/^tvissn-room:[A-Z0-9-]{14}@relay\.test$/);
  const joined=b.rpc('JOIN',{name:'Bob',code:a.state.invite});
  await joined;for(let i=0;i<50&&!(a.state.connected&&b.state.connected);i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(a.state.connected,true);assert.equal(b.state.connected,true);assert.equal(posted,2);
  for(const t of topics.values())for(const l of t.list)assert.ok(!l.includes('tvissn-p2p')&&!l.includes('Alice'));
 }finally{for(const timer of timers)clearInterval(timer);await a.rpc('CLOSE');await b.rpc('CLOSE');}
});
test('room codes round-trip, reject foreign servers and keep relay payloads encrypted',async()=>{
 const {newRoom,encodeRoom,decodeRoom,seal,unseal,normalizeServer}=await import('../extension/src/relay');
 const room=newRoom('ntfy.sh/');assert.equal(room.server,'https://ntfy.sh');
 assert.deepEqual(decodeRoom(encodeRoom(room).toLowerCase()),room);
 assert.throws(()=>normalizeServer('http://ntfy.sh'));assert.throws(()=>decodeRoom('tvissn-room:AAAA-0000-AAAA@ntfy.sh'));
 const code=encodePairing({v:1,kind:'offer',pair:crypto.randomUUID(),expires:Date.now()+60000,sdp:'v=0\r\n'.repeat(400)});
 const sealed=await seal(room.secret,code);assert.ok(!sealed.includes('tvissn')&&sealed.length<3900);
 assert.equal(await unseal(room.secret,sealed),code);assert.equal(await unseal(newRoom('ntfy.sh').secret,sealed),null);
});
test('room secrets reject biased bytes and always round-trip',async()=>{
 const {newRoom,encodeRoom,decodeRoom}=await import('../extension/src/relay');
 const original=crypto.getRandomValues;let calls=0;
 try{
  (crypto as any).getRandomValues=<T extends ArrayBufferView>(a:T):T=>{(a as unknown as Uint8Array).fill(calls++?0:255);return a;};
  assert.equal(newRoom('ntfy.sh').secret,'AAAA-AAAA-AAAA');assert.ok(calls>=2);
 }finally{(crypto as any).getRandomValues=original;}
 for(let i=0;i<1000;i++){const room=newRoom('ntfy.sh');assert.match(room.secret,/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);assert.deepEqual(decodeRoom(encodeRoom(room)),room);}
});
test('MQTT relay keeps retained invitations, splits frames and delivers live answers',async()=>{
 const {newRoom,publish,subscribe}=await import('../extension/src/relay');
 // Fake broker speaking MQTT 3.1.1 framing; every reply is delivered byte by byte to exercise reassembly.
 const retained=new Map<string,Uint8Array>(),subs=new Set<any>();
 const frame=(type:number,body:number[]|Uint8Array)=>{const out=[type],b=[...body];let n=b.length;do{let d=n%128;n=Math.floor(n/128);if(n)d|=128;out.push(d);}while(n);return new Uint8Array([...out,...b]);};
 class FakeSocket{static OPEN=1;readyState=0;binaryType='';onopen:any;onmessage:any;onclose:any;onerror:any;filter='';
  constructor(public url:string,public proto:string){assert.equal(proto,'mqtt');setTimeout(()=>{this.readyState=1;this.onopen();},0);}
  deliver(bytes:Uint8Array){for(const b of bytes)this.onmessage({data:new Uint8Array([b]).buffer});}
  send(p:Uint8Array){const type=p[0]>>4;let i=1;while(p[i]&128)i++;const body=p.slice(i+1);
   if(type===1)this.deliver(frame(0x20,[0,0]));
   if(type===8){const len=(body[2]<<8)|body[3];this.filter=new TextDecoder().decode(body.slice(4,4+len)).replace('#','');subs.add(this);this.deliver(frame(0x90,[body[0],body[1],0]));
    for(const [t,m] of retained)if(t.startsWith(this.filter))this.deliver(m);}
   if(type===3){const len=(body[0]<<8)|body[1],topic=new TextDecoder().decode(body.slice(2,2+len));const fwd=frame(0x31,[...body.slice(0,2+len),...body.slice(4+len)]);retained.set(topic,fwd);
    this.deliver(frame(0x40,[body[2+len],body[3+len]]));for(const s of subs)if(topic.startsWith(s.filter))s.deliver(frame(0x30,[...body.slice(0,2+len),...body.slice(4+len)]));}
   if(type===14)this.close();}
  close(){if(this.readyState===3)return;this.readyState=3;subs.delete(this);setTimeout(()=>this.onclose?.(),0);}
 }
 const original=(globalThis as any).WebSocket;(globalThis as any).WebSocket=FakeSocket;
 try{
  const room=newRoom('wss://broker.test/mqtt'),abort=new AbortController(),got:string[]=[];
  await publish(room,'invitation');
  const done=new Promise<void>(resolve=>void subscribe(room,abort.signal,t=>{got.push(t);if(got.length===2)resolve();},e=>assert.fail(e.message)));
  await new Promise(r=>setTimeout(r,20));await publish(room,'answer');await done;abort.abort();
  assert.deepEqual(got,['invitation','answer']);
  for(const m of retained.values())assert.ok(!new TextDecoder().decode(m).includes('invitation'));
 }finally{(globalThis as any).WebSocket=original;}
});
