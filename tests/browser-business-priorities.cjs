// Fictional fixtures only; replace and restore a disposable database workspace.
const { chromium } = require('playwright');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const base = process.env.BROWSER_BASE_URL;
if (!base || process.env.BROWSER_ALLOW_REPLACE !== '1' || !['127.0.0.1','localhost'].includes(new URL(base).hostname) || new URL(base).port === '8080') throw Error('Use an isolated loopback test workspace.');
const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur'}).format(new Date());
const day = n => new Date(Date.parse(today+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const output = path.resolve('output/playwright/business-priorities');
const json = async route => { const r=await fetch(base+route); const value=await r.json(); assert.equal(r.status,200,JSON.stringify(value)); return value; };
const command = async value => { const current=await json('/api/workspace'); const r=await fetch(base+'/api/commands',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({expectedRevision:current.revision,commandId:randomUUID(),command:value})}); const result=await r.json(); assert.equal(r.status,200,JSON.stringify(result)); return result; };
const wait = async fn => { for(let n=0;n<140;n++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Business priorities state did not arrive.'); };
const source = (fileName,letter,asOfDate,rows) => ({fileName,sheetName:'bag order',digest:letter.repeat(64),asOfDate,rows});
const row = (index,deliveryDate) => ({doNo:`QA-PRIORITY-${index}`,deliveryDate,soldToParty:'Fictional priority buyer',shipToParty:'Fictional destination',materialCode:'QA-MTO-FEED',description:'FS 9901 FICTIONAL FEED 50KG',quantity:100,unit:'Bags',deliveryLeadDays:0,remark:'',daysOutstanding:0,medication:'',fmrOmed:''});
const item = (materialCode,unit,strategy,targetQuantity,closing,medication='') => ({materialCode,description:`FS 9902 FICTIONAL STOCK ${unit==='Bags'?'50KG':'IN BULK'}`,unit,bagWeightKg:unit==='Bags'?50:null,strategy,targetQuantity,needsReview:false,opening:closing,production:0,received:0,salesReturn:0,rework:0,issue:0,closing,medication,fmrOmed:''});

(async()=>{
  await fs.mkdir(output,{recursive:true});
  const backup=await json('/api/backup');
  let browser,page;
  try {
    await command({type:'workspace.restore',backup:{...backup,planning:{...backup.planning,jobs:[],events:[],catalog:[]},sourceData:{imports:[],orders:[],versions:[],discrepancies:[]},inventory:{items:[],imports:[],baselineReports:[],orders:[],ledger:[],reservations:[]},productionProgress:{samples:[],resets:[]}}});
    const rows=[...Array.from({length:51},(_,i)=>row(i,day(-1))),row(51,today),row(52,day(3)),row(53,day(4))];
    await command({type:'inventory.importBaseline',input:{fileName:'fictional-priorities-baseline.xlsx',digest:'a'.repeat(64),asOfDate:day(-1),includeBaseline:true,packingBinTotal:null,orders:[source('fictional-priorities-orders.xlsx','b',day(-1),rows)],items:[item('QA-MTO-FEED','Bags','mto',0,0),item('QA-MTS-BAGS','Bags','mts',10,5),item('QA-MTS-BULK','MT','mts',.001,0)],annotations:[]}});
    const stockItem=(await json('/api/inventory')).items.find(item=>item.materialCode==='QA-MTS-BAGS');
    await command({type:'inventory.adjust',itemId:stockItem.itemId,medication:'Fictional medication',fmrOmed:'',quantityDelta:100,occurredOn:day(-1),reason:'Fictional separate stock variant',postingKey:randomUUID()});
    await command({type:'data.import',input:source('fictional-newest-data.xlsx','c',today,rows)});
    await command({type:'data.import',input:source('fictional-old-backfill.xlsx','d',day(-1),[{...rows[0],description:'FS 9901 REVISED FICTIONAL FEED 50KG'}])});
    const summary=await json('/api/operations-summary');
    assert.deepEqual(summary.counts,{overdueToPlan:51,dueSoon:2,stockShortages:2,pendingImportReviews:1});
    assert.equal(summary.freshness.newestExcelAsOfDate,today);
    assert.equal(summary.freshness.latestOrderImport.asOfDate,day(-1));

    browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
    const context=await browser.newContext({viewport:{width:1280,height:720},timezoneId:'UTC',reducedMotion:'reduce'});
    page=await context.newPage(); page.setDefaultTimeout(15000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const nav=name=>page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true});
    const priority=key=>page.locator(`[data-priority="${key}"]`);
    const openOverview=async()=>{await nav('Overview').click();await wait(async()=>await priority('overdueToPlan').isEnabled());};
    await page.goto(base+'/#/overview');
    await wait(async()=>await priority('overdueToPlan').isEnabled());
    for(const [key,value] of Object.entries(summary.counts))assert.equal(await priority(key).locator('.business-priority-count').innerText(),String(value));
    await page.locator('.overview-freshness summary').click();
    assert.match(await page.locator('.overview-freshness').innerText(),/Newest order Excel date[\s\S]*Latest order upload[\s\S]*File dated[\s\S]*Last verified stock count/);
    await page.screenshot({path:path.join(output,'overview-desktop.png'),fullPage:true});

    // Deliberately leave stale filters/page behind; a priority click must replace them.
    await nav('Data').click();await page.getByLabel('Search order data').fill('NO-MATCH');
    await page.getByRole('heading',{name:'No matching orders',exact:true}).waitFor();
    await openOverview();await priority('overdueToPlan').click();
    await page.locator('.orders-table tbody tr').first().waitFor();
    assert.equal(await page.getByLabel('Search order data').inputValue(),'');
    assert.equal(await page.getByLabel('Delivery to',{exact:true}).inputValue(),day(-1));
    assert.equal(await page.getByRole('button',{name:'Needs production',exact:true}).getAttribute('aria-pressed'),'true');
    assert.match(await page.getByRole('navigation',{name:'Order data pages'}).innerText(),/Page 1 of 2/);
    await page.getByRole('button',{name:'Next',exact:true}).click();await wait(async()=>await page.locator('.orders-table tbody tr').count()===1);
    await openOverview();await priority('overdueToPlan').click();await wait(async()=>await page.locator('.orders-table tbody tr').count()===50);
    assert.match(await page.locator('.data-pagination').innerText(),/1–50 of 51 orders/);
    await page.evaluate(()=>scrollTo(0,0));
    const ordersTop=(await page.locator('.orders-table tbody tr').first().boundingBox()).y;
    assert.ok(ordersTop<500,`Orders should start above500px, got${ordersTop}`);
    await page.screenshot({path:path.join(output,'orders-desktop.png')});
    console.log('PASS Overdue-to-plan count covers all51 rows; navigation clears stale search/page and compact Orders exposes data earlier');

    await openOverview();await priority('dueSoon').click();await wait(async()=>await page.locator('.orders-table tbody tr').count()===2);
    assert.equal(await page.getByLabel('Delivery from',{exact:true}).inputValue(),today);
    assert.equal(await page.getByLabel('Delivery to',{exact:true}).inputValue(),day(3));
    await openOverview();await priority('stockShortages').click();await page.getByRole('button',{name:'Manage stock'}).first().waitFor();
    assert.equal(await page.getByLabel('Below safety stock',{exact:true}).isChecked(),true);
    assert.equal(await page.locator('.source-table tbody tr').count(),2);
    assert.doesNotMatch(await page.locator('.source-table tbody').innerText(),/Fictional medication/);
    await page.evaluate(()=>scrollTo(0,0));
    const stockTop=(await page.locator('.source-table tbody tr').first().boundingBox()).y;
    assert.ok(stockTop<500,`Stock should start above500px, got${stockTop}`);
    await page.screenshot({path:path.join(output,'stock-desktop.png')});
    await openOverview();await priority('pendingImportReviews').click();
    await page.getByRole('heading',{name:'Import review queue',exact:true}).waitFor();
    await wait(async()=>await page.locator('.import-review-row').count()===1);
    assert.equal(await page.getByRole('button',{name:'Pending (1)',exact:true}).getAttribute('aria-pressed'),'true');
    console.log('PASS Due-date, standard-stock and pending-review destinations exactly match their summary counts; freshness distinguishes an old backfill from newest data');

    await openOverview();
    let releaseRefresh;
    const delayedRefresh = new Promise(resolve=>{releaseRefresh=resolve;});
    await page.route('**/api/operations-summary',async route=>{await delayedRefresh;await route.continue();});
    await page.getByRole('button',{name:'Refresh business priorities',exact:true}).click();
    await wait(async()=>await priority('overdueToPlan').isDisabled());
    assert.equal(await priority('overdueToPlan').locator('.business-priority-count').innerText(),'—');
    releaseRefresh();
    await wait(async()=>await priority('overdueToPlan').isEnabled());
    await page.unroute('**/api/operations-summary');
    await page.route('**/api/operations-summary',route=>route.abort());
    await page.getByRole('button',{name:'Refresh business priorities',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Priorities and source dates are unavailable'}).waitFor();
    assert.equal(await priority('overdueToPlan').isDisabled(),true);
    assert.equal(await priority('overdueToPlan').locator('.business-priority-count').innerText(),'—');
    await page.unroute('**/api/operations-summary');
    await page.getByRole('button',{name:'Refresh business priorities',exact:true}).click();
    await wait(async()=>await priority('overdueToPlan').isEnabled());
    for(const width of [390,320]){
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:path.join(output,`overview-${width}.png`),fullPage:true});
    }
    assert.deepEqual(errors,[]);
    console.log('PASS Failed summary never displays zero or enables stale actions; retry recovers; Overview fits390/320px');
  }catch(error){if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
  finally{if(browser)await browser.close();await command({type:'workspace.restore',backup});}
})().catch(error=>{console.error(error);process.exitCode=1;});
