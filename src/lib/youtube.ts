let loading: Promise<void> | null = null;
export function loadYoutube(): Promise<void> {
  if(window.YT?.Player) return Promise.resolve();
  if(loading) return loading;
  loading=new Promise((resolve,reject)=>{
    const timeout=window.setTimeout(()=>{loading=null;reject(new Error('YouTube не ответил. Проверьте доступ к YouTube и повторите попытку.'));},20000);
    window.onYouTubeIframeAPIReady=()=>{clearTimeout(timeout);resolve();};
    document.querySelector('script[data-youtube-api]')?.remove();
    const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';script.dataset.youtubeApi='true';
    script.onerror=()=>{clearTimeout(timeout);loading=null;reject(new Error('Не удалось загрузить YouTube. Проверьте соединение.'));};
    document.head.appendChild(script);
  });
  return loading;
}
export function formatTime(s: number) {
  const n=Math.max(0,Math.floor(s||0));
  return n>=3600?`${Math.floor(n/3600)}:${String(Math.floor(n/60)%60).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`:`${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;
}
