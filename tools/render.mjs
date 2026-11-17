import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright';

const [file,url]=process.argv.slice(2);
const config=JSON.parse(fs.readFileSync(file,'utf8'));
const height=config.height,width=Math.round(height*16/9);
let browser,encoder;
try{
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
  await page.goto(`${url}/?render=1`,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>!!window.vio);
  await page.evaluate(async c=>window.vio.loadSession(c.session,c.view,[c.start,c.end]),config);
  await page.evaluate(()=>document.fonts.ready);
  const frames=config.kind==='snapshot'?1:Math.ceil((config.end-config.start)*config.fps);
  if(config.kind!=='snapshot'){
    encoder=spawn('ffmpeg',['-y','-loglevel','error','-f','image2pipe','-vcodec','png','-framerate',String(config.fps),'-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',config.output],{stdio:['pipe','ignore','inherit']});
    encoder.on('error',e=>{throw e;});
  }
  console.log(JSON.stringify({status:'rendering',progress:0,total_frames:frames}));
  for(let i=0;i<frames;i++){
    const t=config.start+i/config.fps;
    await page.evaluate(async t=>window.vio.renderAt(t),t);
    const png=await page.screenshot({type:'png',animations:'disabled'});
    if(config.kind==='snapshot')fs.writeFileSync(config.output,png);
    else if(!encoder.stdin.write(png))await once(encoder.stdin,'drain');
    if(i%5===0||i===frames-1)console.log(JSON.stringify({status:'rendering',progress:(i+1)/frames,frame:i+1}));
  }
  if(encoder){encoder.stdin.end();const [code]=await once(encoder,'exit');if(code!==0)throw new Error(`ffmpeg exit ${code}`);}
  await browser.close();
}catch(error){
  console.error(error);
  encoder?.kill('SIGTERM');
  await browser?.close();
  process.exitCode=1;
}
