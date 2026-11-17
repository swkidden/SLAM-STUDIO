import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {markersAt} from '../src/DebugMarkers.js';

const base=process.env.STUDIO_URL||'http://127.0.0.1:8779';
const marker={source:'test',name:'ellipsoid',id:0,stamp:0,frame_id:'world',action:'add',type:'ellipsoid',position:[0,0,0],orientation:[0,0,0,1],scale:[2,4,6],color:[1,.4,.2,.3],lifetime:.5};
assert.equal(markersAt([marker],.1,'world').length,1);
assert.equal(markersAt([marker],.6,'world').length,0);
assert.equal(markersAt([marker,{...marker,stamp:.2,action:'delete'}],.3,'world').length,0);
assert.equal(markersAt([marker],.1,'other').length,0);
assert.equal(markersAt([marker,{...marker,stamp:.2,action:'clear'}],.3,'world').length,0);
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
let id;
try{
  await page.goto(base);
  await page.waitForFunction(()=>window.vio?.connectLive);
  id=await page.evaluate(()=>window.vio.connectLive({adapter:'http',frame_id:'world',tracks:[{id:'vio'}],cameras:[]}));
  const response=await page.request.post(`${base}/api/live/${id}/samples`,{data:{
    poses:[{track:'vio',stamp:100,position:[0,0,0],orientation:[0,0,0,1]}],
    diagnostics:[{source:'test',name:'generic_estimator',stamp:100,message:'updated',values:{slam_features:8,'failure.insufficient_baseline':3}}],
    markers:[{...marker,stamp:100}]
  }});
  assert(response.ok(),await response.text());
  await page.getByRole('tab',{name:'调试',exact:true}).click();
  await page.getByText('SLAM 特征数', {exact:true}).waitFor();
  const summary = page.locator('.debug-summary');
  assert.match(await summary.innerText(), /8/);
  assert(await page.getByRole('img',{name:'速度对比曲线'}).isVisible());
  const before = await summary.boundingBox();
  const speedValues = Object.fromEntries(['imu','visual','final'].flatMap(stage =>
    ['0','1','2','norm'].map((axis, i) => [`velocity_${stage}.${axis}`, 1+i])));
  await page.request.post(`${base}/api/live/${id}/samples`,{data:{poses:[{track:'vio',stamp:100.1,position:[0,0,0],orientation:[0,0,0,1]}],diagnostics:[{
    source:'test',name:'generic_estimator',stamp:100.1,message:'updated',
    values:{slam_features:6,promotion_failure:'none',...speedValues}
  }]}});
  await page.waitForFunction(() => document.querySelector('.debug-summary')?.innerText.includes('6'));
  assert.deepEqual(await summary.boundingBox(), before);
  await page.getByLabel('速度分量').selectOption('0');
  await page.getByLabel('速度视图').selectOption('correction');
  assert.equal(await page.locator('.debug-legend strong').first().innerText(), '0.000');
  await page.getByLabel('速度视图').selectOption('speed');
  await page.locator('.debug-extra summary').click();
  await page.getByLabel('调试字段', {exact:true}).selectOption('slam_features');
  assert(await page.getByRole('img',{name:'调试字段曲线'}).isVisible());
  await page.screenshot({path:'/tmp/slam-studio-debug-panel.png'});
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.evaluate(()=>window.vio.disconnectLive());
  assert.deepEqual(errors,[]);
  console.log('Generic debug panel, scalar chart, mobile layout and marker lifetime checks passed');
}finally{
  if(id)await page.request.post(`${base}/api/live/${id}/stop`,{data:{}}).catch(()=>{});
  await browser.close();
}
