import { z } from 'zod';
export interface Playback {
  videoId: string | null;
  mediaRevision: number;
  position: number;
  playing: boolean;
  rate: number;
  anchor: number;
  revision: number;
  updatedBy: string | null;
}
export interface Participant { id: string; name: string; status: 'ready' | 'buffering' | 'connecting' | 'error'; }
export interface Snapshot { playback: Playback; participants: Participant[]; serverTime: number; epoch: string; }
export const rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
export const commandSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('load'),commandId:z.string().uuid(),url:z.string().max(2048)}),
  z.object({type:z.enum(['play','pause','seek','rate','ended']), commandId:z.string().uuid(),mediaRevision:z.number().int().nonnegative(),position:z.number().finite().min(0).max(604800).optional(),rate:z.number().refine(n=>rates.includes(n)).optional()}),
]);
export type Command = z.infer<typeof commandSchema>;
export function positionAt(s: Playback, now: number) { return Math.max(0, s.position + (s.playing ? Math.max(0, now-s.anchor)/1000*s.rate : 0)); }
export function parseYoutube(input: string): {videoId: string; position: number} | null {
  try {
    const u = new URL(input.trim());
    if (!['https:','http:'].includes(u.protocol) || u.username || u.password) return null;
    const host=u.hostname.toLowerCase().replace(/^www\./,'');
    let videoId: string | null = null;
    if (host==='youtu.be') videoId=u.pathname.split('/')[1];
    else if (['youtube.com','m.youtube.com','music.youtube.com','youtube-nocookie.com'].includes(host)) {
      const parts=u.pathname.split('/');
      if (u.pathname==='/watch') videoId=u.searchParams.get('v');
      else if (['embed','shorts','live'].includes(parts[1])) videoId=parts[2];
    }
    if (!videoId || !/^[\w-]{11}$/.test(videoId)) return null;
    const raw=u.searchParams.get('t') || u.searchParams.get('start') || u.hash.match(/t=(.+)/)?.[1] || '0';
    let position=0;
    if (/^\d+(\.\d+)?$/.test(raw)) position=Number(raw);
    else if (/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.test(raw)) {
      const m=raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/)!;
      position=Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0);
    }
    return {videoId, position:Math.min(position,604800)};
  } catch { return null; }
}
export function applyCommand(s: Playback, c: Command, name: string, now: number): Playback {
  if(c.type==='load') {
    const parsed=parseYoutube(c.url);
    if(!parsed) throw new Error('Вставьте корректную ссылку на видео YouTube.');
    return {videoId:parsed.videoId,mediaRevision:s.mediaRevision+1,position:parsed.position,playing:false,rate:1,anchor:now,revision:s.revision+1,updatedBy:name};
  }
  if(!s.videoId || c.mediaRevision!==s.mediaRevision) throw new Error('Видео уже изменилось. Состояние обновлено.');
  if(c.type==='rate' && c.rate===undefined) throw new Error('Выберите скорость.');
  if(c.type==='seek' && c.position===undefined) throw new Error('Укажите позицию.');
  if(c.type==='ended' && !s.playing) return s;
  // A client reports ended only near the shared timeline; prevents an old ended event from stopping a seeked video.
  if(c.type==='ended' && (c.position===undefined || Math.abs(c.position-positionAt(s,now))>5)) return s;
  return {...s,position:c.type==='seek'||c.type==='ended'?c.position!:positionAt(s,now),playing:c.type==='play'?true:(c.type==='pause'||c.type==='ended'?false:s.playing),rate:c.type==='rate'?c.rate!:s.rate,anchor:now,revision:s.revision+1,updatedBy:name};
}
