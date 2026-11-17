import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const base=process.env.STUDIO_URL||'http://127.0.0.1:8772',out='test-results/simple_workflow_20261113';
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const title='流程测试 '+Date.now();
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
const post=async(p,data)=>{const r=await page.request.post(base+p,{data});const b=await r.json();assert(r.ok(),JSON.stringify(b));return b;};
try{
 await page.goto(base);await page.waitForFunction(()=>window.vio);assert.equal(await page.locator('.three-scene canvas').count(),0,'No arbitrary project auto-load');
 await page.screenshot({path:out+'/home.png'});
 await page.locator('.app-header').getByRole('button',{name:'运行算法',exact:true}).click();
 assert.equal(await page.getByLabel('ROS Master',{exact:true}).isVisible(),false);
 await page.getByRole('tab',{name:'读取 bag',exact:true}).click();await page.waitForFunction(()=>document.querySelector('select[aria-label="数据包"]')?.options.length>1);
 await page.screenshot({path:out+'/run.png'});
 let requested;await page.route('**/api/live',async route=>{
  if(route.request().method()!=='POST')return route.continue();requested=route.request().postDataJSON();
  const fixture=await post('/api/live',{adapter:'http',name:title,tracks:[{id:'v',name:'VIO'}],cameras:[]});
  await route.fulfill({contentType:'application/json',body:JSON.stringify(fixture)});
 });
 await page.getByRole('button',{name:'运行并播放',exact:true}).click();await page.waitForFunction(()=>window.vio.getState().live);
 assert(requested.ros_master_uri.startsWith('http://localhost:'));assert.notEqual(requested.ros_master_uri,'http://localhost:11311');assert.deepEqual(requested.runner.commands[0].argv,['roslaunch','ov_srvins','astra_1021.launch']);assert(requested.runner.bag.path.endsWith('.bag'));assert.equal(requested.save_recording,false);
 const id=await page.evaluate(()=>window.vio.getState().session);
 for(let i=0;i<5;i++)await post('/api/live/'+id+'/samples',{poses:[{track:'v',stamp:100+i*.1,position:[i*.1,0,0],orientation:[0,0,0,1]}]});
 await page.waitForFunction(()=>window.vio.getState().time>.2);await page.getByRole('button',{name:'停止运行',exact:true}).click();await page.waitForFunction(()=>!window.vio.getState().live&&window.vio.getState().time===0);
 await page.getByRole('button',{name:'保存记录',exact:true}).click();
 await page.locator('.app-header').getByRole('button',{name:'打开回放',exact:true}).click();await page.getByRole('button',{name:new RegExp(title)}).click();await page.waitForFunction(()=>!window.vio.getState().live);
 await page.locator('.app-header').getByRole('button',{name:'打开回放',exact:true}).click();await page.getByRole('tab',{name:'轨迹文件',exact:true}).click();
 const path=fs.realpathSync(out)+'/fixture.tum';fs.writeFileSync(path,'100 0 0 0 0 0 0 1\n101 1 0 0 0 0 0 1\n');await page.getByLabel('轨迹 1',{exact:true}).fill(path);await page.screenshot({path:out+'/open.png'});
 await page.getByRole('button',{name:'打开轨迹',exact:true}).click();await page.waitForFunction(()=>window.vio.getState().poses?.[0]===2);await page.waitForFunction(()=>!document.querySelector('[role="dialog"]'));
 await page.screenshot({path:out+'/replay.png'});assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,id,errors,launch:requested.runner.commands[0].argv}));
}finally{await browser.close();}
