// Fictional fixtures only. Planning-safety mutation tests must use the disposable test workspace.
const { chromium } = require('playwright');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const base = process.env.BROWSER_BASE_URL;
if (!base || process.env.BROWSER_ALLOW_REPLACE !== '1' || !['localhost', '127.0.0.1'].includes(new URL(base).hostname) || new URL(base).port === '8080') {
  throw Error('Use an isolated loopback BROWSER_BASE_URL with BROWSER_ALLOW_REPLACE=1.');
}
const output = path.resolve('output/playwright/redesign/planning-safety');
const draftKey = 'millplan.planning-draft.v1';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
const addDay = n => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const json = async route => { const response = await fetch(base + route); const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data; };
const command = async value => { const current = await json('/api/workspace'); const response = await fetch(base + '/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ expectedRevision: current.revision, commandId: randomUUID(), command: value }) }); const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data; };
const wait = async fn => { for (let index = 0; index < 120; index += 1) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('Planning safety state did not arrive.'); };
const pass = message => console.log('PASS ' + message);
const jobByOrder = async orderNo => (await json('/api/workspace')).state.jobs.find(job => job.orderNo === orderNo);

function manualInput(orderNo, date, lineId, quantityMt) {
  return { date, lineId, orderNo, productCode: `QA-${orderNo}`, description: 'Fictional planning safety feed', bin: 'QA-BIN', mode: 'bulk', bagCount: null, quantityMt, remarks: '' };
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const backup = await json('/api/backup');
  let browser, page;
  try {
    const settings = { ...backup.planning.settings, workingHoursOverrides: undefined, calendarHistory: undefined, calendarCutover: undefined, dayStart: '07:00', availableHours: 2, changeoverMinutes: 0, rates: { PM1: 10, PM2: 10, PM3: 10, PM4: 10 }, slowProductPrefixes: [], downtime: [] };
    await command({ type: 'workspace.restore', backup: { ...backup.planning, jobs: [], events: [], catalog: [], settings } });
    const material = '7.0000099700000';
    await command({ type: 'inventory.importBaseline', input: {
      fileName: 'fictional-planning-safety.xlsx', digest: '7'.repeat(64), asOfDate: addDay(-1), includeBaseline: true, packingBinTotal: null,
      orders: [{ fileName: 'fictional-planning-safety.xlsx', sheetName: 'bulk order', digest: '8'.repeat(64), asOfDate: addDay(-1), rows: [{ doNo: 'QA-SAFETY-ORDER', deliveryDate: addDay(4), soldToParty: 'Fictional safety customer', shipToParty: 'Fictional safety destination', materialCode: material, description: 'FS 9700 FICTIONAL SAFETY FEED IN BULK', quantity: 100, unit: 'MT', deliveryLeadDays: 1, remark: '', daysOutstanding: 0, medication: '', fmrOmed: '' }] }],
      items: [{ materialCode: material, description: 'FS 9700 FICTIONAL SAFETY FEED IN BULK', unit: 'MT', bagWeightKg: null, strategy: 'mto', targetQuantity: 0, needsReview: false, opening: 0, production: 0, received: 0, salesReturn: 0, rework: 0, issue: 0, closing: 0, medication: '', fmrOmed: '' }], annotations: [],
    } });
    const inventory = await json('/api/inventory');
    const orders = await json('/api/inventory/orders');
    const item = inventory.items[0], order = orders.orders[0];
    await command({ type: 'job.create', input: manualInput('QA-CARRY', addDay(-1), 'PM1', 30) });
    const planned = await command({ type: 'job.create', input: { ...manualInput(order.doNo, today, 'PM2', 40), productCode: order.materialCode, description: order.description, inventoryItemId: item.itemId, productionPurpose: 'mto', notBefore: `${today}T07:00:00+08:00` } });
    const runningId = planned.state.jobs.find(job => job.orderNo === order.doNo).id;
    await command({ type: 'job.start', jobId: runningId });
    await command({ type: 'production.recordReceipt', jobId: runningId, totalActualQuantity: 5, occurredOn: today });

    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : !existsSync(chromium.executablePath()) ? { channel: 'chrome' } : {}) });
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, timezoneId: 'Asia/Kuala_Lumpur', reducedMotion: 'reduce' });
    page = await context.newPage(); page.setDefaultTimeout(15_000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/#/overview');
    await page.getByRole('heading', { name: 'Production overview', exact: true }).waitFor();
    const metric = label => page.locator('.metric').filter({ hasText: label }).locator('.metric-value');
    await wait(async () => Number.parseFloat(await metric('Received into stock').innerText()) === 5);
    assert.equal(Number.parseFloat(await metric('Daily planned quantity').innerText()), 40);
    assert.equal(Number.parseFloat(await metric('Within-shift plan').innerText()), 30);
    assert.equal(Number.parseFloat(await metric('Received into stock').innerText()), 5);
    assert.match(await page.locator('.metric').filter({ hasText: 'Received into stock' }).innerText(), /1 production tasks/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, 'overview-desktop.png'), fullPage: true });
    pass('Overview separates assigned and in-shift quantity and shows a partial running production receipt');

    await command({ type: 'job.create', input: manualInput('QA-MOVE', today, 'PM3', 10) });
    await command({ type: 'job.create', input: manualInput('QA-TARGET', today, 'PM4', 10) });
    await page.reload(); await page.getByRole('button', { name: 'Planning board', exact: true }).click();
    const move = await jobByOrder('QA-MOVE');
    const commandPosts = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/commands')) { try { commandPosts.push(request.postDataJSON().command.type); } catch {} } });
    const dragTo = async lineId => {
      const source = await page.locator(`[data-job-id="${move.id}"][data-draggable="true"] .hplan-card-open`).boundingBox();
      const target = await page.locator(`[data-line-id="${lineId}"]`).boundingBox();
      assert.ok(source && target, 'Expected visible move card and destination line.');
      await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2); await page.mouse.down();
      await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2, { steps: 3 });
      await page.mouse.move(target.x + target.width * .75, target.y + target.height / 2, { steps: 12 }); await page.mouse.up();
      return page.getByRole('dialog', { name: 'Review production move', exact: true });
    };
    let beforePosts = commandPosts.length;
    let moveDialog = await dragTo('PM4'); await moveDialog.getByText('Current schedule', { exact: true }).waitFor();
    assert.equal(commandPosts.length, beforePosts); assert.match(await moveDialog.innerText(), /Current schedule[\s\S]*After move/);
    await page.screenshot({ path: path.join(output, 'move-preview-desktop.png'), fullPage: true });
    await moveDialog.getByRole('button', { name: 'Cancel move', exact: true }).click(); await moveDialog.waitFor({ state: 'hidden' });
    assert.equal(commandPosts.length, beforePosts); assert.equal((await jobByOrder('QA-MOVE')).lineId, 'PM3');
    await page.locator(`[data-job-id="${move.id}"] .hplan-card-open`).click();
    await page.getByRole('button', { name: 'Move to another line or position', exact: true }).click();
    const drawerMoveForm = page.locator('.drawer-move-form'); await drawerMoveForm.waitFor();
    await drawerMoveForm.locator('select').first().selectOption('PM1'); beforePosts = commandPosts.length;
    await page.getByRole('button', { name: 'Apply move', exact: true }).click(); moveDialog = page.getByRole('dialog', { name: 'Review production move', exact: true }); await moveDialog.getByText('Current schedule', { exact: true }).waitFor();
    assert.equal(commandPosts.length, beforePosts); await moveDialog.getByRole('button', { name: 'Cancel move', exact: true }).click(); await page.keyboard.press('Escape');
    moveDialog = await dragTo('PM4'); await moveDialog.getByText('Current schedule', { exact: true }).waitFor(); await moveDialog.getByRole('button', { name: 'Confirm move', exact: true }).click();
    await wait(async () => (await jobByOrder('QA-MOVE')).lineId === 'PM4'); assert.equal(commandPosts.at(-1), 'job.move');
    pass('Drag and drawer move previews make no command until confirmation; cancel is non-mutating');

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const site = page.getByLabel('Site name', { exact: true }); await site.fill('QA unsaved safety settings');
    page.once('dialog', async dialog => { assert.match(dialog.message(), /Settings changes have not been saved/); await dialog.dismiss(); });
    await page.getByRole('button', { name: 'Overview', exact: true }).click(); assert.equal(await site.inputValue(), 'QA unsaved safety settings');
    page.once('dialog', async dialog => { assert.match(dialog.message(), /Discard unsaved changes/); await dialog.accept(); });
    await page.getByRole('button', { name: 'Overview', exact: true }).click(); await page.getByRole('heading', { name: 'Production overview', exact: true }).waitFor();
    pass('Settings navigation warning supports stay and explicit discard');

    await page.getByRole('button', { name: 'Planning board', exact: true }).click();
    const openDraft = async () => { await page.getByRole('button', { name: 'Generate planning', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Generate planning draft', exact: true }); await dialog.waitFor(); return dialog; };
    let draft = await openDraft();
    await draft.getByLabel('Plan from', { exact: true }).fill(addDay(1)); await draft.getByLabel('Plan through', { exact: true }).fill(addDay(3)); await draft.getByLabel('Orders due by', { exact: true }).fill(addDay(4));
    await draft.getByRole('button', { name: 'Generate draft', exact: true }).click(); await draft.locator('.draft-edit-table tbody tr').first().waitFor();
    await page.screenshot({ path: path.join(output, 'draft-desktop.png'), fullPage: true });
    let quantity = draft.locator('input[aria-label^="Quantity draft-"]').first(); const edited = Math.max(.001, Number(await quantity.inputValue()) - 1); await quantity.fill(String(edited));
    page.once('dialog', dialog => dialog.dismiss()); await page.keyboard.press('Escape'); assert.equal(await draft.count(), 1); assert.equal(Number(await quantity.inputValue()), edited);
    await draft.getByRole('button', { name: 'Save draft to this browser', exact: true }).click(); await draft.getByRole('status').filter({ hasText: 'Saved in this browser only' }).waitFor();
    const savedDraftRaw = await page.evaluate(key => localStorage.getItem(key), draftKey); assert.ok(savedDraftRaw);
    await draft.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.reload(); draft = await openDraft(); await draft.getByRole('button', { name: 'Resume saved draft', exact: true }).click();
    quantity = draft.locator('input[aria-label^="Quantity draft-"]').first(); assert.equal(Number(await quantity.inputValue()), edited); assert.equal(await draft.getByRole('button', { name: /Confirm \d+ cards/ }).isEnabled(), true);
    await quantity.fill(String(Math.max(.001, edited - 1))); page.once('dialog', dialog => dialog.accept()); await page.keyboard.press('Escape'); await draft.waitFor({ state: 'hidden' });
    draft = await openDraft(); await draft.getByRole('button', { name: 'Resume saved draft', exact: true }).click(); quantity = draft.locator('input[aria-label^="Quantity draft-"]').first(); assert.equal(Number(await quantity.inputValue()), edited);
    const second = await context.newPage(); await second.goto(base); await second.evaluate(key => { const value = JSON.parse(localStorage.getItem(key)); value.savedAt = new Date(Date.parse(value.savedAt) + 1000).toISOString(); localStorage.setItem(key, JSON.stringify(value)); }, draftKey); await second.close();
    await draft.getByRole('alert').filter({ hasText: 'changed in another tab' }).waitFor(); assert.equal(await quantity.isDisabled(), true);
    await draft.getByRole('button', { name: 'Load latest browser draft', exact: true }).click(); await draft.getByRole('alert').filter({ hasText: 'changed in another tab' }).waitFor({ state: 'hidden' });
    pass('Edited browser draft survives reload; Escape and cross-tab replacement support explicit stay, discard and reload');

    await command({ type: 'job.create', input: manualInput('QA-STALE', addDay(2), 'PM1', 1) });
    await page.reload(); draft = await openDraft(); await draft.getByRole('button', { name: 'Resume saved draft', exact: true }).click();
    await draft.getByRole('alert').filter({ hasText: 'workspace changed' }).waitFor(); assert.equal(await draft.getByRole('button', { name: /Confirm \d+ cards/ }).isDisabled(), true);
    await draft.getByRole('button', { name: 'Regenerate draft', exact: true }).click(); await wait(async () => await draft.getByRole('button', { name: /Confirm \d+ cards/ }).isEnabled());

    const beforeCommit = (await json('/api/workspace')).state.jobs.length;
    const cardCount = await draft.locator('.draft-edit-table tbody tr').count(); const requestIds = []; let lostAttempts = 0, allowExplicitRetry = false;
    const lost = async route => { const body = route.request().postDataJSON(); if (body.command?.type === 'planning.commitDraft') { requestIds.push(body.commandId); if (!allowExplicitRetry) { if (lostAttempts++ === 0) await route.fetch(); await route.abort(); return; } } await route.continue(); };
    await page.route('**/api/commands', lost); await draft.getByRole('button', { name: /Confirm \d+ cards/ }).click();
    await draft.getByRole('alert').filter({ hasText: 'previous save needs confirmation' }).waitFor(); await page.getByRole('button', { name: 'Retry connection', exact: true }).waitFor(); await wait(async () => (await json('/api/workspace')).state.jobs.length === beforeCommit + cardCount);
    const pendingDraftRaw = await page.evaluate(key => localStorage.getItem(key), draftKey); assert.ok(JSON.parse(pendingDraftRaw).pendingCommit?.commandId);
    allowExplicitRetry = true;
    await page.reload(); draft = await openDraft(); await draft.getByRole('button', { name: 'Check previous save', exact: true }).click(); await draft.waitFor({ state: 'hidden' });
    assert.ok(requestIds.length >= 3); assert.ok(requestIds.every(id => id === requestIds[0])); assert.equal((await json('/api/workspace')).state.jobs.length, beforeCommit + cardCount); await page.unroute('**/api/commands', lost);
    pass('Stale drafts block confirmation until regeneration; a lost success reload retries the exact command ID without duplicates');

    await page.evaluate(key => localStorage.setItem(key, '{not-json'), draftKey); draft = await openDraft(); await draft.getByRole('alert').filter({ hasText: 'corrupt or unsupported' }).waitFor();
    await page.evaluate(([key, raw]) => { window.__qaConfirm = window.confirm; window.confirm = () => { localStorage.setItem(key, raw); return true; }; }, [draftKey, pendingDraftRaw]);
    await draft.getByRole('button', { name: 'Discard unreadable browser draft', exact: true }).click();
    await draft.getByRole('alert').filter({ hasText: 'Another tab saved a readable draft' }).waitFor();
    assert.equal(JSON.parse(await page.evaluate(key => localStorage.getItem(key), draftKey)).pendingCommit.commandId, JSON.parse(pendingDraftRaw).pendingCommit.commandId);
    await page.evaluate(() => { window.confirm = window.__qaConfirm; delete window.__qaConfirm; }); await draft.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.evaluate(key => localStorage.removeItem(key), draftKey);
    await page.evaluate(key => { window.__qaGetItem = Storage.prototype.getItem; Storage.prototype.getItem = function (name) { if (name === key) throw new Error('blocked'); return window.__qaGetItem.call(this, name); }; }, draftKey);
    draft = await openDraft(); await draft.getByRole('alert').filter({ hasText: 'could not read' }).waitFor(); await draft.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.evaluate(() => { Storage.prototype.getItem = window.__qaGetItem; delete window.__qaGetItem; });
    await page.evaluate(([key, raw]) => localStorage.setItem(key, raw), [draftKey, savedDraftRaw]); await page.reload(); draft = await openDraft(); await draft.getByRole('button', { name: 'Resume saved draft', exact: true }).click();
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 760 }]) {
      await page.setViewportSize(viewport); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(await draft.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      assert.equal(await draft.locator('.editor-footer button').count(), 3); assert.ok(await draft.locator('.editor-footer').evaluate(footer => [...footer.querySelectorAll('button')].every(button => { const rect = button.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; })));
      await page.screenshot({ path: path.join(output, `draft-mobile-${viewport.width}.png`), fullPage: true });
    }
    await draft.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual(errors, []);
    pass('Corrupt and unavailable local storage fail safely; planning surfaces fit desktop and mobile');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (page) await page.evaluate(key => localStorage.removeItem(key), draftKey).catch(() => {});
    if (browser) await browser.close();
    await command({ type: 'workspace.restore', backup });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
