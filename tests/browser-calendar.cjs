// Fictional fixtures only. Calendar mutation tests must use the disposable test workspace.
const {chromium}=require('playwright');
const {existsSync}=require('node:fs');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const base=process.env.BROWSER_BASE_URL;
if(!base||process.env.BROWSER_ALLOW_REPLACE!=='1'||!['localhost','127.0.0.1'].includes(new URL(base).hostname)||new URL(base).port==='8080')throw Error('Use an isolated loopback BROWSER_BASE_URL with BROWSER_ALLOW_REPLACE=1.');
const output=path.resolve('output/playwright/redesign/calendar');
const json=async route=>{const r=await fetch(base+route);assert.equal(r.status,200);return r.json();};
const command=async command=>{const {revision}=await json('/api/workspace');const r=await fetch(base+'/api/commands',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({expectedRevision:revision,commandId:randomUUID(),command})});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;};
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur'}).format(new Date());
const addDay=n=>new Date(Date.parse(today+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const tomorrow=addDay(1),yesterday=addDay(-1);
const wait=async fn=>{for(let n=0;n<100;n++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Calendar state did not arrive');};
(async()=>{
 await fs.mkdir(output,{recursive:true});const backup=await json('/api/backup');let browser,page;
 try{
  const settings={...backup.planning.settings,dayStart:'07:00',availableHours:12,changeoverMinutes:0,rates:{PM1:10,PM2:10,PM3:10,PM4:10},slowProductPrefixes:[],downtime:[],calendarCutover:{effectiveFrom:yesterday,priorDayStart:'08:30',priorAvailableHours:23,activatedAt:new Date().toISOString()}};
  delete settings.calendarHistory;
  const manual={id:'qa-calendar-manual',date:tomorrow,lineId:'PM1',sequence:1,orderNo:'QA-CALENDAR-MANUAL',productCode:'QA-CALENDAR',description:'Fictional manual calendar fixture',bin:'QA',mode:'bulk',bagCount:null,quantityMt:100,status:'pending',remarks:'Retain this quantity',actualStart:null,actualEnd:null,binNeedsReview:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  const locked={...manual,id:'qa-calendar-locked',orderNo:'QA-CALENDAR-LOCKED',productCode:'QA-LOCKED',date:yesterday,lineId:'PM4',quantityMt:10,status:'completed',actualStart:`${today}T05:00:00+08:00`,actualEnd:`${today}T06:00:00+08:00`,lockedSegments:[{jobId:'qa-calendar-locked',lineId:'PM4',kind:'production',start:Date.parse(`${today}T05:00:00+08:00`),end:Date.parse(`${today}T06:00:00+08:00`)}]};
  const restored=await command({type:'workspace.restore',backup:{...backup.planning,settings,jobs:[manual,locked],events:[]}});const frozenBefore=restored.state.jobs.find(j=>j.id===locked.id);
  const material='7.0000099522000';
  const order={doNo:'QA-CALENDAR-ORDER',deliveryDate:tomorrow,soldToParty:'Fictional calendar customer',shipToParty:'Fictional calendar destination',materialCode:material,description:'FS 5220 FICTIONAL FEED IN BULK',quantity:1000,unit:'MT',deliveryLeadDays:1,remark:'',daysOutstanding:0,medication:'',fmrOmed:''};
  await command({type:'inventory.importBaseline',input:{fileName:'fictional-calendar.xlsm',digest:'a'.repeat(64),asOfDate:yesterday,includeBaseline:true,orders:[{fileName:'fictional-calendar.xlsm',sheetName:'bulk order',digest:'b'.repeat(64),asOfDate:yesterday,rows:[order]}],items:[{materialCode:material,description:order.description,unit:'MT',bagWeightKg:null,strategy:'mto',targetQuantity:0,needsReview:false,opening:0,production:0,received:0,salesReturn:0,rework:0,issue:0,closing:0,medication:'',fmrOmed:''}],annotations:[],packingBinTotal:null}});
  browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
  page=await browser.newPage({viewport:{width:1366,height:768},timezoneId:'Asia/Kuala_Lumpur',reducedMotion:'reduce'});page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/#/settings');const start=page.getByLabel('Planning day starts',{exact:true}),hours=page.getByRole('spinbutton',{name:/Daily available hours/});await start.waitFor();assert.equal(await start.isEnabled(),true);assert.equal(await hours.isEnabled(),true);
  await start.fill('08:00');await hours.fill('8');await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await wait(async()=>{const s=(await json('/api/workspace')).state.settings;return s.dayStart==='08:00'&&s.availableHours===8;});
  await page.getByText('Planning settings saved',{exact:true}).waitFor();await page.reload();await wait(async()=>await hours.inputValue()==='8');
  await page.getByRole('button',{name:'Planning board',exact:true}).click();await page.locator('.legacy-carryover').filter({hasText:'extend outside this shift'}).waitFor();assert.deepEqual((await json('/api/workspace')).state.jobs.find(j=>j.id===locked.id),frozenBefore);await page.locator('.date-picker-trigger').click();await page.getByLabel('Calendar year').selectOption(tomorrow.slice(0,4));await page.getByLabel('Calendar month').selectOption(String(Number(tomorrow.slice(5,7))-1));await page.locator(`[data-date="${tomorrow}"]`).click();
  assert.equal(await page.locator('.hplan-axis-tick span').first().innerText(),'08:00');assert.equal(await page.locator('.hplan-axis-tick span').last().innerText(),'16:00');await page.getByRole('button',{name:'Full plan',exact:true}).waitFor();
  const retained=(await json('/api/workspace')).state.jobs.find(j=>j.id===manual.id);assert.equal(retained.quantityMt,100);assert.equal(retained.status,'pending');assert.equal(retained.orderNo,manual.orderNo);assert.equal(retained.actualStart,null);
  console.log('PASS Activated calendar remains editable, persists after reload and updates board window/carry-over without altering quantities');
  await command({type:'job.cancel',jobId:manual.id});await page.reload();
  async function draftTotal(expected){
   await page.getByRole('button',{name:'Generate planning',exact:true}).click();const draft=page.getByRole('dialog',{name:'Generate planning draft',exact:true});await draft.getByLabel('Plan from',{exact:true}).fill(tomorrow);await draft.getByLabel('Plan through',{exact:true}).fill(tomorrow);await draft.getByRole('button',{name:'Generate draft',exact:true}).click();await draft.locator('.draft-edit-table tbody tr').first().waitFor();
   const inputs=draft.locator('input[aria-label^="Quantity draft-"]');const values=await inputs.evaluateAll(nodes=>nodes.map(n=>Number(n.value)));assert.equal(values.reduce((sum,q)=>sum+q,0),expected);return draft;
  }
  let draft=await draftTotal(320);await draft.getByRole('button',{name:'Cancel',exact:true}).click();await draft.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Settings',exact:true}).click();await hours.fill('12');await page.getByRole('button',{name:'Save settings',exact:true}).click();await wait(async()=>(await json('/api/workspace')).state.settings.availableHours===12);await page.getByText('Planning settings saved',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Planning board',exact:true}).click();draft=await draftTotal(480);assert.equal(await draft.getByRole('button',{name:'Confirm 4 cards',exact:true}).isEnabled(),true);assert.match(await draft.locator('.draft-edit-table').innerText(),/20:00/);await page.screenshot({path:path.join(output,'extended-hours-draft.png')});await draft.getByRole('button',{name:'Cancel',exact:true}).click();await draft.waitFor({state:'hidden'});
  console.log('PASS Generate planning scales from320 MT in8 hours to480 MT in12 hours and accepts a20:00 finish');
  await page.getByRole('button',{name:'Settings',exact:true}).click();await start.fill('22:00');await hours.fill('8');await page.getByRole('tab',{name:'Unavailable periods',exact:true}).click();
  await page.getByLabel('Planning date',{exact:true}).fill(tomorrow);await page.getByLabel('From',{exact:true}).fill('01:00');await page.getByLabel('To',{exact:true}).fill('02:00');await page.getByLabel('Reason',{exact:true}).fill('Fictional overnight maintenance');await page.getByRole('button',{name:'Add period',exact:true}).click();await page.getByRole('button',{name:'Save settings',exact:true}).click();await wait(async()=>{const s=(await json('/api/workspace')).state.settings;return s.dayStart==='22:00'&&s.availableHours===8;});await page.getByText('Planning settings saved',{exact:true}).waitFor();
  await page.getByRole('tab',{name:'Workspace',exact:true}).click();assert.match(await page.locator('.inline-info').innerText(),/22:00.*06:00.*\+1 day/);await page.getByRole('button',{name:'Planning board',exact:true}).click();draft=await draftTotal(280);const confirm=draft.getByRole('button',{name:'Confirm 4 cards',exact:true});assert.equal(await confirm.isEnabled(),true);assert.match(await draft.locator('.draft-edit-table').innerText(),/06:00/);await confirm.click();await draft.waitFor({state:'hidden'});
  const saved=(await json('/api/workspace')).state;assert.equal(saved.jobs.filter(j=>j.status==='pending'&&j.inventoryItemId).reduce((sum,j)=>sum+j.quantityMt,0),280);assert.equal(saved.jobs.find(j=>j.id===manual.id).status,'cancelled');
  await page.screenshot({path:path.join(output,'overnight-board.png')});
  for(const viewport of [{width:390,height:844},{width:320,height:760}]){await page.setViewportSize(viewport);await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('tab',{name:'Workspace',exact:true}).click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal(await start.isEnabled(),true);await page.screenshot({path:path.join(output,`editable-hours-${viewport.width}.png`)});await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('button',{name:'Planning board',exact:true}).click();}
  assert.deepEqual(errors,[]);console.log('PASS Overnight shifts and post-midnight downtime reduce draft capacity, save successfully and fit desktop/mobile');
 }catch(e){if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});throw e;}
 finally{if(browser)await browser.close();await command({type:'workspace.restore',backup});}
})().catch(e=>{console.error(e);process.exitCode=1;});
