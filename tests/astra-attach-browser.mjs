import {chromium} from 'playwright';
import fs from 'node:fs';
const base=process.env.STUDIO_URL||'http://127.0.0.1:8771',out='test-results/stream_repair_20261113';
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1280,height:800}});const errors=[];
page.on('pageerror',e=>errors.push(e.message));await page.route('**/api/projects',r=>r.fulfill({contentType:'application/json',body:'[]'}));
try{
 await page.goto(base);await page.waitForFunction(()=>window.vio);
 const config=JSON.parse(fs.readFileSync(process.env.STUDIO_LIVE_CONFIG||'examples/live-astravins-attach.json'));config.ros_master_uri=process.env.ROS_MASTER_URI||config.ros_master_uri;
 const id=await page.evaluate(c=>window.vio.connectLive(c),config);
 await page.waitForTimeout(Number(process.env.STUDIO_WAIT_MS||15000));
 const s=await(await page.request.get(base+`/api/live/${id}`)).json();
 const visual=await page.evaluate(()=>({state:window.vio.getState(),streams:[...document.querySelectorAll('.camera-frame img,.video-background img')].map(i=>({stamp:i.dataset.stamp,loaded:i.complete&&i.naturalWidth>0}))}));
 fs.writeFileSync(out+'/astra-attach.json',JSON.stringify({id,status:s.status,runner_status:s.runner_status,runner_error:s.runner_error,counts:s.counts,pose_count:s.tracks?.[0]?.poses.length,cameras:s.cameras,display:visual,errors},null,2));
 await page.screenshot({path:out+'/astra-attach.png'});
 await page.getByRole('button',{name:'停止运行',exact:true}).click();await page.waitForFunction(()=>!window.vio.getState().live);
 await page.getByRole('button',{name:'保存记录',exact:true}).click();
 console.log(JSON.stringify({id,status:s.status,counts:s.counts,errors}));
}finally{await browser.close();}
