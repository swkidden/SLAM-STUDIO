import React,{useEffect,useState} from 'react';
import {api} from './model';

export function TopicPicker({label,value,onChange,onType,master,id}){
  const [topics,setTopics]=useState([]),[status,setStatus]=useState('');
  const refresh=async()=>{
    if(!master.trim()){setTopics([]);return;}
    setStatus('查询中…');
    try{const result=await api(`/api/ros/topics?master=${encodeURIComponent(master)}`);setTopics(result);setStatus(`发现 ${result.length} 个话题`);}
    catch(e){setStatus(e.message);setTopics([]);}
  };
  useEffect(()=>{refresh();},[master]);
  return <label>{label}<div className="topic-picker"><input aria-label={label} list={id} value={value} onChange={e=>{onChange(e.target.value);const found=topics.find(t=>t.name===e.target.value);if(found)onType?.(found.type);}}/><datalist id={id}>{topics.map(t=><option key={t.name} value={t.name}>{t.type}</option>)}</datalist><button type="button" title={status||'刷新 ROS 话题'} onClick={refresh}>刷新</button></div><small className="topic-status">{status||'可从发现列表选择，也可手动输入'}</small></label>;
}

