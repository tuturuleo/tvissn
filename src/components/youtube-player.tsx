import { useEffect, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, Play, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { loadYoutube } from '@/lib/youtube';
import { positionAt, type Playback } from '../../server/protocol';

interface Props {
  state:Playback; connected:boolean; serverNow:()=>number;
  onCommand:(c:{type:'play'|'pause'|'seek'|'rate'|'ended';position?:number;rate?:number})=>void;
  onStatus:(status:string)=>void; onMetrics:(m:{position:number;duration:number;drift:number;title:string;rates:number[]})=>void;
  playerRef:React.RefObject<YT.Player|null>; resyncKey:number;
}
export function YoutubePlayer(props:Props) {
  const node=useRef<HTMLDivElement>(null);
  const current=useRef(props);current.current=props;
  const ready=useRef(false), applied=useRef(''), ignoreUntil=useRef(0),last=useRef({position:0,time:0});
  const [error,setError]=useState(''),[loading,setLoading]=useState(true),[blocked,setBlocked]=useState(false),[retry,setRetry]=useState(0);
  const force=useRef(false), failed=useRef(false), autoplayBlocked=useRef(false);
  useEffect(()=>{
    let disposed=false;
    ready.current=false;applied.current='';failed.current=false;autoplayBlocked.current=false;setError('');setLoading(true);setBlocked(false);
    current.current.onStatus('connecting');
    const div=document.createElement('div');node.current?.replaceChildren(div);
    void loadYoutube().then(()=>{
      if(disposed)return;
      const p=new YT.Player(div,{width:'100%',height:'100%',videoId:current.current.state.videoId!,playerVars:{origin:location.origin,playsinline:1,rel:0,autoplay:0},events:{
        onReady:()=>{if(disposed)return;ready.current=true;ignoreUntil.current=Date.now()+1800;setLoading(false);current.current.onStatus('ready');apply(true);},
        onStateChange:e=>{
          if(disposed)return;
          const c=current.current;
          if(e.data===YT.PlayerState.BUFFERING){c.onStatus('buffering');return;}
          if(e.data===YT.PlayerState.PLAYING){autoplayBlocked.current=false;setBlocked(false);c.onStatus('ready');}
          if(e.data===YT.PlayerState.PAUSED||e.data===YT.PlayerState.CUED)c.onStatus('ready');
          if(!c.connected||Date.now()<ignoreUntil.current)return;
          if(e.data===YT.PlayerState.PLAYING&&!c.state.playing)c.onCommand({type:'play'});
          if(e.data===YT.PlayerState.PAUSED&&c.state.playing)c.onCommand({type:'pause'});
          if(e.data===YT.PlayerState.ENDED)c.onCommand({type:'ended',position:p.getCurrentTime()});
        },
        onPlaybackRateChange:e=>{if(!disposed&&current.current.connected&&Date.now()>ignoreUntil.current&&e.data!==current.current.state.rate)current.current.onCommand({type:'rate',rate:e.data});},
        onAutoplayBlocked:()=>{if(!disposed){autoplayBlocked.current=true;setBlocked(true);current.current.onStatus('connecting');}},
        onError:e=>{if(disposed)return;failed.current=true;setLoading(false);current.current.onStatus('error');setError(({2:'Некорректная ссылка на видео.',5:'Браузеру не удалось воспроизвести видео.',100:'Видео удалено или доступно только автору.',101:'YouTube не разрешил просмотр на этой странице. Проверьте сообщение в плеере или выберите другой ролик.',150:'YouTube не разрешил просмотр на этой странице. Проверьте сообщение в плеере или выберите другой ролик.',153:'YouTube не подтвердил адрес сайта. Попробуйте перезагрузить страницу.'} as Record<number,string>)[e.data]||'Видео недоступно. Проверьте доступ к YouTube или выберите другой ролик.');},
      }});
      current.current.playerRef.current=p;
    }).catch(e=>{if(!disposed){setError(e.message);setLoading(false);current.current.onStatus('error');}});
    function apply(hard=false){
      const c=current.current,p=c.playerRef.current;
      if(!ready.current||!p||failed.current)return;
      const key=`${c.state.mediaRevision}:${c.state.revision}`;
      const target=positionAt(c.state,c.serverNow());
      const pos=p.getCurrentTime()||0;
      const mustSeek=hard || Math.abs(pos-target)>.8;
      if(mustSeek){ignoreUntil.current=Date.now()+1800;p.seekTo(target,true);last.current={position:target,time:Date.now()};}
      if(p.getPlaybackRate()!==c.state.rate){ignoreUntil.current=Date.now()+1800;p.setPlaybackRate(c.state.rate);}
      const playing=p.getPlayerState();
      if(c.state.playing&&playing!==1&&playing!==3&&!autoplayBlocked.current){ignoreUntil.current=Date.now()+1800;p.playVideo();}
      if(!c.state.playing&&playing!==2&&playing!==5){ignoreUntil.current=Date.now()+1800;p.pauseVideo();}
      applied.current=key;
    }
    const tick=setInterval(()=>{
      const c=current.current,p=c.playerRef.current;if(!ready.current||!p||failed.current)return;
      const pos=p.getCurrentTime()||0,duration=p.getDuration()||0,now=Date.now();
      const target=positionAt(c.state,c.serverNow());
      c.onMetrics({position:pos,duration,drift:pos-target,title:p.getVideoData().title||'',rates:p.getAvailablePlaybackRates()||[1]});
      if(!c.connected){if(p.getPlayerState()===1){ignoreUntil.current=now+1800;p.pauseVideo();}last.current={position:pos,time:now};return;}
      const elapsed=(now-last.current.time)/1000;
      const jumped=last.current.time>0 && Math.abs(pos-last.current.position-(p.getPlayerState()===1?elapsed*c.state.rate:0))>1.5;
      if(jumped&&now>ignoreUntil.current){ignoreUntil.current=now+1400;c.onCommand({type:'seek',position:pos});last.current={position:pos,time:now};return;}
      last.current={position:pos,time:now};
      if(applied.current!==`${c.state.mediaRevision}:${c.state.revision}`||force.current){apply(force.current);force.current=false;}
      else if(now>ignoreUntil.current && Math.abs(pos-target)>1 && p.getPlayerState()!==3 && !autoplayBlocked.current)apply();
    },500);
    return()=>{disposed=true;clearInterval(tick);ready.current=false;current.current.playerRef.current?.destroy();current.current.playerRef.current=null;};
  },[props.state.videoId,props.state.mediaRevision,retry]);
  useEffect(()=>{force.current=true;},[props.resyncKey]);
  // Errors and loading are displayed outside the iframe; YouTube controls remain unobscured.
  return <><div className="player-surface" ref={node} />
    {loading&&<div className="player-notice" role="status"><LoaderCircle className="size-4 animate-spin"/>Подключаем YouTube…</div>}
    {error&&<div className="player-notice text-destructive" role="alert"><AlertCircle className="size-4 shrink-0"/><span>{error}</span><Button variant="outline" size="sm" onClick={()=>setRetry(n=>n+1)}><RefreshCw/>Повторить</Button></div>}
    {blocked&&!error&&<div className="player-notice" role="status"><span>Браузеру нужно разрешение на воспроизведение.</span><Button size="sm" onClick={()=>{autoplayBlocked.current=false;props.playerRef.current?.playVideo();setBlocked(false);force.current=true;}}><Play/>Подключиться к просмотру</Button></div>}
  </>;
}
