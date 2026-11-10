export type Mapped = { address: string; port: number; server: string };
export function judgeNat(mapped: Mapped[]) {
 if(!mapped.length)return "no-public-address";
 // Chrome drops a server-reflexive candidate equal to an existing one, so two STUN servers reporting
 // different ports for one public address mean the NAT maps per destination (symmetric): direct P2P needs TURN.
 for(const address of new Set(mapped.map(m=>m.address))){
  const list=mapped.filter(m=>m.address===address),servers=new Set(list.map(m=>m.server));
  if(servers.size>1&&servers.size===list.length&&new Set(list.map(m=>m.port)).size>1)return "symmetric";
 }
 return "likely-ok";
}
