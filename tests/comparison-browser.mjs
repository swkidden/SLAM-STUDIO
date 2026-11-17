import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const base=process.env.SLAM_STUDIO_URL||'http://127.0.0.1:8766';
const project='comparison_400_200_parking_lot_3_high';
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
fs.mkdirSync('test-results',{recursive:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/?project=${project}`);
  await page.waitForFunction(()=>window.vio?.getState().session&&!document.querySelector('.loading-overlay'),null,{timeout:240000});
  assert.equal(await page.getByLabel('选择序列',{exact:true}).inputValue(),project);
  const names=['IMU-guided 400','OpenVINS original 400','DynaVINS 200','VINS-Fusion original 200'];
  for(const name of names)assert.equal(await page.getByRole('checkbox',{name:'显示 '+name,exact:true}).count(),1);
  const id=await page.evaluate(()=>window.vio.getState().session);
  const session=await(await page.request.get(base+'/api/session/'+id)).json();
  assert.equal(session.data.tracks.length,5);
  const tracks=session.data.tracks.filter(t=>!t.truth);
  assert.deepEqual(tracks.map(t=>t.name),names);
  const fusion=tracks.find(t=>t.name==='VINS-Fusion original 200');
  assert(fusion.rmse>.29&&fusion.rmse<.31,JSON.stringify(fusion.rmse));
  assert.equal(fusion.poses.length,586);
  for(const spec of session.data.project.methods){
    assert(!spec.path.includes('/viode_final/'));
    assert(!spec.path.includes('/viode/run_001/'));
  }
  const pixels=()=>page.locator('.three-scene canvas').evaluate(c=>{
    const gl=c.getContext('webgl2'),p=new Uint8Array(c.width*c.height*4);
    gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,p);
    const colors=new Set();let drawn=0,transparent=0;
    for(let i=0;i<p.length;i+=4){
      if(p[i+3]===0)transparent++;
      if(Math.max(p[i],p[i+1],p[i+2])-Math.min(p[i],p[i+1],p[i+2])>30&&Math.max(p[i],p[i+1],p[i+2])>70)drawn++;
      if(i%64===0)colors.add(`${p[i]},${p[i+1]},${p[i+2]}`);
    }
    return {colors:colors.size,drawn,transparent,width:c.width,height:c.height};
  });
  await page.evaluate(()=>window.vio.renderAt(40));
  assert(await page.locator('.camera-frame img').evaluateAll(images=>images.length===2&&images.every(i=>i.complete&&i.naturalWidth===752)));
  const desktop=await pixels();assert(desktop.colors>20&&desktop.drawn>200,JSON.stringify(desktop));
  await page.screenshot({path:'test-results/comparison-desktop.png'});
  await page.getByRole('checkbox',{name:'显示 VINS-Fusion original 200',exact:true}).uncheck();
  assert.equal((await page.evaluate(()=>window.vio.getState())).settings.visible.method_3,false);
  await page.getByRole('checkbox',{name:'显示 VINS-Fusion original 200',exact:true}).check();
  await page.getByRole('button',{name:'视频跟随',exact:true}).click();
  await page.evaluate(()=>window.vio.renderAt(20));
  const cameraBefore=await page.evaluate(()=>window.vio.getCamera());
  const imageBefore=await page.locator('.video-background img').getAttribute('src');
  await page.evaluate(()=>window.vio.renderAt(25));
  assert.notDeepEqual(await page.evaluate(()=>window.vio.getCamera()),cameraBefore);
  assert.notEqual(await page.locator('.video-background img').getAttribute('src'),imageBefore);
  assert(await page.locator('.video-background img').evaluate(i=>i.complete&&i.naturalWidth===752));
  const video=await pixels();assert(video.transparent>1000&&video.drawn>200,JSON.stringify(video));
  await page.screenshot({path:'test-results/comparison-video.png'});
  await page.getByRole('button',{name:'播放',exact:true}).click();
  await page.waitForTimeout(1500);
  await page.getByRole('button',{name:'暂停',exact:true}).click();
  assert((await page.evaluate(()=>window.vio.getState())).time>25.1);
  await page.getByRole('button',{name:'自由视角',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.vio.renderAt(40));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const mobile=await pixels();assert(mobile.colors>20&&mobile.drawn>100,JSON.stringify(mobile));
  await page.screenshot({path:'test-results/comparison-mobile.png'});
  await page.setViewportSize({width:1440,height:1000});
  await page.getByLabel('选择序列',{exact:true}).selectOption('comparison_400_200_city_day_3_high');
  await page.waitForFunction(old=>window.vio.getState().session!==old&&!document.querySelector('.loading-overlay'),id,{timeout:240000});
  assert.equal(await page.getByRole('checkbox',{name:'显示 VINS-Fusion original 200',exact:true}).count(),0);
  assert.equal(await page.getByRole('checkbox',{name:'显示 OpenVINS original 400',exact:true}).count(),1);
  await page.evaluate(()=>window.vio.renderAt(35));
  assert.deepEqual(errors,[]);
  fs.writeFileSync('test-results/comparison-checks.json',JSON.stringify({desktop,video,mobile,tracks:tracks.map(t=>({name:t.name,rmse:t.rmse,poses:t.poses.length})),errors},null,2));
  console.log(JSON.stringify({desktop,video,mobile,errors,tracks:tracks.map(t=>({name:t.name,rmse:t.rmse}))}));
}finally{await browser.close();}
