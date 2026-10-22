// Layout/accessibility regression checks. Fixture writes require a disposable loopback workspace.
const {chromium}=require('playwright');
const {existsSync}=require('node:fs');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const base=process.env.BROWSER_BASE_URL;
if(!base||process.env.BROWSER_ALLOW_REPLACE!=='1'||!['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname))throw Error('Use an isolated loopback BROWSER_BASE_URL with BROWSER_ALLOW_REPLACE=1.');
const output=path.resolve('output/playwright/redesign');
const get=async()=>{const r=await fetch(base+'/api/workspace');assert.equal(r.status,200);return r.json();};
const command=async command=>{const current=await get();const r=await fetch(base+'/api/commands',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({expectedRevision:current.revision,commandId:randomUUID(),command})});assert.equal(r.status,200,await r.text());};
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur'}).format(new Date());
async function bounds(locator,width,height){const b=await locator.boundingBox();assert.ok(b&&b.x>=0&&b.y>=0&&b.x+b.width<=width+1&&b.y+b.height<=height+1,'Floating content fits viewport: '+JSON.stringify(b));}
(async()=>{
 await fs.mkdir(output,{recursive:true});const baseline=await get();let browser;
 try{
  await command({type:'workspace.resetDemo',date:today()});
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
  const context=await browser.newContext({viewport:{width:1366,height:768},timezoneId:'Asia/Kuala_Lumpur',reducedMotion:'reduce'});
  const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  // Browser interactions below must be read-only; fixture writes are confined to the guarded API helper.
  await page.route('**/api/commands',r=>{errors.push('Unexpected browser mutation');return r.abort();});
  await page.goto(base+'/#/planning');await page.locator('.hplan-board').waitFor();
  assert.equal(await page.locator('.hplan-track').count(),4);await bounds(page.locator('.hplan-board'),1366,768);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),'Four-line board needs no page scrolling at 1366x768');
  await page.screenshot({path:path.join(output,'board-desktop.png'),animations:'disabled'});
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await bounds(page.locator('.schedule-panel'),1366,768);
  assert.ok((await page.locator('.schedule-panel').boundingBox()).y<(await page.locator('.capacity-panel').boundingBox()).y);
  await page.screenshot({path:path.join(output,'overview-desktop.png'),animations:'disabled',fullPage:true});
  console.log('PASS Four complete mill lanes fit 1366x768; Overview exposes totals and schedule before capacity details');
  for(const viewport of [{width:1440,height:960},{width:768,height:1024},{width:390,height:844},{width:320,height:760}]){
   await page.setViewportSize(viewport);
   if(viewport.width<=600){
    await page.getByRole('button',{name:'Open navigation',exact:true}).click();const navigation=page.getByRole('dialog',{name:'Workspace navigation',exact:true});
    for(let i=0;i<10;i++){assert.ok(await navigation.evaluate(el=>el.contains(document.activeElement)),'Mobile navigation contains keyboard focus');await page.keyboard.press('Tab');}
    await page.keyboard.press('Escape');await navigation.waitFor({state:'hidden'});assert.ok(await page.getByRole('button',{name:'Open navigation',exact:true}).evaluate(el=>el===document.activeElement),'Menu returns focus to its trigger');
   }
   const navigate=async label=>{if(viewport.width<=600)await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('button',{name:label,exact:true}).click();};
   for(const label of ['Overview','Data','History','Settings','Planning board']){
    await navigate(label);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${label} has no page overflow at ${viewport.width}px`);
   }
   await page.locator('.date-picker-trigger').click();await bounds(page.getByRole('dialog',{name:'Choose planning date'}),viewport.width,viewport.height);await page.getByLabel('Calendar month').waitFor();await page.getByLabel('Calendar year').waitFor();await page.keyboard.press('Escape');
   await page.getByRole('button',{name:'Add production',exact:true}).click();let modal=page.getByRole('dialog',{name:'Add production',exact:true});await bounds(modal,viewport.width,viewport.height);
   for(let i=0;i<18;i++){await page.keyboard.press('Tab');assert.ok(await modal.evaluate(el=>el.contains(document.activeElement)),'Production form retains keyboard focus');}
   await page.screenshot({path:path.join(output,`editor-${viewport.width}.png`),animations:'disabled'});await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});
   await page.getByRole('button',{name:'Copy planning',exact:true}).click();modal=page.getByRole('dialog',{name:'Copy planning',exact:true});await bounds(modal,viewport.width,viewport.height);await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});
   await page.locator('.hplan-card-open').first().click();await bounds(page.getByRole('dialog'),viewport.width,viewport.height);await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
   await page.getByRole('button',{name:'Export',exact:true}).click();await bounds(page.locator('.export-menu'),viewport.width,viewport.height);await page.keyboard.press('Tab');assert.ok(await page.getByRole('button',{name:'Excel report',exact:false}).evaluate(el=>el===document.activeElement),'Export skips its pointer-only scrim');await page.keyboard.press('Escape');assert.ok(await page.getByRole('button',{name:'Export',exact:true}).evaluate(el=>el===document.activeElement),'Export returns focus on Escape');await page.getByRole('button',{name:'Export',exact:true}).click();await page.getByRole('button',{name:'Date range report',exact:false}).click();modal=page.getByRole('dialog',{name:'Date range report',exact:true});await bounds(modal,viewport.width,viewport.height);await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});
   if(viewport.width<=600){await page.screenshot({path:path.join(output,`board-${viewport.width}.png`),animations:'disabled'});await navigate('History');await page.screenshot({path:path.join(output,`history-${viewport.width}.png`),animations:'disabled'});}
  }
  console.log('PASS All five pages, direct calendar, export menu, production/copy/report dialogs and drawer fit 320/390/768/1440px; keyboard focus and Escape work');
  await page.setViewportSize({width:1366,height:768});await page.getByRole('button',{name:'Planning board',exact:true}).click();
  const samples=await page.locator('.add-production-button,.status-legend .status-badge').evaluateAll(elements=>elements.map(el=>{const s=getComputedStyle(el);return {label:el.textContent,fg:s.color,bg:s.backgroundColor};}));
  const luminance=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
  for(const sample of samples){const a=luminance(sample.fg),b=luminance(sample.bg);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,`${sample.label} text contrast`);}
  await page.emulateMedia({media:'print'});assert.equal(await page.locator('.workspace').isVisible(),false);assert.equal(await page.locator('.print-report').isVisible(),true);await page.emulateMedia({media:'screen'});assert.deepEqual(errors,[]);
  console.log('PASS Primary action and all five status labels meet 4.5:1 contrast; print view retains the report; no page errors or browser writes');
 }finally{if(browser)await browser.close();await command({type:'workspace.restore',backup:baseline.state});}
})().catch(e=>{console.error(e);process.exitCode=1;});
