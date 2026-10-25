// Destructive fixtures: run only against a disposable loopback database.
const {chromium}=require('playwright');
const {existsSync}=require('node:fs');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const base=process.env.BROWSER_BASE_URL;
if(!base||process.env.BROWSER_ALLOW_REPLACE!=='1'||!['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname)||new URL(base).port==='8080')throw Error('Use an isolated loopback BROWSER_BASE_URL with BROWSER_ALLOW_REPLACE=1.');
const output=path.resolve('output/playwright/redesign');
const get=async()=>{const r=await fetch(base+'/api/workspace');assert.equal(r.status,200);return r.json();};
const command=async command=>{const current=await get();const r=await fetch(base+'/api/commands',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({expectedRevision:current.revision,commandId:randomUUID(),command})});assert.equal(r.status,200,await r.text());};
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur'}).format(new Date());
const wait=async fn=>{for(let i=0;i<70;i++){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100));}assert.fail('Timed out waiting for confirmed state');};
async function bounds(locator,width,height){const b=await locator.boundingBox();assert.ok(b&&b.x>=0&&b.y>=0&&b.x+b.width<=width+1&&b.y+b.height<=height+1,'Preview fits viewport: '+JSON.stringify(b));}
(async()=>{
 await fs.mkdir(output,{recursive:true});const backupResponse=await fetch(base+'/api/backup');assert.equal(backupResponse.status,200);const baseline=await backupResponse.json();let browser,page;
 try{
  await command({type:'workspace.resetDemo',date:today()});
  const demo=(await get()).state;
  Object.assign(demo.jobs[0],{productCode:'QA-PREVIEW-MATERIAL-0000001',description:'Fictional finisher pellet product with a deliberately long description for preview wrapping',orderNo:'QA-PREVIEW-LONG-ORDER-REFERENCE'});
  await command({type:'workspace.restore',backup:demo});
  browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
  const context=await browser.newContext({viewport:{width:1366,height:768},timezoneId:'Asia/Kuala_Lumpur',reducedMotion:'reduce'});
  page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/#/settings');await page.getByRole('heading',{name:'Workspace settings',exact:true}).waitFor();
  assert.equal(await page.getByRole('tabpanel').count(),1);
  await page.getByLabel('Site name',{exact:true}).fill('Settings tab fixture');
  await page.getByRole('tab',{name:'Products',exact:true}).click();await page.getByRole('button',{name:'Add product',exact:true}).click();
  let form=page.getByRole('form',{name:'Add catalog product'});await form.getByLabel('Product code',{exact:false}).fill('QA-TAB-DRAFT');
  await page.getByRole('tab',{name:'Production rules',exact:true}).click();
  const rate=page.getByRole('spinbutton',{name:'PM1 MT/hr',exact:true});await rate.fill('0');
  await page.getByRole('tab',{name:'Products',exact:true}).click();
  assert.equal(await form.getByLabel('Product code',{exact:false}).inputValue(),'QA-TAB-DRAFT');
  await page.getByRole('button',{name:'Save settings',exact:true}).click();
  assert.equal(await page.getByRole('tab',{name:'Production rules',exact:true}).getAttribute('aria-selected'),'true');
  assert.equal(await rate.evaluate(el=>el===document.activeElement),true);
  assert.notEqual((await get()).state.settings.siteName,'Settings tab fixture');
  await rate.fill('8');await page.getByRole('tab',{name:'Products',exact:true}).click();
  await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await wait(async()=>(await get()).state.settings.siteName==='Settings tab fixture');
  await page.getByText('Planning settings saved',{exact:true}).waitFor();
  assert.equal(await form.getByLabel('Product code',{exact:false}).inputValue(),'QA-TAB-DRAFT');
  await form.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('tab',{name:'Workspace',exact:true}).focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab',{name:'Production rules',exact:true}).getAttribute('aria-selected'),'true');
  await page.keyboard.press('End');assert.equal(await page.getByRole('tab',{name:'Backup & recovery',exact:true}).getAttribute('aria-selected'),'true');
  await page.keyboard.press('Home');assert.equal(await page.getByRole('tab',{name:'Workspace',exact:true}).getAttribute('aria-selected'),'true');
  await page.screenshot({path:path.join(output,'settings-tabs-desktop.png'),animations:'disabled'});
  console.log('PASS Settings/catalog drafts survive tab switches; hidden invalid field opens and focuses; shared save works from Products; tabs support arrows/Home/End');

  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.locator('.metric').filter({hasText:'Recorded output'}).waitFor();assert.equal(await page.getByText('Production load',{exact:true}).count(),0);
  assert.equal(await page.locator('.capacity-panel').getAttribute('open'),null);await page.locator('.capacity-panel summary').click();assert.equal(await page.locator('.line-summary').count(),4);
  await page.screenshot({path:path.join(output,'overview-hierarchy-desktop.png'),animations:'disabled',fullPage:true});

  await page.getByRole('button',{name:'Planning board',exact:true}).click();
  const card=page.locator('.hplan-card-open').first();await card.hover();let preview=page.getByRole('tooltip');await preview.waitFor();
  await bounds(preview,1366,768);assert.match(await preview.innerText(),/Order[\s\S]*Planned start[\s\S]*Planned end/);
  await preview.hover();await page.waitForTimeout(180);assert.equal(await preview.isVisible(),true);
  await page.keyboard.press('Escape');await preview.waitFor({state:'hidden'});await page.waitForTimeout(180);assert.equal(await preview.count(),0);
  await card.focus();await preview.waitFor();assert.ok((await card.getAttribute('aria-describedby')).includes(await preview.getAttribute('id')));
  await page.screenshot({path:path.join(output,'planning-preview-desktop.png'),animations:'disabled'});
  const describedId=await preview.getAttribute('id');
  const other=page.locator('.hplan-card-open').nth(1);
  assert.notEqual(await card.locator('..').getAttribute('data-production-job'),await other.locator('..').getAttribute('data-production-job'));
  await other.hover();
  assert.equal(await preview.count(),1);assert.equal(await preview.getAttribute('id'),describedId,'Keyboard focus keeps preview ownership when another card is hovered');
  await page.keyboard.press('Enter');await page.getByRole('dialog').waitFor();await preview.waitFor({state:'hidden'});await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
  const movable=page.locator('.hplan-card[data-draggable=true] .hplan-card-open').first();
  await movable.focus();await preview.waitFor();assert.equal(await preview.count(),1);
  await page.keyboard.press('Space');await page.waitForTimeout(100);assert.equal(await preview.count(),0);await page.keyboard.press('Escape');
  console.log('PASS Card hover/focus shows full details within viewport; preview is hoverable and dismisses on Escape; Enter opens details and keyboard drag suppresses preview');
  for(const viewport of [{width:390,height:844},{width:320,height:760}]){
   await page.setViewportSize(viewport);await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('button',{name:'Settings',exact:true}).click();
   await page.getByRole('tab',{name:'Products',exact:true}).click();assert.equal(await page.getByRole('heading',{name:'Product catalog',exact:true}).isVisible(),true);
   await page.getByRole('tab',{name:'Workspace',exact:true}).click();await bounds(page.locator('.settings-savebar'),viewport.width,viewport.height);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,`settings-tabs-${viewport.width}.png`),animations:'disabled'});
   await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('button',{name:'Planning board',exact:true}).click();await page.locator('.hplan-card-open').last().focus();await preview.waitFor();await bounds(preview,viewport.width,viewport.height);await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors,[]);console.log('PASS Settings tabs/save bar and focus previews fit 320/390px; no browser errors');
 }catch(error){if(page)await page.screenshot({path:path.join(output,'settings-preview-failure.png')}).catch(()=>{});throw error;}
 finally{if(browser)await browser.close();await command({type:'workspace.restore',backup:baseline});}
})().catch(error=>{console.error(error);process.exitCode=1;});
