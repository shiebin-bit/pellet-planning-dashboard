// Fictional data only. Writes are limited to this disposable loopback test workspace.
const { chromium } = require('playwright');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const base = process.env.BROWSER_BASE_URL;
if (!base || process.env.BROWSER_ALLOW_REPLACE !== '1' || !['127.0.0.1','localhost'].includes(new URL(base).hostname) || new URL(base).port === '8080') throw Error('Use an isolated loopback test workspace.');
const today = new Intl.DateTimeFormat('en-CA',{ timeZone:'Asia/Kuala_Lumpur' }).format(new Date());
const add = (date,n) => new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const monday = add(today,-((new Date(today+'T12:00:00Z').getUTCDay()+6)%7));
const wednesday = add(monday,2);
const output = path.resolve('output/playwright/weekly-list');
const json = async route => { const r=await fetch(base+route); assert.equal(r.status,200); return r.json(); };
const command = async command => { const current=await json('/api/workspace'); const r=await fetch(base+'/api/commands',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({expectedRevision:current.revision,commandId:randomUUID(),command})}); assert.equal(r.status,200,await r.text()); };
const wait = async fn => { for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('List/week UI did not settle.'); };
function job(id,date,patch={}) { return { id,date,lineId:'PM1',sequence:1,orderNo:id,productCode:'FEED-A',description:'FS 5220 FICTIONAL BROILER FIN PELLET II IN BULK',bin:'',mode:'bulk',bagCount:null,quantityMt:30,status:'pending',remarks:'Fictional list/week fixture',actualStart:null,actualEnd:null,binNeedsReview:false,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',...patch }; }
(async()=>{
  await fs.mkdir(output,{recursive:true}); const backup=await json('/api/backup'); let browser,page;
  try {
    const jobs=[job('QA-WEEK-SPLIT',monday),job('QA-WEEK-BAGS',wednesday,{mode:'bags',bagCount:400,bagWeightKgSnapshot:50,quantityMt:20,description:'FS 5220 FICTIONAL BROILER FIN PELLET II 50KG'}),job('QA-WEEK-NEXT-PRODUCT',wednesday,{sequence:2,productCode:'5811',quantityMt:10,description:'FS 5811 FICTIONAL FEED IN BULK'}),job('QA-WEEK-NIGHT',wednesday,{lineId:'PM3',quantityMt:60}),job('QA-WEEK-BACKLOG',wednesday,{lineId:'PM4',quantityMt:0})];
    const settings={...backup.planning.settings,dayStart:'07:00',availableHours:2,rates:{PM1:10,PM2:10,PM3:10,PM4:10},changeoverMinutes:30,calendarHistory:undefined,calendarCutover:undefined,workingHoursOverrides:[{date:wednesday,lineId:'PM1',dayStart:'07:00',availableHours:14,reason:'Fictional overtime',activatedAt:'2026-01-01T00:00:00Z'},{date:wednesday,lineId:'PM2',dayStart:'07:00',availableHours:0,reason:'Fictional closure',activatedAt:'2026-01-01T00:00:00Z'},{date:wednesday,lineId:'PM3',dayStart:'20:00',availableHours:8,reason:'Fictional overnight shift',activatedAt:'2026-01-01T00:00:00Z'}],downtime:[{id:'QA-NIGHT-SERVICE',date:wednesday,lineId:'PM3',start:'23:00',end:'01:00',reason:'Fictional service'}]};
    await command({type:'workspace.restore',backup:{...backup,planning:{...backup.planning,catalog:[],events:[],jobs,settings},sourceData:{imports:[],orders:[],versions:[],discrepancies:[]},inventory:{items:[],imports:[],baselineReports:[],orders:[],ledger:[],reservations:[]},productionProgress:{samples:[],resets:[]}}});
    const initial=await json('/api/backup');
    browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
    const context=await browser.newContext({viewport:{width:1366,height:768},timezoneId:'UTC',reducedMotion:'reduce'});
    page=await context.newPage();page.setDefaultTimeout(15000);const errors=[],writes=[];
    page.on('pageerror',error=>errors.push(error.message));await page.route('**/api/commands',route=>{writes.push(route.request().method());return route.abort();});
    const nav=label=>page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:label,exact:true});
    const view=label=>page.getByRole('group',{name:'Planning view',exact:true}).getByRole('button',{name:label,exact:true});
    await page.goto(base+'/#/planning');await page.locator('.hplan-board').waitFor();assert.equal(await view('Timeline').getAttribute('aria-pressed'),'true');
    await view('List').click();await page.getByRole('region',{name:'Production by line',exact:true}).waitFor();assert.equal(await page.locator('.production-list-line').count(),4);
    await nav('Overview').click();await page.getByRole('button',{name:'Week capacity',exact:true}).click();await page.getByRole('region',{name:'Weekly line capacity',exact:true}).waitFor();assert.equal(await page.locator('.weekly-capacity-cell').count(),28);
    const cell=(date,line)=>page.getByRole('button',{name:`Open ${line} planning for ${date}`,exact:true});
    assert.match(await cell(monday,'PM1').innerText(),/100%[\s\S]*2\.0 \/ 2\.0 hrs[\s\S]*20\.0 MT/);
    assert.match(await cell(add(monday,1),'PM1').innerText(),/50%[\s\S]*10\.0 MT[\s\S]*carry-in/);
    assert.match(await cell(wednesday,'PM1').innerText(),/25%[\s\S]*3\.5 \/ 14\.0 hrs[\s\S]*30\.0 MT/);
    assert.match(await cell(wednesday,'PM2').innerText(),/Closed/);
    assert.match(await cell(wednesday,'PM3').innerText(),/100%[\s\S]*6\.0 \/ 6\.0 hrs[\s\S]*60\.0 MT/);
    assert.match(await cell(wednesday,'PM4').innerText(),/1 need quantity/);
    await page.screenshot({path:path.join(output,'week-desktop.png'),fullPage:true});
    await page.getByRole('button',{name:'Next capacity week',exact:true}).click();assert.equal(await cell(add(monday,7),'PM1').count(),1);await page.getByRole('button',{name:'Previous capacity week',exact:true}).click();
    await cell(wednesday,'PM1').click();await page.locator('.production-list-open').first().waitFor();assert.equal(await view('List').getAttribute('aria-pressed'),'true');
    const bags=page.locator('[data-job-id="QA-WEEK-BAGS"]');assert.match(await bags.innerText(),/400 Bags[\s\S]*20\.000 MT/);assert.match(await bags.innerText(),/FICTIONAL BROILER FIN PELLET/);
    await bags.getByRole('button').click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
    await page.screenshot({path:path.join(output,'list-desktop.png'),fullPage:true});
    const overlaps=await page.locator('.production-list-open').evaluateAll(rows=>rows.some(row=>{const boxes=[...row.children].filter(el=>getComputedStyle(el).display!=='none'&&!el.classList.contains('sr-only')).map(el=>el.getBoundingClientRect());return boxes.some((a,i)=>boxes.slice(i+1).some(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1));}));assert.equal(overlaps,false);
    await nav('Overview').click();assert.match(await page.locator('.metric').filter({hasText:'Within-shift plan'}).locator('.metric-value').innerText(),/90\.00/);await nav('Planning board').click();await page.locator('.production-list').waitFor();
    console.log('PASS Desktop List exposes complete batch details, retains navigation preference, opens details, and keeps text separate; week clips carry-in/overnight MT, changeovers, closures and overtime correctly');
    await page.setViewportSize({width:390,height:844});assert.equal(await view('List').getAttribute('aria-pressed'),'true');await view('Timeline').click();await page.locator('.hplan-board').waitFor();
    await page.setViewportSize({width:1366,height:768});await page.locator('.production-list').waitFor();assert.equal(await view('List').getAttribute('aria-pressed'),'true');await view('Timeline').click();await page.locator('.hplan-board').waitFor();assert.equal(await page.locator('.hplan-track').count(),4);
    for(const width of[390,320]){
      await page.setViewportSize({width,height:844});await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('button',{name:'Overview',exact:true}).click();await page.locator('.weekly-capacity').waitFor();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,`week-${width}.png`),fullPage:true});
      await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('button',{name:'Planning board',exact:true}).click();await view('List').click();await page.locator('.production-list').waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    }
    assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);const after=await json('/api/backup');assert.deepEqual(after.planning,initial.planning);assert.deepEqual(after.inventory,initial.inventory);
    console.log('PASS Weekly drill-through selects the correct day; desktop/mobile view choices stay independent; mobile fits390/320px; all view interactions leave business data unchanged');
  }catch(error){if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
  finally{if(browser)await browser.close();await command({type:'workspace.restore',backup});}
})().catch(error=>{console.error(error);process.exitCode=1;});
