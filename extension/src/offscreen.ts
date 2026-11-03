import { decodePairing, encodePairing } from "./pairing";
import { LocalRoom, participantSchema, wireSchema } from "./room";
import { decodeRoom, encodeRoom, isRoomCode, newRoom, publish as relayPublish, subscribe as relaySubscribe, type Room } from "./relay";
import type { Participant, Snapshot } from "../../shared/protocol";
let pc:RTCPeerConnection|null=null, channel:RTCDataChannel|null=null, room:LocalRoom|null=null;
let peer:Participant|null=null, coordinator=false, pair="", expires=0, deadline=0, code="", error="", notice="", invite="", phase="idle", offset=0, ping:number|null=null, latest:Snapshot|null=null;
let generation=0, received=Date.now(), hello=false, relayAbort:AbortController|null=null;
let diagnostics:Record<string,unknown>={},everConnected=false,checkingSince=0;
// Network facts gathered while connecting; kept separately so a failure snapshot does not erase them.
let net:{nat?:string,srflx?:string[],stunErrors?:number[],gatherMs?:number,iceFailedAfterMs?:number,relay?:string}={};
let mapped:{address:string,port:number,server:string}[]=[];
function judgeNat() {
 if(!mapped.length)return "no-public-address";
 // Chrome drops a server-reflexive candidate equal to an existing one, so two STUN servers reporting
 // different ports for one public address mean the NAT maps per destination (symmetric): direct P2P needs TURN.
 for(const address of new Set(mapped.map(m=>m.address))){
  const list=mapped.filter(m=>m.address===address),servers=new Set(list.map(m=>m.server));
  if(servers.size>1&&servers.size===list.length&&new Set(list.map(m=>m.port)).size>1)return "symmetric";
 }
 return "likely-ok";
}
function describe(reason:string) {
 const count=(sdp:string|undefined)=>{const result={host:0,srflx:0,relay:0};for(const line of (sdp||"").split("\n")){const type=line.match(/ typ (host|srflx|relay)(?: |\r|$)/)?.[1] as keyof typeof result|undefined;if(type)result[type]++;}return result;};
 diagnostics={reason,everConnected,role:coordinator?"offer":"answer",connection:pc?.connectionState,ice:pc?.iceConnectionState,gathering:pc?.iceGatheringState,channel:channel?.readyState,local:count(pc?.localDescription?.sdp),remote:count(pc?.remoteDescription?.sdp),...checkingSince?{afterMs:Date.now()-checkingSince}:{}};
}
const pending=new Map<string,{resolve:()=>void,reject:(e:Error)=>void,timer:ReturnType<typeof setTimeout>}>();
function state(){return {phase,code,invite,error,notice,connected:hello&&channel?.readyState==="open",coordinator,ping,clockOffset:offset,person:room?.self||null,snapshot:latest,diagnostics:{...net,...diagnostics}};}
function notify(){void chrome.runtime.sendMessage({target:"background",type:"PEER_EVENT",state:state()}).catch(()=>{});}
function send(message:unknown){if(channel?.readyState!=="open")throw new Error("Нет P2P-соединения.");if(channel.bufferedAmount>262144)throw new Error("Соединение перегружено.");channel.send(JSON.stringify(message));}
function publish(){if(!room||!coordinator)return;latest=room.snapshot(peer);if(hello)send({type:"snapshot",snapshot:latest});notify();}
function stopRelay(){relayAbort?.abort();relayAbort=null;}
function close(reason=""){
 generation++; hello=false; stopRelay(); channel?.close();pc?.close();channel=null;pc=null;peer=null;code="";invite="";notice="";offset=0;ping=null;checkingSince=0;
 for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error("Соединение закрыто."));}pending.clear();
 room?.pause();if(room&&coordinator)latest=room.snapshot(null);phase=reason?"disconnected":"idle";error=reason;notify();
}
function lost(reason="channel-closed"){
 if(phase==="disconnected"||phase==="idle")return;
 describe(reason);
 const symmetric=net.nat==="symmetric";
 close(!everConnected&&reason==="ice-failed"
 ? symmetric
  ? "Прямой маршрут не установлен: ваш NAT симметричный (часто мобильный или корпоративный интернет). Без TURN такая сеть не соединится; попробуйте другую сеть или VPN."
  : "Прямой маршрут между устройствами не установлен (ICE failed). Если ответный код шёл дольше ~30 секунд, повторите обмен быстрее или включите сервер обмена. Иначе возможны ограничения NAT/UDP."
 : `P2P-соединение закрыто (${reason}). Создайте новое подключение и обменяйтесь кодами.`);
}
function bind(ch:RTCDataChannel,gen:number){
 channel=ch;
 let opened=false;
 // A channel announced through ondatachannel may already be open, so the open event is not guaranteed; run once either way.
 const open=()=>{if(gen!==generation||opened)return;opened=true;phase="connected";received=Date.now();send({type:"hello",person:room!.self});notify();};
 ch.onopen=open;
 ch.onclose=()=>{if(gen===generation)lost("channel-closed");};ch.onerror=()=>{if(gen===generation)lost("channel-error");};
 ch.onmessage=event=>{
  if(gen!==generation)return;
  try{
   if(typeof event.data!=="string"||event.data.length>65536)throw new Error("Некорректное сообщение.");
   const m=wireSchema.parse(JSON.parse(event.data));received=Date.now();
   if(m.type==="hello"){
    if(hello||m.person.id===room!.self.id)throw new Error("Некорректное рукопожатие.");
    peer=m.person;hello=true;everConnected=true;code="";invite="";notice="";error="";phase="connected";stopRelay();
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
  }catch{describe("protocol-error");close("Ошибка протокола P2P. Создайте новое подключение.");}
 };
 if(ch.readyState==="open")queueMicrotask(open);
}
async function start(name:string,offer?:string){
 const person=participantSchema.parse({id:crypto.randomUUID(),name:name.trim(),status:"connecting"});
 const imported=offer?decodePairing(offer,"offer"):null;
 close();diagnostics={};net={};mapped=[];everConnected=false;const gen=generation;coordinator=!imported;room=new LocalRoom(person);latest=coordinator?room.snapshot(null):null;
 // expires travels inside the codes and is checked against the creator's clock; deadline is this device's own limit.
 pair=imported?.pair||crypto.randomUUID();expires=imported?.expires||Date.now()+30*60000;deadline=Date.now()+30*60000;error="";phase="gathering";notify();
 const connection=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"},{urls:"stun:stun.cloudflare.com:3478"}],iceCandidatePoolSize:0});pc=connection;
 connection.ondatachannel=e=>{if(gen!==generation){e.channel.close();return;}if(channel||e.channel.label!=="tvissn-v1"){e.channel.close();return;}bind(e.channel,gen);};
 connection.onconnectionstatechange=()=>{
  if(gen!==generation)return;
  const s=connection.connectionState;
  if(s==="failed"&&!coordinator&&!everConnected){
   // The answering side starts ICE checks as soon as it creates the answer, while the friend may still be pasting it;
   // libwebrtc gives up after ~30s but can revive when the friend's checks arrive, so keep the agent until the deadline.
   net.iceFailedAfterMs??=Date.now()-checkingSince;notify();return;
  }
  if(s==="failed"||s==="closed")lost(s==="failed"?"ice-failed":"connection-closed");
 };
 connection.onicecandidateerror=e=>{net.stunErrors=[...new Set([...(net.stunErrors||[]),e.errorCode])];};
 connection.onicecandidate=e=>{
  const c=e.candidate;if(gen!==generation||c?.type!=="srflx"||!c.address||!c.port)return;
  const server=String((c as {url?:string}).url||(e as {url?:string|null}).url||"?").replace(/^stuns?:/,"").replace(/:\d+$/,"");
  mapped.push({address:c.address,port:c.port,server});
  net.srflx=mapped.map(m=>`${m.server} → :${m.port}`);net.nat=judgeNat();
 };
 try{
  const began=Date.now();
  if(imported){await connection.setRemoteDescription({type:"offer",sdp:imported.sdp});checkingSince=Date.now();await connection.setLocalDescription(await connection.createAnswer());}
  else {bind(connection.createDataChannel("tvissn-v1",{ordered:true}),gen);await connection.setLocalDescription(await connection.createOffer());}
  await new Promise<void>(resolve=>{
   if(connection.iceGatheringState==="complete"){resolve();return;}
   let early:ReturnType<typeof setTimeout>|undefined;
   const done=()=>{clearTimeout(timer);clearTimeout(early);connection.removeEventListener("icegatheringstatechange",change);connection.removeEventListener("icecandidate",found);resolve();};
   const change=()=>{if(connection.iceGatheringState==="complete")done();};
   // A public address is enough; wait a moment longer for the second STUN server so the NAT type can be judged.
   // Full gathering can hang on dead interfaces, and on the answering side every second here is lost from the ICE window.
   const found=(e:RTCPeerConnectionIceEvent)=>{if(e.candidate?.type==="srflx"&&!early)early=setTimeout(done,1200);};
   const timer=setTimeout(done,5000);
   connection.addEventListener("icegatheringstatechange",change);connection.addEventListener("icecandidate",found);
  });
  net.gatherMs=Date.now()-began;net.nat=judgeNat();
  if(gen!==generation)throw new Error("Создание подключения отменено.");
  code=hello?"":encodePairing({v:1,kind:imported?"answer":"offer",pair,expires,sdp:connection.localDescription!.sdp});
  if(!hello)phase=imported?"answer":"offer";notify();return state();
 }catch(e){if(gen===generation)close((e as Error).message);throw e;}
}
async function applyAnswer(text:string){
 const a=decodePairing(text,"answer");
 if(!pc||!coordinator||a.pair!==pair||phase!=="offer")throw new Error("Ответ относится к другому подключению.");
 phase="connecting";stopRelay();
 try{await pc.setRemoteDescription({type:"answer",sdp:a.sdp});}catch(e){phase="offer";throw e;}
 checkingSince=Date.now();code="";invite="";notify();
}
function relayFailed(e:Error){net.relay=e.message;notice="Сервер обмена недоступен: "+e.message+" Можно обменяться кодами вручную.";notify();}
async function create(name:string,server?:string){
 const result=await start(name);
 if(!server||hello)return result;
 const gen=generation,offerCode=code,r=newRoom(server),abort=new AbortController();relayAbort=abort;
 net.relay=r.server;
 void relaySubscribe(r,abort.signal,text=>{
  if(gen!==generation||phase!=="offer")return;
  try{if(decodePairing(text,"answer").pair!==pair)return;}catch{return;}
  void applyAnswer(text).catch(e=>{notice=(e as Error).message;notify();});
 },relayFailed);
 // The room code is shown only once the invitation is stored, so a friend can never look for it too early.
 try{await relayPublish(r,offerCode);if(gen===generation&&phase==="offer"){invite=encodeRoom(r);notify();}}catch(e){if(gen===generation)relayFailed(e as Error);}
 return state();
}
async function joinRoom(name:string,text:string){
 const r=decodeRoom(text);
 close();const gen=generation,abort=new AbortController();relayAbort=abort;phase="joining";net={relay:r.server};notify();
 const offerCode=await new Promise<string>((resolve,reject)=>{
  const timer=setTimeout(()=>{abort.abort();reject(new Error("Приглашение не найдено на сервере обмена. Проверьте код или попросите друга создать новый."));},120000);
  abort.signal.addEventListener("abort",()=>{clearTimeout(timer);reject(new Error("Подключение отменено."));},{once:true});
  void relaySubscribe(r,abort.signal,t=>{try{decodePairing(t,"offer");}catch{return;}clearTimeout(timer);resolve(t);abort.abort();},e=>{if(gen===generation){net.relay=e.message;notice="Сервер обмена недоступен: "+e.message;notify();}});
 }).catch(e=>{if(gen===generation)close((e as Error).message);throw e;});
 if(gen!==generation)throw new Error("Подключение отменено.");
 const result=await start(name,offerCode);
 if(hello)return result;
 const g=generation;
 try{await relayPublish(r,code);invite=text.trim();notice="";}catch(e){if(g===generation){net.relay=(e as Error).message;notice="Не удалось отправить ответ через сервер обмена: "+(e as Error).message+" Отправьте ответный код другу вручную.";}}
 notify();return state();
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
 if(!hello&&Date.now()>deadline){close("Код устарел. Создайте новое подключение.");return;}
 if(hello){if(Date.now()-received>60000){lost("heartbeat-timeout");return;}try{send({type:"ping",at:Date.now()});if(coordinator)publish();}catch{lost("send-error");}}
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
   case "CREATE":return create(message.name,typeof message.server==="string"&&message.server?message.server:undefined);
   case "JOIN":return isRoomCode(message.code)?joinRoom(message.name,message.code):start(message.name,message.code);
   case "ANSWER":await applyAnswer(message.code);return state();
   case "COMMAND":await command(message.command);return state();
   case "STATUS":if(room){room.self.status=participantSchema.shape.status.parse(message.status);if(hello){if(coordinator)publish();else send({type:"status",status:room.self.status});}}return state();
   case "CLOSE":close();room=null;latest=null;notify();return state();
   default:throw new Error("Неизвестное действие.");
  }
 })().then(result=>reply({ok:true,result})).catch(e=>reply({ok:false,error:(e as Error).message}));return true;
});
