import { z } from "zod";
import { applyCommand, commandSchema, type Playback, type Participant, type Snapshot } from "../../shared/protocol";
const name = z.string().trim().min(1).max(32).refine(s => !/[\p{C}]/u.test(s));
export const participantSchema = z.object({ id: z.string().uuid(), name, status: z.enum(["ready", "buffering", "connecting", "error"]) });
const playbackSchema = z.object({ videoId: z.string().nullable(), externalUrl: z.string().max(2048).url().nullable().optional(), mediaRevision: z.number().int().nonnegative(), position: z.number().finite().min(0).max(604800), playing: z.boolean(), rate: z.number().refine(n => [0.25,0.5,0.75,1,1.25,1.5,1.75,2].includes(n)), anchor: z.number().finite(), revision: z.number().int().nonnegative(), updatedBy: z.string().max(32).nullable() });
export const wireSchema = z.discriminatedUnion("type", [
  z.object({type:z.literal("hello"),person:participantSchema}),
  z.object({type:z.literal("status"),status:participantSchema.shape.status}),
  z.object({type:z.literal("command"),command:commandSchema}),
  z.object({type:z.literal("ack"),id:z.string().uuid(),error:z.string().max(300).optional()}),
  z.object({type:z.literal("snapshot"),snapshot:z.object({epoch:z.string().uuid(),serverTime:z.number().finite(),playback:playbackSchema,participants:z.array(participantSchema).max(2)})}),
  z.object({type:z.literal("ping"),at:z.number().finite()}),
  z.object({type:z.literal("pong"),at:z.number().finite(),now:z.number().finite()}),
]);
export class LocalRoom {
  epoch = crypto.randomUUID();
  playback: Playback = {videoId:null, externalUrl:null, mediaRevision:0, position:0, playing:false, rate:1, anchor:Date.now(), revision:0, updatedBy:null};
  private seen = new Map<string, string | undefined>();
  constructor(public self: Participant) {}
  apply(input: unknown, person: Participant) {
    const c = commandSchema.parse(input);
    if (this.seen.has(c.commandId)) { const error=this.seen.get(c.commandId); if(error) throw new Error(error); return; }
    try { this.playback = applyCommand(this.playback,c,person.name,Date.now()); this.seen.set(c.commandId,undefined); }
    catch(e) { const error=(e as Error).message; this.seen.set(c.commandId,error); throw e; }
    finally { if(this.seen.size>256) this.seen.delete(this.seen.keys().next().value!); }
  }
  snapshot(peer:Participant|null):Snapshot { return {epoch:this.epoch,serverTime:Date.now(),playback:this.playback,participants:peer?[this.self,peer]:[this.self]}; }
  pause() { const now=Date.now(); const s=this.playback; this.playback={...s,position:Math.min(604800,s.position+(s.playing?Math.max(0,now-s.anchor)/1000*s.rate:0)),anchor:now,playing:false,revision:s.revision+1}; }
}
