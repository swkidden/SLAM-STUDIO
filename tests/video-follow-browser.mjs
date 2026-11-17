import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const url='http://127.0.0.1:8765';
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
fs.mkdirSync('test-results',{recursive:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(()=>window.vio?.getState().session&&!document.querySelector('.loading-overlay'),null,{timeout:240000});
  const old=await page.evaluate(()=>window.vio.getState().session);
  await page.getByLabel('选择序列',{exact:true}).selectOption('parking_lot_3_high');
  await page.waitForFunction(id=>window.vio.getState().session!==id&&!document.querySelector('.loading-overlay'),old,{timeout:240000});
  const cameras=[];
  for(const time of [12,20,12]){
    await page.getByRole('button',{name:'跟随',exact:true}).click();
    await page.evaluate(t=>window.vio.renderAt(t),time);
    const normal=await page.evaluate(()=>window.vio.getCamera());
    await page.getByRole('button',{name:'视频跟随',exact:true}).click();
    await page.evaluate(t=>window.vio.renderAt(t),time);
    const video=await page.evaluate(()=>window.vio.getCamera());
    assert.deepEqual(video,normal,'Video mode must use exactly the normal follow camera');cameras.push(video);
    assert.equal(await page.locator('.video-background img').count(),1);
  }
  assert.deepEqual(cameras[0],cameras[2]);assert.notDeepEqual(cameras[0],cameras[1]);
  await page.evaluate(()=>window.vio.renderAt(20));
  const pixels=await page.locator('.three-scene canvas').evaluate(c=>{
    const gl=c.getContext('webgl2'),p=new Uint8Array(c.width*c.height*4);gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,p);
    let transparent=0,drawn=0;for(let i=3;i<p.length;i+=4){if(p[i]===0)transparent++;else drawn++;}return {transparent,drawn};
  });
  assert(pixels.transparent>100000);assert(pixels.drawn>1000);
  await page.screenshot({path:'test-results/video-follow-desktop.png'});
  const left=await page.locator('.video-background img').getAttribute('src');
  const before=await page.evaluate(()=>window.vio.getCamera());
  await page.getByRole('button',{name:'展示设置',exact:true}).first().click();
  await page.getByLabel('视频底图',{exact:true}).selectOption('1');
  await page.getByRole('button',{name:'完成',exact:true}).click();
  await page.evaluate(()=>window.vio.renderAt(20));
  assert((await page.locator('.video-background img').getAttribute('src')).includes('camera=1'));
  assert.deepEqual(await page.evaluate(()=>window.vio.getCamera()),before);
  await page.getByRole('button',{name:'展示设置',exact:true}).first().click();
  await page.getByLabel('视频底图',{exact:true}).selectOption('0');
  await page.getByLabel('跟随距离',{exact:true}).fill('12');
  await page.getByLabel('跟随高度',{exact:true}).fill('5');
  await page.getByRole('button',{name:'完成',exact:true}).click();
  await page.evaluate(()=>window.vio.renderAt(20));
  assert.notDeepEqual(await page.evaluate(()=>window.vio.getCamera()),before);
  await page.getByRole('button',{name:'下一帧',exact:true}).click();
  await page.evaluate(()=>window.vio.renderAt(window.vio.getState().time));
  assert.notEqual(await page.locator('.video-background img').getAttribute('src'),left);
  await page.getByRole('button',{name:'播放',exact:true}).click();await page.waitForTimeout(1500);
  await page.getByRole('button',{name:'暂停',exact:true}).click();
  assert((await page.evaluate(()=>window.vio.getState())).time>20.1);
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.vio.renderAt(20));
  await page.screenshot({path:'test-results/video-follow-mobile.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.setViewportSize({width:1440,height:1000});
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'保存工程',exact:true}).click();
  await (await download).saveAs('test-results/video-follow.vio.json');
  const saved=JSON.parse(fs.readFileSync('test-results/video-follow.vio.json','utf8'));
  assert.equal(saved.view.camera,'video-follow');assert.equal(saved.view.followDistance,12);
  await page.reload();
  await page.waitForFunction(()=>window.vio?.getState().session&&!document.querySelector('.loading-overlay'));
  await page.getByLabel('选择序列',{exact:true}).selectOption(saved.id);
  await page.waitForFunction(()=>window.vio.getState().settings.camera==='video-follow'&&!document.querySelector('.loading-overlay'));
  await page.evaluate(()=>window.vio.renderAt(20));
  const state=await page.evaluate(()=>window.vio.getState());
  console.log(JSON.stringify({followEquality:true,seek:true,stereo:true,saveReload:true,pixels,errors}));
  const response=await page.request.post(url+'/api/export',{data:{session:state.session,kind:'video',start:20,end:21,height:720,fps:24,view:state.settings}});
  const job=await response.json();assert(response.ok(),JSON.stringify(job));
  for(let i=0;i<240;i++){
    const result=await(await page.request.get(url+'/api/export/'+job.id)).json();
    if(result.status==='error')throw new Error(result.error);
    if(result.status==='done'){assert.equal(result.frame,24);fs.copyFileSync(result.output,'exports/slam_studio_video_follow.mp4');break;}
    if(i===239)throw new Error('Export timeout');await page.waitForTimeout(1000);
  }
  await page.setViewportSize({width:1280,height:720});
  await page.getByRole('button',{name:'展示模式',exact:true}).click();
  await page.evaluate(()=>window.vio.renderAt(20));
  await page.screenshot({path:'test-results/video-follow-presentation.png'});
  assert.deepEqual(errors,[]);console.log(JSON.stringify({videoFollow:'passed',exportFrames:24,errors}));
}finally{await browser.close();}
