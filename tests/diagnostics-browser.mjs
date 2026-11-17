import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const base=process.env.SLAM_STUDIO_URL||'http://127.0.0.1:8767';
const project=process.env.SLAM_STUDIO_PROJECT||'astra_102703_humanwalking';
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
fs.mkdirSync('test-results',{recursive:true});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/?project='+encodeURIComponent(project));
  await page.waitForFunction(()=>window.vio?.getState().session&&!document.querySelector('.loading-overlay'),null,{timeout:300000});
  const id=await page.evaluate(()=>window.vio.getState().session);
  const {data}=await(await page.request.get(base+'/api/session/'+id)).json();
  assert.equal(data.cameras.length,4);
  assert.equal(data.tracks.length,2);
  assert(data.tracks.every(t=>t.rmse===null));
  assert.equal(data.project.alignment,'none');
  assert(data.cameras.slice(2).every(c=>c.role==='diagnostic'&&c.count>3000&&c.width===1504));
  for(const c of data.cameras.slice(2)){
    assert(c.stamps.every(t=>data.cameras[0].stamps.some(raw=>Math.abs(raw-t)<1e-5)));
  }
  await page.evaluate(()=>window.vio.renderAt(55));
  assert.equal(await page.getByRole('tab',{name:'外点剔除',exact:true}).getAttribute('aria-selected'),'true');
  const annotated=page.locator('.diagnostic-panel img');
  const pixels=await annotated.evaluate(img=>{
    const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
    const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const a=ctx.getImageData(0,0,c.width,c.height).data;
    let red=0,blue=0,green=0;
    for(let i=0;i<a.length;i+=4){if(a[i]>150&&a[i]>a[i+1]*1.5&&a[i]>a[i+2]*1.5)red++;
      if(a[i+2]>150&&a[i+2]>a[i]*1.5&&a[i+2]>a[i+1]*1.5)blue++;
      if(a[i+1]>150&&a[i+1]>a[i]*1.5&&a[i+1]>a[i+2]*1.5)green++;}
    return {width:c.width,height:c.height,red,blue,green};
  });
  assert(pixels.red>20&&pixels.blue>20,JSON.stringify(pixels));
  const scenePixels=()=>page.locator('.three-scene canvas').evaluate(c=>{
    const gl=c.getContext('webgl2'),p=new Uint8Array(c.width*c.height*4);gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,p);
    let colored=0;for(let i=0;i<p.length;i+=4)if(Math.max(p[i],p[i+1],p[i+2])-Math.min(p[i],p[i+1],p[i+2])>40)colored++;
    return colored;
  });
  assert(await scenePixels()>100);
  await page.screenshot({path:'test-results/astra-diagnostics-desktop.png'});
  const first=await annotated.getAttribute('src');
  await page.getByLabel('剔除结果来源',{exact:true}).selectOption('3');
  await page.evaluate(()=>window.vio.renderAt(55));
  assert.notEqual(await annotated.getAttribute('src'),first);
  const ransacRed=await annotated.evaluate(img=>{
    const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
    const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const a=ctx.getImageData(0,0,c.width,c.height).data;
    let red=0;for(let i=0;i<a.length;i+=4)if(a[i]>150&&a[i]>a[i+1]*1.5&&a[i]>a[i+2]*1.5)red++;
    return red;
  });
  assert(ransacRed>20,'Missing native RANSAC rejection markers');
  await page.getByRole('button',{name:'放大剔除图像',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'外点剔除',exact:true});
  await dialog.getByLabel('剔除结果来源').selectOption('2');
  await page.evaluate(()=>window.vio.renderAt(55));
  assert(await dialog.locator('img').evaluate(i=>i.complete&&i.naturalWidth===1504));
  await dialog.getByRole('button',{name:'下一帧',exact:true}).click();
  assert((await page.evaluate(()=>window.vio.getState())).time>55);
  await page.screenshot({path:'test-results/astra-diagnostics-expanded.png'});
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'播放',exact:true}).click();
  await page.waitForTimeout(1200);
  await page.getByRole('button',{name:'暂停',exact:true}).click();
  assert((await page.evaluate(()=>window.vio.getState())).time>55.1);
  await page.getByRole('tab',{name:'原图',exact:true}).click();
  await page.evaluate(()=>window.vio.renderAt(20));
  assert.equal(await page.locator('.camera-views img').count(),2);
  await page.getByRole('tab',{name:'外点剔除',exact:true}).click();
  await page.getByRole('button',{name:'视频跟随',exact:true}).click();
  await page.evaluate(()=>window.vio.renderAt(55));
  const cam=await page.evaluate(()=>window.vio.getCamera());
  await page.evaluate(()=>window.vio.renderAt(60));
  assert.notDeepEqual(await page.evaluate(()=>window.vio.getCamera()),cam);
  assert(await page.locator('.video-background img').evaluate(i=>i.complete&&i.naturalWidth===752));
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.vio.renderAt(55));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert(await scenePixels()>100);
  assert(await annotated.evaluate(i=>i.complete&&i.getBoundingClientRect().width>300));
  await page.screenshot({path:'test-results/astra-diagnostics-mobile.png'});
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'展示模式',exact:true}).click();
  await page.evaluate(()=>window.vio.renderAt(55));
  assert(await annotated.isVisible());
  await page.screenshot({path:'test-results/astra-diagnostics-presentation.png'});
  assert.deepEqual(errors,[]);
  const exports=[];
  if(process.env.STUDIO_TEST_EXPORT==='1'){
    const {settings:view}=await page.evaluate(()=>window.vio.getState());
    for(const kind of ['snapshot','video']){
      const response=await page.request.post(base+'/api/export',{data:{session:id,kind,start:55,end:56,height:720,fps:24,view}});
      assert(response.ok(),await response.text());
      let job=await response.json();
      const deadline=Date.now()+180000;
      while(['starting','rendering'].includes(job.status)&&Date.now()<deadline){
        await page.waitForTimeout(500);
        job=await(await page.request.get(base+'/api/export/'+job.id)).json();
      }
      assert.equal(job.status,'done',JSON.stringify(job));
      assert(fs.statSync(job.output).size>10000);
      fs.copyFileSync(job.output,'test-results/astra-diagnostics-export.'+(kind==='snapshot'?'png':'mp4'));
      exports.push(job);
    }
  }
  fs.writeFileSync('test-results/astra-diagnostics-checks.json',JSON.stringify({project,pixels,ransacRed,errors,frames:data.cameras.map(c=>c.count),exports},null,2));
  console.log(JSON.stringify({project,pixels,ransacRed,errors,frames:data.cameras.map(c=>c.count),exports}));
}finally{await browser.close();}
