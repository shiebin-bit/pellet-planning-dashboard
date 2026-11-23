// Fictional fixtures only. This test replaces an explicitly disposable workspace.
const {chromium}=require('playwright');
const {existsSync}=require('node:fs');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const base=process.env.BROWSER_BASE_URL;
if(!base||process.env.BROWSER_ALLOW_REPLACE!=='1'||!['127.0.0.1','localhost'].includes(new URL(base).hostname)||new URL(base).port==='8080')throw Error('Use an explicitly disposable loopback workspace.');
const hash=value=>createHash('sha256').update(value).digest('hex');
async function json(route){const response=await fetch(base+route),data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;}
async function command(value){const workspace=await json('/api/workspace');const response=await fetch(base+'/api/commands',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({expectedRevision:workspace.revision,commandId:randomUUID(),command:value})});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;}
(async()=>{
  const original=await json('/api/backup');let browser;
  try{
    const clean={...original,planning:{...original.planning,catalog:[],jobs:[],events:[],settings:{...original.planning.settings,dayStart:'00:00',availableHours:24,calendarHistory:undefined,calendarCutover:undefined,workingHoursOverrides:undefined,downtime:[]}}};
    for(const key of ['sourceData','inventory','productionProgress','baselineHistory','dailyPlanning'])clean[key]=Object.fromEntries(Object.keys(original[key]).map(name=>[name,[]]));
    await command({type:'workspace.restore',backup:clean});
    const context=await json('/api/data/import-context'),material='7.9999999522100',description='FS 5210 FICTIONAL BULK';
    await command({type:'inventory.importStockReports',reports:[{fileName:'fictional-zero-stock.xlsm',digest:hash('retry-rejection-stock'),sheetName:'daily',asOfDate:context.asOfDate,stockRows:[{materialCode:material,description,unit:'MT',bagWeightKg:null,strategy:'mto',targetQuantity:0,needsReview:false,opening:0,production:0,received:0,salesReturn:0,rework:0,issue:0,closing:0,medication:'',fmrOmed:''}]}],reconcile:false,reason:''});
    await command({type:'data.importBatch',inputs:[{fileName:'fictional-sap.xlsx',sheetName:'bulk order',digest:hash('retry-rejection-order'),asOfDate:context.asOfDate,rows:[{doNo:'FICTION-RETRY-REJECT',deliveryDate:context.targetIssueDate,soldToParty:'Fictional buyer',shipToParty:'Fictional buyer',materialCode:material,description,quantity:10,unit:'MT',deliveryLeadDays:1,remark:'',daysOutstanding:null,medication:'',fmrOmed:''}]}]});
    browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
    const page=await browser.newPage({viewport:{width:1366,height:768},timezoneId:'Asia/Kuala_Lumpur'});page.setDefaultTimeout(15000);page.on('dialog',dialog=>dialog.accept());
    const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/#/planning');
    await page.getByRole('button',{name:'Generate planning',exact:true}).click();const modal=page.getByRole('dialog',{name:'Generate planning draft',exact:true});
    await modal.getByRole('button',{name:'Generate draft',exact:true}).click();const confirm=modal.getByRole('button',{name:/Confirm \d+ proposals/});await confirm.waitFor();
    const lose=async route=>{const body=route.request().postDataJSON();if(body.command?.type==='planning.commitDraft'){await route.abort();return;}await route.continue();};
    await page.route('**/api/commands',lose);await confirm.click();await modal.getByRole('button',{name:'Check previous save',exact:true}).waitFor();
    const pending=await page.evaluate(()=>JSON.parse(localStorage.getItem('millplan.planning-draft.v1')));assert.ok(pending.pendingCommit?.commandId);assert.ok(pending.jobs.length);
    const deadline=Math.min(...pending.pendingCommit.command.jobs.map(job=>Date.parse(job.notBefore)),...pending.pendingCommit.command.carryovers.map(row=>Date.parse(row.notBefore)));
    await page.unroute('**/api/commands',lose);
    await page.route('**/api/commands',async route=>{const body=route.request().postDataJSON();if(body.command?.type==='planning.commitDraft'){await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'DRAFT_EXPIRED',message:'The planning draft reached its first proposed start.'}})});return;}await route.continue();});
    await page.clock.install({time:new Date(deadline+1000)});await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await modal.getByRole('alert').filter({hasText:'DRAFT_EXPIRED'}).waitFor();
    const retained=await page.evaluate(()=>JSON.parse(localStorage.getItem('millplan.planning-draft.v1')));assert.equal(retained.pendingCommit,undefined);assert.ok(retained.jobs.length);assert.equal((await json('/api/workspace')).state.jobs.length,0);
    assert.doesNotMatch(await modal.innerText(),/PostgreSQL is unavailable/);assert.equal(errors.length,0);
    console.log('PASS an uncertain planning retry rejected after its deadline preserves the draft, clears only its matching pending marker and shows the server reason');
  }finally{if(browser)await browser.close();await command({type:'workspace.restore',backup:original});}
})().catch(error=>{console.error(error);process.exitCode=1;});
