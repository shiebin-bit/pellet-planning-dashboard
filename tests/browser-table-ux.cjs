// Fictional fixtures only. These mutations require an isolated disposable database/server.
const {chromium}=require('playwright');
const {existsSync}=require('node:fs');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const ExcelJS=require('exceljs');
const base=process.env.BROWSER_BASE_URL;
if(!base||process.env.BROWSER_ALLOW_REPLACE!=='1'||!['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname)||new URL(base).port==='8080')throw Error('Use an isolated loopback BROWSER_BASE_URL, never production8080, with BROWSER_ALLOW_REPLACE=1.');
const output=path.resolve('output/playwright/table-ux');
const json=async route=>{const r=await fetch(base+route);assert.equal(r.status,200);return r.json();};
const command=async command=>{const w=await json('/api/workspace');const r=await fetch(base+'/api/commands',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({expectedRevision:w.revision,commandId:randomUUID(),command})});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;};
const wait=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}assert.fail('Timed out waiting for UI state');};
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur'}).format(new Date());
const baselineDate=new Date(Date.parse(today+'T12:00:00Z')-86400000).toISOString().slice(0,10);
const planningDate='2026-10-19';
async function bounds(locator,viewport){const r=await locator.boundingBox();assert.ok(r&&r.x>=0&&r.y>=0&&r.x+r.width<=viewport.width+1&&r.y+r.height<=viewport.height+1,JSON.stringify(r));}
async function scrollCheck(page,label){
 const area=page.getByRole('region',{name:label+' — scroll for more columns',exact:true});
 await area.waitFor();await area.scrollIntoViewIfNeeded();
 assert.ok(await area.evaluate(el=>el.clientHeight<=640&&el.scrollHeight>el.clientHeight),'Long tables have bounded vertical scrolling');
 await area.evaluate(el=>{el.scrollTop=el.scrollHeight;});
 assert.ok(await area.locator('th').first().evaluate(el=>Math.abs(el.getBoundingClientRect().top-el.closest('.record-table-scroll').getBoundingClientRect().top)<2),'Header stays visible at the last row');
 if(await area.evaluate(el=>el.scrollWidth>el.clientWidth+1)){
  const right=page.getByRole('button',{name:'Scroll '+label.toLowerCase()+' right',exact:true});await right.waitFor();await right.click();await wait(()=>area.evaluate(el=>el.scrollLeft>0));
  const left=page.getByRole('button',{name:'Scroll '+label.toLowerCase()+' left',exact:true});await wait(()=>left.isEnabled());await left.click();await wait(()=>area.evaluate(el=>el.scrollLeft<2));
 }
 return area;
}
(async()=>{
 await fs.mkdir(output,{recursive:true});const backup=await json('/api/backup');let browser,page;
 try{
  await command({type:'workspace.resetDemo',date:planningDate});
  const state=(await json('/api/workspace')).state,sample=state.jobs.find(j=>j.status==='pending'&&j.quantityMt>0);
  await command({type:'workspace.restore',backup:{...state,jobs:Array.from({length:57},(_,i)=>({...sample,id:'table-qa-'+i,orderNo:'TABLE-'+i,sequence:i+1,lineId:i%2?'PM2':'PM1',date:planningDate})),events:[]}});
  const items=Array.from({length:57},(_,i)=>({materialCode:'7.9000000'+String(i).padStart(6,'0'),description:'Fictional finished feed for table navigation '+i,unit:'Bags',bagWeightKg:50,strategy:'mto',targetQuantity:0,needsReview:false,opening:10,production:0,received:0,salesReturn:0,rework:0,issue:0,closing:10,medication:'',fmrOmed:''}));
  await command({type:'inventory.importBaseline',input:{fileName:'fictional-table-stock.xlsm',digest:createHash('sha256').update('table-fixture').digest('hex'),asOfDate:baselineDate,orders:[],items,annotations:[],packingBinTotal:null,includeBaseline:true}});
  browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
  page=await browser.newPage({viewport:{width:1366,height:768},timezoneId:'Asia/Kuala_Lumpur',acceptDownloads:true});page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/#/planning');await page.locator('.hplan-board').waitFor();
  await page.locator('.date-picker-trigger').click();await page.getByLabel('Calendar year').selectOption('2026');await page.getByLabel('Calendar month').selectOption('9');await page.locator('[data-date="'+planningDate+'"]').click();await page.getByRole('button',{name:'Stock',exact:true}).click();await page.getByRole('button',{name:'Manage stock',exact:true}).first().waitFor();
  assert.ok((await page.getByLabel('Stock dates').innerText()).includes(new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(baselineDate+'T12:00:00Z'))));
  const stockTop=page.getByRole('navigation',{name:'Stock pages — top',exact:true}),stockBottom=page.getByRole('navigation',{name:'Stock pages — bottom',exact:true});
  await stockTop.getByRole('button',{name:'Next stock page',exact:true}).click();await wait(async()=>await page.locator('.source-table tbody tr').count()===7);assert.match(await stockBottom.innerText(),/Page 2 of 2/);
  await stockBottom.getByRole('button',{name:'Previous stock page',exact:true}).click();await wait(async()=>await page.locator('.source-table tbody tr').count()===50);
  await scrollCheck(page,'Stock table');await page.screenshot({path:path.join(output,'stock-desktop.png')});
  await page.getByLabel('Search stock').fill('NO-MATCH');await wait(async()=>await page.locator('.source-table tbody tr').count()===0);assert.equal(await stockTop.getByRole('button',{name:'Next stock page'}).isDisabled(),true);await page.getByLabel('Search stock').fill('');await wait(async()=>await page.locator('.source-table tbody tr').count()===50);
  console.log('PASS Stock top/bottom pagination stays in sync, empty filters recover, headers stay fixed and scroll controls work');

  await page.getByRole('tab',{name:'Daily stock',exact:true}).click();await page.getByRole('button',{name:'Enter physical count',exact:true}).first().waitFor();
  assert.equal(await page.getByLabel('Stock date',{exact:true}).inputValue(),today);assert.match(await page.getByLabel('Daily stock date context').innerText(),/planning date does not filter/);
  const dailyTop=page.getByRole('navigation',{name:'Daily stock pages — top',exact:true}),dailyBottom=page.getByRole('navigation',{name:'Daily stock pages — bottom',exact:true});
  await dailyTop.getByRole('button',{name:'Next daily stock page'}).click();await wait(async()=>await page.locator('.source-table tbody tr').count()===7);assert.match(await dailyBottom.innerText(),/Page 2 of 2/);await dailyBottom.getByRole('button',{name:'Previous daily stock page'}).click();await wait(async()=>await page.locator('.source-table tbody tr').count()===50);
  const area=await scrollCheck(page,'Daily stock table');const trigger=page.getByRole('button',{name:'Enter physical count',exact:true}).last();await trigger.scrollIntoViewIfNeeded();const originalScroll=await area.evaluate(el=>el.scrollTop),windowScroll=await page.evaluate(()=>scrollY);
  let releaseLoad;const heldLoad=new Promise(resolve=>{releaseLoad=resolve;});await page.route('**/api/inventory',async route=>{await heldLoad;await route.continue();});
  await trigger.click();const loadingDialog=page.getByRole('dialog',{name:'Physical stock count',exact:true});await loadingDialog.getByRole('status').filter({hasText:'Loading stock details'}).waitFor();await page.keyboard.press('Escape');await loadingDialog.waitFor({state:'hidden'});const loaded=page.waitForResponse(response=>response.url()===base+'/api/inventory');releaseLoad();await loaded;await page.unroute('**/api/inventory');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await loadingDialog.count(),0,'Closing a loading count dialog ignores late inventory responses');
  await trigger.click();const dialog=page.getByRole('dialog',{name:'Physical stock count',exact:true});await dialog.waitFor();await bounds(dialog,{width:1366,height:768});assert.equal(await page.locator('#root').evaluate(el=>el.inert),true);
  for(let i=0;i<9;i++){await page.keyboard.press('Tab');assert.ok(await dialog.evaluate(el=>el.contains(document.activeElement)));}
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);assert.ok(Math.abs(await area.evaluate(el=>el.scrollTop)-originalScroll)<2);assert.ok(Math.abs(await page.evaluate(()=>scrollY)-windowScroll)<2);
  await trigger.click();await dialog.waitFor();await dialog.getByLabel('Physical count (Bags)',{exact:true}).fill('11');await dialog.getByLabel('Count adjustment reason',{exact:true}).fill('Fictional QA count');
  let lost=false,recover=false;const ids=[];await page.route('**/api/commands',async route=>{const c=route.request().postDataJSON();if(c.command.type==='inventory.adjust'){ids.push(c.commandId);if(!recover){if(!lost){lost=true;await route.fetch();}await route.abort();return;}}await route.continue();});
  await dialog.getByRole('button',{name:'Confirm physical count',exact:true}).click();await dialog.getByRole('button',{name:'Retry connection',exact:true}).waitFor();assert.equal(await dialog.getByLabel('Physical count (Bags)',{exact:true}).inputValue(),'11');recover=true;await dialog.getByRole('button',{name:'Retry connection',exact:true}).click();await wait(async()=>await dialog.getByLabel('Physical count (Bags)',{exact:true}).inputValue()==='');await page.unroute('**/api/commands');assert.equal(new Set(ids).size,1);assert.equal((await json('/api/inventory/ledger')).filter(e=>e.movementType==='adjustment').length,1);await dialog.getByRole('status').filter({hasText:'previous change is confirmed'}).waitFor();
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  for(const viewport of [{width:390,height:844},{width:320,height:760}]){await page.setViewportSize(viewport);await scrollCheck(page,'Daily stock table');await trigger.click();await dialog.waitFor();await bounds(dialog,viewport);await bounds(dialog.getByRole('button',{name:'Close physical count'}),viewport);await page.screenshot({path:path.join(output,'count-'+viewport.width+'.png')});await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  console.log('PASS Bottom-row physical count opens a bounded modal, traps/restores focus and scroll, preserves failed drafts and retries one adjustment; mobile fits');

  await page.setViewportSize({width:1366,height:768});await page.getByRole('button',{name:'History',exact:true}).click();await page.getByRole('region',{name:'History table — scroll for more columns',exact:true}).waitFor();
  const historyTop=page.getByRole('navigation',{name:'History pages — top',exact:true}),historyBottom=page.getByRole('navigation',{name:'History pages — bottom',exact:true});await historyTop.getByRole('button',{name:'Next history page'}).click();assert.match(await historyBottom.innerText(),/Page 2 of 2/);assert.equal(await page.locator('.table-scroll tbody tr').count(),7);await historyBottom.getByRole('button',{name:'Previous history page'}).click();await scrollCheck(page,'History table');
  await page.getByLabel('History from date').fill(today);await page.getByLabel('History to date').fill(today);await page.getByRole('heading',{name:'No matching records',exact:true}).waitFor();assert.match(await page.getByLabel('History date and export context').innerText(),/19 Oct 2026/);
  await page.getByRole('button',{name:'Export',exact:true}).click();assert.match(await page.locator('.export-menu').innerText(),/History|Page filters do not apply/);const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:/^Excel report/}).click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'Millplan_'+planningDate+'.xlsx');const exported=path.join(output,'quick-planning.xlsx');await download.saveAs(exported);const book=new ExcelJS.Workbook();await book.xlsx.readFile(exported);assert.equal(book.getWorksheet('Actual production').rowCount,58);
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();for(const viewport of [{width:390,height:844},{width:320,height:760}]){await page.setViewportSize(viewport);await scrollCheck(page,'History table');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'history-'+viewport.width+'.png')});}
  assert.deepEqual(errors,[]);console.log('PASS History dual pagination and sticky headers, explicit independent dates, and quick export includes the planning day despite empty History filters');
 }catch(e){if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});throw e;}
 finally{if(browser)await browser.close();await command({type:'workspace.restore',backup});}
})().catch(e=>{console.error(e);process.exitCode=1;});
