// Fictional fixtures only. This test replaces an explicitly disposable workspace.
const {chromium}=require('playwright');
const {existsSync}=require('node:fs');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const base=process.env.BROWSER_BASE_URL;
if(!base||process.env.BROWSER_ALLOW_REPLACE!=='1'||!['127.0.0.1','localhost'].includes(new URL(base).hostname)||new URL(base).port==='8080')throw Error('Use an explicitly disposable loopback workspace.');
const hash=value=>createHash('sha256').update(value).digest('hex');
async function json(route){const r=await fetch(base+route);const d=await r.json();assert.equal(r.status,200,JSON.stringify(d));return d;}
async function command(value){const ws=await json('/api/workspace');const r=await fetch(base+'/api/commands',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({expectedRevision:ws.revision,commandId:randomUUID(),command:value})});const d=await r.json();assert.equal(r.status,200,JSON.stringify(d));return d;}
(async()=>{
 const original=await json('/api/backup');let browser;
 try{
  const clean={...original,planning:{...original.planning,catalog:[],jobs:[],events:[],settings:{...original.planning.settings,dayStart:'00:00',availableHours:24,calendarHistory:undefined,calendarCutover:undefined,workingHoursOverrides:undefined,downtime:[]}}};
  for(const key of ['sourceData','inventory','productionProgress','baselineHistory','dailyPlanning'])clean[key]=Object.fromEntries(Object.keys(original[key]).map(name=>[name,[]]));
  await command({type:'workspace.restore',backup:clean});
  const context=await json('/api/data/import-context'),material='7.9999999522000',description='FS 5220 FICTIONAL BULK';
  await command({type:'inventory.importStockReports',reports:[{fileName:'fictional-stock.xlsm',digest:hash('readiness-stock'),sheetName:'daily',asOfDate:context.asOfDate,stockRows:[{materialCode:material,description,unit:'MT',bagWeightKg:null,strategy:'mto',targetQuantity:0,needsReview:false,opening:100,production:0,received:0,salesReturn:0,rework:0,issue:0,closing:100,medication:'',fmrOmed:''}]}],reconcile:false,reason:''});
  const row=(doNo,quantity)=>({doNo,deliveryDate:context.targetIssueDate,soldToParty:'Fictional buyer',shipToParty:'Fictional buyer',materialCode:material,description,quantity,unit:'MT',deliveryLeadDays:1,remark:'',daysOutstanding:null,medication:'',fmrOmed:''});
  await command({type:'data.importBatch',inputs:[{fileName:'fictional-sap.xlsx',sheetName:'bulk order',digest:hash('readiness-orders'),asOfDate:context.asOfDate,rows:[row('FICTION-STOCK-READY',50),row('FICTION-NEEDS-PRODUCTION',1000)]}]});
  browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
  const page=await browser.newPage({viewport:{width:1366,height:768},timezoneId:'Asia/Kuala_Lumpur'});page.setDefaultTimeout(15000);page.on('dialog',dialog=>dialog.accept());
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.clock.install({time:new Date()});await page.goto(base+'/#/data');
  const ready=page.locator('.source-table tbody tr').filter({hasText:'FICTION-STOCK-READY'});await ready.getByText('Stock ready',{exact:true}).first().waitFor();
  assert.match(await ready.innerText(),/Covered by stock/);assert.doesNotMatch(await ready.innerText(),/External complete|Already processed/);
  assert.match(await page.getByLabel('Filtered order summary').innerText(),/Stock ready \/ completed\s+1 \/ 0/);
  await page.getByRole('button',{name:'Advanced filters',exact:true}).click();await page.getByRole('combobox',{name:/^Production/}).selectOption('stock-ready');
  await page.waitForFunction(()=>document.querySelectorAll('.source-table tbody tr').length===1);
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();
  await page.getByRole('button',{name:'Generate planning',exact:true}).click();const modal=page.getByRole('dialog',{name:'Generate planning draft',exact:true});
  await modal.getByRole('button',{name:'Generate draft',exact:true}).click();await modal.getByText(/Confirm before/).waitFor();
  const confirm=modal.getByRole('button',{name:/Confirm \d+ proposals/});await confirm.waitFor();
  let submitted;
  await page.route('**/api/commands',async route=>{const body=route.request().postDataJSON();if(body.command?.type==='planning.commitDraft'){submitted=body;await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'DRAFT_CAPACITY_CHANGED',message:'Fictional capacity changed; regenerate using current capacity.'}})});return;}await route.continue();});
  await confirm.click();await modal.getByRole('alert').filter({hasText:'DRAFT_CAPACITY_CHANGED'}).waitFor();
  assert.match(await modal.innerText(),/Fictional capacity changed/);assert.equal((await json('/api/workspace')).state.jobs.length,0);
  const local=await page.evaluate(()=>JSON.parse(localStorage.getItem('millplan.planning-draft.v1')));assert.ok(local.jobs.length);assert.equal(local.pendingCommit,undefined);
  await page.unroute('**/api/commands');
  // Browser clock only: expired proposals are blocked before any request is sent.
  const deadline=Math.min(...submitted.command.jobs.map(job=>Date.parse(job.notBefore)));
  await page.clock.setSystemTime(new Date(deadline+1000));await page.clock.runFor(15001);
  await modal.getByRole('alert').filter({hasText:'first proposed start has passed'}).waitFor();assert.equal(await confirm.isDisabled(),true);
  await page.clock.setSystemTime(new Date());await page.clock.runFor(15001);await modal.getByRole('button',{name:'Regenerate draft',exact:true}).click();await modal.getByText(/Confirm before/).waitFor();
  while(await modal.locator('button[aria-label^="Remove draft-"]').count()>1)await modal.locator('button[aria-label^="Remove draft-"]').last().click();
  await modal.locator('input[aria-label^="Quantity draft-"]').first().fill('1');
  const firstLine=modal.locator('select[aria-label^="Line draft-"]').first(),oldLine=await firstLine.inputValue();await firstLine.selectOption(oldLine==='PM1'?'PM2':'PM1');assert.equal(await confirm.isEnabled(),true,'Changing PM today retains a future review floor');
  await confirm.click();await modal.waitFor({state:'hidden'});
  assert.ok((await json('/api/workspace')).state.jobs.length>0);assert.equal((await json('/api/inventory')).items[0].totalOnHand,100,'Planning does not manufacture physical stock');
  assert.deepEqual(errors,[]);
  console.log('PASS stock-ready labels/filter/stats, retained server rejection, deadline expiry and regenerated atomic confirmation');
 }finally{if(browser)await browser.close();await command({type:'workspace.restore',backup:original});}
})().catch(error=>{console.error(error);process.exitCode=1;});
