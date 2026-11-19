// Fictional fixtures only. Never run a replacement suite against the production workspace.
const { chromium } = require('playwright');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const base = process.env.BROWSER_BASE_URL;
if (!base || process.env.BROWSER_ALLOW_REPLACE !== '1' || !['127.0.0.1', 'localhost'].includes(new URL(base).hostname) || new URL(base).port === '8080') {
  throw Error('Use an explicitly disposable loopback BROWSER_BASE_URL, never production 8080, with BROWSER_ALLOW_REPLACE=1.');
}
const output = path.resolve('output/playwright/carryover');
const draftKey = 'millplan.planning-draft.v1';
async function json(route) {
  const response = await fetch(base + route);
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}
async function command(value) {
  const { revision } = await json('/api/workspace');
  const response = await fetch(base + '/api/commands', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ expectedRevision: revision, commandId: randomUUID(), command: value }),
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}
async function waitFor(check) {
  for (let index = 0; index < 100; index++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Timed out waiting for carryover browser state.');
}
const addDays = (date, count) => new Date(Date.parse(date + 'T12:00:00Z') + count * 86400000).toISOString().slice(0, 10);
const emptyCollections = object => Object.fromEntries(Object.keys(object).map(key => [key, []]));
async function fits(locator) {
  assert.ok(await locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
  }), 'Dialog/footer stays inside the viewport');
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const original = await json('/api/backup');
  const { asOfDate: today, targetIssueDate: tomorrow } = await json('/api/data/import-context');
  const yesterday = addDays(today, -1), through = addDays(tomorrow, 1);
  let browser, page;
  try {
    assert.equal(original.schemaVersion, 7, 'Carryover coverage requires the V7 workspace');
    const clean = {
      ...original,
      planning: { ...original.planning, jobs: [], events: [], settings: {
        ...original.planning.settings, dayStart: '07:00', availableHours: 12,
        rates: { PM1: 10, PM2: 10, PM3: 10, PM4: 10 }, changeoverMinutes: 0,
        slowProductPrefixes: [], downtime: [], workingHoursOverrides: [],
        calendarHistory: undefined, calendarCutover: undefined,
      } },
      sourceData: emptyCollections(original.sourceData),
      inventory: emptyCollections(original.inventory),
      productionProgress: emptyCollections(original.productionProgress),
      baselineHistory: emptyCollections(original.baselineHistory),
      dailyPlanning: emptyCollections(original.dailyPlanning),
    };
    await command({ type: 'workspace.restore', backup: clean });
    await command({ type: 'inventory.importStockReports', reports: [{
      fileName: 'fictional-carryover-stock.xlsm', digest: '6'.repeat(64), sheetName: Number(today.slice(-2)) + 'th', asOfDate: today,
      stockRows: [{ materialCode: '7.9999999599900', description: 'FS 5999 FICTIONAL BULK', unit: 'MT', bagWeightKg: null,
        strategy: 'mto', targetQuantity: 0, needsReview: false, medication: '', fmrOmed: '',
        opening: 0, production: 0, received: 0, salesReturn: 0, rework: 0, issue: 0, closing: 0 }],
    }], reconcile: false, reason: '' });
    function manual(orderNo, lineId, quantityMt, productCode) {
      return { orderNo, date: yesterday, lineId, productCode, description: `FS ${productCode} FICTIONAL BULK`,
        bin: 'FICTIONAL-BIN', mode: 'bulk', bagCount: null, quantityMt, remarks: 'Fictional carryover browser fixture' };
    }
    await command({ type: 'job.create', input: manual('FICTION-PENDING', 'PM1', 8, '5220') });
    await command({ type: 'job.create', input: manual('FICTION-RUNNING', 'PM2', 6, '5811') });
    let before = (await json('/api/workspace')).state;
    const runningId = before.jobs.find(job => job.orderNo === 'FICTION-RUNNING').id;
    await command({ type: 'job.start', jobId: runningId });
    before = (await json('/api/workspace')).state;
    const pendingBefore = before.jobs.find(job => job.orderNo === 'FICTION-PENDING');
    const runningBefore = before.jobs.find(job => job.id === runningId);
    const originalIds = before.jobs.map(job => job.id).sort();
    assert.equal(before.jobs.length, 2);
    assert.ok(runningBefore.actualStart, 'Start records server time');
    assert.ok(runningBefore.lockedSegments.length, 'Started card retains a locked historical plan');

    browser = await chromium.launch({ headless: true, ...(!existsSync(chromium.executablePath()) ? { channel: 'chrome' } : {}) });
    page = await browser.newPage({ viewport: { width: 1366, height: 768 }, timezoneId: 'Asia/Kuala_Lumpur', reducedMotion: 'reduce' });
    page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/#/planning');
    await page.getByRole('button', { name: 'Generate planning', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Generate planning draft', exact: true });
    await modal.getByLabel('Plan from', { exact: true }).fill(tomorrow);
    await modal.getByLabel('Plan through', { exact: true }).fill(through);
    await modal.getByRole('button', { name: 'Generate draft', exact: true }).click();
    const proposals = modal.getByRole('region', { name: 'Unfinished production proposals', exact: true });
    // Named section uses its accessible label; section-to-region is native HTML semantics.
    await proposals.waitFor();
    async function assertCarryoverOnly() {
      assert.equal(await proposals.locator('tbody tr').count(), 2);
      await proposals.getByText('Continue', { exact: true }).waitFor();
      await proposals.getByText('Carry over', { exact: true }).waitFor();
      assert.match(await proposals.innerText(), new RegExp(runningId));
      assert.match(await proposals.innerText(), new RegExp(pendingBefore.id));
      assert.equal(await modal.getByRole('heading', { name: /^New production cards/ }).count(), 0);
      assert.equal(await modal.getByText(/^No cards to save/).count(), 0);
      assert.equal(await modal.getByRole('button', { name: 'Confirm 2 proposals', exact: true }).isEnabled(), true);
    }
    await assertCarryoverOnly();
    const storedBefore = await json('/api/workspace');
    await modal.getByRole('button', { name: 'Save draft to this browser', exact: true }).click();
    await modal.getByText('Saved in this browser only. It is not yet production planning.', { exact: true }).waitFor();
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), draftKey);
    assert.equal(saved.jobs.length, 0); assert.equal(saved.preview.carryovers.length, 2);
    assert.equal((await json('/api/workspace')).revision, storedBefore.revision, 'Browser draft does not write production');
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click(); await modal.waitFor({ state: 'hidden' });
    assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden');
    await page.getByRole('button', { name: 'Generate planning', exact: true }).click();
    await modal.getByRole('button', { name: 'Resume saved draft', exact: true }).click();
    await assertCarryoverOnly();
    for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await fits(modal); await fits(modal.locator('.editor-footer'));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const body = modal.locator('.editor-body'); await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
      for (let index = 0; index < 10; index++) { await page.keyboard.press('Tab'); assert.ok(await modal.evaluate(element => element.contains(document.activeElement)), 'Focus stays in the planning modal'); }
      await page.screenshot({ path: path.join(output, 'carryover-' + viewport.width + '.png') });
    }
    await modal.getByRole('button', { name: 'Confirm 2 proposals', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
    await waitFor(async () => (await json('/api/workspace')).state.jobs.find(job => job.id === pendingBefore.id).date === tomorrow);
    const after = (await json('/api/workspace')).state;
    assert.deepEqual(after.jobs.map(job => job.id).sort(), originalIds, 'Carryover-only confirmation never creates replacement cards');
    const pendingAfter = after.jobs.find(job => job.id === pendingBefore.id), runningAfter = after.jobs.find(job => job.id === runningId);
    assert.equal(pendingAfter.date, tomorrow); assert.equal(pendingAfter.status, 'pending');
    assert.equal(pendingAfter.quantityMt, pendingBefore.quantityMt); assert.equal(runningAfter.quantityMt, runningBefore.quantityMt);
    assert.equal(runningAfter.date, runningBefore.date); assert.equal(runningAfter.lineId, 'PM2');
    assert.equal(runningAfter.actualStart, runningBefore.actualStart); assert.equal(runningAfter.actualEnd, runningBefore.actualEnd);
    assert.deepEqual(runningAfter.lockedSegments, runningBefore.lockedSegments, 'Continuation does not replace historical locks');
    assert.equal(runningAfter.status, 'running'); assert.ok(runningAfter.continuationPlan.segments.length);
    const backup = await json('/api/backup'); assert.equal(backup.schemaVersion, 7);
    assert.equal(backup.dailyPlanning.continuationReservations.length, 1);
    const reservation = backup.dailyPlanning.continuationReservations[0];
    assert.equal(reservation.jobId, runningId); assert.equal(reservation.lineId, 'PM2'); assert.equal(reservation.remainingQuantity, 6);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), draftKey), null, 'Confirmed browser draft is removed');
    await page.reload(); await page.getByRole('button', { name: 'Generate planning', exact: true }).waitFor();
    assert.deepEqual((await json('/api/workspace')).state.jobs.map(job => job.id).sort(), originalIds, 'Reload creates no duplicate cards');
    assert.equal((await json('/api/backup')).dailyPlanning.continuationReservations.length, 1, 'Reload creates no duplicate continuation reservation');
    assert.deepEqual(errors, []);
    console.log('PASS carryover-only Continue/Carry over draft, browser save/resume, original IDs/actuals/locks, V7 reservation, reload and responsive focus');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await command({ type: 'workspace.restore', backup: original });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
