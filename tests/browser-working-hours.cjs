// Fictional fixtures only. Working-hours mutation tests must use the disposable test workspace.
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
const output = path.resolve('output/playwright/redesign/working-hours');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
const addDay = count => new Date(Date.parse(`${today}T12:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10);
const planDate = addDay(2), nextDate = addDay(3), historyDate = addDay(-1);
const json = async route => { const response = await fetch(base + route); const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data; };
const command = async value => { const current = await json('/api/workspace'); const response = await fetch(base + '/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ expectedRevision: current.revision, commandId: randomUUID(), command: value }) }); const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data; };
const wait = async predicate => { for (let index = 0; index < 120; index += 1) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('Working-hours state did not arrive.'); };
const pass = message => console.log('PASS ' + message);

async function chooseBoardDate(page, date) {
  await page.locator('.date-picker-trigger').click();
  await page.getByLabel('Calendar year').selectOption(date.slice(0, 4));
  await page.getByLabel('Calendar month').selectOption(String(Number(date.slice(5, 7)) - 1));
  await page.locator(`[data-date="${date}"]`).click();
}

async function generateOneDayDraft(page, date) {
  await page.getByRole('button', { name: 'Generate planning', exact: true }).click();
  const draft = page.getByRole('dialog', { name: 'Generate planning draft', exact: true });
  await draft.getByLabel('Plan from', { exact: true }).fill(date);
  await draft.getByLabel('Plan through', { exact: true }).fill(date);
  await draft.getByLabel('Orders due by', { exact: true }).fill(date);
  await draft.getByRole('button', { name: 'Generate draft', exact: true }).click();
  await draft.locator('.draft-edit-table tbody tr').first().waitFor();
  return draft;
}

async function discardDraft(page, draft) {
  page.once('dialog', dialog => dialog.accept());
  await draft.getByRole('button', { name: 'Cancel', exact: true }).click();
  await draft.waitFor({ state: 'hidden' });
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const backup = await json('/api/backup');
  let browser, page;
  try {
    const activatedAt = new Date().toISOString();
    const settings = {
      ...backup.planning.settings,
      dayStart: '07:00', availableHours: 12, changeoverMinutes: 0,
      rates: { PM1: 10, PM2: 10, PM3: 10, PM4: 10 }, slowProductPrefixes: [], downtime: [],
      calendarHistory: [{ effectiveFrom: null, dayStart: '07:00', availableHours: 12, activatedAt: null }],
    };
    delete settings.calendarCutover;
    delete settings.workingHoursOverrides;
    const locked = {
      id: 'qa-hours-locked', date: historyDate, lineId: 'PM4', sequence: 1, orderNo: 'QA-HOURS-HISTORY',
      productCode: 'QA-HOURS-HISTORY', description: 'Fictional completed production', bin: 'QA', mode: 'bulk', bagCount: null,
      quantityMt: 10, status: 'completed', remarks: 'Historical record must remain unchanged',
      actualStart: `${historyDate}T07:00:00+08:00`, actualEnd: `${historyDate}T08:00:00+08:00`, binNeedsReview: false,
      createdAt: activatedAt, updatedAt: activatedAt,
      lockedSegments: [{ jobId: 'qa-hours-locked', lineId: 'PM4', kind: 'production', start: Date.parse(`${historyDate}T07:00:00+08:00`), end: Date.parse(`${historyDate}T08:00:00+08:00`) }],
    };
    await command({ type: 'workspace.restore', backup: { ...backup.planning, settings, jobs: [locked], events: [], catalog: [] } });
    const frozenBefore = (await json('/api/workspace')).state.jobs.find(job => job.id === locked.id);
    const material = '7.0000099988000';
    await command({ type: 'inventory.importBaseline', input: {
      fileName: 'fictional-working-hours.xlsx', digest: '9'.repeat(64), asOfDate: historyDate, includeBaseline: true, packingBinTotal: null,
      orders: [{ fileName: 'fictional-working-hours.xlsx', sheetName: 'bulk order', digest: '8'.repeat(64), asOfDate: historyDate, rows: [{
        doNo: 'QA-HOURS-ORDER', deliveryDate: planDate, soldToParty: 'Fictional hours customer', shipToParty: 'Fictional hours destination',
        materialCode: material, description: 'FS 9988 FICTIONAL HOURS FEED IN BULK', quantity: 1000, unit: 'MT', deliveryLeadDays: 1,
        remark: '', daysOutstanding: 0, medication: '', fmrOmed: '',
      }] }],
      items: [{ materialCode: material, description: 'FS 9988 FICTIONAL HOURS FEED IN BULK', unit: 'MT', bagWeightKg: null, strategy: 'mto', targetQuantity: 0, needsReview: false, opening: 0, production: 0, received: 0, salesReturn: 0, rework: 0, issue: 0, closing: 0, medication: '', fmrOmed: '' }], annotations: [],
    } });

    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : !existsSync(chromium.executablePath()) ? { channel: 'chrome' } : {}) });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kuala_Lumpur', reducedMotion: 'reduce' });
    page = await context.newPage(); page.setDefaultTimeout(15_000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/#/settings');
    await page.getByRole('tab', { name: 'Unavailable periods', exact: true }).click();
    const panel = page.locator('.working-hours-panel');
    await panel.getByLabel('Planning date', { exact: true }).fill(planDate);
    for (const line of ['PM1', 'PM2']) {
      await panel.getByLabel(`${line} rule`, { exact: true }).selectOption('custom');
      await panel.getByLabel(`${line} start`, { exact: true }).fill('07:00');
      await panel.getByLabel(`${line} available hours`, { exact: true }).fill('14');
    }
    for (const line of ['PM3', 'PM4']) await panel.getByLabel(`${line} rule`, { exact: true }).selectOption('closed');
    await panel.getByLabel('Reason for this change', { exact: true }).fill('Fictional urgent-order overtime');
    await panel.getByRole('button', { name: 'Apply date hours', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'were applied' }).waitFor();
    await wait(async () => (await json('/api/workspace')).state.settings.workingHoursOverrides?.filter(row => row.date === planDate).length === 4);
    assert.deepEqual((await json('/api/workspace')).state.jobs.find(job => job.id === locked.id), frozenBefore);
    pass('A reasoned per-line date exception persists while completed production stays byte-for-byte unchanged');

    await page.getByRole('button', { name: 'Planning board', exact: true }).click();
    await chooseBoardDate(page, planDate);
    const axis = page.locator('.hplan-axis-tick span');
    assert.equal(await axis.first().innerText(), '07:00'); assert.equal(await axis.last().innerText(), '21:00');
    assert.match(await page.locator('[data-line-label="PM1"]').innerText(), /07:00–21:00 · exception/);
    assert.match(await page.locator('[data-line-label="PM2"]').innerText(), /07:00–21:00 · exception/);
    assert.match(await page.locator('[data-line-label="PM3"]').innerText(), /Closed · exception/);
    assert.match(await page.locator('[data-line-label="PM4"]').innerText(), /Closed · exception/);
    let draft = await generateOneDayDraft(page, planDate);
    const quantities = await draft.locator('input[aria-label^="Quantity draft-"]').evaluateAll(inputs => inputs.map(input => Number(input.value)));
    assert.equal(quantities.reduce((sum, value) => sum + value, 0), 280);
    const lines = await draft.locator('select[aria-label^="Line draft-"]').evaluateAll(selects => selects.map(select => select.value));
    assert.deepEqual([...new Set(lines)].sort(), ['PM1', 'PM2']);
    await page.screenshot({ path: path.join(output, 'overtime-and-closures.png'), fullPage: true });
    await discardDraft(page, draft);
    pass('The board and generated draft use14-hour PM1/PM2 capacity and exclude closed PM3/PM4');

    await chooseBoardDate(page, nextDate);
    assert.equal(await axis.first().innerText(), '07:00'); assert.equal(await axis.last().innerText(), '19:00');
    for (const line of ['PM1', 'PM2', 'PM3', 'PM4']) assert.doesNotMatch(await page.locator(`[data-line-label="${line}"]`).innerText(), /exception/);
    draft = await generateOneDayDraft(page, nextDate);
    const nextQuantities = await draft.locator('input[aria-label^="Quantity draft-"]').evaluateAll(inputs => inputs.map(input => Number(input.value)));
    assert.equal(nextQuantities.reduce((sum, value) => sum + value, 0), 480);
    await discardDraft(page, draft);
    pass('The following day automatically returns to the normal12-hour four-line calendar');

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Unavailable periods', exact: true }).click();
    await panel.getByLabel('Planning date', { exact: true }).fill(planDate);
    await panel.getByLabel('Reason for this change', { exact: true }).fill('Unsaved fictional revision');
    page.once('dialog', async dialog => { assert.match(dialog.message(), /working-hours draft has not been saved/); await dialog.dismiss(); });
    await panel.getByLabel('Planning date', { exact: true }).fill(nextDate);
    assert.equal(await panel.getByLabel('Planning date', { exact: true }).inputValue(), planDate);
    assert.equal(await panel.getByLabel('Reason for this change', { exact: true }).inputValue(), 'Unsaved fictional revision');
    await panel.getByRole('button', { name: 'Discard date draft', exact: true }).click();
    await panel.getByLabel('Planning date', { exact: true }).fill(nextDate);
    assert.equal(await panel.getByLabel('Planning date', { exact: true }).inputValue(), nextDate);
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 760 }]) {
      await page.setViewportSize(viewport);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(output, `editor-${viewport.width}.png`), fullPage: true });
    }
    assert.deepEqual(errors, []);
    pass('Unsaved date drafts require explicit discard and the editor reflows at390px and320px');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await command({ type: 'workspace.restore', backup });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
