import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Activity,ArrowDownToLine,Axis3D,Camera,Check,ChevronDown,ChevronLeft,ChevronRight,Clapperboard,Columns2,Crosshair,Download,Expand,Eye,Film,FolderOpen,Grid3X3,Image,Layers,LoaderCircle,Maximize2,Monitor,MousePointer2,Move3D,Pause,Play,Plus,Repeat2,RotateCcw,Save,Settings2,SkipBack,SkipForward,SlidersHorizontal,Sun,Moon,Trash2,Video,X} from 'lucide-react';
import Scene from './Scene';
import DebugPanel from './DebugPanel';
import Frame from './Frame';
import {usePlayback} from './usePlayback';
import {dataSource} from './dataSource';
import {Radio,Unplug} from 'lucide-react';
import LiveDialog from './LiveDialog';
import OpenDialog from './OpenDialog';
import './workflow.css';
import astraStereoLive from '../examples/live-astravins-astra-stereo.json';
import {api,clock,defaults,frameAt,frameAtOrBefore,frameUrl,lowerBound} from './model';
import './style.css';
import './video-background.css';
import './live.css';
import './diagnostics.css';
import '@fontsource/dm-sans/latin-400.css';
import '@fontsource/dm-sans/latin-500.css';
import '@fontsource/dm-sans/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';

