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
 assert.throws(()=>decodePairing(encodePairing({...offer,expires:Date.now()-1})));
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
 const create=()=>{
  let listener:any;let last:any;
  const chrome={runtime:{id:'test',getURL:(p:string)=>'chrome-extension://test/'+p,onMessage:{addListener:(fn:any)=>{listener=fn;}},sendMessage:async(m:any)=>{last=m.state;}}};
  runInNewContext(bundle,{chrome,RTCPeerConnection:PC,crypto,TextEncoder,TextDecoder,btoa,atob,URL,console,setTimeout,clearTimeout,setInterval:(fn:any,ms:number)=>{const t=setInterval(fn,ms);timers.push(t);return t;},clearInterval});
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
  await a.rpc('CLOSE');await new Promise(r=>setTimeout(r,10));assert.equal(b.state.connected,false);assert.equal(b.state.phase,'disconnected');
  await assert.rejects(b.rpc('COMMAND',{command:{type:'pause',commandId:crypto.randomUUID(),mediaRevision:1}}));
 }finally{for(const timer of timers)clearInterval(timer);await a.rpc('CLOSE');await b.rpc('CLOSE');}
});
