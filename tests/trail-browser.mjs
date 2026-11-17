import {chromium} from 'playwright';import assert from 'node:assert/strict';import fs from 'node:fs';
const base=process.env.STUDIO_URL||'http://127.0.0.1:8772';const b=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});const p=await b.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
try{
 await p.route('**/api/projects',r=>r.fulfill({contentType:'application/json',body:'[]'}));await p.goto(base);await p.waitForFunction(()=>window.vio);
 const path=fs.realpathSync('test-results/simple_workflow_20261113')+'/trail.tum';fs.writeFileSync(path,Array.from({length:61},(_,i)=>`${100+i*.1} ${i*.02} 0 0 0 0 0 1`).join('\n'));
 const r=await p.request.post(base+'/api/load',{data:{name:'Trail',methods:[{name:'VIO',path}]}});const {id}=await r.json();for(let i=0;i<100;i++){const s=await(await p.request.get(base+'/api/session/'+id)).json();if(s.status==='ready')break;await p.waitForTimeout(30);}
 await p.evaluate(id=>window.vio.loadSession(id,{camera:'follow',trail:2,pathMode:'full'},[0,6]),id);await p.evaluate(()=>window.vio.renderAt(4));await p.keyboard.press('Escape');
 const select=p.locator('.timeline-options').getByLabel('轨迹显示时长',{exact:true});assert.equal(await select.inputValue(),'2');await select.selectOption('0');await select.selectOption('2');await p.waitForTimeout(200);
 const divider=p.getByRole('separator',{name:'调整轨迹与图像宽度'});const box=await divider.boundingBox();const workspace=await p.locator('#capture').boundingBox();
 await p.mouse.move(box.x+5,box.y+60);await p.mouse.down();await p.mouse.move(workspace.x+workspace.width*.45,box.y+60,{steps:8});await p.mouse.up();
 assert(Math.abs(Number(await divider.getAttribute('aria-valuenow'))-45)<=1);
 assert(Math.abs(await p.evaluate(()=>Number(localStorage.getItem('slam-studio-split')))-.45)<.02);
 await p.locator('.app-header').getByRole('button',{name:'运行算法',exact:true}).click();const command=await p.getByLabel('启动命令',{exact:true}).boundingBox();const save=await p.getByRole('button',{name:'保存为我的配置',exact:true}).boundingBox();assert(save.y>command.y);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,trail:2,saveBelowCommand:true}));
}finally{await b.close();}
