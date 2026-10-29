// Fictional fixtures only. Never run mutation checks against production 8080.
const { chromium } = require('playwright');
const ExcelJS = require('exceljs');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const base = process.env.BROWSER_BASE_URL;
if (!base || process.env.BROWSER_ALLOW_REPLACE !== '1' || !['localhost','127.0.0.1'].includes(new URL(base).hostname) || new URL(base).port === '8080') throw Error('Use an isolated loopback BROWSER_BASE_URL with BROWSER_ALLOW_REPLACE=1.');
const output = path.resolve('output/playwright/inventory');
const json = async route => { const r = await fetch(base + route); const data = await r.json(); assert.equal(r.status, 200, JSON.stringify(data)); return data; };
const command = async c => { const current = await json('/api/workspace'); const r = await fetch(base + '/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ expectedRevision: current.revision, commandId: randomUUID(), command: c }) }); const data = await r.json(); assert.equal(r.status, 200, JSON.stringify(data)); return data; };
const today = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Kuala_Lumpur' }).format(new Date());
const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 86400000).toISOString().slice(0,10);
const yesterday = new Date(Date.parse(today + 'T12:00:00Z') - 86400000).toISOString().slice(0,10);
const wait = async fn => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Timed out waiting for inventory state.'); };
async function fixture(file) {
 const b = new ExcelJS.Workbook();
 for (const [name, unit, material, quantity] of [['bag order','BAG','7.0000000000025',100],['bulk order','MT','7.0000000000000',20]]) {
  const s = b.addWorksheet(name); s.addRow(['Delivery','Goods movement stat.','Goods Issue Date','Name of sold-to party','Name of the ship-to party','Material','Description','Delivery quantity','Sales Unit']);
  s.addRow([unit === 'BAG' ? 'QA-BAG-100' : 'QA-BULK-20','A',new Date(tomorrow+'T00:00:00Z'),'Fictional customer','Fictional ship-to',material,'Fictional feed',quantity,unit]);
 }
 const d = b.addWorksheet('18th'); d.getCell('R14').value = new Date(yesterday+'T00:00:00Z');
 for (const [n, code, mode, weight, opening, target] of [[18,'7.0000000000025','BAG',25,30,20],[75,'7.0000000000000','BULK',null,0,'PER ADVICE']]) {
  d.getCell(n,2).value=code; d.getCell(n,3).value='Fictional poultry feed with a long product description for finished-goods stock'; if(weight)d.getCell(n,4).value=weight; d.getCell(n,6).value=mode;
  d.getCell(n,7).value=opening; d.getCell(n,8).value={formula:'0',result:0};d.getCell(n,13).value=opening; d.getCell(n,14).value=target;
 }
 await b.xlsx.writeFile(file);
}
(async () => {
 await fs.mkdir(output,{recursive:true}); const backup = await json('/api/backup'); let browser,page;
 try {
  const current = await json('/api/workspace'); await command({type:'workspace.restore',backup:{...current.state,jobs:[],events:[],settings:{...current.state.settings,dayStart:'07:00',availableHours:12,downtime:[]}}});
  const file=path.join(output,'fictional-daily-stock.xlsm'); await fixture(file);
  browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
  page=await browser.newPage({viewport:{width:1440,height:900},timezoneId:'Asia/Kuala_Lumpur'}); page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/#/data'); await page.getByRole('button',{name:'Import Excel',exact:true}).click();
  await page.getByLabel('Excel order file').setInputFiles(file);
  const modal=page.getByRole('dialog',{name:'Daily stock workbook',exact:true}); await modal.waitFor();
  await wait(()=>modal.getByRole('checkbox',{name:/Establish opening/}).isChecked());
  await modal.getByRole('checkbox',{name:/I checked/}).check(); await modal.getByRole('button',{name:'Confirm import',exact:true}).click(); await modal.waitFor({state:'hidden'});
  let stock=await json('/api/inventory'); let progress=await json('/api/inventory/orders');
  const bag=stock.items.find(i=>i.unit==='Bags');const order=progress.orders.find(o=>o.unit==='Bags');
  assert.equal(bag.totalOnHand,30); assert.equal(bag.totalReserved,30);assert.equal(order.netToPlan,70);
  console.log('PASS XLSM import establishes closing stock once, preserves item bag weight and reserves physical stock');
  await page.getByRole('button',{name:'QA-BAG-100',exact:true}).click(); await page.getByRole('dialog',{name:'Order details'}).waitFor();await page.getByText('Still to plan',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Close order details',exact:true}).click();
  await page.getByRole('button',{name:'Generate planning',exact:true}).click(); const draft=page.getByRole('dialog',{name:'Generate planning draft',exact:true});
  await draft.getByLabel('Plan from',{exact:true}).fill(tomorrow);await draft.getByLabel('Plan through',{exact:true}).fill(tomorrow);await draft.getByRole('button',{name:'Generate draft',exact:true}).click();
  await draft.locator('.draft-edit-table tbody tr').first().waitFor();
  const data=await fetch(base+'/api/inventory/draft',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({fromDate:tomorrow,toDate:tomorrow})}).then(r=>r.json());
  assert.equal(data.jobs.filter(j=>j.unit==='Bags').reduce((s,j)=>s+j.quantity,0),90);
  const save=draft.getByRole('button',{name:/Confirm \d+ cards/});await save.click();await draft.waitFor({state:'hidden'});
  let state=(await json('/api/workspace')).state; const job=state.jobs.find(j=>j.sourceOrderId===order.sourceOrderId||j.sourceAllocations?.some(a=>a.sourceOrderId===order.sourceOrderId));
  assert.equal(job.quantityMt,1.75);assert.equal(job.bagWeightKgSnapshot,25);
  await page.locator(`[data-job-id="${job.id}"] .hplan-card-open`).click();
  await page.getByRole('button',{name:'Start production',exact:true}).click();await wait(async()=>(await json('/api/workspace')).state.jobs.find(j=>j.id===job.id).status==='running');
  await page.getByLabel('New quantity (Bags)',{exact:true}).fill('40');await page.getByRole('button',{name:'Record production quantity',exact:true}).click();await wait(async()=>(await json('/api/inventory/orders')).orders.find(o=>o.sourceOrderId===order.sourceOrderId).produced===40);
  await page.locator('.job-drawer').getByRole('button',{name:'Close production details',exact:true}).click();await page.getByRole('button',{name:'Data',exact:true}).click();await page.getByRole('button',{name:'QA-BAG-100',exact:true}).click();
  let lostPickup=false;
  await page.route('**/api/commands',async route=>{const body=route.request().postDataJSON();if(!lostPickup&&body?.command?.type==='delivery.record'){lostPickup=true;await route.fetch();await route.abort('failed');}else await route.continue();});
  await page.getByLabel('Collected quantity (Bags)',{exact:true}).fill('50');await page.getByRole('button',{name:'Record collection',exact:true}).click();
  await wait(async()=>await page.getByRole('button',{name:'Retry connection',exact:true}).first().isVisible() || await page.getByLabel('Collected quantity (Bags)',{exact:true}).inputValue()==='');
  if(await page.getByRole('button',{name:'Retry connection',exact:true}).first().isVisible())await page.getByRole('button',{name:'Retry connection',exact:true}).first().click();
  await wait(async()=>await page.getByLabel('Collected quantity (Bags)',{exact:true}).inputValue()==='');
  await page.unroute('**/api/commands');
  assert.equal((await json('/api/inventory/ledger')).filter(row=>row.movementType==='dispatch').length,1);
  await wait(async()=>(await json('/api/inventory/orders')).orders.find(o=>o.sourceOrderId===order.sourceOrderId).delivered===50);
  progress=await json('/api/inventory/orders');assert.equal(progress.orders.find(o=>o.sourceOrderId===order.sourceOrderId).orderNeed,30);
  console.log('PASS automatic draft produces 70 order bags plus 20 safety-stock bags; partial production and collection update remaining quantities');
  await page.getByRole('button',{name:'Close order details',exact:true}).click();
  assert.equal(await page.getByRole('tablist',{name:'Stock sections'}).count(),0);
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Stock',exact:true}).click();
  await page.getByRole('heading',{name:'Stock',exact:true}).waitFor();assert.equal(new URL(page.url()).hash,'#/stock');
  assert.equal(await page.getByLabel('Search order data').count(),0);
  await page.reload();await page.getByRole('heading',{name:'Stock',exact:true}).waitFor();
  await page.getByRole('button',{name:'Manage stock'}).first().waitFor();
  assert.ok(await page.locator('.inventory-workspace .source-table tbody tr').evaluateAll(rows=>rows.every(row=>[row.cells[0],row.cells[1]].every(cell=>{const bounds=cell.getBoundingClientRect();return [...cell.querySelectorAll('strong,small')].every(text=>{const range=document.createRange();range.selectNodeContents(text);return [...range.getClientRects()].every(rect=>rect.left>=bounds.left&&rect.right<=bounds.right-8);});}))), 'Long product and variant text stays inside its own table column');
  const stockTab=page.getByRole('tab',{name:'Stock',exact:true});await stockTab.focus();await page.keyboard.press('ArrowRight');
  await page.getByLabel('Stock date',{exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'Daily stock',exact:true}).getAttribute('aria-selected'),'true');
  await page.keyboard.press('Home');const manage=page.getByRole('button',{name:'Manage stock'}).last();await manage.scrollIntoViewIfNeeded();const stockScroll=await page.evaluate(()=>scrollY);await manage.click();
  const stockDetails=page.getByRole('dialog',{name:'Manage stock',exact:true});await stockDetails.waitFor();
  assert.ok(await stockDetails.evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight));assert.equal(await page.locator('#root').evaluate(el=>el.inert),true);
  let stockSummaryReached=false;for(let n=0;n<12;n++){await page.keyboard.press('Tab');assert.ok(await stockDetails.evaluate(el=>el.contains(document.activeElement)));stockSummaryReached ||= await page.evaluate(()=>document.activeElement.tagName==='SUMMARY');}assert.ok(stockSummaryReached,'Stock adjustment disclosure remains keyboard reachable');
  await stockDetails.getByLabel('Safety stock (Bags)',{exact:true}).fill('25');await stockDetails.getByRole('button',{name:'Save stock policy',exact:true}).click();
  await wait(async()=>(await json('/api/inventory')).items.find(item=>item.itemId===bag.itemId).targetQuantity===25);await stockDetails.getByRole('status').filter({hasText:'Stock policy saved'}).waitFor();
  await page.getByRole('heading',{name:'Stock movements',exact:true}).waitFor();await page.screenshot({path:path.join(output,'stock-desktop.png'),fullPage:true});
  await page.keyboard.press('Escape');await stockDetails.waitFor({state:'hidden'});assert.equal(await manage.evaluate(el=>el===document.activeElement),true);assert.ok(Math.abs((await page.evaluate(()=>scrollY))-stockScroll)<3,'Closing stock details preserves list scroll');
  for(const viewport of [{width:390,height:844},{width:320,height:760}]){await page.setViewportSize(viewport);await manage.click();await stockDetails.waitFor();assert.ok(await stockDetails.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));await page.screenshot({path:path.join(output,'stock-details-'+viewport.width+'.png')});await page.keyboard.press('Escape');await stockDetails.waitFor({state:'hidden'});}
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('tab',{name:'Daily stock',exact:true}).click();await page.getByLabel('Stock date',{exact:true}).fill(yesterday);await wait(async()=>await page.locator('.source-table tbody tr').count()===2);
  const after=await json('/api/backup');assert.equal(after.schemaVersion,4);assert.ok(after.inventory.ledger.length>=3);
  for(const viewport of [{width:390,height:844},{width:320,height:760}]){await page.setViewportSize(viewport);await page.waitForTimeout(350);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,`daily-${viewport.width}.png`),fullPage:true});}
  await command({type:'data.import',input:{fileName:'fictional-protected-order.xlsx',sheetName:'bulk order',digest:'f'.repeat(64),asOfDate:yesterday,rows:[{doNo:'QA-PROTECTED',goodsMovementStatus:'A',sourceSheet:'bulk order',sourceRow:2,deliveryDate:tomorrow,soldToParty:'Fictional customer',shipToParty:'Fictional ship-to',materialCode:'7.0000000000000',description:'Fictional feed',quantity:20,unit:'MT',deliveryLeadDays:null,remark:'',daysOutstanding:null,medication:'',fmrOmed:''}]}});
  const protectedId=(await json('/api/data?search=QA-PROTECTED')).items[0].id;await command({type:'data.updateManualFields',sourceOrderId:protectedId,patch:{medication:'QA protected med',fmrOmed:'QA protected FMR'}});
  const revised=path.join(output,'fictional-updated-stock.xlsm');const revisedBook=new ExcelJS.Workbook();await revisedBook.xlsx.readFile(file);revisedBook.getWorksheet('bag order').getCell('H2').value=110;revisedBook.getWorksheet('bulk order').getCell('A2').value='QA-PROTECTED';await revisedBook.xlsx.writeFile(revised);
  await page.setViewportSize({width:1440,height:900});await page.reload();await page.getByRole('button',{name:'Import Excel',exact:true}).click();await page.getByLabel('Excel order file').setInputFiles(revised);const compare=page.getByRole('dialog',{name:'Daily stock workbook',exact:true});await compare.getByLabel('Import changes').first().waitFor();const differences=compare.getByLabel('Import changes').first();assert.match(await differences.innerText(),/Quantity[\s\S]*100 Bags[\s\S]*110 Bags/);assert.doesNotMatch(await differences.innerText(),/Medication|FMR/);await page.screenshot({path:path.join(output,'workbook-comparison.png')});await page.keyboard.press('Escape');await compare.waitFor({state:'hidden'});
  console.log('PASS Daily workbook comparisons show before/after quantity and retain protected Medication/FMR');
  assert.deepEqual(errors,[]);console.log('PASS stock ledger, daily stock, backup v4, desktop/mobile rendering and browser console');
 } catch(e) {if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});throw e;}
 finally {if(browser)await browser.close();await command({type:'workspace.restore',backup});}
})().catch(e=>{console.error(e);process.exitCode=1;});