function Tool({title,icon:Icon,onClick,active,disabled,className=''}){
  return <button type="button" className={`icon-button ${active?'active':''} ${className}`} aria-label={title} title={title} onClick={onClick} disabled={disabled}><Icon size={17}/></button>;
}
function Modal({title,children,close,wide=false}){
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close();}}><section className={`modal ${wide?'wide':''}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><Tool title="关闭" icon={X} onClick={close}/></header>{children}</section></div>;
}
function ErrorPlot({data,time,settings}){
  const tracks=data.tracks.filter(t=>!t.truth&&settings.visible[t.id]!==false);
  const max=Math.max(.05,...tracks.flatMap(t=>t.errors.map(x=>x[1])));
  return <div className="error-plot"><div className="section-label"><span>位置误差</span><span>{max.toFixed(2)} m</span></div>
    <svg viewBox="0 0 320 70" preserveAspectRatio="none" aria-label="Position error curve"><path d="M0 20H320 M0 45H320 M0 69H320" stroke="var(--border)" fill="none"/>
      {tracks.map(t=><polyline key={t.id} fill="none" stroke={settings.colors[t.id]||t.color} strokeWidth="1.3" points={t.errors.map(([x,y])=>`${x/data.duration*320},${68-y/max*60}`).join(' ')}/>)}
      <line x1={time/data.duration*320} x2={time/data.duration*320} y1="0" y2="70" stroke="var(--text)" strokeWidth="1"/></svg></div>;
}

function App(){
  const [split,setSplit]=useState(()=>{try{const n=Number(localStorage.getItem('slam-studio-split'));return n>=.2&&n<=.8?n:.7;}catch{return .7;}});
  const resizeSplit=e=>{
    const bounds=e.currentTarget.parentElement.getBoundingClientRect();
    const value=Math.max(.2,Math.min(.8,(e.clientX-bounds.left)/bounds.width));
    setSplit(value);try{localStorage.setItem('slam-studio-split',String(value));}catch{}
  };
  const renderMode=new URLSearchParams(location.search).has('render');
  const [projects,setProjects]=useState([]),[recordings,setRecordings]=useState([]),[project,setProject]=useState(null),[data,setData]=useState(null);
  const [loading,setLoading]=useState(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [time,setTime]=useState(0),[playing,setPlaying]=useState(false),[buffering,setBuffering]=useState(false);
  const [settings,setSettings]=useState(()=>{
    try{return {...defaults,...JSON.parse(localStorage.getItem('slam-studio-follow')||'{}')};}
    catch{return {...defaults};}
  }),[range,setRange]=useState([0,1]);
  const [modal,setModal]=useState(''),[draft,setDraft]=useState(''),[presentation,setPresentation]=useState(renderMode);
  const [job,setJob]=useState(null),[resolution,setResolution]=useState(1080),[fps,setFps]=useState(30);
  const [telemetry,setTelemetry]=useState(null);
  const telemetryTime=useRef(0);
  const [liveId,setLiveId]=useState(null),[liveFollowing,setLiveFollowing]=useState(false),[liveStatus,setLiveStatus]=useState('waiting');
  const receiver=useRef(null),following=useRef(false),latestLive=useRef(null);
  const scene=useRef(),loadedRequest=useRef(0),current=useRef(),fileInput=useRef(),frameCache=useRef(new Map());
  current.current={data,time,settings,range,playing,liveFollowing,liveStatus};
  const change=(key,value)=>setSettings(s=>({...s,[key]:value,...(key==='camera'?{savedCamera:null}:{})}));
  const withFollowPreferences=(next,cameras=[],tracks=[])=>{
    try{
      const saved=JSON.parse(localStorage.getItem('slam-studio-follow')||'{}');
      return {...next,frustums:saved.frustums??next.frustums,frustumLength:saved.frustumLength??next.frustumLength,
        followDistance:saved.followDistance??next.followDistance,
        followHeight:saved.followHeight??next.followHeight,followAngle:saved.followAngle??next.followAngle,
        selectedTrack:tracks.some(track=>track.id===saved.selectedTrack)?saved.selectedTrack:next.selectedTrack,
        camera:saved.camera==='follow'?'follow':saved.camera==='video-follow'&&cameras.length?'video-follow':next.camera};
    }catch{return next;}
  };
  const videoBackground=settings.camera==='video-follow';
  const diagnosticStreams=data?.cameras.map((c,i)=>({...c,index:i})).filter(c=>c.role==='diagnostic')||[];
  const diagnosticCamera=diagnosticStreams.find(c=>c.index===settings.diagnosticCamera)?.index??diagnosticStreams[0]?.index;
  const debugView=settings.inspectionView==='debug';
  const diagnosticView=(settings.inspectionView==='diagnostics'&&diagnosticCamera!==undefined)||debugView;
  const diagnosticSelector=<select aria-label="特征显示模式" value={diagnosticCamera??''} onChange={e=>change('diagnosticCamera',Number(e.target.value))}>{diagnosticStreams.map(c=><option key={c.index} value={c.index}>{c.label||c.topic}</option>)}</select>;
  const fail=e=>setError(e.message||String(e));
  const followLive=value=>{following.current=value;setLiveFollowing(value);};
  const historyRequest=useRef(0);
  const openHistory=async(t,play=false)=>{
    const id=receiver.current;if(!id)return;
    const request=++historyRequest.current;followLive(false);setPlaying(false);
    const archive=await dataSource(id).info(true);
    if(request!==historyRequest.current||receiver.current!==id)return;
    setData({...archive,generation:latestLive.current?.generation,revision:`history:${latestLive.current?.revision}`,live:false});
    setRange([0,archive.duration]);setTime(Math.min(archive.duration,Math.max(0,t)));setPlaying(play);
  };
  const seek=t=>{
    if(receiver.current&&following.current){openHistory(t).catch(fail);return;}
    setPlaying(false);setTime(Math.min(data?.duration||0,Math.max(0,t)));
  };
  const resumeLive=()=>{++historyRequest.current;setPlaying(false);followLive(true);if(latestLive.current)showLive(latestLive.current);};
  const showLive=s=>{setData(s);setTime(s.time);setRange([0,s.duration]);};
  const togglePlay=()=>{
    if(!data||loading)return;
    if(data.live){openHistory(time).catch(fail);return;}
    if(time<range[0]||time>=range[1])setTime(range[0]);
    setPlaying(p=>!p);
  };

  async function detachLive(){
    ++historyRequest.current;receiver.current=null;setLiveId(null);followLive(false);sessionStorage.removeItem('slam-studio-live');
  }
  async function disconnectLive(){
    const id=receiver.current;if(!id)return;
    await api(`/api/live/${id}/stop`,{});
    setLiveStatus('stopped');await openHistory(0);
  }
  async function discardLive(){
    const id=receiver.current;if(!id)return;
    await api(`/api/live/${id}/discard`,{});await detachLive();
    setData(null);setProject(null);setTime(0);setRange([0,1]);setNotice('临时记录已丢弃');
  }
  async function saveLiveRecording(){
    if(!liveId)return;
    await api(`/api/live/${liveId}/save`,{});
    setData(value=>value?.id===liveId?{...value,recording_saved:true}:value);
    if(latestLive.current)latestLive.current={...latestLive.current,recording_saved:true};
    setNotice('本次运行记录已保存');
    setRecordings(await api('/api/recordings'));
  }
  async function attachSession(id){
    await detachLive();
    const snapshot=await dataSource(id).info();
    receiver.current=id;latestLive.current=snapshot;sessionStorage.setItem('slam-studio-live',id);
    setProject({...snapshot.project,id});setData(snapshot);setTime(snapshot.time);setRange([0,snapshot.duration]);
    setSettings(withFollowPreferences({...defaults,camera:snapshot.cameras.length?'video-follow':'follow',selectedTrack:snapshot.tracks[0]?.id},snapshot.cameras,snapshot.tracks));
    setPlaying(false);setLiveId(id);setLiveStatus(snapshot.status);followLive(snapshot.status!=='stopped');setModal('');
    if(snapshot.status==='stopped')await openHistory(snapshot.time);
  }
  async function connectLive(config){
    await detachLive();
    ++loadedRequest.current;
    const snapshot=await api('/api/live',config);
    receiver.current=snapshot.id;latestLive.current=snapshot;sessionStorage.setItem('slam-studio-live',snapshot.id);
    frameCache.current.clear();setPlaying(false);setLoading(null);setError('');
    setProject({...snapshot.project,id:snapshot.id});
    setSettings(withFollowPreferences({...defaults,camera:snapshot.cameras.length?'video-follow':'follow',selectedTrack:snapshot.tracks[0].id},snapshot.cameras,snapshot.tracks));
    showLive(snapshot);followLive(true);setLiveStatus(snapshot.status);setLiveId(snapshot.id);setModal('');
    return snapshot.id;
  }
  async function loadRecording(id){
    await detachLive();
    ++loadedRequest.current;
    setPlaying(false);setError('');setLoading({status:'queued',progress:0});
    try{
      const archived=await api(`/api/recordings/${id}`),p=archived.project;
      frameCache.current.clear();
      setData(archived);setProject(p);
      setSettings(withFollowPreferences({...defaults,camera:archived.cameras.length?'video-follow':'follow',selectedTrack:archived.tracks[0]?.id},archived.cameras,archived.tracks));
      setRange([0,archived.duration]);setTime(0);setLoading(null);setModal('');
    }catch(e){setLoading(null);fail(e);}
  }
  async function deleteRecording(){
    const id=project?.id;
    if(!id||!recordings.some(recording=>recording.id===id)||data?.live)return;
    if(!window.confirm('删除这次运行记录及其图像归档？此操作不可撤销。'))return;
    try{
      const response=await fetch(`/api/recordings/${id}`,{method:'DELETE'}),result=await response.json();
      if(!response.ok)throw new Error(result.error||response.statusText);
      setRecordings(items=>items.filter(recording=>recording.id!==id));
      setData(null);setProject(null);setTime(0);setRange([0,1]);setPlaying(false);setNotice('运行记录已删除');
    }catch(e){fail(e);}
  }
  useEffect(()=>{
    if(!liveId)return;
    const id=liveId;
    const seed=latestLive.current;
    return dataSource(id).subscribe(seed,s=>{
      if(receiver.current!==id)return;
      const previous=latestLive.current;
      latestLive.current=s;
      if(performance.now()-telemetryTime.current>1000){
        telemetryTime.current=performance.now();
        const samples=window.slamDisplayStats||{};
        const display=s.cameras.map((c,i)=>{const rows=(samples[`${id}:${i}`]||[]).filter(r=>performance.now()-r.at<1000);return rows.length;});
        setTelemetry({counts:s.counts,display});
      }
      setLiveStatus(s.runner_status&&s.runner_status!=='attached'?s.runner_status:s.status);
      if(previous?.generation!==s.generation){frameCache.current.clear();++historyRequest.current;setPlaying(false);followLive(true);}
      if(following.current)showLive(s);
      if(s.status==='stopped'&&previous?.status!=='stopped')openHistory(0).catch(fail);
      if(s.runner_error||s.error)setError(s.runner_error||s.error);
    },status=>setLiveStatus(status));
  },[liveId]);
  useEffect(()=>{
    let cancelled=false,timer;
    const refresh=async()=>{
      try{const list=await api('/api/recordings');if(!cancelled)setRecordings(list);}
      catch{}
      if(!cancelled)timer=setTimeout(refresh,2500);
    };
    refresh();return()=>{cancelled=true;clearTimeout(timer);};
  },[]);

  async function load(p){
    await detachLive();
    const request=++loadedRequest.current;
    setPlaying(false);setError('');setLoading({status:'queued',progress:0});
    try{
      const {id}=await api('/api/load',p);
      for(;;){
        if(request!==loadedRequest.current)return;
        const s=await api('/api/session/'+id);
        if(s.status==='error')throw new Error(s.error);
        if(s.status==='ready'){
          if(!p.id)p={...p,id:'import_'+id};
          setProjects(list=>list.some(x=>x.id===p.id)?list.map(x=>x.id===p.id?p:x):[...list,p]);
          frameCache.current.clear();setData(s.data);setProject(p);setTime(p.clip?.[0]||0);
          setSettings(withFollowPreferences({...defaults,...p.view,visible:{...p.view?.visible},colors:{...p.view?.colors},names:{...p.view?.names}},s.data.cameras,s.data.tracks));
          setRange(p.clip||[0,s.data.duration]);setLoading(null);setModal('');return;
        }
        setLoading(s);await new Promise(r=>setTimeout(r,600));
      }
    }catch(e){if(request===loadedRequest.current){setLoading(null);fail(e);}}
  }
  useEffect(()=>{
    if(new URLSearchParams(location.search).get('live')==='astravins-astra-stereo'){
      connectLive(astraStereoLive).catch(fail);
      return;
    }
    const existing=sessionStorage.getItem('slam-studio-live');
    if(existing){
      dataSource(existing).info().then(snapshot=>{
        receiver.current=snapshot.id;latestLive.current=snapshot;
        setProject({...snapshot.project,id:snapshot.id});
        setSettings(withFollowPreferences({...defaults,camera:snapshot.cameras.length?'video-follow':'follow',selectedTrack:snapshot.tracks[0]?.id},snapshot.cameras,snapshot.tracks));
        showLive(snapshot);followLive(snapshot.status!=='stopped');setLiveStatus(snapshot.status);setLiveId(snapshot.id);
        if(snapshot.status==='stopped')openHistory(snapshot.time).catch(fail);
      }).catch(()=>sessionStorage.removeItem('slam-studio-live'));
      api('/api/projects').then(setProjects).catch(fail);return;
    }
    api('/api/projects').then(list=>{
      setProjects(list);
      if(!renderMode&&list.length&&new URLSearchParams(location.search).has('project')){
        const requested=new URLSearchParams(location.search).get('project');
        const selected=requested?list.find(p=>p.id===requested):list[0];
        if(!selected)throw new Error(`Unknown project: ${requested}`);
        load(selected);
      }
    }).catch(fail);
  },[]);
  useEffect(()=>{document.documentElement.dataset.theme=settings.theme;},[settings.theme]);
  useEffect(()=>{
    try{localStorage.setItem('slam-studio-follow',JSON.stringify({camera:settings.camera,frustums:settings.frustums,frustumLength:settings.frustumLength,followDistance:settings.followDistance,
      followHeight:settings.followHeight,followAngle:settings.followAngle,selectedTrack:settings.selectedTrack}));}catch{}
  },[settings.camera,settings.frustums,settings.frustumLength,settings.followDistance,settings.followHeight,settings.followAngle,settings.selectedTrack]);
  useEffect(()=>{if(!notice)return;const id=setTimeout(()=>setNotice(''),3000);return()=>clearTimeout(id);},[notice]);
  usePlayback({playing,data,current,frameCache,setTime,setPlaying,setBuffering});
  const step=direction=>{
    if(!data)return;
    const stamps=data.cameras[videoBackground?settings.imageCamera:0]?.stamps||data.tracks[0].poses.map(p=>p[0]);
    if(!stamps.length)return;
    const displayed=frameAt(stamps,time);
    let i=displayed>=0?displayed+direction:lowerBound(stamps,time)-(direction<0?1:0);
    seek(stamps[Math.max(0,Math.min(stamps.length-1,i))]);
  };
  useEffect(()=>{
    const onKey=e=>{
      if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName))return;
      if(e.code==='Space'){e.preventDefault();if(data&&!modal)togglePlay();}
      if(e.code==='ArrowRight')step(1);
      if(e.code==='ArrowLeft')step(-1);
      if(e.code==='Escape'){setPresentation(false);setModal('');}
    };
    window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);
  },[data,time,modal,range,loading,videoBackground,settings.imageCamera]);

  async function waitImages(){
    await Promise.all([...document.querySelectorAll('.camera-frame img,.video-background img')].map(img=>img.decode().catch(()=>{throw new Error('Frame decode failed');})));
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));scene.current?.render();
  }
  useEffect(()=>{
    window.vio={
      connectLive,
      attachSession,
      disconnectLive,
      loadSession:async(id,view,clip)=>{
        await detachLive();++loadedRequest.current;
        const session=await api('/api/session/'+id);if(session.status!=='ready')throw new Error('Session unavailable');
        flushSync(()=>{setPlaying(false);setData(session.data);setProject(session.data.project);setSettings(withFollowPreferences({...defaults,...view},session.data.cameras,session.data.tracks));setRange(clip);setTime(clip[0]);setLoading(null);setPresentation(true);});
        await new Promise(r=>setTimeout(r,200));await waitImages();
      },
      renderAt:async(t)=>{flushSync(()=>setTime(t));await waitImages();},
      getState:()=>({time:current.current.time,playing:current.current.playing,settings:current.current.settings,session:current.current.data?.id,
        live:!!current.current.data?.live,following:current.current.liveFollowing,status:current.current.liveStatus,revision:current.current.data?.revision,
        poses:current.current.data?.tracks.map(t=>t.poses.length),counts:latestLive.current?.counts,display:window.slamDisplayStats||{}}),
      getCamera:()=>scene.current?.getCamera?.(),
    };
    return()=>delete window.vio;
  },[]);

  async function save(){
    if(data?.live)return;
    try{
      const p={...project,view:{...settings,savedCamera:scene.current?.getCamera?.()||settings.savedCamera},clip:range};
      const saved=await api('/api/projects',p);setProjects(list=>[...list,saved]);setProject(saved);
      const blob=new Blob([JSON.stringify(saved,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob);
      const a=document.createElement('a');a.href=url;a.download=`${saved.id}.vio.json`;a.click();URL.revokeObjectURL(url);setNotice('展示工程已保存');
    }catch(e){fail(e);}
  }
  async function exportMedia(kind){
    if(data?.live)return;
    setPlaying(false);setError('');
    try{
      const start=kind==='snapshot'?Math.min(time,data.duration-.001):range[0];
      const end=kind==='snapshot'?data.duration:range[1];
      const j=await api('/api/export',{session:data.id,kind,start,end,height:resolution,fps,view:{...settings,savedCamera:scene.current?.getCamera?.()||settings.savedCamera}});
      setJob(j);setModal('export');
    }catch(e){fail(e);}
  }
  useEffect(()=>{
    if(!job||!['starting','rendering'].includes(job.status))return;
    const id=setInterval(()=>api('/api/export/'+job.id).then(setJob).catch(fail),700);return()=>clearInterval(id);
  },[job?.id,job?.status]);
  const cameraKeys=()=>{
    const key=scene.current?.getCamera?.();if(!key)return;
    change('keyframes',[...settings.keyframes.filter(k=>Math.abs(k.time-time)>.01),{...key,time}].sort((a,b)=>a.time-b.time));
    setNotice('镜头关键帧已添加');
  };
  const activeCamera=data?.cameras[videoBackground?settings.imageCamera:0];
  const frame=activeCamera?Math.max(0,frameAt(activeCamera.stamps,time)):0;
  const effectiveLayout=videoBackground?'scene':settings.layout;
  const running=data?.live?liveFollowing:playing;

  return <div className={`app ${presentation?'presentation':''} ${renderMode?'render-mode':''}`}>
    {!presentation&&<header className="app-header">
      <div className="brand"><div className="brand-icon"><Move3D size={22}/></div><strong>SLAM<span>STUDIO</span></strong></div>
      <div className="current-source"><strong>{project?.name||'尚未打开数据'}</strong><small>{liveId?(['stopped','complete','error'].includes(liveStatus)?'已停止 · 可回放':liveFollowing?'实时显示':'查看历史 · 仍在接收'):data?'离线回放':'选择运行算法或打开回放'}</small></div>
      <div className="header-actions" onClick={e=>{if(e.target.closest('.more-menu button'))e.target.closest('details').open=false;}}>
        <button onClick={()=>setModal('live')} disabled={!!loading}><Radio size={16}/>运行算法</button>
        <button onClick={()=>setModal('open')} disabled={!!loading}><FolderOpen size={16}/>打开回放</button>
        {liveId&&!['stopped','complete','error'].includes(liveStatus)&&<button onClick={()=>disconnectLive().catch(fail)}>停止运行</button>}
        {liveId&&!liveFollowing&&!['stopped','complete','error'].includes(liveStatus)&&<button className="primary" onClick={resumeLive}>回到实时</button>}
        {liveId&&!data?.recording_saved&&<button onClick={()=>saveLiveRecording().catch(fail)}><Save size={16}/>保存记录</button>}
        <details className="more-menu"><summary>更多</summary><div>
          <button disabled={!data} onClick={()=>setModal('settings')}>显示设置</button>
          <button disabled={!data||data.live} onClick={save}>保存展示工程</button>
          <button disabled={!data} onClick={()=>{setDraft(JSON.stringify(project||{},null,2));setModal('source');}}>高级数据配置</button>
          <button onClick={()=>change('theme',settings.theme==='dark'?'light':'dark')}>切换明暗主题</button>
          <button disabled={!data} onClick={()=>setPresentation(true)}>进入展示模式</button>
          {liveId&&<button onClick={()=>discardLive().catch(fail)}>丢弃本次记录</button>}
          {recordings.some(r=>r.id===project?.id)&&!data?.live&&<button onClick={deleteRecording}>删除已保存记录</button>}
        </div></details>
        <button className="primary" disabled={!data||!!loading||data.live} onClick={()=>setModal('export')}><Clapperboard size={16}/>导出</button>
      </div>
    </header>}
    <input ref={fileInput} hidden type="file" accept=".json" onChange={async e=>{const f=e.target.files[0];if(!f)return;try{const p=JSON.parse(await f.text());await load(p);}catch(error){fail(error);}e.target.value='';}}/>
    {error&&<div className="error-banner" role="alert"><span>{error}</span><Tool title="关闭错误" icon={X} onClick={()=>setError('')}/></div>}
    {notice&&!renderMode&&<div className="toast"><Check size={16}/>{notice}</div>}
    <main className={`workspace layout-${effectiveLayout} ${videoBackground?'video-mode':''} ${diagnosticView?'diagnostic-open':''}`} id="capture" style={data&&(!(presentation&&videoBackground)||diagnosticView)&&!renderMode?{gridTemplateColumns:`minmax(0,${split}fr) minmax(0,${1-split}fr)`}:undefined}>
      <section className="scene-region">
        {data&&videoBackground&&data.cameras[settings.imageCamera]&&<Frame data={data} time={time} camera={settings.imageCamera} background/>}
        {data&&<Scene ref={scene} data={data} time={time} settings={settings}/>}
        <div className="scene-heading"><h1>{project?.name||'SLAM Studio'}</h1></div>
        {presentation&&<div className="film-clock"><span>{clock(time)}</span><small> / {clock(data?.duration||0)}</small></div>}
        {!presentation&&<div className="scene-tools">
          <div className="tool-stack">{[[MousePointer2,'orbit','自由视角'],[Grid3X3,'top','俯视'],[Crosshair,'follow','跟随'],[Video,'video-follow','视频跟随'],[Camera,'fixed','固定镜头'],[Film,'cinematic','关键帧镜头']].map(([Icon,value,title])=><Tool key={value} title={title} icon={Icon} active={settings.camera===value} onClick={()=>change('camera',value)}/>)}<span className="stack-divider"/><Tool title="重置视角" icon={RotateCcw} onClick={()=>scene.current?.reset?.()}/></div>
          <div className="tool-stack"><Tool title="米制网格" icon={Grid3X3} active={settings.grid} onClick={()=>change('grid',!settings.grid)}/><Tool title="相机视锥" icon={Camera} active={settings.frustums} onClick={()=>change('frustums',!settings.frustums)}/><Tool title="协方差与SLAM约束椭球" icon={Activity} active={settings.debugMarkers!==false} onClick={()=>change('debugMarkers',settings.debugMarkers===false)}/><Tool title="姿态坐标轴" icon={Axis3D} active={settings.axes} onClick={()=>change('axes',!settings.axes)}/></div>
        </div>}
        <div className="scene-legend">{data?.tracks.map(t=>settings.visible[t.id]!==false&&<span key={t.id}><i style={{background:settings.colors[t.id]||t.color}}/>{settings.names[t.id]||t.name}</span>)}</div>
        {!data&&!loading&&<div className="empty-state"><FolderOpen size={32}/><h2>运行算法，或打开数据回放</h2><div className="welcome-actions"><button className="primary" onClick={()=>setModal('live')}>运行算法</button><button onClick={()=>setModal('open')}>打开回放</button></div><p className="workflow-help">运行结束后可直接回放，满意后再保存记录。</p></div>}
      </section>
      {data&&(!(presentation&&videoBackground)||diagnosticView)&&!renderMode&&<div role="separator" tabIndex={0} aria-label="调整轨迹与图像宽度" aria-orientation="vertical" aria-valuenow={Math.round(split*100)} aria-valuemin={20} aria-valuemax={80} className="panel-divider" style={{left:`${split*100}%`}}
        onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);resizeSplit(e);}}
        onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))resizeSplit(e);}}
        onPointerUp={e=>e.currentTarget.releasePointerCapture(e.pointerId)}
        onDoubleClick={()=>{setSplit(.7);localStorage.setItem('slam-studio-split','.7');}}
        onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();const n=Math.max(.2,Math.min(.8,split+(e.key==='ArrowLeft'?-.02:.02)));setSplit(n);localStorage.setItem('slam-studio-split',String(n));}}}/>}
      {data&&(!(presentation&&videoBackground)||diagnosticView)&&<aside className="inspection">
        {<div className="inspection-tabs" role="tablist" aria-label="图像面板">
          <button role="tab" aria-selected={settings.inspectionView==='images'} onClick={()=>change('inspectionView','images')}><Camera size={15}/>原图</button>
          <button role="tab" disabled={!diagnosticStreams.length} aria-selected={settings.inspectionView==='diagnostics'} onClick={()=>change('inspectionView','diagnostics')}><Crosshair size={15}/>特征跟踪</button>
        <button role="tab" aria-selected={debugView} onClick={()=>change('inspectionView','debug')}><Activity size={15}/>调试</button></div>}
        {debugView?<DebugPanel data={data} time={time} onTime={seek} showMarkers={settings.debugMarkers!==false} onShowMarkers={value=>change('debugMarkers',value)}/>:diagnosticView?<section className="diagnostic-panel" aria-label="特征跟踪结果">
          <div className="diagnostic-toolbar">{diagnosticSelector}<Tool title="放大剔除图像" icon={Maximize2} onClick={()=>setModal('diagnostic')}/></div>
          <Frame data={data} time={time} camera={diagnosticCamera} indexLabel={data.cameras[diagnosticCamera].label} retainPrevious/>
        </section>:!videoBackground&&<>{!presentation&&diagnosticStreams.length===0&&<div className="panel-heading"><span><Camera size={15}/> 图像</span></div>}
        <div className="camera-views">{data.cameras.map((c,i)=>c.role!=='diagnostic'&&<Frame key={`${data.id}:${i}`} data={data} time={time} camera={i} indexLabel={c.label||(data.cameras.filter(c=>c.role!=='diagnostic').length===1?'相机':i===0?'左目':'右目')}/>)}</div></>}
        {!presentation&&liveId&&telemetry&&<div className="stream-metrics" aria-label="接收与显示统计">接收 {telemetry.counts.source_frames??telemetry.counts.frames} · 归档 {telemetry.counts.archived_frames??telemetry.counts.frames} 帧<br/>显示 {telemetry.display.join(' / ')} FPS · 丢弃 {(telemetry.counts.bridge_dropped_frames||0)+(telemetry.counts.dropped||0)}</div>}
        {!presentation&&<><div className="panel-heading methods-heading"><span><Layers size={15}/> 轨迹</span><button className="plain" aria-label="展示设置" onClick={()=>setModal('settings')}><SlidersHorizontal size={15}/></button></div>
          <div className="track-list">{data.tracks.map(t=><div className={`track-row ${settings.selectedTrack===t.id?'selected':''}`} key={t.id} title={t.note||''}>
            <input aria-label={`显示 ${t.name}`} type="checkbox" checked={settings.visible[t.id]!==false} onChange={e=>change('visible',{...settings.visible,[t.id]:e.target.checked})}/>
            <input aria-label={`${t.name} 颜色`} className="color-swatch" type="color" value={settings.colors[t.id]||t.color} onChange={e=>change('colors',{...settings.colors,[t.id]:e.target.value})}/>
            <button className="track-name" onClick={()=>change('selectedTrack',t.id)}>{settings.names[t.id]||t.name}</button>
            {!data.live&&t.rmse!=null&&<span className="metric">{t.rmse.toFixed(3)}<small>m APE</small></span>}
          </div>)}</div>{!data.live&&data.tracks.some(t=>t.errors.length>0)&&<ErrorPlot data={data} time={time} settings={settings}/>}</>}
      </aside>}
    </main>
    {!presentation&&<footer className="timeline">
      <div className="timeline-top"><div className="transport"><Tool title="回到区间起点" icon={SkipBack} onClick={()=>seek(range[0])} disabled={!data}/><Tool title="上一帧" icon={ChevronLeft} onClick={()=>step(-1)} disabled={!data}/><button className="play-button" aria-label={data?.live?(running?'暂停实时显示':'恢复实时显示'):(running?'暂停':'播放')} disabled={!data||!!loading} onClick={togglePlay}>{buffering?<LoaderCircle size={19} className="spin"/>:running?<Pause size={19}/>:<Play size={19} fill="currentColor"/>}</button><Tool title="下一帧" icon={ChevronRight} onClick={()=>step(1)} disabled={!data}/><Tool title="跳到区间终点" icon={SkipForward} onClick={()=>seek(range[1])} disabled={!data}/><span className="timecode">{clock(time)}<small> / {clock(data?.duration||0)}</small></span></div>
        <div className="timeline-options"><select aria-label="播放速度" disabled={liveFollowing} value={settings.rate} onChange={e=>change('rate',Number(e.target.value))}>{[.25,.5,1,2,4].map(r=><option key={r} value={r}>{r}x</option>)}</select><Tool title="区间循环" disabled={liveFollowing} icon={Repeat2} active={settings.loop} onClick={()=>change('loop',!settings.loop)}/><span className="divider"/><select aria-label="轨迹显示时长" value={settings.trail} onChange={e=>change('trail',Number(e.target.value))}><option value="0">全部</option><option value="2">2 秒消散</option></select><select aria-label="轨迹显示方式" value={settings.pathMode} onChange={e=>change('pathMode',e.target.value)}><option value="progressive">轨迹逐帧增长</option><option value="full">完整轨迹</option></select><Tool title="添加镜头关键帧" icon={Plus} onClick={cameraKeys} disabled={!data}/><Tool title="截图" icon={Image} onClick={()=>exportMedia('snapshot')} disabled={!data||data.live}/></div></div>
      <div className="scrubber"><div className="clip-span" style={{left:`${range[0]/(data?.duration||1)*100}%`,width:`${(range[1]-range[0])/(data?.duration||1)*100}%`}}/><input aria-label="播放位置" type="range" min="0" max={data?.duration||1} step="0.001" value={time} disabled={!data} style={{'--progress':`${time/(data?.duration||1)*100}%`}} onChange={e=>seek(Number(e.target.value))}/>{settings.keyframes.map(k=><button key={k.time} className="key-marker" title={`镜头 ${clock(k.time)}`} style={{left:`${k.time/(data?.duration||1)*100}%`}} onClick={()=>seek(k.time)}/>)}</div>
      <div className="timeline-bottom"><span><i className={running?'playing-dot':'idle-dot'}/>{data?.live?({waiting:'等待数据',starting:'算法启动中',running:'算法运行中',playing:'正在回放',complete:'回放完成',receiving:liveFollowing?'实时':'显示已暂停',stale:'暂无新数据',stopped:'已停止',error:'运行异常'}[liveStatus]||liveStatus):loading?'INDEXING':playing?'PLAYING':'PAUSED'} <span className="frame-counter">FRAME {String(frame+1).padStart(4,'0')} / {activeCamera?.count||'----'}</span></span><div className="ticks">{Array.from({length:7},(_,i)=><span key={i}>{clock((data?.duration||0)*i/6)}</span>)}</div><button className="plain" onClick={()=>setModal('settings')}>展示设置 <Settings2 size={13}/></button></div>
    </footer>}
    {presentation&&!renderMode&&<div className="presentation-controls"><Tool title="退出展示" icon={X} onClick={()=>setPresentation(false)}/><Tool title={running?'暂停':'播放'} icon={running?Pause:Play} onClick={togglePlay}/></div>}
    {loading&&<div className="loading-overlay"><div><LoaderCircle size={30} className="spin"/><h2>{loading.status==='queued'?'准备数据':'建立图像索引'}</h2><p>{projects.find(p=>p.id===project?.id)?.dataset||'VIODE'} / {Math.round((loading.progress||0)*100)}%</p><progress max="1" value={loading.progress||0}/></div></div>}

    {modal==='open'&&<Modal title="打开回放" wide close={()=>setModal('')}><OpenDialog projects={projects} recordings={recordings} openProject={load} openRecording={loadRecording} importFile={()=>fileInput.current.click()}/></Modal>}
    {modal==='live'&&<Modal title="运行算法" close={()=>setModal('')}><LiveDialog connect={connectLive} resume={attachSession}/></Modal>}
    {modal==='settings'&&<Modal title="展示设置" close={()=>setModal('')}>
      <div className="form-grid"><label>画面布局<select value={settings.layout} onChange={e=>change('layout',e.target.value)}><option value="scene">轨迹为主</option><option value="image">图像为主</option><option value="split">轨迹 / 图像并列</option></select></label><label>轨迹显示时长<select aria-label="轨迹显示时长" value={settings.trail} onChange={e=>change('trail',Number(e.target.value))}><option value="0">全部历史</option><option value="2">2 秒消散</option></select></label><label>区间起点 / s<input type="number" min="0" max={range[1]-.01} step=".01" value={range[0]} onChange={e=>setRange([Math.max(0,Math.min(range[1]-.01,Number(e.target.value))),range[1]])}/></label><label>区间终点 / s<input type="number" min={range[0]+.01} max={data?.duration} step=".01" value={range[1]} onChange={e=>setRange([range[0],Math.min(data.duration,Math.max(range[0]+.01,Number(e.target.value)))])}/></label></div>
      <h3>跟随镜头</h3>
      <div className="form-grid follow-settings">
        <label>跟随目标<select aria-label="跟随目标" value={settings.selectedTrack} onChange={e=>change('selectedTrack',e.target.value)}>{data?.tracks.map(t=><option key={t.id} value={t.id}>{settings.names[t.id]||t.name}</option>)}</select></label>
        <label>距离 / m<input aria-label="跟随距离" type="number" min="0.5" max="200" step="0.5" value={settings.followDistance} onChange={e=>change('followDistance',Math.max(.5,Math.min(200,Number(e.target.value))))}/></label>
        <label>高度 / m<input aria-label="跟随高度" type="number" min="0.1" max="200" step="0.5" value={settings.followHeight} onChange={e=>change('followHeight',Math.max(.1,Math.min(200,Number(e.target.value))))}/></label>
        <label>侧向角度 / °<input aria-label="跟随角度" type="number" min="-180" max="180" step="5" value={settings.followAngle} onChange={e=>change('followAngle',Math.max(-180,Math.min(180,Number(e.target.value))))}/></label>
        <label>相机视锥长度 / m<input aria-label="视锥长度" type="number" min="0.05" max="5" step="0.05" value={settings.frustumLength} onChange={e=>change('frustumLength',Math.max(0.05,Math.min(5,Number(e.target.value))))}/></label>
      </div>
      <div className="form-grid"><label>视频底图<select aria-label="视频底图" value={settings.imageCamera} onChange={e=>change('imageCamera',Number(e.target.value))}>{data?.cameras.map((c,i)=>c.role!=='diagnostic'&&<option key={i} value={i}>{c.topic}</option>)}</select></label></div>
      <h3>图例名称</h3>{data?.tracks.map(t=><label className="name-edit" key={t.id}><span style={{color:settings.colors[t.id]||t.color}}>{t.name}</span><input value={settings.names[t.id]||t.name} maxLength={40} onChange={e=>change('names',{...settings.names,[t.id]:e.target.value})}/></label>)}
      <div className="section-title"><h3>镜头关键帧</h3><Tool title="记录当前镜头" icon={Plus} onClick={cameraKeys}/></div><div className="keyframes">{settings.keyframes.length===0?<span className="muted">暂无关键帧</span>:settings.keyframes.map(k=><div key={k.time}><button onClick={()=>seek(k.time)}>{clock(k.time)}</button><Tool title="删除关键帧" icon={Trash2} onClick={()=>change('keyframes',settings.keyframes.filter(x=>x!==k))}/></div>)}</div>
      <div className="modal-actions"><button onClick={()=>{change('camera','cinematic');setModal('');}} disabled={settings.keyframes.length<2}><Film size={16}/>启用镜头序列</button><button className="primary" onClick={()=>setModal('')}>完成</button></div>
    </Modal>}
    {modal==='diagnostic'&&diagnosticCamera!==undefined&&<Modal title="外点剔除" wide close={()=>setModal('')}>
      <div className="diagnostic-expanded">
        <div className="diagnostic-toolbar">{diagnosticSelector}<span>{clock(time)}</span>
          <Tool title="上一帧" icon={ChevronLeft} onClick={()=>step(-1)}/>
          <Tool title={running?'暂停':'播放'} icon={running?Pause:Play} onClick={togglePlay}/>
          <Tool title="下一帧" icon={ChevronRight} onClick={()=>step(1)}/>
        </div>
        <Frame data={data} time={time} camera={diagnosticCamera} indexLabel={data.cameras[diagnosticCamera].label} retainPrevious/>
      </div>
    </Modal>}
    {modal==='source'&&<Modal title="数据源 / 展示工程" wide close={()=>setModal('')}>
      <textarea className="project-editor" aria-label="工程 JSON" readOnly={!!data?.live} spellCheck="false" value={draft} onChange={e=>setDraft(e.target.value)}/>
      {!data?.live&&<div className="modal-actions"><button onClick={()=>fileInput.current.click()}><FolderOpen size={16}/>导入文件</button><button className="primary" onClick={()=>{try{const p=JSON.parse(draft);setModal('');load(p);}catch(e){fail(e);}}}>加载工程</button></div>}
    </Modal>}
    {modal==='export'&&<Modal title="导出画面" close={()=>setModal('')}>
      <div className="export-preview"><Clapperboard size={28}/><div><strong>{project?.name}</strong><span>{clock(range[0])} — {clock(range[1])}</span></div><span>16:9</span></div>
      <div className="form-grid"><label>分辨率<select aria-label="导出分辨率" value={resolution} onChange={e=>setResolution(Number(e.target.value))}><option value="720">1280 × 720</option><option value="1080">1920 × 1080</option><option value="2160">3840 × 2160</option></select></label><label>帧率<select aria-label="导出帧率" value={fps} onChange={e=>setFps(Number(e.target.value))}>{[24,30,60].map(v=><option key={v}>{v}</option>)}</select></label><label>开始 / s<input aria-label="导出起点" type="number" min="0" max={range[1]-.01} step=".01" value={range[0]} onChange={e=>setRange([Math.max(0,Math.min(range[1]-.01,Number(e.target.value))),range[1]])}/></label><label>结束 / s<input aria-label="导出终点" type="number" min={range[0]+.01} max={data?.duration} step=".01" value={range[1]} onChange={e=>setRange([range[0],Math.max(range[0]+.01,Math.min(data.duration,Number(e.target.value)))])}/></label></div>
      {job&&<div className="export-job"><div><span>{({starting:'启动渲染',rendering:'离屏渲染',done:'导出完成',error:'导出失败',cancelled:'已取消'})[job.status]}</span><span>{Math.round((job.progress||0)*100)}%</span></div><progress max="1" value={job.progress||0}/>{job.error&&<p className="job-error">{job.error}</p>}{job.status==='done'&&<a className="download-link" href={`/api/export/${job.id}/file`} download={`${project?.id||'vio'}.${job.kind==='snapshot'?'png':'mp4'}`}><Download size={16}/>下载{job.kind==='snapshot'?'截图':'视频'}</a>}</div>}
      <div className="modal-actions">{job&&['starting','rendering'].includes(job.status)?<button onClick={()=>api(`/api/export/${job.id}/cancel`,{}).then(j=>setJob({...job,...j})).catch(fail)}>取消导出</button>:<><button onClick={()=>exportMedia('snapshot')}><Camera size={16}/>当前帧 PNG</button><button className="primary" onClick={()=>exportMedia('video')}><Video size={16}/>导出 MP4</button></>}</div>
    </Modal>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
