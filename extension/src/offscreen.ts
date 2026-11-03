import { decodePairing, encodePairing } from "./pairing";
import { LocalRoom, participantSchema, wireSchema } from "./room";
import type { Participant, Snapshot } from "../../shared/protocol";
let pc:RTCPeerConnection|null=null, channel:RTCDataChannel|null=null, room:LocalRoom|null=null;
let peer:Participant|null=null, coordinator=false, pair="", expires=0, code="", error="", phase="idle", offset=0, ping:number|null=null, latest:Snapshot|null=null;
let generation=0, received=Date.now(), hello=false;
const pending=new Map<string,{resolve:()=>void,reject:(e:Error)=>void,timer:ReturnType<typeof setTimeout>}>();
function state(){return {phase,code,error,connected:hello&&channel?.readyState==="open",coordinator,ping,clockOffset:offset,person:room?.self||null,snapshot:latest};}
function notify(){void chrome.runtime.sendMessage({target:"background",type:"PEER_EVENT",state:state()}).catch(()=>{});}
function send(message:unknown){if(channel?.readyState!=="open")throw new Error("Нет P2P-соединения.");if(channel.bufferedAmount>262144)throw new Error("Соединение перегружено.");channel.send(JSON.stringify(message));}
function publish(){if(!room||!coordinator)return;latest=room.snapshot(peer);if(hello)send({type:"snapshot",snapshot:latest});notify();}
function close(reason=""){
 generation++; hello=false; channel?.close();pc?.close();channel=null;pc=null;peer=null;code="";offset=0;ping=null;
 for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error("Соединение закрыто."));}pending.clear();
 room?.pause();if(room&&coordinator)latest=room.snapshot(null);phase=reason?"disconnected":"idle";error=reason;notify();
}
function lost(){if(phase==="disconnected"||phase==="idle")return;close("Связь прервана. Создайте новое подключение и обменяйтесь кодами.");}
function bind(ch:RTCDataChannel,gen:number){
 channel=ch;
 ch.onopen=()=>{if(gen!==generation)return;phase="connected";received=Date.now();send({type:"hello",person:room!.self});notify();};
 ch.onclose=()=>{if(gen===generation)lost();};ch.onerror=()=>{if(gen===generation)lost();};
 ch.onmessage=event=>{
  if(gen!==generation)return;
  try{
   if(typeof event.data!=="string"||event.data.length>65536)throw new Error("Некорректное сообщение.");
   const m=wireSchema.parse(JSON.parse(event.data));received=Date.now();
   if(m.type==="hello"){
    if(hello||m.person.id===room!.self.id)throw new Error("Некорректное рукопожатие.");
    peer=m.person;hello=true;code="";error="";phase="connected";
    if(coordinator)publish();else notify();return;
   }
   if(!hello)throw new Error("Рукопожатие не завершено.");
   if(m.type==="ping"){send({type:"pong",at:m.at,now:Date.now()});return;}
   if(m.type==="pong"){const r=Date.now()-m.at;if(r>=0&&r<10000){ping=r;if(!coordinator)offset=m.now-(m.at+Date.now())/2;}notify();return;}
   if(m.type==="snapshot"){
    if(coordinator)throw new Error("Недопустимое состояние.");
    const url=m.snapshot.playback.externalUrl;if(url&&!/^https?:\/\//.test(url))throw new Error("Недопустимая ссылка.");
    if(!latest||latest.epoch!==m.snapshot.epoch||m.snapshot.playback.revision>=latest.playback.revision)latest=m.snapshot;
    notify();return;
   }
   if(m.type==="command"){
    if(!coordinator)throw new Error("Недопустимая команда.");
    let failure:string|undefined;
    try{room!.apply(m.command,peer!);}catch(e){failure=(e as Error).message;}
    send({type:"ack",id:m.command.commandId,error:failure});publish();return;
   }
   if(m.type==="ack"){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve();}return;}
   if(m.type==="status"){peer!.status=m.status;if(coordinator)publish();}
  }catch{close("Ошибка протокола P2P. Создайте новое подключение.");}
 };
}
async function start(name:string,offer?:string){
 const person=participantSchema.parse({id:crypto.randomUUID(),name:name.trim(),status:"connecting"});
 const imported=offer?decodePairing(offer,"offer"):null;
 close();const gen=generation;coordinator=!imported;room=new LocalRoom(person);latest=coordinator?room.snapshot(null):null;
 pair=imported?.pair||crypto.randomUUID();expires=imported?.expires||Date.now()+30*60000;error="";phase="gathering";notify();
 const connection=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"},{urls:"stun:stun.cloudflare.com:3478"}],iceCandidatePoolSize:0});pc=connection;
 connection.ondatachannel=e=>{if(gen!==generation){e.channel.close();return;}if(channel||e.channel.label!=="tvissn-v1"){e.channel.close();return;}bind(e.channel,gen);};
 connection.onconnectionstatechange=()=>{if(gen!==generation)return;if(connection.connectionState==="failed"||connection.connectionState==="closed")lost();};
 try{
  if(imported){await connection.setRemoteDescription({type:"offer",sdp:imported.sdp});await connection.setLocalDescription(await connection.createAnswer());}
  else {bind(connection.createDataChannel("tvissn-v1",{ordered:true}),gen);await connection.setLocalDescription(await connection.createOffer());}
  await new Promise<void>(resolve=>{if(connection.iceGatheringState==="complete"){resolve();return;}const done=()=>{clearTimeout(timer);connection.removeEventListener("icegatheringstatechange",change);resolve();};const change=()=>{if(connection.iceGatheringState==="complete")done();};const timer=setTimeout(done,12000);connection.addEventListener("icegatheringstatechange",change);});
  if(gen!==generation)throw new Error("Создание подключения отменено.");
  code=encodePairing({v:1,kind:imported?"answer":"offer",pair,expires,sdp:connection.localDescription!.sdp});
  if(!hello)phase=imported?"answer":"offer";notify();return state();
 }catch(e){if(gen===generation)close((e as Error).message);throw e;}
}
async function command(input:unknown){
 if(!room||!hello)throw new Error("Сначала подключите друга.");
 if(coordinator){room.apply(input,room.self);publish();return;}
 const m=wireSchema.parse({type:"command",command:input});if(m.type!=="command")return;
 return new Promise<void>((resolve,reject)=>{
  const id=m.command.commandId;const timer=setTimeout(()=>{pending.delete(id);reject(new Error("Друг не подтвердил команду. Состояние будет обновлено."));},8000);
  pending.set(id,{resolve,reject,timer});try{send(m);}catch(e){clearTimeout(timer);pending.delete(id);reject(e);}
 });
}
setInterval(()=>{
 if(!pc)return;
 if(!hello&&Date.now()>expires){close("Код устарел. Создайте новое подключение.");return;}
 if(hello){if(Date.now()-received>20000){lost();return;}try{send({type:"ping",at:Date.now()});if(coordinator)publish();}catch{lost();}}
 else notify();
},3000);
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(message.target!=="peer"||sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL("background.js")){
  // Service-worker messages may omit sender.url; tab/content-script callers are never trusted.
  if(message.target!=="peer"||sender.id!==chrome.runtime.id||sender.tab||sender.url) return;
 }
 void (async()=>{
  switch(message.type){
   case "STATE":return state();
   case "CREATE":return start(message.name);
   case "JOIN":return start(message.name,message.code);
   case "ANSWER":{const a=decodePairing(message.code,"answer");if(!pc||!coordinator||a.pair!==pair||phase!=="offer")throw new Error("Ответ относится к другому подключению.");await pc.setRemoteDescription({type:"answer",sdp:a.sdp});phase="connecting";code="";notify();return state();}
   case "COMMAND":await command(message.command);return state();
   case "STATUS":if(room){room.self.status=participantSchema.shape.status.parse(message.status);if(hello){if(coordinator)publish();else send({type:"status",status:room.self.status});}}return state();
   case "CLOSE":close();room=null;latest=null;notify();return state();
   default:throw new Error("Неизвестное действие.");
  }
 })().then(result=>reply({ok:true,result})).catch(e=>reply({ok:false,error:(e as Error).message}));return true;
});
