import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const url=process.env.STUDIO_URL||'http://127.0.0.1:8771';
const out=process.env.RESULT_DIR||'test-results/stream_repair_20261113';fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1280,height:800}});const errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/projects',r=>r.fulfill({contentType:'application/json',body:'[]'}));
const post=async(path,data)=>{const r=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const v=await r.json();assert(r.ok,JSON.stringify(v));return v;};
const get=async(path)=>{const r=await fetch(url+path);assert(r.ok);return r.json();};
const summary=[];
try{
 await page.goto(url);await page.waitForFunction(()=>window.vio);
 const jpeg=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=752;c.height=480;const ctx=c.getContext('2d');const pixels=ctx.createImageData(752,480);let seed=7;for(let i=0;i<pixels.data.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)|0;pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=seed>>>24;pixels.data[i+3]=255;}ctx.putImageData(pixels,0,0);return c.toDataURL('image/jpeg',.7).split(',')[1];});
 for(const hz of [25,30]){
  const id=await page.evaluate(async()=>window.vio.connectLive({adapter:'http',name:'Controlled input',save_recording:false,tracks:[{id:'v',name:'VIO'}],cameras:[{topic:'left'},{topic:'right'},{topic:'outliers',role:'diagnostic'}],max_frames:10,history_seconds:2}),null);
  await page.getByRole('button',{name:'自由视角',exact:true}).click();
  const sent={},interval=1000/hz,n=hz*60,started=performance.now();
  for(let i=0;i<n;i++){
   if(i===hz*30)await page.getByRole('tab',{name:'外点剔除',exact:true}).click();
   const due=started+i*interval;await new Promise(r=>setTimeout(r,Math.max(0,due-performance.now())));
   // Source time is wall time so end-to-end delay includes ingestion and browser decode.
   const stamp=Date.now()/1000;sent[i]=stamp*1000;
   await post(`/api/live/${id}/samples`,{poses:[{track:'v',stamp,position:[i*.001,0,0],orientation:[0,0,0,1]}],frames:[0,1,2].map(camera=>({camera,stamp,jpeg}))});
  }
  await page.waitForTimeout(500);
  const stats=await page.evaluate(()=>({display:window.slamDisplayStats,origin:performance.timeOrigin,state:window.vio.getState(),gpu:document.querySelector('canvas')?.getContext('webgl2')?.getParameter(7937)}));
  const data=await get(`/api/data/${id}?history=1`);
  const begin=data.epoch*1000;
  const metrics=[0,1,2].map(camera=>{
    const lo=camera===2?32:2,hi=camera===2?58:28;
    const sourceInWindow=data.cameras[camera].stamps.filter(t=>t>=lo&&t<hi).length;
    const records=(stats.display[`${id}:${camera}`]||[]).filter(r=>r.stamp>=lo&&r.stamp<hi);
    const times=records.map(r=>stats.origin+r.at-(begin+r.stamp*1000)).sort((a,b)=>a-b);
    return {camera,decoded:records.length,fps:records.length/(hi-lo),source_fps:sourceInWindow/(hi-lo),display_ratio:records.length/sourceInWindow,latency_p95_ms:times[Math.floor(times.length*.95)]};
  });
  summary.push({hz,source_frames:n,elapsed_s:(performance.now()-started)/1000,jpeg_bytes:Buffer.from(jpeg,'base64').length,metrics,archived:data.cameras.map(c=>c.count),pose_count:data.tracks[0].poses.length,browser:browser.version(),gpu:stats.gpu,errors:[...errors]});
  console.log(JSON.stringify(summary.at(-1)));fs.writeFileSync(`${out}/performance.json`,JSON.stringify(summary,null,2));
  assert.deepEqual(data.cameras.map(c=>c.count),[n,n,n]);
  await page.getByRole('button',{name:'暂停实时显示',exact:true}).click();
  await page.waitForFunction(()=>!window.vio.getState().live);await page.locator('input[aria-label="播放位置"]').fill('0');
  await page.waitForFunction(()=>document.querySelector('.camera-frame img')?.dataset.frame==='0');
  const before=await get(`/api/live/${id}`);await post(`/api/live/${id}/samples`,{poses:[{track:'v',stamp:Date.now()/1000,position:[2,0,0],orientation:[0,0,0,1]}]});
  const after=await get(`/api/live/${id}`);assert(after.counts.poses>before.counts.poses);
  await page.getByRole('button',{name:'回到实时',exact:true}).click();await page.waitForFunction(()=>window.vio.getState().following);
  await page.getByRole('button',{name:'停止运行',exact:true}).click();await page.waitForFunction(()=>!window.vio.getState().live);
  assert((await get(`/api/data/${id}?history=1`)).cameras[0].count===n);
  await page.getByRole('button',{name:'保存记录',exact:true}).click();
  assert((await get('/api/recordings')).some(r=>r.id===id));
  await page.screenshot({path:`${out}/stream-${hz}.png`});
  for(const m of metrics){assert(m.fps>=hz*.9,`Display ${m.fps} below target ${hz*.9}`);assert(m.latency_p95_ms<250,`latency ${m.latency_p95_ms}`);}
 }
 assert.deepEqual(errors,[]);
}finally{await browser.close();}
