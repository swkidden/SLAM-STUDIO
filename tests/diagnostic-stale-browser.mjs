import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base=process.env.STUDIO_URL||'http://127.0.0.1:8772';
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1280,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
const post=async(path,data)=>{const r=await page.request.post(base+path,{data});const body=await r.json();assert(r.ok(),JSON.stringify(body));return body;};
try{
 await page.route('**/api/projects',r=>r.fulfill({contentType:'application/json',body:'[]'}));
 await page.goto(base);await page.waitForFunction(()=>window.vio);
 const id=await page.evaluate(()=>window.vio.connectLive({adapter:'http',name:'Diagnostic gap',tracks:[{id:'v',name:'VIO'}],cameras:[{topic:'left'},{topic:'filter',role:'diagnostic'}]}));
 const jpeg=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=64;c.height=48;c.getContext('2d').fillRect(0,0,64,48);return c.toDataURL('image/jpeg').split(',')[1];});
 await post(`/api/live/${id}/samples`,{poses:[{track:'v',stamp:100,position:[0,0,0],orientation:[0,0,0,1]}],frames:[{camera:1,stamp:100,jpeg}]});
 await page.getByRole('tab',{name:'外点剔除',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.diagnostic-panel img'));
 await post(`/api/live/${id}/samples`,{poses:[{track:'v',stamp:100.4,position:[.4,0,0],orientation:[0,0,0,1]}]});
 await page.waitForFunction(()=>document.querySelector('.frame-age')?.textContent.includes('400 ms'));
 assert.equal(await page.locator('.diagnostic-panel img').count(),1);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,age:await page.locator('.frame-age').textContent()}));
}finally{await browser.close();}
