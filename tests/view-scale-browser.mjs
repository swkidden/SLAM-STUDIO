import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const base=process.env.STUDIO_URL||'http://127.0.0.1:8772',out='test-results/simple_workflow_20261113';
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:900}});
try{
 const path=fs.realpathSync(out)+'/fixture.tum';
 fs.writeFileSync(path,'100 0 0 0 0 0 0 1\n101 0.4 0 0 0 0 0 1\n102 0.8 0.2 0 0 0 0.05 0.998749\n103 1.2 0.5 0 0 0 0.1 0.994987\n');
 const r=await page.request.post(base+'/api/load',{data:{name:'Scale check',methods:[{name:'VIO',path}]}});const job=await r.json();assert(r.ok());
 let state;for(let i=0;i<100;i++){state=await(await page.request.get(base+'/api/session/'+job.id)).json();if(state.status==='ready')break;await page.waitForTimeout(30);}assert.equal(state.status,'ready');
 await page.goto(base);await page.waitForFunction(()=>window.vio);await page.evaluate(id=>window.vio.loadSession(id,{camera:'follow'},[0,3]),job.id);
 await page.waitForSelector('.three-scene canvas');
 const display=await page.evaluate(()=>({settings:window.vio.getState().settings,camera:window.vio.getCamera(),canvas:[document.querySelector('canvas').width,document.querySelector('canvas').height]}));
 assert.equal(display.settings.followDistance,1);assert.equal(display.settings.followHeight,1);assert.equal(display.settings.frustumLength,.25);assert.equal(display.settings.frustums,true);
 await page.screenshot({path:out+'/scale-check.png'});console.log(JSON.stringify(display));
}finally{await browser.close();}
