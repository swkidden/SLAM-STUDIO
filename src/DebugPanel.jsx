import React,{useMemo,useState} from 'react';
import './debug.css';

function display(value){
  if(value===null||value===undefined)return '—';
  if(typeof value==='number')return Number.isInteger(value)?String(value):Math.abs(value)>=1e6?value.toFixed(6):Number(value.toPrecision(5)).toString();
  return String(value);
}

export default function DebugPanel({data,time,onTime}){
  const [query,setQuery]=useState(''),[selected,setSelected]=useState('');
  const samples=data.diagnostics||[];
  const groups=useMemo(()=>{
    const result=new Map();
    for(const sample of samples){
      if(sample.stamp>time+1e-6)continue;
      const id=sample.source+'|'+sample.name;
      if(!result.has(id)||result.get(id).stamp<=sample.stamp)result.set(id,sample);
    }
    return [...result.entries()];
  },[samples,time]);
  const fields=[];
  for(const [id,sample] of groups)for(const [key,value] of Object.entries(sample.values||{})){
    if((sample.source+' '+sample.name+' '+key).toLowerCase().includes(query.toLowerCase()))fields.push({id:id+'|'+key,group:sample.name,key,value,sample});
  }
  const field=fields.find(f=>f.id===selected);
  const history=field?samples.filter(s=>s.source===field.sample.source&&s.name===field.sample.name&&typeof s.values?.[field.key]==='number').sort((a,b)=>a.stamp-b.stamp):[];
  const low=Math.min(0,...history.map(s=>s.values[field.key])),high=Math.max(1,...history.map(s=>s.values[field.key]));
  const begin=history[0]?.stamp??0,end=history.at(-1)?.stamp??1;
  return <section className="debug-panel" aria-label="通用调试面板">
    <input aria-label="搜索调试字段" placeholder="搜索来源或字段" value={query} onChange={e=>setQuery(e.target.value)}/>
    {!groups.length&&<p className="debug-empty">等待诊断数据</p>}
    {groups.map(([id,sample])=><div className="debug-status" key={id} title={sample.source}>
      <span>{sample.name}</span><span>{time-sample.stamp>.5?'数据过期':sample.message||'正常'}</span>
    </div>)}
    <div className="debug-fields">{[...new Set(fields.map(f=>f.group))].map(group=>{
      const entries=fields.filter(f=>f.group===group);
      const render=f=><button className={f.id===selected?'selected':''} key={f.id} title={f.group} onClick={()=>setSelected(f.id)}><span>{f.key}</span><strong>{display(f.value)}</strong></button>;
      const prefixes=[...new Set(entries.filter(f=>f.key.includes('.')).map(f=>f.key.split('.')[0]))];
      const collapsed=new Set(prefixes.filter(prefix=>entries.filter(f=>f.key.startsWith(prefix+'.')).length>3));
      return <React.Fragment key={group}>
        {entries.filter(f=>!collapsed.has(f.key.split('.')[0])).map(render)}
        {[...collapsed].map(prefix=><details key={prefix}><summary>{prefix}</summary>{entries.filter(f=>f.key.startsWith(prefix+'.')).map(render)}</details>)}
      </React.Fragment>;
    })}</div>
    {history.length>0&&<div className="debug-chart"><span>{field.key}</span><svg viewBox="0 0 320 110" role="img" aria-label="调试字段曲线" onClick={e=>{const b=e.currentTarget.getBoundingClientRect();onTime(begin+(end-begin)*(e.clientX-b.left)/b.width);}}>
      <polyline fill="none" stroke="var(--accent,#67b7ff)" strokeWidth="1.5" points={history.map(s=>`${(s.stamp-begin)/Math.max(end-begin,.001)*320},${100-(s.values[field.key]-low)/(high-low)*90}`).join(' ')}/>
      <line x1={(time-begin)/Math.max(end-begin,.001)*320} x2={(time-begin)/Math.max(end-begin,.001)*320} y1="0" y2="110" stroke="var(--text)"/>
    </svg><small>{display(low)} — {display(high)}</small></div>}
  </section>;
}
