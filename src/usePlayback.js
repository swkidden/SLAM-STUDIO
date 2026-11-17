import {useEffect} from 'react';
import {frameAt,frameUrl} from './model';

export function usePlayback({playing,data,current,frameCache,setTime,setPlaying,setBuffering}){
  useEffect(()=>{
    if(!playing||!data||data.live)return;
    let cancelled=false,previous=performance.now();
    const tick=async now=>{
      if(cancelled)return;
      const c=current.current;
      let next=c.time+Math.min(.1,(now-previous)/1000)*c.settings.rate;previous=now;
      if(next>c.range[1]){
        if(c.settings.loop)next=c.range[0];else{setTime(c.range[1]);setPlaying(false);return;}
      }
      const streams=data.cameras.map((cam,i)=>({...cam,index:i})).filter(cam=>cam.role==='diagnostic');
      const diagnostic=streams.find(cam=>cam.index===c.settings.diagnosticCamera)?.index??streams[0]?.index;
      const showDiagnostic=c.settings.inspectionView==='diagnostics'&&diagnostic!==undefined;
      const ready=data.cameras.map((cam,i)=>{
        const visible=(c.settings.camera==='video-follow'&&i===c.settings.imageCamera)||
          (showDiagnostic?i===diagnostic:c.settings.camera!=='video-follow'&&cam.role!=='diagnostic');
        if(!visible)return true;
        const idx=frameAt(cam.stamps,next);if(idx<0)return true;
        for(let j=idx;j<Math.min(idx+5,cam.stamps.length);j++){
          const key=`${i}:${j}`;
          if(frameCache.current.has(key))continue;
          const image=new window.Image(),entry={image,ready:false};frameCache.current.set(key,entry);
          image.onload=()=>entry.ready=true;image.onerror=()=>entry.ready=true;
          image.src=frameUrl(data,i,j);
        }
        return frameCache.current.get(`${i}:${idx}`).ready;
      }).every(Boolean);
      setBuffering(!ready);if(ready)setTime(next);
      if(frameCache.current.size>80){for(const key of [...frameCache.current.keys()].slice(0,40))frameCache.current.delete(key);}
      requestAnimationFrame(tick);
    };
    const id=requestAnimationFrame(tick);
    return()=>{cancelled=true;cancelAnimationFrame(id);setBuffering(false);};
  },[playing,data]);
}
