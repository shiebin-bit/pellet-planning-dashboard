// Fictional data only. This suite refuses production and restores its isolated workspace.
const { chromium } = require('playwright');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const ExcelJS = require('exceljs');
const base = process.env.BROWSER_BASE_URL;
if (!base || process.env.BROWSER_ALLOW_REPLACE !== '1' || !['127.0.0.1','localhost'].includes(new URL(base).hostname) || new URL(base).port === '8080') throw Error('An isolated loopback test server is required.');
const output = path.resolve('output/playwright/combined-production');
const json = async route => {const r = await fetch(base+route); const data=await r.json(); assert.equal(r.status,200,JSON.stringify(data)); return data;};
const command = async command => {const {revision}=await json('/api/workspace');const r=await fetch(base+'/api/commands',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({commandId:randomUUID(),expectedRevision:revision,command})});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;};
const wait = async fn => {for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Saved state did not arrive');};
const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur'}).format(new Date());
const tomorrow = new Date(Date.parse(today+'T12:00:00Z')+86400000).toISOString().slice(0,10);
const later = new Date(Date.parse(today+'T12:00:00Z')+172800000).toISOString().slice(0,10);
const yesterday = new Date(Date.parse(today+'T12:00:00Z')-86400000).toISOString().slice(0,10);
const material='7.0000099522000';
const sourceRows = [10,20,5,6].map((quantity,i)=>({doNo:`QA-COMB-${i+1}`,deliveryDate:i<2?tomorrow:later,soldToParty:`Fictional customer ${i+1}`,shipToParty:`Fictional farm ${i+1}`,materialCode:material,description:'FS 5220 FICTIONAL FEED IN BULK',quantity,unit:'MT',deliveryLeadDays:1,remark:'',daysOutstanding:0,medication:'',fmrOmed:''}));
sourceRows.push({...sourceRows[0],doNo:'QA-OTHER-MATERIAL',materialCode:'7.0000000522000',quantity:4});
const sourceInput={fileName:'fictional-combined.xlsx',sheetName:'SAP',digest:'a'.repeat(64),asOfDate:yesterday,rows:sourceRows};
const sources = job => job.sourceAllocations || (job.sourceOrderId?[{sourceOrderId:job.sourceOrderId,sourceSnapshot:job.sourceSnapshot,plannedQuantity:job.quantityMt}]:[]);
(async()=>{
 await fs.mkdir(output,{recursive:true});const backup=await json('/api/backup');let browser,page;
 try {
  await command({type:'workspace.restore',backup:{...backup.planning,jobs:[],events:[],settings:{...backup.planning.settings,dayStart:'07:00',availableHours:12,downtime:[]}}});
  await command({type:'inventory.importBaseline',input:{fileName:'fictional-stock.xlsm',digest:'b'.repeat(64),asOfDate:yesterday,includeBaseline:true,orders:[sourceInput],items:[{materialCode:material,description:sourceRows[0].description,unit:'MT',bagWeightKg:null,strategy:'mto',targetQuantity:0,needsReview:false,opening:0,production:0,received:0,salesReturn:0,rework:0,issue:0,closing:0,medication:'',fmrOmed:''}],annotations:[],packingBinTotal:null}});
  browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
  page=await browser.newPage({viewport:{width:1366,height:900},acceptDownloads:true,timezoneId:'Asia/Kuala_Lumpur',reducedMotion:'reduce'});page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/#/planning');await page.getByRole('button',{name:'Plan from Data',exact:true}).click();
  await page.getByRole('button',{name:'QA-COMB-1',exact:true}).click();let dialog=page.getByRole('dialog',{name:/^Plan production from orders?$/});await dialog.waitFor();
  await dialog.getByLabel('Planning date',{exact:true}).fill(tomorrow);
  await dialog.getByRole('button',{name:'Add same-product order',exact:true}).click();
  await page.getByLabel('Search order data',{exact:true}).fill('');
  const other=page.locator('tr').filter({has:page.getByRole('button',{name:'QA-OTHER-MATERIAL',exact:true})});
  await other.waitFor();assert.equal(await other.getByRole('button',{name:'QA-OTHER-MATERIAL',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'QA-COMB-2',exact:true}).click();await dialog.waitFor();
  assert.equal(await dialog.getByLabel('Production quantity QA-COMB-1',{exact:true}).inputValue(),'10');
  assert.equal(await dialog.getByLabel('Production quantity QA-COMB-2',{exact:true}).inputValue(),'20');
  for(const viewport of [{width:390,height:844},{width:320,height:760},{width:1366,height:900}]){
   await page.setViewportSize(viewport);assert.ok(await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;}));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.screenshot({path:path.join(output,`multi-order-plan-${viewport.width}.png`)});
  }
  await dialog.getByRole('button',{name:'Add to planning',exact:true}).click();await dialog.waitFor({state:'hidden'});
  let state=(await json('/api/workspace')).state;const group=state.jobs.find(j=>sources(j).length===2&&j.status==='pending');assert.ok(group);assert.equal(group.quantityMt,30);
  const card=page.locator(`[data-job-id="${group.id}"]`);await card.waitFor();assert.equal(await card.locator('.hplan-code-full').innerText(),'5220');assert.doesNotMatch(await card.innerText(),/7\.0000/);
  await card.locator('.hplan-card-open').click();const drawer=page.getByRole('dialog',{name:'5220',exact:true});await drawer.waitFor();
  assert.equal(await drawer.locator('.drawer-material-code').innerText(),material);
  const allocations=drawer.getByLabel('Production order allocations');assert.match(await allocations.innerText(),/QA-COMB-1[\s\S]*Fictional farm 1[\s\S]*10\.000 MT[\s\S]*QA-COMB-2[\s\S]*Fictional farm 2[\s\S]*20\.000 MT/);
  await allocations.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'combined-card-details.png'),animations:'disabled'});
  await drawer.getByRole('button',{name:'Start production',exact:true}).click();await wait(async()=>(await json('/api/workspace')).state.jobs.find(j=>j.id===group.id).status==='running');
  await drawer.getByLabel('New quantity (MT)',{exact:true}).fill('8');await drawer.getByRole('button',{name:'Record production quantity',exact:true}).click();await wait(async()=>(await json('/api/inventory')).items.find(i=>i.materialCode===material).totalOnHand===8);
  let progress=(await json('/api/inventory/orders')).orders;let o1=progress.find(o=>o.doNo==='QA-COMB-1'),o2=progress.find(o=>o.doNo==='QA-COMB-2');assert.equal(o1.produced,8);assert.equal(o2.produced,0);
  await drawer.getByRole('button',{name:'Mark as done',exact:true}).click();await drawer.getByLabel('Actual quantity (MT)',{exact:true}).fill('25');await drawer.getByRole('button',{name:'Confirm done',exact:true}).click();await wait(async()=>(await json('/api/workspace')).state.jobs.find(j=>j.id===group.id).status==='completed');
  progress=(await json('/api/inventory/orders')).orders;o1=progress.find(o=>o.doNo==='QA-COMB-1');o2=progress.find(o=>o.doNo==='QA-COMB-2');assert.equal(o1.produced,10);assert.equal(o2.produced,15);assert.equal((await json('/api/inventory')).items.find(i=>i.materialCode===material).totalOnHand,25);
  await drawer.getByRole('button',{name:'Close production details',exact:true}).click();
  console.log('PASS Multi-order selection, stable product isolation, short FS code, full details, responsive dialogs and single physical receipt attribution');
  const list=await json('/api/data');const three=list.items.find(o=>o.doNo==='QA-COMB-3'),four=list.items.find(o=>o.doNo==='QA-COMB-4');
  for(const order of [three,four])await command({type:'job.createFromSources',input:{orders:[{sourceOrderId:order.id,sourceOrderVersion:order.version,plannedQuantity:order.quantity}],date:tomorrow,lineId:'PM3',bin:'QA BIN',remarks:'Fictional run'}});
  await page.reload();await page.getByRole('button',{name:/^Planning date:/}).click();await page.locator(`.calendar-day[data-date="${tomorrow}"]`).click();await page.getByRole('button',{name:'Combine cards',exact:true}).click();const combine=page.getByRole('dialog',{name:'Combine production cards',exact:true});await combine.waitFor();
  await combine.getByLabel('Combine QA-COMB-3',{exact:true}).check();await combine.getByLabel('Combine QA-COMB-4',{exact:true}).check();await combine.getByRole('button',{name:'Combine selected cards',exact:true}).click();await combine.waitFor({state:'hidden'});
  state=(await json('/api/workspace')).state;const joined=state.jobs.find(j=>j.status==='pending'&&sources(j).some(a=>a.sourceOrderId===three.id));assert.equal(sources(joined).length,2);assert.equal(joined.quantityMt,11);assert.equal(state.jobs.filter(j=>j.status==='cancelled').length,1);
  await page.getByRole('button',{name:'Export',exact:true}).click();const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Excel report',exact:false}).click();const download=await downloadPromise;const exported=path.join(output,'combined-production.xlsx');await download.saveAs(exported);const book=new ExcelJS.Workbook();await book.xlsx.readFile(exported);const sheet=book.getWorksheet('Order allocations');assert.ok(sheet);assert.ok(sheet.rowCount>=5);assert.ok(sheet.getColumn('F').values.includes('QA-COMB-1'));assert.ok(sheet.getColumn('F').values.includes('QA-COMB-2'));
  assert.match(await page.locator('.print-report').innerText(),/QA-COMB-1/);assert.match(await page.locator('.print-report').innerText(),/QA-COMB-2/);
  console.log('PASS Existing-card combine retains cancelled originals and Excel/print lists all order shares without duplicating production totals');
  const saved=await json('/api/backup');await command({type:'workspace.restore',backup:saved});assert.deepEqual((await json('/api/workspace')).state.jobs.map(j=>sources(j)),saved.planning.jobs.map(j=>sources(j)));
  await page.reload();await page.getByRole('button',{name:'Data',exact:true}).click();await page.getByRole('button',{name:'Import Excel',exact:true}).click();
  const imported=path.join(output,'fictional-repeat.xlsx');const repeat=new ExcelJS.Workbook();const sap=repeat.addWorksheet('SAP');sap.addRow(['DO no','Delivery date','Sold to Party','Ship to Party','Material code','Description','Qty','Unit','Delivery lead days','Remark','Days of outstanding','Medication','FMR / OMED']);sap.addRow(['QA-COMB-1',tomorrow,'Changed customer','Changed farm',material,'FS 5101 CHANGED IN SAP',99,'MT',1,'OUT',1,'','']);sap.addRow(['QA-COMB-NEW',tomorrow,'Fictional new customer','Fictional new farm',material,'FS 5220 FICTIONAL FEED IN BULK',3,'MT',1,'',1,'','']);await repeat.xlsx.writeFile(imported);
  const importer=page.getByRole('dialog',{name:'Import Excel orders',exact:true});await importer.getByLabel('Excel order file').setInputFiles(imported);await wait(()=>importer.getByRole('button',{name:'Review import',exact:true}).isEnabled());await importer.getByRole('button',{name:'Review import',exact:true}).click();await importer.getByLabel('Import preview summary').waitFor();assert.match(await importer.getByLabel('Import preview summary').innerText(),/1\s+New orders[\s\S]*1\s+Existing orders/);assert.match(await importer.getByLabel('Import changes').innerText(),/Saved · retained[\s\S]*Excel · skipped/);
  await page.screenshot({path:path.join(output,'insert-only-import.png')});await importer.getByRole('checkbox',{name:/I reviewed/}).check();await importer.getByRole('button',{name:'Confirm import',exact:true}).click();await importer.waitFor({state:'hidden'});
  const after=await json('/api/backup');const old=saved.sourceData.orders.find(o=>o.id===o1.sourceOrderId);assert.deepEqual(after.sourceData.orders.find(o=>o.id===old.id),old);assert.deepEqual(after.sourceData.versions.filter(v=>v.sourceOrderId===old.id),saved.sourceData.versions.filter(v=>v.sourceOrderId===old.id));assert.deepEqual(after.inventory.ledger,saved.inventory.ledger);assert.equal(after.sourceData.orders.length,saved.sourceData.orders.length+1);
  assert.deepEqual(errors,[]);console.log('PASS Existing changed SAP order is skipped, only new order inserted; grouped backup round-trip and ledger remain intact; no browser errors');
  await command({type:'workspace.restore',backup:{...backup.planning,jobs:[],events:[],settings:{...backup.planning.settings,dayStart:'07:00',availableHours:12,downtime:[]}}});
  await command({type:'inventory.importBaseline',input:{fileName:'fictional-extra.xlsm',digest:'c'.repeat(64),asOfDate:yesterday,includeBaseline:true,orders:[{...sourceInput,rows:[{...sourceRows[0],doNo:'QA-EXTRA',quantity:100}]}],items:[{materialCode:material,description:sourceRows[0].description,unit:'MT',bagWeightKg:null,strategy:'mto',targetQuantity:0,needsReview:false,opening:30,production:0,received:0,salesReturn:0,rework:0,issue:0,closing:30,medication:'',fmrOmed:''}],annotations:[],packingBinTotal:null}});
  const item=(await json('/api/inventory')).items[0];await command({type:'inventory.configure',itemId:item.itemId,patch:{defaultExtra:{type:'fixed',quantity:20}}});
  await page.goto(base+'/#/planning');await page.reload();await page.getByRole('button',{name:'Generate planning',exact:true}).click();const draft=page.getByRole('dialog',{name:'Generate planning draft',exact:true});await draft.getByLabel('Plan from',{exact:true}).fill(tomorrow);await draft.getByLabel('Plan through',{exact:true}).fill(tomorrow);await draft.getByRole('button',{name:'Generate draft',exact:true}).click();await draft.locator('.draft-edit-table tbody tr').first().waitFor();
  assert.equal(await draft.getByLabel('Quantity draft-1',{exact:true}).inputValue(),'90');await draft.locator('.draft-edit-table details summary').first().click();assert.equal(await draft.getByLabel('Stock extra draft-1',{exact:true}).inputValue(),'20');assert.equal(await draft.locator('summary').filter({hasText:'Unscheduled demand'}).count(),0);
  await draft.getByLabel('Stock extra draft-1',{exact:true}).fill('0');const unscheduled=draft.locator('details').filter({has:page.locator('summary').filter({hasText:'Unscheduled demand'})});await unscheduled.locator('summary').click();assert.match(await unscheduled.innerText(),/Extra for stock[\s\S]*20\.000 MT/);await draft.getByLabel('Stock extra draft-1',{exact:true}).fill('20');assert.equal(await draft.locator('summary').filter({hasText:'Unscheduled demand'}).count(),0);
  await page.screenshot({path:path.join(output,'draft-order-and-stock-extra.png'),animations:'disabled'});await draft.getByRole('button',{name:'Confirm 1 cards',exact:true}).click();await draft.waitFor({state:'hidden'});const extraJob=(await json('/api/workspace')).state.jobs[0];assert.equal(extraJob.quantityMt,90);assert.equal(extraJob.sourceAllocations[0].plannedQuantity,70);assert.equal((await json('/api/inventory/orders')).orders[0].netToPlan,0);assert.deepEqual(errors,[]);
  console.log('PASS Automatic draft keeps 70 order quantity plus 20 extra stock separate; editing extra updates backlog and saves 90 physical production once');
  // Due-date batches are generated as physical runs before choosing a line.
  await command({type:'workspace.restore',backup:{...backup.planning,jobs:[],events:[],settings:{...backup.planning.settings,dayStart:'07:00',availableHours:12,downtime:['PM2','PM3','PM4'].map(lineId=>({id:`qa-${lineId}`,date:tomorrow,lineId,start:'07:00',end:'07:00',reason:'Fictional single-line scenario'}))}}});
  const dueRows=[
   {...sourceRows[0],doNo:'QA-BATCH-A1',deliveryDate:tomorrow,quantity:14},
   {...sourceRows[0],doNo:'QA-BATCH-A2',deliveryDate:tomorrow,quantity:15},
   {...sourceRows[0],doNo:'QA-BATCH-B',materialCode:'7.0000099581100',description:'FS 5811 FICTIONAL FEED IN BULK',deliveryDate:later,quantity:20},
   {...sourceRows[0],doNo:'QA-BATCH-A3',deliveryDate:new Date(Date.parse(later+'T12:00:00Z')+86400000).toISOString().slice(0,10),quantity:20},
  ];
  await command({type:'inventory.importBaseline',input:{fileName:'fictional-batches.xlsm',digest:'d'.repeat(64),asOfDate:yesterday,includeBaseline:true,orders:[{...sourceInput,rows:dueRows}],items:[dueRows[0],dueRows[2]].map(row=>({materialCode:row.materialCode,description:row.description,unit:'MT',bagWeightKg:null,strategy:'mto',targetQuantity:0,needsReview:false,opening:0,production:0,received:0,salesReturn:0,rework:0,issue:0,closing:0,medication:'',fmrOmed:''})),annotations:[],packingBinTotal:null}});
  await page.reload();await page.getByRole('button',{name:'Generate planning',exact:true}).click();
  const batchDialog=page.getByRole('dialog',{name:'Generate planning draft',exact:true});
  await batchDialog.getByLabel('Plan from',{exact:true}).fill(tomorrow);await batchDialog.getByLabel('Plan through',{exact:true}).fill(tomorrow);await batchDialog.getByLabel('Orders due by',{exact:true}).fill(dueRows[3].deliveryDate);
  const combineOption=batchDialog.getByRole('checkbox',{name:'Combine same-product orders with the same due date',exact:true});assert.equal(await combineOption.isChecked(),true);
  await batchDialog.getByRole('button',{name:'Generate draft',exact:true}).click();await batchDialog.locator('.draft-edit-table tbody tr').first().waitFor();
  assert.equal(await batchDialog.locator('.draft-edit-table tbody tr').count(),3);
  assert.deepEqual(await batchDialog.locator('.draft-edit-table tbody tr td:first-child > strong').allTextContents(),['5220','5811','5220']);
  await batchDialog.locator('.draft-edit-table details summary').first().click();const previewText=await batchDialog.locator('.draft-edit-table tbody tr').first().innerText();for(const expected of ['QA-BATCH-A1','QA-BATCH-A2','Due'])assert.ok(previewText.includes(expected));
  await page.screenshot({path:path.join(output,'due-date-batches.png'),animations:'disabled'});
  await combineOption.uncheck();assert.equal(await batchDialog.locator('.draft-edit-table').count(),0);await batchDialog.getByRole('button',{name:'Generate draft',exact:true}).click();await batchDialog.locator('.draft-edit-table tbody tr').first().waitFor();assert.equal(await batchDialog.locator('.draft-edit-table tbody tr').count(),4);
  await combineOption.check();await batchDialog.getByRole('button',{name:'Generate draft',exact:true}).click();await batchDialog.locator('.draft-edit-table tbody tr').first().waitFor();
  await batchDialog.getByRole('button',{name:'Confirm 3 cards',exact:true}).click();await batchDialog.waitFor({state:'hidden'});
  const batchJobs=(await json('/api/workspace')).state.jobs.filter(j=>j.status==='pending').sort((a,b)=>a.sequence-b.sequence);
  assert.deepEqual(batchJobs.map(j=>j.productCode),[material,dueRows[2].materialCode,material]);assert.deepEqual(batchJobs.map(j=>j.quantityMt),[29,20,20]);assert.equal(sources(batchJobs[0]).length,2);assert.equal(sources(batchJobs[2]).length,1);
  const batchCard=page.locator(`[data-job-id="${batchJobs[0].id}"]`);await batchCard.waitFor();assert.equal(await batchCard.locator('.hplan-order-count').innerText(),'2 orders');assert.equal(await batchCard.locator('.hplan-order-count').isVisible(),true);await batchCard.locator('.hplan-card-open').click();
  const batchDrawer=page.getByRole('dialog',{name:'5220',exact:true});await batchDrawer.waitFor();const batchDetails=batchDrawer.getByLabel('Production order allocations');for(const [doNo,quantity] of [['QA-BATCH-A1','14.000 MT'],['QA-BATCH-A2','15.000 MT']])assert.ok((await batchDetails.locator('.combined-source-item').filter({hasText:doNo}).innerText()).includes(quantity));await batchDrawer.getByRole('button',{name:'Close production details',exact:true}).click();
  await page.setViewportSize({width:1366,height:650});await page.screenshot({path:path.join(output,'due-date-board-short-window.png'),animations:'disabled'});assert.deepEqual(errors,[]);
  console.log('PASS Due-date batches produce 5220(A1+A2), then5811, then later5220(A3); optional separate cards, saved order details and quantities remain correct');
 }catch(error){if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
 finally{if(browser)await browser.close();await command({type:'workspace.restore',backup});}
})().catch(e=>{console.error(e);process.exitCode=1;});
