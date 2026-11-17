import {chromium} from 'playwright';
import {Matrix4,Vector3} from 'three';
import {followView,poseAt} from '../src/model.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';

fs.mkdirSync('test-results',{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const url='http://127.0.0.1:8765';
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8765');
  await page.waitForFunction(()=>window.vio?.getState().session&&!document.querySelector('.loading-overlay'),null,{timeout:240000});
  const state=await page.evaluate(()=>window.vio.getState());
  const {data}=await(await page.request.get(url+'/api/session/'+state.session)).json();
  const extrinsic=new Matrix4().set(...data.project.body_from_camera.flat());
  await page.getByRole('button',{name:'跟随',exact:true}).click();
  const offsets=[];
  for(const time of [12,40,12]){
    await page.evaluate(t=>window.vio.renderAt(t),time);
    const camera=await page.evaluate(()=>window.vio.getCamera());
    const pose=poseAt(data.tracks.find(t=>t.id==='method_0').poses,time,data.max_gap);
    const expected=followView(pose,extrinsic,state.settings);
    assert(new Vector3(...camera.position).distanceTo(expected.position)<1e-8);
    assert(new Vector3(...camera.target).distanceTo(pose.position)<1e-8);
    offsets.push(new Vector3(...camera.position).sub(pose.position));
  }
  assert(offsets[0].distanceTo(offsets[1])>1,'Camera offset must turn with heading');
  assert(offsets[0].distanceTo(offsets[2])<1e-8,'Seeking must not depend on previous frame');
  await page.getByRole('button',{name:'展示设置',exact:true}).first().click();
  await page.getByLabel('跟随距离',{exact:true}).fill('15');
  await page.getByLabel('跟随高度',{exact:true}).fill('8');
  await page.getByLabel('跟随角度',{exact:true}).fill('30');
  await page.getByLabel('跟随目标',{exact:true}).selectOption('method_3');
  await page.getByRole('button',{name:'完成',exact:true}).click();
  await page.evaluate(()=>window.vio.renderAt(40));
  const configured=await page.evaluate(()=>window.vio.getState());
  const camera=await page.evaluate(()=>window.vio.getCamera());
  const expected=followView(poseAt(data.tracks.find(t=>t.id==='method_3').poses,40,data.max_gap),extrinsic,configured.settings);
  assert(new Vector3(...camera.position).distanceTo(expected.position)<1e-8);
  await page.screenshot({path:'test-results/follow-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.vio.renderAt(40));
  await page.screenshot({path:'test-results/follow-mobile.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const job=await(await page.request.post(url+'/api/export',{data:{session:data.id,kind:'video',start:40,end:41,height:720,fps:24,view:configured.settings}})).json();
  assert(job.id,JSON.stringify(job));
  for(let i=0;i<120;i++){
    const result=await(await page.request.get(url+'/api/export/'+job.id)).json();
    if(result.status==='error')throw new Error(result.error);
    if(result.status==='done'){
      assert.equal(result.frame,24);
      fs.copyFileSync(result.output,'exports/slam_studio_follow_demo.mp4');
      console.log(JSON.stringify({follow:'passed',seek:'passed',settings:'passed',export:result.output,frames:result.frame,errors}));
      assert.deepEqual(errors,[]);break;
    }
    if(i===119)throw new Error('Export timeout');
    await page.waitForTimeout(1000);
  }
}finally{await browser.close();}
