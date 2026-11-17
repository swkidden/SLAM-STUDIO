import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base=process.env.STUDIO_URL||'http://127.0.0.1:8772';
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 const saved=[];
 await page.route('**/api/projects',r=>r.fulfill({contentType:'application/json',body:'[]'}));
 await page.route('**/api/connection-profiles',r=>r.request().method()==='GET'?r.fulfill({contentType:'application/json',body:JSON.stringify(saved)}):r.fulfill({contentType:'application/json',body:(saved.push({id:'profile1',name:'Astra test',config:r.request().postDataJSON().config}),JSON.stringify(saved[0]))}));
 await page.route('**/api/ros/topics*',r=>r.fulfill({contentType:'application/json',body:JSON.stringify([{name:'/custom/pose',type:'geometry_msgs/PoseStamped'},{name:'/custom/image',type:'sensor_msgs/Image'}])}));
 await page.goto(base);await page.locator('.app-header').getByRole('button',{name:'运行算法',exact:true}).click();await page.getByText('其他算法 / 高级设置',{exact:true}).click();
 await page.getByLabel('配置名称',{exact:true}).fill('Astra test');
 await page.waitForFunction(()=>[...document.querySelectorAll('datalist')].some(d=>[...d.options].some(o=>o.value==='/custom/pose')));
 const topic=page.getByLabel('位姿话题',{exact:true});await topic.fill('/custom/pose');
 await page.waitForFunction(()=>document.querySelector('select[value="geometry_msgs/PoseStamped"]')||[...document.querySelectorAll('select')].some(s=>s.value==='geometry_msgs/PoseStamped'));
 await page.getByRole('button',{name:'保存配置',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[aria-label="已保存连接配置"]')?.options.length===2);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,discovered:'/custom/pose',savedProfile:'Astra test'}));
}finally{await browser.close();}
