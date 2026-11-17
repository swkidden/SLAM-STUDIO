import React,{useEffect,useRef,useState} from 'react';
import {LoaderCircle} from 'lucide-react';
import {frameAt,frameAtOrBefore,frameUrl} from './model';

export default function Frame({data,time,camera,indexLabel,background=false,retainPrevious=false}){
  const stream=data.cameras[camera];
  const normalIndex=frameAt(stream?.stamps||[],time);
  const index=retainPrevious?frameAtOrBefore(stream?.stamps||[],time):normalIndex;
  const staleMs=index>=0?Math.max(0,(time-stream.stamps[index])*1000):0;
  const url=frameUrl(data,camera,index);
  const [shown,setShown]=useState(null),[failed,setFailed]=useState(false);
  const pending=useRef(null),busy=useRef(false),generation=useRef(0),load=useRef();
  useEffect(()=>{generation.current++;busy.current=false;pending.current=null;setShown(null);setFailed(false);return()=>{generation.current++;};},[data.id,data.generation,camera]);
  useEffect(()=>{
    if(!shown)return;
    const frame=requestAnimationFrame(()=>{
      const key=`${data.id}:${camera}`;
      window.slamDisplayStats??={};const records=window.slamDisplayStats[key]??=[];
      records.push({index:shown.index,stamp:shown.stamp,at:performance.now()});
      if(records.length>5000)records.splice(0,records.length-5000);
    });
    return()=>cancelAnimationFrame(frame);
  },[shown]);
  load.current=()=>{
    if(busy.current||!pending.current)return;
    const request=pending.current;pending.current=null;busy.current=true;
    const token=generation.current,image=new window.Image();
    const finish=ok=>{
      if(token!==generation.current)return;
      busy.current=false;
      if(ok){
        setShown(request);setFailed(false);
      }else setFailed(true);
      load.current();
    };
    image.onload=()=>finish(true);image.onerror=()=>finish(false);image.src=request.url;
  };
  useEffect(()=>{
    if(!url){pending.current=null;setShown(null);setFailed(false);return;}
    pending.current={url,index,stamp:stream.stamps[index]};load.current();
  },[url,data.id,data.generation,camera]);
  return <div className={background?'video-background':'camera-frame'} style={background?undefined:{aspectRatio:`${stream.width}/${stream.height}`}}>
    {!background&&<div className="camera-label"><span>{indexLabel||`相机 ${camera+1}`}</span>{retainPrevious&&index>=0&&staleMs>5&&<span className="frame-age">延迟 {staleMs<1000?`${Math.round(staleMs)} ms`:`${(staleMs/1000).toFixed(1)} s`}</span>}</div>}
    {url&&shown?<img src={shown.url} alt={stream.topic} data-frame={shown.index} data-stamp={shown.stamp} draggable="false"/>:<div className="no-frame">{url?(failed?'图像读取失败':<LoaderCircle className="spin" size={18}/>):'当前时刻无图像'}</div>}
  </div>;
}
