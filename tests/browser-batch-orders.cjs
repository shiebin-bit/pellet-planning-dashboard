// Fictional fixtures; refuses the live application and restores its isolated DB.
const { chromium } = require('playwright');
const { historicalFixtureCommand } = require('./historical-fixture.cjs');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const base = process.env.BROWSER_BASE_URL;
if (!base || process.env.BROWSER_ALLOW_REPLACE !== '1' || !['localhost','127.0.0.1'].includes(new URL(base).hostname) || new URL(base).port === '8080') throw Error('Disposable loopback test server required.');
const json = async route => { const r=await fetch(base+route); assert.equal(r.status,200); return r.json(); };
const command = async command => {
  const fixture=await historicalFixtureCommand(base,command); if(fixture)return fixture;
  const {revision}=await json('/api/workspace');
  const r=await fetch(base+'/api/commands',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({commandId:randomUUID(),expectedRevision:revision,command})});
  const data=await r.json(); assert.equal(r.status,200,JSON.stringify(data)); return data;
};
const wait=async fn=>{for(let i=0;i<80;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Saved state did not arrive');};
const allocations=job=>job.sourceAllocations??[];
(async()=>{
  const original=await json('/api/backup'); let browser,page;
  const output='output/playwright/batch-orders'; await fs.mkdir(output,{recursive:true});
  try {
    const clean={...original,planning:{...original.planning,jobs:[],events:[],settings:{...original.planning.settings,dayStart:'07:00',availableHours:12,downtime:[],workingHoursOverrides:undefined,calendarHistory:undefined,calendarCutover:undefined}},sourceData:{imports:[],orders:[],versions:[],discrepancies:[]}};
    for(const key of ['inventory','productionProgress','baselineHistory','dailyPlanning'])clean[key]=Object.fromEntries(Object.keys(original[key]).map(name=>[name,[]]));
    await command({type:'workspace.restore',backup:clean});
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur'}).format(new Date());
    const tomorrow=new Date(Date.parse(today+'T12:00:00Z')+86400000).toISOString().slice(0,10);
    const material='7.9999952220000';
    const rows=[1,2,3,4,5,6].map(n=>({doNo:`QA-NEST-${n}`,deliveryDate:tomorrow,soldToParty:`Fictional buyer ${n}`,shipToParty:`Fictional farm ${n}`,materialCode:material,description:'FS 5220 FICTIONAL FEED IN BULK',quantity:n,unit:'MT',deliveryLeadDays:1,remark:'',daysOutstanding:0,medication:'',fmrOmed:''}));
    await command({type:'inventory.importBaseline',input:{fileName:'fictional-stock.xlsm',digest:'b'.repeat(64),asOfDate:today,includeBaseline:true,orders:[{fileName:'fictional-orders.xlsx',sheetName:'SAP',digest:'a'.repeat(64),asOfDate:today,rows}],items:[{materialCode:material,description:rows[0].description,unit:'MT',bagWeightKg:null,strategy:'mto',targetQuantity:0,needsReview:false,opening:0,production:0,received:0,salesReturn:0,rework:0,issue:0,closing:0,medication:'',fmrOmed:''}],annotations:[],packingBinTotal:null}});
    const orders=(await json('/api/data')).items.sort((a,b)=>a.doNo.localeCompare(b.doNo));
    for(const [lineId,selected] of [['PM1',orders.slice(0,5)],['PM2',orders.slice(5)]])await command({type:'job.createFromSources',input:{orders:selected.map(o=>({sourceOrderId:o.id,sourceOrderVersion:o.version,plannedQuantity:o.quantity})),date:tomorrow,lineId,bin:'QA',remarks:'Fictional batch'}});
    let state=(await json('/api/workspace')).state;
    const group=state.jobs.find(j=>j.lineId==='PM1'),target=state.jobs.find(j=>j.lineId==='PM2');
    browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
    page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'Asia/Kuala_Lumpur',reducedMotion:'reduce'});page.setDefaultTimeout(15000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/#/planning');
    await page.getByRole('button',{name:/^Planning date:/}).click();await page.locator(`.calendar-day[data-date="${tomorrow}"]`).click();
    await page.getByRole('group',{name:'Planning view',exact:true}).getByRole('button',{name:'Batches',exact:true}).click();
    const box=id=>page.locator(`[data-batch-id="${id}"]`),tile=(job,id)=>box(job).locator(`[data-order-id="${id}"] .batch-order-main`);
    await box(group.id).waitFor(); assert.equal(await box(group.id).locator('.batch-order').count(),5);
    assert.match(await box(group.id).innerText(),/15\.000 MT/);
    await page.screenshot({path:output+'/five-orders.png',fullPage:true});
    async function drag(from,to){await from.scrollIntoViewIfNeeded();const a=await from.boundingBox();await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(a.x+a.width/2+10,a.y+a.height/2,{steps:3});await to.scrollIntoViewIfNeeded();const b=await to.boundingBox();await page.mouse.move(b.x+b.width/2,b.y+20,{steps:20});await page.mouse.up();}
    await drag(tile(group.id,orders[0].id),page.locator('[data-batch-line="PM3"]'));
    await wait(async()=>allocations((await json('/api/workspace')).state.jobs.find(j=>j.id===group.id)).length===4);
    state=(await json('/api/workspace')).state;const separate=state.jobs.find(j=>j.lineId==='PM3'&&j.status==='pending');assert.equal(separate.quantityMt,1);assert.equal(state.jobs.find(j=>j.id===group.id).quantityMt,14);
    await wait(()=>box(separate.id).isVisible());
    await drag(tile(separate.id,orders[0].id),box(target.id).locator('.batch-box-header'));
    await wait(async()=>allocations((await json('/api/workspace')).state.jobs.find(j=>j.id===target.id)).length===2);
    state=(await json('/api/workspace')).state;assert.equal(state.jobs.find(j=>j.id===separate.id).status,'cancelled');assert.equal(state.jobs.filter(j=>j.status==='pending').reduce((n,j)=>n+j.quantityMt,0),21);
    // Non-drag operation uses the same command and works with keyboard navigation.
    await box(group.id).getByRole('button',{name:'Move order QA-NEST-2',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Move order QA-NEST-2',exact:true});await dialog.getByLabel('Destination PM').selectOption('PM2');await dialog.getByLabel('Destination batch').selectOption(target.id);await dialog.getByRole('button',{name:'Move order',exact:true}).click();await dialog.waitFor({state:'hidden'});
    assert.equal((await json('/api/workspace')).state.jobs.find(j=>j.id===target.id).quantityMt,9);
    await box(group.id).getByRole('button',{name:'Move order QA-NEST-3',exact:true}).click();
    const retryDialog=page.getByRole('dialog',{name:'Move order QA-NEST-3',exact:true});await retryDialog.getByLabel('Destination PM').selectOption('PM2');await retryDialog.getByLabel('Destination batch').selectOption(target.id);
    const receipts=[];
    const loseReply=async route=>{const body=route.request().postDataJSON();if(body.command.type!=='job.transferOrder')return route.continue();receipts.push(body.commandId);const response=await route.fetch();assert.equal(response.status(),200);await route.abort();};
    await page.route('**/api/commands',loseReply);await retryDialog.getByRole('button',{name:'Move order',exact:true}).click();await retryDialog.getByRole('button',{name:'Retry connection',exact:true}).waitFor();await page.unroute('**/api/commands',loseReply);
    const observe=async route=>{const body=route.request().postDataJSON();if(body.command.type==='job.transferOrder')receipts.push(body.commandId);await route.continue();};await page.route('**/api/commands',observe);await retryDialog.getByRole('button',{name:'Retry connection',exact:true}).click();await retryDialog.waitFor({state:'hidden'});await page.unroute('**/api/commands',observe);
    assert.equal(new Set(receipts).size,1);assert.equal((await json('/api/workspace')).state.jobs.find(j=>j.id===target.id).quantityMt,12);await page.getByText('Order move confirmed. Batch quantities and schedules updated.',{exact:true}).waitFor();
    for(const width of [1366,390]){await page.setViewportSize({width,height:900});if(width===390)await page.getByRole('group',{name:'Planning view',exact:true}).getByRole('button',{name:'Batches',exact:true}).click();await box(group.id).waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.ok(await box(group.id).evaluate(el=>el.scrollWidth<=el.clientWidth+1));await page.screenshot({path:`${output}/batches-${width}.png`,fullPage:true});}
    assert.deepEqual(errors,[]);console.log('PASS Five visible order tiles; real drag out/merge, conserved totals, non-drag move, lost-reply retry without duplication and responsive layout.');
  }catch(error){if(page)await page.screenshot({path:output+'/failure.png',fullPage:true}).catch(()=>{});throw error;}
  finally{if(browser)await browser.close();await command({type:'workspace.restore',backup:original});}
})().catch(error=>{console.error(error);process.exitCode=1;});
