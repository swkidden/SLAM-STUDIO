import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const url=process.env.STUDIO_URL||'http://127.0.0.1:8765',ros=process.env.ROS_LIVE_TEST==='1';
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
let id;
const get=async path=>(await page.request.get(url+path)).json();
const post=async(path,data)=>{
  const r=await page.request.post(url+path,{data});const body=await r.json();assert(r.ok(),JSON.stringify(body));return body;
};
const state=()=>page.evaluate(()=>window.vio.getState());
try{
  await page.route('**/api/projects',route=>route.fulfill({status:200,contentType:'application/json',body:'[]'}));
  await page.goto(url);
  await page.waitForFunction(()=>window.vio?.connectLive);
  const jpeg=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=32;canvas.height=24;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#247ca3';ctx.fillRect(0,0,32,24);
    return canvas.toDataURL('image/jpeg').split(',')[1];
  });
  await page.locator('.app-header').getByRole('button',{name:'运行算法',exact:true}).click();
  await page.getByText('其他算法 / 高级设置',{exact:true}).click();
  await page.getByRole('checkbox',{name:'自定义 JSON'}).check();
  const config={name:ros?'VINS-Fusion original / Live':'HTTP live test',adapter:ros?'ros1':'http',frame_id:'world',
    ros_master_uri:'http://localhost:11429',max_frames:60,
    body_from_camera:[[0,0,1,0],[1,0,0,0],[0,1,0,0],[0,0,0,1]],
    tracks:[{id:'vio',name:'VINS-Fusion',topic:'/vins_estimator/odometry',type:'nav_msgs/Odometry',color:'#c7ef79'}],
    cameras:[{topic:'/cam0/image_raw',type:'sensor_msgs/Image'}]};
  if(!ros)config.tracks.push({id:'gt',name:'Ground truth',truth:true,color:'#aaaaaa'});
  await page.getByLabel('实时接入 JSON',{exact:true}).fill(JSON.stringify(config));
  await page.getByRole('button',{name:'连接',exact:true}).click();
  await page.waitForFunction(()=>window.vio.getState().live);
  id=(await state()).session;console.log(JSON.stringify({live:id,waitingFor:ros?'real ROS VINS data':'HTTP'}));
  const push=async i=>post(`/api/live/${id}/samples`,{
    poses:['vio','gt'].map(track=>({track,stamp:1000+i*.05,position:[i*.07,Math.sin(i*.03),0],orientation:[0,0,Math.sin(i*.005),Math.cos(i*.005)]})),
    frames:[{camera:0,stamp:1000+i*.05,jpeg}]});
  if(!ros){for(let i=0;i<40;i++){await push(i);await page.waitForTimeout(40);}}
  await page.waitForFunction(()=>window.vio.getState().poses?.[0]>=20,null,{timeout:180000});
  await page.locator('.three-scene canvas').evaluate(c=>c.dataset.stable='yes');
  const first=await state(),camera=await page.evaluate(()=>window.vio.getCamera());
  if(!ros){for(let i=40;i<65;i++){await push(i);await page.waitForTimeout(40);}}
  else await page.waitForTimeout(5000);
  assert((await state()).time>first.time);
  assert.notDeepEqual(await page.evaluate(()=>window.vio.getCamera()),camera);
  assert.equal(await page.locator('.three-scene canvas').getAttribute('data-stable'),'yes','Streaming must not recreate WebGL');
  await page.getByRole('button',{name:'暂停实时显示',exact:true}).click();
  const frozen=await state(),received=(await get(`/api/live/${id}`)).counts.poses;
  if(!ros){for(let i=65;i<70;i++)await push(i);}else await page.waitForTimeout(2000);
  await page.waitForTimeout(400);
  assert.equal((await state()).time,frozen.time);
  assert((await get(`/api/live/${id}`)).counts.poses>received,'Pausing display must not pause reception');
  await page.getByRole('button',{name:'回到实时',exact:true}).click();
  await page.waitForFunction(t=>window.vio.getState().time>t,frozen.time);
  assert.equal(await page.locator('.metric,.error-plot').count(),0,'No unaligned live APE');
  assert(await page.getByRole('button',{name:'保存工程',exact:true}).isDisabled());
  const pixels=await page.locator('.three-scene canvas').evaluate(c=>{
    const gl=c.getContext('webgl2'),p=new Uint8Array(c.width*c.height*4);gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,p);
    let drawn=0,clear=0;for(let i=3;i<p.length;i+=4){if(p[i])drawn++;else clear++;}return {drawn,clear};
  });
  assert(pixels.drawn>500&&pixels.clear>10000,JSON.stringify(pixels));
  await page.waitForFunction(()=>document.querySelector('.video-background img')?.naturalWidth>0);
  fs.mkdirSync('test-results',{recursive:true});
  const label=ros?'live-ros':'live-http';
  await page.screenshot({path:`test-results/${label}-desktop.png`});
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(300);
  await page.screenshot({path:`test-results/${label}-mobile.png`});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const mobile=await page.locator('.three-scene canvas').evaluate(c=>{
    const gl=c.getContext('webgl2'),p=new Uint8Array(c.width*c.height*4);gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,p);return p.some((v,i)=>i%4===3&&v>0);
  });assert(mobile);
  const result={mode:label,state:await state(),counts:(await get(`/api/live/${id}`)).counts,pixels,errors};
  await page.getByRole('button',{name:'断开实时接入',exact:true}).click();
  await page.waitForFunction(()=>window.vio.getState().status==='stopped');
  assert.equal((await get(`/api/live/${id}`)).status,'stopped');
  if(!ros){
    await page.waitForFunction(id=>document.querySelector(`option[value="${id}"]`),id,{timeout:10000});
    await page.locator('select[aria-label="选择序列"]').selectOption(id);
    await page.waitForFunction(()=>!window.vio.getState().live&&window.vio.getState().poses?.[0]===70);
    assert.equal((await page.locator('.video-background img').evaluate(img=>img.naturalWidth>0)),true,
      'Archived frames must remain readable after eviction from the live buffer');
    const archivedTime=await state();
    await page.getByRole('button',{name:'播放',exact:true}).click();
    await page.waitForFunction(t=>window.vio.getState().time>t,archivedTime.time);
    await page.getByRole('button',{name:'暂停',exact:true}).click();
    id=await page.evaluate(()=>window.vio.connectLive({adapter:'http',tracks:[{id:'only'}],cameras:[]}));
    await post(`/api/live/${id}/samples`,{poses:[{track:'only',stamp:1,position:[0,0,0],orientation:[0,0,0,1]}]});
    await page.waitForFunction(()=>window.vio.getState().poses[0]===1);
    await post(`/api/live/${id}/reset`,{});
    await page.waitForFunction(()=>window.vio.getState().poses[0]===0);
    await page.evaluate(()=>window.vio.disconnectLive());
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(`test-results/${label}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
  if(id)await page.request.post(url+`/api/live/${id}/stop`,{data:{}}).catch(()=>{});
  await browser.close();
}
