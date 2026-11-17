import {chromium} from 'playwright';import assert from 'node:assert/strict';
const base=process.env.STUDIO_URL||'http://127.0.0.1:8767';
const b=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});const p=await b.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));let id;
const post=async(path,data)=>{const r=await p.request.post(base+path,{data});const result=await r.json();assert(r.ok(),JSON.stringify(result));return result;};
try{
 await p.route('**/api/projects',r=>r.fulfill({contentType:'application/json',body:'[]'}));await p.goto(base);await p.waitForFunction(()=>window.vio);
 id=await p.evaluate(()=>window.vio.connectLive({adapter:'http',tracks:[{id:'v'}],cameras:[{topic:'left'}]}));
 const jpeg=await p.evaluate(()=>{const c=document.createElement('canvas');c.width=32;c.height=24;return c.toDataURL('image/jpeg').split(',')[1];});
 await post(`/api/live/${id}/samples`,{poses:[{track:'v',stamp:100,position:[0,0,0],orientation:[0,0,0,1]}],frames:[{camera:0,stamp:100,jpeg}]});
 await p.waitForFunction(()=>document.querySelector('canvas')?.dataset.frustumVisible==='true');
 for(let i=1;i<=10;i++){
  await post(`/api/live/${id}/samples`,{frames:[{camera:0,stamp:100+i*.04,jpeg}]});
  await p.waitForFunction(t=>Math.abs(window.vio.getState().time-t)<1e-5,i*.04);
  await p.waitForTimeout(20);assert.equal(await p.locator('canvas').getAttribute('data-frustum-visible'),'true');
 }
 assert((await p.locator('.pose-delay').textContent()).includes('位姿滞后'));
 await post(`/api/live/${id}/samples`,{poses:[{track:'v',stamp:100.4,position:[.4,0,0],orientation:[0,0,0,1]}]});await p.waitForFunction(()=>document.querySelector('canvas')?.dataset.poseAge==='0');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,imageOnlyUpdates:10,errors}));
}finally{if(id)await post(`/api/live/${id}/discard`,{});await b.close();}
