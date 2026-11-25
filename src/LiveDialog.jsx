import React,{useEffect,useState} from 'react';
import {api} from './model';
import {TopicPicker} from './TopicPicker';
import astra from '../examples/live-astravins-attach.json';
import igof from '../examples/live-openvins-1021.json';
import basalt from '../examples/live-basalt-astra-1021.json';

const stereoRetryArg = 'klt_stereo_retry:=';
function preset(id){
 if(id==='basalt')return structuredClone(basalt);
 const isAstra=id==='astra',workspace='/root/vins_dev/'+(isAstra?'AstraVins':'imu_guided_outlier_filter_ws');
 const c=structuredClone(isAstra?astra:igof);
 c.name=isAstra?'AstraVins':'IMU-guided OpenVINS';c.save_recording=false;
 if(!isAstra){for(const t of [...c.tracks,...c.cameras])t.topic=t.topic.replace('/run_subscribe_msckf','/ov_msckf');}
 const yaml=workspace+(isAstra?'/src/sqrtvins':'/src/open_vins')+'/config/astra_1021/estimator_config.yaml';
 c.runner={auto_master:true,startup_delay:5,drain_delay:2,commands:[{id,setup:['/opt/ros/noetic/setup.bash',workspace+'/devel/setup.bash'],cwd:workspace,argv:isAstra?['roslaunch','ov_srvins','astra_1021.launch','config_path:='+yaml]:['roslaunch','ov_msckf','subscribe.launch','config:=astra_1021','config_path:='+yaml,stereoRetryArg+'true']}]};
 return c;
}
export default function LiveDialog({connect,resume}){
 const [selected,setSelected]=useState('preset:astra'),[config,setConfig]=useState(()=>preset('astra')),[mode,setMode]=useState('algorithm'),[profiles,setProfiles]=useState([]),[sessions,setSessions]=useState([]),[directory,setDirectory]=useState('/root/1021'),[bags,setBags]=useState([]),[bag,setBag]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[dirty,setDirty]=useState(false),[raw,setRaw]=useState(''),[jsonDraft,setJsonDraft]=useState(null);
 const refresh=()=>api('/api/connection-profiles').then(setProfiles).catch(e=>setError(e.message));
 const scan=async()=>{try{const r=await api('/api/bags?directory='+encodeURIComponent(directory));setBags(r.files);setBag(v=>r.files.some(f=>f.path===v)?v:r.files[0]?.path||'');}catch(e){setError(e.message);}};
 useEffect(()=>{refresh();scan();api('/api/live').then(setSessions).catch(()=>{});},[]);
 const edit=c=>{setConfig(c);setDirty(true);setNotice('');};
 const choose=(value,keepMode=false)=>{
  setSelected(value);setDirty(false);setError('');setNotice('');setRaw('');setJsonDraft(null);
  const c=value.startsWith('preset:')?preset(value.split(':')[1]):structuredClone(profiles.find(p=>p.id===value).config);
  if(keepMode){
   c.ros_master_uri=config.ros_master_uri;
  }else{
   setMode(c.studio_input_mode||(c.runner?.bag?'bag':c.runner?'algorithm':'attach'));
  }
  if(c.runner?.bag?.path){setBag(c.runner.bag.path);setDirectory(c.runner.bag.path.slice(0,c.runner.bag.path.lastIndexOf('/')));}
  delete c.studio_input_mode;setConfig(c);
 };
 const fullConfig=()=>{
  const c=structuredClone(config);c.save_recording=false;
  if(mode==='attach')delete c.runner;
  else {if(!c.runner?.commands?.length)throw new Error('请填写启动命令，或选择连接已运行算法');if(mode==='bag')c.runner.bag={...(c.runner.bag||{}),path:bag,rate:c.runner.bag?.rate||1,start:0,duration:-1,clock:false};else delete c.runner.bag;}
  return c;
 };
 const save=async copy=>{try{const c=structuredClone(config);c.studio_input_mode=mode;if(mode==='bag'&&c.runner)c.runner.bag={...(c.runner.bag||{}),path:bag,rate:1,start:0,duration:-1,clock:false};const p=await api('/api/connection-profiles',{id:!copy&&!selected.startsWith('preset:')?selected:undefined,name:config.name,config:c});await refresh();setSelected(p.id);setDirty(false);setNotice('配置已保存');}catch(e){setError(e.message);}};
 const run=async()=>{setBusy(true);setError('');try{await connect(fullConfig());}catch(e){setError(e.message);}finally{setBusy(false);}};
 const updateChannel=(kind,i,patch)=>{setConfig(c=>({...c,[kind]:c[kind].map((t,j)=>j===i?{...t,...patch}:t)}));setDirty(true);setNotice('');};
 const updateCommand=patch=>edit({...config,runner:{...(config.runner||{}),commands:[{...(config.runner?.commands?.[0]||{}),...patch},...(config.runner?.commands?.slice(1)||[])]}});
 const launchArgs=config.runner?.commands?.[0]?.argv;
 const argv=Array.isArray(launchArgs)&&launchArgs.every(arg=>typeof arg==='string')?launchArgs:[];
 const retryArg=argv.find(arg=>arg.startsWith(stereoRetryArg));
 const showRetry=mode!=='attach'&&retryArg!==undefined&&argv[0]==='roslaunch'&&argv[1]==='ov_msckf'&&argv[2]==='subscribe.launch';
 const updateStereoRetry=enabled=>updateCommand({argv:[...argv.filter(arg=>!arg.startsWith(stereoRetryArg)),stereoRetryArg+enabled]});
 return <div className="simple-dialog unified-config">
  <label>算法配置<select aria-label="算法配置" value={selected} disabled={busy} onChange={e=>choose(e.target.value)}><optgroup label="内置模板"><option value="preset:astra">AstraVins</option><option value="preset:igof">IMU-guided OpenVINS</option><option value="preset:basalt">Basalt Astra 1021</option></optgroup>{profiles.length>0&&<optgroup label="本机保存">{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>}</select></label>
  <div className="algorithm-switches">
   <label><input type="checkbox" role="switch" checked={selected==='preset:igof'} disabled={busy}
    onChange={e=>choose(e.target.checked?'preset:igof':'preset:astra',true)}/>使用 IMU-guided OpenVINS 模板</label>
   {showRetry&&<label><input type="checkbox" role="switch" checked={retryArg===stereoRetryArg+'true'}
    disabled={busy||!!raw||jsonDraft!==null} onChange={e=>updateStereoRetry(e.target.checked)}/>双目 KLT 重关联</label>}
  </div>
  <label>配置名称<input aria-label="配置名称" value={config.name} onChange={e=>edit({...config,name:e.target.value})}/></label>

  <div className="workflow-tabs" role="tablist" aria-label="运行方式">{[['algorithm','启动算法'],['bag','读取 bag'],['attach','连接已运行算法']].map(([id,label])=><button key={id} role="tab" aria-selected={mode===id} onClick={()=>{setMode(id);setDirty(true);if(id==='bag'&&mode!=='bag')edit({...config,ros_master_uri:'http://localhost:'+(20000+crypto.getRandomValues(new Uint32Array(1))[0]%40000)});}}>{label}</button>)}</div>
  <p className="workflow-help">下方是当前配置。保存与运行均使用这些设置。{mode==='attach'?'仅订阅所选话题，不启动算法。':''}</p>
  {config.description&&<p className="workflow-help">{config.description}</p>}
  {mode==='bag'&&<><label>数据包目录<div className="path-row"><input aria-label="数据包目录" value={directory} onChange={e=>setDirectory(e.target.value)}/><button onClick={scan}>扫描</button></div></label><label>数据包<select aria-label="数据包" value={bag} onChange={e=>{setBag(e.target.value);setDirty(true);}}>{bags.map(b=><option key={b.path} value={b.path}>{b.name}</option>)}</select></label></>}
  <div className="form-grid"><label>ROS Master<input aria-label="ROS Master" value={config.ros_master_uri||''} onChange={e=>edit({...config,ros_master_uri:e.target.value})}/></label><label>世界坐标系<input aria-label="世界坐标系" value={config.frame_id||''} onChange={e=>edit({...config,frame_id:e.target.value})}/></label></div>
  {(config.tracks||[]).map((t,i)=><div className="form-grid" key={'pose'+i}><TopicPicker label={i===0?'位姿话题':'位姿话题 '+(i+1)} id={'unified-pose-'+i} master={config.ros_master_uri||''} value={t.topic||''} onChange={topic=>updateChannel('tracks',i,{topic})} onType={type=>updateChannel('tracks',i,{type})}/><label>消息类型<input aria-label={'位姿消息类型 '+(i+1)} value={t.type||''} onChange={e=>updateChannel('tracks',i,{type:e.target.value})}/></label></div>)}
  {(config.cameras||[]).map((t,i)=><div className="form-grid" key={'image'+i}><TopicPicker label={t.role==='diagnostic'?'外点剔除图像话题':'图像话题 '+(i+1)} id={'unified-image-'+i} master={config.ros_master_uri||''} value={t.topic||''} onChange={topic=>updateChannel('cameras',i,{topic})} onType={type=>updateChannel('cameras',i,{type})}/><label>消息类型<input aria-label={'图像消息类型 '+(i+1)} value={t.type||''} onChange={e=>updateChannel('cameras',i,{type:e.target.value})}/></label></div>)}
  {mode!=='attach'&&<section className="launch-config"><h3>算法启动配置</h3><label>工作目录<input aria-label="工作目录" value={config.runner?.commands?.[0]?.cwd||''} onChange={e=>updateCommand({cwd:e.target.value})}/></label><label>ROS 环境脚本（每行一个）<textarea aria-label="ROS 环境脚本" value={(config.runner?.commands?.[0]?.setup||[]).join('\n')} onChange={e=>updateCommand({setup:e.target.value.split('\n').filter(Boolean)})}/></label><label>启动命令参数（JSON 数组）<textarea aria-label="启动命令" value={raw||JSON.stringify(config.runner?.commands?.[0]?.argv||[],null,2)} onChange={e=>{setRaw(e.target.value);try{const argv=JSON.parse(e.target.value);if(Array.isArray(argv)&&argv.every(v=>typeof v==='string')){updateCommand({argv});setRaw('');}}catch{}}}/></label></section>}
  {error&&<p className="job-error" role="alert">{error}</p>}

  <details className="workflow-advanced"><summary>完整配置 JSON（多算法、环境变量等）</summary><textarea className="project-editor" aria-label="完整连接配置" value={jsonDraft??JSON.stringify(config,null,2)} onChange={e=>{setJsonDraft(e.target.value);try{const c=JSON.parse(e.target.value);if(Array.isArray(c.tracks)&&Array.isArray(c.cameras)){edit(c);setJsonDraft(null);}}catch{}}}/></details>
  <div className="config-save"><button disabled={busy||!!raw||jsonDraft!==null} onClick={()=>save(false)}>{selected.startsWith('preset:')?'保存为我的配置':'保存修改'}</button>{!selected.startsWith('preset:')&&<button onClick={()=>save(true)}>另存为</button>}<small>{notice||(dirty?'有未保存修改':selected.startsWith('preset:')?'内置模板，修改后可保存副本':'已保存配置')}</small></div>
  <div className="modal-actions"><button className="primary" disabled={busy||!!raw||jsonDraft!==null||(mode==='bag'&&!bag)} onClick={run}>{busy?'正在启动…':mode==='attach'?'连接并显示':mode==='bag'?'运行并播放':'启动算法'}</button></div>
  {sessions.length>0&&<details className="workflow-advanced"><summary>重新打开已有运行</summary><div className="replay-list">{sessions.map(s=><button key={s.id} data-session-id={s.id} onClick={()=>resume(s.id).catch(e=>setError(e.message))}>{s.name}<small>{s.status}</small></button>)}</div></details>}
 </div>;
}
