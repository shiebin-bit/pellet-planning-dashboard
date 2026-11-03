// Fictional production only; this replaces and restores a disposable workspace.
const { chromium } = require('playwright');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const base = process.env.BROWSER_BASE_URL;
if (!base || process.env.BROWSER_ALLOW_REPLACE !== '1' || !['localhost', '127.0.0.1'].includes(new URL(base).hostname) || new URL(base).port === '8080') throw Error('Use an isolated loopback test workspace.');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
const yesterday = new Date(Date.parse(today + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
const output = path.resolve('output/playwright/redesign/live-progress');
const json = async route => { const r = await fetch(base + route); const data = await r.json(); assert.equal(r.status, 200, JSON.stringify(data)); return data; };
const command = async command => { const ws = await json('/api/workspace'); const r = await fetch(base + '/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ expectedRevision: ws.revision, commandId: randomUUID(), command }) }); const data = await r.json(); assert.equal(r.status, 200, JSON.stringify(data)); return data; };
const wait = async check => { for (let n = 0; n < 120; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('Live progress did not arrive.'); };
const pass = text => console.log('PASS ' + text);

(async () => {
  await fs.mkdir(output, { recursive: true });
  const backup = await json('/api/backup');
  let browser, page;
  try {
    const { calendarHistory, calendarCutover, workingHoursOverrides, ...original } = backup.planning.settings;
    const settings = { ...original, dayStart: '00:00', availableHours: 24, changeoverMinutes: 0, rates: { PM1: 1, PM2: 1, PM3: 1, PM4: 1 }, slowProductPrefixes: [], downtime: [] };
    await command({ type: 'workspace.restore', backup: { ...backup.planning, settings, jobs: [], events: [], catalog: [] } });
    const material = '7.FICTIONAL.PROGRESS';
    await command({ type: 'inventory.importBaseline', input: {
      fileName: 'fictional-live-progress.xlsx', digest: 'a'.repeat(64), asOfDate: yesterday, includeBaseline: true, packingBinTotal: null,
      orders: [{ fileName: 'fictional-live-progress.xlsx', sheetName: 'bag order', digest: 'b'.repeat(64), asOfDate: yesterday, rows: [{ doNo: 'QA-LIVE-PROGRESS', deliveryDate: today, soldToParty: 'Fictional progress customer', shipToParty: 'Fictional destination', materialCode: material, description: 'FS 9701 FICTIONAL PROGRESS FEED 50KG', quantity: 100, unit: 'Bags', deliveryLeadDays: 0, remark: '', daysOutstanding: 0, medication: '', fmrOmed: '' }] }],
      items: [{ materialCode: material, description: 'FS 9701 FICTIONAL PROGRESS FEED 50KG', unit: 'Bags', bagWeightKg: 50, strategy: 'mto', targetQuantity: 0, needsReview: false, opening: 0, production: 0, received: 0, salesReturn: 0, rework: 0, issue: 0, closing: 0, medication: '', fmrOmed: '' }], annotations: [],
    } });
    const item = (await json('/api/inventory')).items[0];
    const planned = await command({ type: 'job.create', input: { date: today, lineId: 'PM1', orderNo: 'QA-LIVE-PROGRESS', productCode: material, description: 'FS 9701 FICTIONAL PROGRESS FEED 50KG', bin: 'QA-BIN', mode: 'bags', bagCount: 100, quantityMt: 5, bagWeightKgSnapshot: 50, inventoryItemId: item.itemId, productionPurpose: 'mts', remarks: '' } });
    const jobId = planned.state.jobs[0].id;
    await command({ type: 'job.start', jobId });
    await command({ type: 'production.recordReceipt', jobId, totalActualQuantity: 40 });

    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : !existsSync(chromium.executablePath()) ? { channel: 'chrome' } : {}) });
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, timezoneId: 'UTC', reducedMotion: 'reduce' });
    page = await context.newPage(); page.setDefaultTimeout(15_000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/#/planning');
    await page.locator('.hplan-card .hplan-receipt-label').filter({ hasText: '40 / 100 Bags' }).waitFor();
    assert.equal(await page.locator('[data-now-marker]').count(), 5);
    assert.equal(await page.locator('.hplan-receipt-meter').count(), 1);
    await page.locator(`[data-job-id="${jobId}"] .hplan-card-open`).click();
    const drawer = page.getByRole('dialog', { name: '9701', exact: true });
    await drawer.locator('.live-production-total').filter({ hasText: '40 / 100 Bags' }).waitFor();
    assert.equal(await drawer.locator('.live-production-estimate').count(), 0);
    assert.match(await drawer.locator('.live-production-note').innerText(), /More current-time output records/);
    await drawer.getByLabel('New quantity (Bags)', { exact: true }).fill('10');
    await drawer.getByRole('button', { name: 'Record production quantity', exact: true }).click();
    await drawer.locator('.live-production-total').filter({ hasText: '50 / 100 Bags' }).waitFor();
    await drawer.locator('.live-production').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'progress-drawer-desktop.png') });
    await drawer.getByRole('button', { name: 'Close production details', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'progress-board-desktop.png') });
    pass('Now marker spans four lines; authoritative bag receipts update board and drawer without inventing an ETA');

    let mode = 'estimate';
    await page.route('**/api/inventory/production-progress?*', async route => {
      if (mode === 'error') return route.abort();
      const response = await route.fetch(); const data = await response.json();
      if (mode === 'estimate') {
        const now = Date.parse(data.serverNow);
        data.jobs = data.jobs.map(job => ({ ...job, samples: [10, 30, 50].map((quantity, n) => ({ id: `fictional-sample-${n}`, cumulativeTotal: quantity, sampledAt: new Date(now - (2 - n) * 15 * 60_000).toISOString(), trustworthy: true })), estimate: { label: 'estimate', estimatedCompletionAt: new Date(now + 60 * 60_000).toISOString(), ratePerHour: 50, sampleCount: 3, windowStartedAt: new Date(now - 30 * 60_000).toISOString(), deltaMinutes: 30, status: 'late' }, estimateUnavailableReason: null }));
      }
      return route.fulfill({ response, json: data });
    });
    await page.reload(); await page.locator(`[data-job-id="${jobId}"] .hplan-card-open`).click();
    await drawer.locator('.live-production-estimate').waitFor();
    assert.match(await drawer.locator('.live-production-estimate').innerText(), /Estimated finish[\s\S]*later than plan/);
    mode = 'error';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await drawer.locator('.live-production.is-stale').waitFor();
    assert.equal(await drawer.locator('.live-production-estimate').count(), 0);
    assert.match(await drawer.locator('.live-production-total').innerText(), /50 \/ 100 Bags[\s\S]*last known/);
    mode = 'real';
    await drawer.getByRole('button', { name: 'Retry progress', exact: true }).click();
    await wait(async () => await drawer.locator('.live-production.is-stale').count() === 0);
    await drawer.getByRole('button', { name: 'Close production details', exact: true }).click();
    await page.unroute('**/api/inventory/production-progress?*');
    pass('Estimated finish is labelled; failed refresh retains marked last-known quantity and hides the estimate until retry');

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator('.production-list-live').filter({ hasText: '50 / 100 Bags' }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(output, `progress-list-${width}.png`) });
      await page.locator(`[data-job-id="${jobId}"] .production-list-open`).click();
      await drawer.getByRole('progressbar', { name: 'Production received', exact: true }).waitFor();
      await drawer.locator('.live-production').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `progress-mobile-${width}.png`) });
      await drawer.getByRole('button', { name: 'Close production details', exact: true }).click();
    }
    assert.deepEqual(errors, []);
    pass('Native-unit progress, accessible meters and drawer actions fit 320/390px without page overflow');
  } catch (error) { console.error('Live progress assertion failed:', error); if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
  finally { if (browser) await browser.close(); await command({ type: 'workspace.restore', backup }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
