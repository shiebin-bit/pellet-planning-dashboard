// Fictional fixtures only. This suite replaces and restores an explicitly isolated workspace.
const { chromium } = require('playwright');
const ExcelJS = require('exceljs');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { planningAction } = require('./planning-actions.cjs');
const base = process.env.BROWSER_BASE_URL;
if (!base || process.env.BROWSER_ALLOW_REPLACE !== '1' || !['127.0.0.1','localhost'].includes(new URL(base).hostname) || new URL(base).port === '8080') throw Error('Use a disposable loopback BROWSER_BASE_URL with BROWSER_ALLOW_REPLACE=1. Never production 8080.');
const output = path.resolve('output/playwright/baseline-split');
const json = async route => { const response = await fetch(base + route); const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data; };
const command = async command => { const {revision} = await json('/api/workspace'); const response = await fetch(base + '/api/commands', {method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({expectedRevision:revision,commandId:randomUUID(),command})}); const data = await response.json(); assert.equal(response.status,200,JSON.stringify(data)); return data; };
const wait = async fn => { for(let index=0;index<100;index++) { if(await fn()) return; await new Promise(resolve=>setTimeout(resolve,100)); } throw Error('Timed out waiting for isolated browser state.'); };
const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur'}).format(new Date());
const offset = days => new Date(Date.parse(today+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
const firstDate=offset(-2),lastDate=offset(-1),planDate=offset(1);
const bagMaterial='7.0000000522001',bulkMaterial='7.0000000522002';
async function workbook(file,date) {
  const book=new ExcelJS.Workbook(),daily=book.addWorksheet(Number(date.slice(-2))+'th');
  daily.getCell('R14').value=new Date(date+'T00:00:00Z');
  for(const [row,material,description,unit,opening] of [[18,bagMaterial,'FS 5220CCB FICTIONAL FEED 25KG','BAG',30],[75,bulkMaterial,'FS 5220MER FICTIONAL FEED IN BULK','BULK',0]]) {
    for(const [column,value] of [[2,material],[3,description],[6,unit],[7,opening],[8,0],[13,opening],[14,'PER ADVICE']]) daily.getCell(row,column).value=value;
    if(unit==='BAG')daily.getCell(row,4).value=25;
  }
  for(let index=0;index<62;index++) {
    const unit=index===0?'Bags':'MT',quantity=index===0?100:index===1?10:index===2?20:1,material=index===0?bagMaterial:bulkMaterial;
    for(const [column,value] of [[3,String(8800001+index)],[4,new Date(planDate+'T00:00:00Z')],[7,'Fictional customer '+index],[10,'Fictional farm '+index],[12,material],[13,unit==='Bags'?'FS 5220CCB FICTIONAL FEED 25KG':'FS 5220MER FICTIONAL FEED IN BULK'],[16,quantity],[17,unit],[18,3],[19,''],[20,null]]) daily.getCell(131+index,column).value=value;
  }
  const sapHeaders=['Delivery','Goods movement stat.','Goods Issue Date','Name of sold-to party','Name of the ship-to party','Material','Description','Delivery quantity','Sales Unit'];
  const bag=book.addWorksheet('bag order'),bulk=book.addWorksheet('bulk order');bag.addRow(sapHeaders);bulk.addRow(sapHeaders);
  for(let index=0;index<62;index++){
    const bags=index===0,quantity=bags?100:index===1?10:index===2?20:1;
    (bags?bag:bulk).addRow([String(8800001+index),'A',new Date(planDate+'T00:00:00Z'),'Fictional SAP customer '+index,'Fictional SAP farm '+index,bags?bagMaterial:bulkMaterial,bags?'FS 5220CCB FICTIONAL FEED 25KG':'FS 5220MER FICTIONAL FEED IN BULK',quantity,bags?'BAG':'MT']);
  }
  await book.xlsx.writeFile(file);
}
const fits = async locator => assert.ok(await locator.evaluate(element=>{const box=element.getBoundingClientRect();return box.left>=0&&box.top>=0&&box.right<=innerWidth+1&&box.bottom<=innerHeight+1;}),'Dialog stays inside viewport');
(async()=>{
  await fs.mkdir(output,{recursive:true});const backup=await json('/api/backup');let browser,page;
  try {
    await command({type:'workspace.restore',backup:{...backup.planning,jobs:[],events:[],settings:{...backup.planning.settings,workingHoursOverrides:undefined,calendarHistory:undefined,calendarCutover:undefined,dayStart:'07:00',availableHours:12,downtime:[]}}});
    const first=path.join(output,'fictional-first.xlsm'),last=path.join(output,'fictional-last.xlsm');await workbook(first,firstDate);await workbook(last,lastDate);
    browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
    page=await browser.newPage({viewport:{width:1366,height:650},timezoneId:'Asia/Kuala_Lumpur',reducedMotion:'reduce'});page.setDefaultTimeout(15000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/#/data');
    const trigger=page.getByRole('button',{name:'Import Excel',exact:true});await trigger.click();const modal=page.getByRole('dialog',{name:'Import Excel',exact:true});
    await modal.getByLabel('Baseline Excel files').setInputFiles([last,first]);await wait(()=>modal.getByRole('button',{name:'Review baseline import',exact:true}).isEnabled());
    assert.equal(await page.getByRole('dialog').count(),1,'Both import modes share one modal shell');
    assert.deepEqual(await modal.getByLabel('Selected baseline reports').locator('tbody tr td:nth-child(3)').allTextContents(),[firstDate,lastDate]);
    const body=modal.locator('.import-mode-pane:not([hidden]) .editor-body');assert.ok(await body.evaluate(element=>element.scrollHeight>element.clientHeight));await body.evaluate(element=>{element.scrollTop=element.scrollHeight;});assert.ok(await body.evaluate(element=>element.scrollTop>0));await fits(modal.locator('.import-mode-pane:not([hidden]) .editor-footer'));
    let failPreview=true;await page.route('**/api/inventory/daily-import/preview',route=>{if(failPreview){failPreview=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Fictional preview interruption'}})});}return route.continue();});
    await modal.getByRole('button',{name:'Review baseline import',exact:true}).click();await modal.getByText('Fictional preview interruption',{exact:true}).waitFor();assert.equal(await modal.getByLabel('Selected baseline reports').locator('tbody tr').count(),2);
    const revision=(await json('/api/workspace')).revision;await modal.getByRole('button',{name:'Review baseline import',exact:true}).click();await modal.getByRole('checkbox',{name:/I checked/}).waitFor();assert.equal((await json('/api/workspace')).revision,revision,'Preview is read-only');
    await modal.getByRole('button',{name:/SAP orders/}).click();await modal.getByLabel('Excel order file').setInputFiles(last);await wait(()=>modal.getByRole('button',{name:'Review import',exact:true}).isEnabled());assert.match(await modal.innerText(),/Recognised SAP tables/);
    await modal.getByRole('button',{name:/Baseline import/}).click();assert.equal(await modal.getByLabel('Selected baseline reports').locator('tbody tr').count(),2);await modal.getByRole('checkbox',{name:/I checked/}).waitFor();
    for(const viewport of [{width:390,height:844},{width:320,height:760}]) { await page.setViewportSize(viewport);await fits(modal);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));for(let count=0;count<12;count++){await page.keyboard.press('Tab');assert.ok(await modal.evaluate(element=>element.contains(document.activeElement)));}await page.screenshot({path:path.join(output,'baseline-'+viewport.width+'.png')}); }
    await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});assert.notEqual(await page.evaluate(()=>document.body.style.overflow),'hidden');assert.equal(await trigger.evaluate(element=>element===document.activeElement),true);
    await page.setViewportSize({width:1366,height:900});await trigger.click();await modal.getByLabel('Baseline Excel files').setInputFiles([last,first]);await wait(()=>modal.getByRole('button',{name:'Review baseline import',exact:true}).isEnabled());await modal.getByRole('button',{name:'Review baseline import',exact:true}).click();await modal.getByRole('checkbox',{name:/I checked/}).check();await modal.getByRole('button',{name:'Confirm baseline import',exact:true}).click();await modal.waitFor({state:'hidden'});assert.notEqual(await page.evaluate(()=>document.body.style.overflow),'hidden');await page.unroute('**/api/inventory/daily-import/preview');
    console.log('PASS Baseline/SAP single modal, chronological multi-file draft, read-only failed/retry preview, scroll, focus and narrow layout');
    assert.deepEqual((await json('/api/inventory/orders')).orders,[],'Neither dated baseline projects its 62 lower-table orders');
    assert.equal((await json('/api/data')).total,0);assert.equal((await json('/api/backup')).baselineHistory.observations.length,0);
    await trigger.click();await modal.getByRole('button',{name:/SAP orders/}).click();await modal.getByLabel('Excel order file').setInputFiles(last);
    await wait(()=>modal.getByRole('button',{name:'Review import',exact:true}).isEnabled());await modal.getByRole('button',{name:'Review import',exact:true}).click();
    await modal.getByRole('checkbox',{name:/I reviewed/}).check();await modal.getByRole('button',{name:'Confirm import',exact:true}).click();await modal.waitFor({state:'hidden'});
    assert.equal((await json('/api/data')).total,62,'Only the separate next-day SAP tables admit orders');

    await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Stock',exact:true}).click();const packaging=page.getByLabel('Stock packaging',{exact:true});await packaging.selectOption('Bags');await wait(async()=>await page.getByRole('button',{name:'Manage stock',exact:true}).count()===1);assert.match(await page.locator('.product-identity-title').innerText(),/5220CCB/);await packaging.selectOption('MT');await wait(async()=>await page.getByRole('button',{name:'Manage stock',exact:true}).count()===1);assert.match(await page.locator('.product-identity-title').innerText(),/5220MER/);await packaging.selectOption('');await wait(async()=>await page.getByRole('button',{name:'Manage stock',exact:true}).count()===2);
    await page.getByRole('tab',{name:'Daily stock',exact:true}).click();await page.getByLabel('Stock date',{exact:true}).fill(firstDate);await page.getByLabel('Daily stock packaging',{exact:true}).selectOption('Bags');await wait(async()=>await page.locator('.daily-stock-browser tbody tr').count()===1);assert.match(await page.locator('.daily-stock-browser tbody tr').innerText(),/Bags/);
    console.log('PASS Stock and Daily stock packaging filters and complete FS suffix labels');
    await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Planning board',exact:true}).click();await planningAction(page,'Plan from Orders');await page.getByRole('button',{name:'8800002',exact:true}).click();const plan=page.getByRole('dialog',{name:/^Plan production from orders?$/});await plan.getByLabel('Planning date',{exact:true}).fill(planDate);await plan.getByRole('button',{name:'Add same-product order',exact:true}).click();await page.getByRole('button',{name:'8800003',exact:true}).click();await plan.getByRole('button',{name:'Add to planning',exact:true}).click();await plan.waitFor({state:'hidden'});
    let state=(await json('/api/workspace')).state;const original=state.jobs.find(job=>job.status==='pending'&&job.sourceAllocations?.length===2);assert.ok(original);assert.equal(original.quantityMt,30);
    await page.locator(`[data-job-id="${original.id}"] .hplan-card-open`).click();await page.getByRole('button',{name:'Split card / quantities',exact:true}).click();const split=page.getByRole('dialog',{name:'Split production card',exact:true});await split.getByLabel('Card 1 DO 8800002 quantity',{exact:true}).fill('4');await split.getByLabel('Card 2 DO 8800002 quantity',{exact:true}).fill('6');await split.getByLabel('Card 1 DO 8800003 quantity',{exact:true}).fill('0');await split.getByLabel('Card 2 DO 8800003 quantity',{exact:true}).fill('20');
    await page.setViewportSize({width:390,height:844});await fits(split);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'split-390.png')});await split.getByRole('button',{name:'Save split cards',exact:true}).click();await split.waitFor({state:'hidden'});
    state=(await json('/api/workspace')).state;assert.equal(state.jobs.find(job=>job.id===original.id).status,'cancelled');const parts=state.jobs.filter(job=>job.status==='pending'&&job.derivedFromJobId===original.id);assert.equal(parts.length,2);assert.deepEqual(parts.map(job=>job.quantityMt).sort((a,b)=>a-b),[4,26]);
    const ledger=(await json('/api/backup')).inventory.ledger;await page.setViewportSize({width:1366,height:900});await page.keyboard.press('Escape');await page.locator(`[data-job-id="${parts[0].id}"] .hplan-card-open`).click();await page.getByRole('button',{name:/Combine with other cards/}).click();const combine=page.getByRole('dialog',{name:'Combine production cards',exact:true});const choices=combine.getByRole('checkbox');for(let index=0;index<await choices.count();index++)if(!await choices.nth(index).isChecked())await choices.nth(index).check();await combine.getByRole('button',{name:'Combine selected cards',exact:true}).click();await combine.waitFor({state:'hidden'});
    state=(await json('/api/workspace')).state;const combined=state.jobs.filter(job=>job.status==='pending');assert.equal(combined.length,1);assert.equal(combined[0].quantityMt,30);assert.equal(combined[0].sourceAllocations.length,2);assert.deepEqual((await json('/api/backup')).inventory.ledger,ledger,'Split and recombine never receive stock');assert.deepEqual(errors,[]);
    console.log('PASS Pending combined card splits partial order quantities and recombines without changing totals or inventory');
  } catch(error) { if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});throw error; }
  finally { if(page)await page.unrouteAll({behavior:'ignoreErrors'});if(browser)await browser.close();await command({type:'workspace.restore',backup}); }
})().catch(error=>{console.error(error);process.exitCode=1;});
