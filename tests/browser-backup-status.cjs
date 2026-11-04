// Read-only UI checks; automatic backup states are mocked without touching real backup files.
const {chromium}=require('playwright');
const {existsSync}=require('node:fs');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const base=process.env.BROWSER_BASE_URL;
if(!base||!['127.0.0.1','localhost'].includes(new URL(base).hostname)||new URL(base).port==='8080')throw Error('Use an isolated loopback test server.');
const output=path.resolve('output/playwright/automatic-backup');
const now=new Date().toISOString(),next=new Date(Date.now()+86400000).toISOString();
const saved={enabled:true,format:'portable-v5',intervalHours:24,retentionCount:14,state:'idle',lastAttempt:{at:now,result:'success'},lastSuccess:{at:now,fileName:'millplan-auto-v5-20261104T000000000Z.json',bytes:4096},nextAttemptAt:next};
(async()=>{
  await fs.mkdir(output,{recursive:true});const browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
  try{
    const context=await browser.newContext({viewport:{width:1366,height:768},timezoneId:'Asia/Kuala_Lumpur'});const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[],writes=[];
    page.on('pageerror',e=>errors.push(e.message));await page.route('**/api/commands',route=>{writes.push(route.request().method());return route.abort();});
    const panel=page.getByRole('region',{name:'Automatic backup status',exact:true});
    const refresh=()=>page.getByRole('button',{name:'Refresh automatic backup status',exact:true}).click();
    let response={...saved,enabled:false,state:'disabled',lastAttempt:null,lastSuccess:null,nextAttemptAt:null};
    await page.route('**/api/backup/status',route=>route.fulfill({json:response}));
    await page.goto(base+'/#/settings');await page.getByRole('tab',{name:'Backup & recovery',exact:true}).click();await panel.getByText('Automatic backups are disabled on this server.',{exact:true}).waitFor();
    response=saved;await refresh();await panel.getByText('Newest 14 copies · every 24h',{exact:true}).waitFor();assert.doesNotMatch(await panel.innerText(),/No successful copy yet/);
    await page.screenshot({path:path.join(output,'backup-desktop.png'),fullPage:true});
    response={...saved,state:'running',nextAttemptAt:null};await refresh();await panel.getByText('Saving now',{exact:true}).waitFor();await panel.getByText('In progress',{exact:true}).waitFor();
    response={...saved,state:'degraded',lastAttempt:{at:now,result:'failed',code:'WRITE_FAILED',sanitizedMessage:'The automatic recovery copy could not be saved. Retrying in 15 minutes.'},nextAttemptAt:new Date(Date.now()+900000).toISOString()};await refresh();await panel.getByText('Needs attention',{exact:true}).waitFor();await panel.getByRole('alert').waitFor();
    const download=page.getByRole('button',{name:'Download backup',exact:true}),restore=page.getByRole('button',{name:'Restore JSON backup',exact:true});assert.equal(await download.isEnabled(),true);assert.equal(await restore.isEnabled(),true);
    await page.unroute('**/api/backup/status');await page.route('**/api/backup/status',route=>route.abort());await refresh();await panel.getByRole('alert').filter({hasText:'status is unavailable'}).waitFor();
    const received=page.waitForEvent('download');await download.click();const file=await received;const stream=await file.createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);assert.equal(JSON.parse(Buffer.concat(chunks).toString('utf8')).schemaVersion,5);assert.equal(await restore.isEnabled(),true);
    await page.unroute('**/api/backup/status');await page.route('**/api/backup/status',route=>route.fulfill({json:saved}));await refresh();await panel.getByText('Newest 14 copies · every 24h',{exact:true}).waitFor();assert.equal(await panel.getByRole('alert').count(),0);
    for(const width of[390,320]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,`backup-${width}.png`),fullPage:true});}
    assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);console.log('PASS Automatic backup status distinguishes disabled/saved/running/degraded/unavailable, retries, keeps manual V5 download/restore usable, and fits390/320px without writes');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
