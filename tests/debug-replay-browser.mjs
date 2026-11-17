import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base=process.env.STUDIO_URL||'http://127.0.0.1:8779';
const id=process.env.SLAM_STUDIO_RECORDING_ID;
if(!id){console.log('Set SLAM_STUDIO_RECORDING_ID to validate a recorded diagnostic stream');process.exit(0);}
const session={id};
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  const response=await page.request.get(`${base}/api/recordings/${session.id}`);
  const recording=await response.json();assert(response.ok());
  const diagnostics=recording.diagnostics;
  const valid=diagnostics.filter(s=>s.values['information.0']!==undefined);
  assert(valid.length>100);
  assert(diagnostics.some(s=>Object.keys(s.values).some(k=>k.startsWith('failure.'))));
  await page.goto(base);
  await page.waitForFunction(()=>window.vio?.loadSession);
  await page.evaluate(async({id,end,time})=>{
    await window.vio.loadSession(id,{camera:'orbit',inspectionView:'debug'},[0,end]);
    await window.vio.renderAt(time);
  },{id:session.id,end:recording.duration,time:valid[Math.floor(valid.length/2)].stamp});
  await page.getByRole('button',{name:/^slam_features /}).waitFor();
  await page.getByRole('button',{name:/^slam_features /}).click();
  assert(await page.getByRole('img',{name:'调试字段曲线'}).isVisible());
  await page.screenshot({path:'/tmp/astravins_debug_eval/studio-replay.png'});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({valid_spectra:valid.length,diagnostics:diagnostics.length,markers:recording.markers.length}));
}finally{await browser.close();}
