// Fictional fixtures only; mutations are guarded and restored in a disposable database.
const {chromium}=require('playwright');
const {existsSync}=require('node:fs');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {planningAction}=require('./planning-actions.cjs');
const base=process.env.BROWSER_BASE_URL;
if(!base||process.env.BROWSER_ALLOW_REPLACE!=='1'||!['localhost','127.0.0.1'].includes(new URL(base).hostname)||new URL(base).port==='8080')throw Error('Use an isolated loopback test database and explicit replacement opt-in.');
const output=path.resolve('output/playwright/workbench-ux');
const json=async route=>{const r=await fetch(base+route);assert.equal(r.status,200);return r.json();};
const command=async command=>{const w=await json('/api/workspace');const r=await fetch(base+'/api/commands',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({expectedRevision:w.revision,commandId:randomUUID(),command})});assert.equal(r.status,200,await r.text());};
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur'}).format(new Date());
async function bounds(locator,viewport){const b=await locator.boundingBox();assert.ok(b&&b.x>=0&&b.y>=0&&b.x+b.width<=viewport.width+1&&b.y+b.height<=viewport.height+1,JSON.stringify(b));}
(async()=>{
 await fs.mkdir(output,{recursive:true});const backup=await json('/api/backup');let browser,page;
 try{
  await command({type:'workspace.resetDemo',date:today});
  const items=Array.from({length:12},(_,i)=>({materialCode:'7.0800000000'+String(i).padStart(3,'0'),description:`FS ${5220+i} FICTIONAL FINISHER FEED WITH A LONG COMPLETE DESCRIPTION ${i===0?'25KG':i===1?'IN BULK':'50KG'}`,unit:i===1?'MT':'Bags',bagWeightKg:i===1?null:i===0?25:50,strategy:'mto',targetQuantity:0,needsReview:false,opening:0,production:0,received:0,salesReturn:0,rework:0,issue:0,closing:0,medication:'',fmrOmed:''}));
  const orders=items.map((item,i)=>({doNo:'QA-WORKBENCH-'+i,deliveryDate:today,soldToParty:'Fictional farm',shipToParty:'Fictional farm '+i,materialCode:item.materialCode,description:item.description,quantity:i===1?.001:100,unit:item.unit,deliveryLeadDays:0,remark:'Open',daysOutstanding:1,medication:'',fmrOmed:''}));
  await command({type:'inventory.importBaseline',input:{fileName:'fictional-workbench-stock.xlsx',digest:'a'.repeat(64),asOfDate:today,includeBaseline:true,packingBinTotal:null,orders:[{fileName:'fictional-workbench-orders.xlsx',sheetName:'bag order',digest:'b'.repeat(64),asOfDate:today,rows:orders}],items,annotations:[]}});
  const initial=await json('/api/backup');
  browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
  const context=await browser.newContext({viewport:{width:1366,height:768},timezoneId:'Asia/Kuala_Lumpur',reducedMotion:'reduce'});
  page=await context.newPage();page.setDefaultTimeout(10000);const errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/api/commands',route=>{writes.push(route.request().method());return route.abort();});
  await page.goto(base+'/#/planning');await page.locator('.hplan-board').waitFor();
  const more=page.locator('.planning-more'),trigger=more.locator('summary');
  assert.equal(await page.getByRole('button',{name:'Copy planning',exact:true}).count(),0,'Secondary actions start collapsed');
  await trigger.focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:'Copy planning',exact:true}).waitFor();await bounds(page.locator('.planning-more-panel'),{width:1366,height:768});
  await page.keyboard.press('Escape');assert.equal(await more.getAttribute('open'),null);assert.ok(await trigger.evaluate(el=>el===document.activeElement));
  await trigger.click();await page.getByRole('heading',{name:'Planning board',exact:true}).click();assert.equal(await more.getAttribute('open'),null);
  for(const [action,title]of[['Copy planning','Copy planning'],['Plan from Orders','Choose an order to plan'],['Combine cards','Combine production cards']]){
   await planningAction(page,action);const modal=page.getByRole('dialog');await modal.waitFor();assert.match(await modal.locator('h2').first().innerText(),new RegExp(title));assert.equal(await more.getAttribute('open'),null);await bounds(modal,{width:1366,height:768});await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});assert.ok(await trigger.evaluate(el=>el===document.activeElement),'Dialog restores visible More trigger');
  }
  await trigger.click();await trigger.press('Tab');assert.ok(await more.evaluate(el=>el.contains(document.activeElement)));await page.keyboard.press('Shift+Tab');await page.keyboard.press('Shift+Tab');assert.equal(await more.getAttribute('open'),null,'Tab out dismisses disclosure');
  await page.screenshot({path:path.join(output,'planning-desktop.png')});
  console.log('PASS Secondary planning actions are discoverable, Escape/outside/Tab dismissal works, and all three dialogs return focus to a visible trigger without saving');
  await page.getByRole('navigation',{name:'Main navigation',exact:true}).getByRole('button',{name:'Orders',exact:true}).click();const orderRow=page.locator('.orders-table tbody tr').first();await orderRow.waitFor();
  const details=orderRow.locator('.product-identity-details'),material=orderRow.locator('.product-identity-material');assert.equal(await material.isVisible(),false);
  await details.locator('summary').focus();await page.keyboard.press('Enter');await material.waitFor();assert.match(await material.innerText(),/7\.0800000000000/);assert.match(await details.locator('p').innerText(),/LONG COMPLETE DESCRIPTION 25KG/);
  await page.keyboard.press('Enter');assert.equal(await material.isVisible(),false);
  assert.match(await orderRow.locator('.product-identity-title').innerText(),/5220.*25kg Bags/);assert.equal(await orderRow.locator('td').nth(3).innerText(),'100 Bags');
  const bulk=page.locator('.orders-table tbody tr').filter({hasText:'QA-WORKBENCH-1'}).first();assert.match(await bulk.locator('td').nth(3).innerText(),/0\.001 MT/);
  assert.ok((await orderRow.boundingBox()).height<=95,'Ordinary Orders rows fit a compact reading height');
  const visibleRows=await page.locator('.orders-table tbody tr').evaluateAll(rows=>rows.filter(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}).length);assert.ok(visibleRows>=4,`At least4 complete Orders rows in768px, saw${visibleRows}`);
  await orderRow.locator('.data-order-link').click();await page.getByRole('dialog',{name:'Order details',exact:true}).waitFor();await page.keyboard.press('Escape');
  await page.screenshot({path:path.join(output,'orders-desktop.png')});
  await page.getByRole('button',{name:'Stock',exact:true}).click();const stockRow=page.locator('.stock-records-table tbody tr').first();await stockRow.waitFor();
  assert.ok(Number(await stockRow.locator('td').nth(2).evaluate(el=>parseFloat(getComputedStyle(el).fontSize)))>=14);assert.ok((await stockRow.boundingBox()).height<=85);
  await stockRow.locator('.product-identity-details summary').click();await stockRow.locator('.product-identity-material').waitFor();await stockRow.locator('.product-identity-details summary').click();
  await stockRow.getByRole('button',{name:'Manage stock',exact:true}).click();await page.getByRole('dialog',{name:'Manage stock',exact:true}).waitFor();await page.keyboard.press('Escape');
  await page.screenshot({path:path.join(output,'stock-desktop.png')});
  console.log('PASS Compact Orders/Stock preserve searchable full identities and keyboard expansion, exact Bags/0.001MT, readable14px balances and existing details dialogs');
  for(const width of[390,320]){
   const viewport={width,height:844};await page.setViewportSize(viewport);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('button',{name:'Planning board',exact:true}).click();await page.locator('.production-list').waitFor();
   assert.ok((await page.locator('.production-list-card').first().boundingBox()).y<420,'First mobile card is visible without a long toolbar scroll');
   await trigger.click();await bounds(page.locator('.planning-more-panel'),viewport);await page.keyboard.press('Escape');
   await page.screenshot({path:path.join(output,`planning-${width}.png`)});
   for(const label of['Orders','Stock']){await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('navigation',{name:'Main navigation',exact:true}).getByRole('button',{name:label,exact:true}).click();await page.locator(label==='Orders'?'.orders-table':'.stock-records-table').waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,`${label.toLowerCase()}-${width}.png`)});}
  }
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);const after=await json('/api/backup');assert.deepEqual(after.planning,initial.planning);assert.deepEqual(after.sourceData,initial.sourceData);assert.deepEqual(after.inventory,initial.inventory);
  console.log('PASS Compact controls and tables fit390/320px; first mobile card appears sooner; views create no commands or business changes');
 }catch(e){if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});throw e;}
 finally{if(browser)await browser.close();await command({type:'workspace.restore',backup});}
})().catch(e=>{console.error(e);process.exitCode=1;});
