// All fixtures are fictional. This test replaces data only on an explicitly isolated loopback server.
const { chromium } = require('playwright');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const base = process.env.BROWSER_BASE_URL;
if (!base || process.env.BROWSER_ALLOW_REPLACE !== '1' || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) || new URL(base).port === '8080') {
  throw Error('Use a disposable loopback BROWSER_BASE_URL, never production 8080, with BROWSER_ALLOW_REPLACE=1.');
}
const output = path.resolve('output/playwright/import-reviews');
const json = async route => { const response = await fetch(base + route); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
const workspace = () => json('/api/workspace');
const command = async body => {
  const current = await workspace();
  const response = await fetch(base + '/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ expectedRevision: current.revision, commandId: randomUUID(), command: body }) });
  const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
};
const wait = async fn => { for (let index = 0; index < 120; index++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); } assert.fail('Timed out waiting for browser state'); };
const orderRow = (doNo, patch = {}) => ({ goodsMovementStatus: '', sourceSheet: 'Orders', sourceRow: 2, doNo, deliveryDate: '2026-11-10', soldToParty: 'Fictional buyer', shipToParty: 'Fictional mill', materialCode: 'TEST-FEED-' + doNo, description: 'Original fictional feed', quantity: 100, unit: 'MT', deliveryLeadDays: 7, remark: '', daysOutstanding: 0, medication: '', fmrOmed: '', ...patch });
const source = (fileName, digestCharacter, rows) => ({ fileName, sheetName: 'Orders', digest: digestCharacter.repeat(64), asOfDate: '2026-11-03', rows });

(async () => {
  await fs.mkdir(output, { recursive: true });
  const original = await json('/api/backup');
  let browser;
  try {
    const empty = {
      ...original,
      planning: { ...original.planning, jobs: [], catalog: [], events: [] },
      sourceData: { imports: [], orders: [], versions: [], discrepancies: [] },
      inventory: { items: [], imports: [], baselineReports: [], orders: [], ledger: [], reservations: [] },
      productionProgress: { samples: [], resets: [] },
    };
    await command({ type: 'workspace.restore', backup: empty });
    const target = orderRow('QA-REVIEW-001');
    await command({ type: 'inventory.importBaseline', input: {
      fileName: 'fictional-baseline.xlsx', digest: 'a'.repeat(64), asOfDate: '2026-11-03', includeBaseline: true, reconcileStock: false, packingBinTotal: null,
      orders: [source('fictional-baseline-orders.xlsx', 'b', [target])], annotations: [],
      items: [{ materialCode: target.materialCode, description: target.description, unit: 'MT', bagWeightKg: null, medication: '', fmrOmed: '', strategy: 'mto', targetQuantity: 0, needsReview: false, opening: 30, production: 0, received: 0, salesReturn: 0, rework: 0, issue: 0, closing: 30 }],
    } });
    const bulkInitial = Array.from({ length: 50 }, (_, index) => orderRow('QA-PAGE-' + String(index + 1).padStart(3, '0'), { sourceRow: index + 2, quantity: 10 + index }));
    await command({ type: 'data.import', input: source('fictional-page-initial.xlsx', 'c', bulkInitial) });
    await command({ type: 'data.import', input: source('fictional-page-changes.xlsx', 'd', bulkInitial.map((item, index) => ({ ...item, description: 'Revised fictional feed ' + index }))) });
    await command({ type: 'data.import', input: source('fictional-protected-change.xlsx', 'e', [{ ...target, description: 'Verified fictional feed', quantity: 120 }]) });

    const before = await json('/api/data?search=QA-REVIEW-001&page=1');
    assert.equal(before.items[0].description, 'Original fictional feed'); assert.equal(before.items[0].quantity, 100);
    const baselineLedgerCount = (await json('/api/inventory/ledger')).length;

    browser = await chromium.launch({ headless: true, ...(!existsSync(chromium.executablePath()) ? { channel: 'chrome' } : {}) });
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, timezoneId: 'Asia/Kuala_Lumpur' });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/#/data'); await page.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Import review queue', exact: true }).click();
    await page.getByRole('heading', { name: 'Import review queue', exact: true }).waitFor();
    await wait(async () => /Pending \(51\)/.test(await page.getByRole('button', { name: /^Pending/ }).innerText()));
    assert.match(await page.locator('.data-pagination').innerText(), /1–50 of 51 reviews/);

    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await wait(async () => await page.locator('.import-review-row').count() === 1);
    assert.match(await page.locator('.data-pagination').innerText(), /51.of 51 reviews/);
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await wait(async () => await page.locator('.import-review-row').count() === 50);
    await page.getByRole('button', { name: /QA-REVIEW-001/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Review QA-REVIEW-001', exact: true }); await dialog.waitFor();
    assert.equal(await page.locator('#root').evaluate(element => element.inert), true);
    const quantity = dialog.locator('.review-field-list>label').filter({ hasText: 'Quantity' });
    assert.match(await quantity.innerText(), /Protected/); assert.equal(await quantity.getByRole('checkbox').isDisabled(), true);
    const description = dialog.locator('.review-field-list>label').filter({ hasText: 'Description' });
    await description.getByRole('checkbox').check();
    await dialog.getByLabel('Reason (required)').fill('Buyer confirmed the revised description.');

    // An unrelated save refreshes the queue; the verification draft must not be remounted or cleared.
    await command({ type: 'data.import', input: source('fictional-unrelated.xlsx', 'f', [orderRow('QA-UNRELATED-001')]) });
    const refreshed = page.waitForResponse(response => response.request().method() === 'GET' && response.url().endsWith('/api/workspace'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await refreshed; await page.waitForTimeout(300);
    assert.equal(await description.getByRole('checkbox').isChecked(), true);
    assert.equal(await dialog.getByLabel('Reason (required)').inputValue(), 'Buyer confirmed the revised description.');

    let actionReached = false;
    for (let index = 0; index < 18; index++) { await page.keyboard.press('Tab'); assert.ok(await dialog.evaluate(element => element.contains(document.activeElement))); actionReached ||= await page.evaluate(() => document.activeElement?.textContent?.includes('Apply selected fields') ?? false); }
    assert.equal(actionReached, true, 'Review actions are keyboard reachable within the focus trap');
    await dialog.getByRole('button', { name: 'Apply selected fields', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    const corrected = await json('/api/data?search=QA-REVIEW-001&page=1');
    assert.equal(corrected.items[0].description, 'Verified fictional feed'); assert.equal(corrected.items[0].quantity, 100, 'Protected quantity remains unchanged');
    assert.equal((await json('/api/inventory/ledger')).length, baselineLedgerCount, 'Review never replays inventory movements');

    await page.getByRole('button', { name: /^Applied/ }).click(); await wait(async () => /Applied \(1\)/.test(await page.getByRole('button', { name: /^Applied/ }).innerText()));
    await page.getByRole('button', { name: /QA-REVIEW-001/ }).click();
    const applied = page.getByRole('dialog', { name: 'Review QA-REVIEW-001', exact: true }); assert.match(await applied.innerText(), /Buyer confirmed the revised description/);
    await page.keyboard.press('Escape'); await applied.waitFor({ state: 'hidden' });

    await page.getByRole('button', { name: /^Pending/ }).click(); await page.locator('.import-review-row').first().click();
    const pendingDialog = page.getByRole('dialog', { name: /^Review QA-PAGE-/ });
    await pendingDialog.getByLabel('Reason (required)').fill('The newer workbook row is not authoritative.');
    await pendingDialog.getByRole('button', { name: 'Dismiss review', exact: true }).click(); await pendingDialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: /^Dismissed/ }).click(); await wait(async () => /Dismissed \(1\)/.test(await page.getByRole('button', { name: /^Dismissed/ }).innerText()));

    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 760 }]) {
      await page.setViewportSize(viewport); await page.locator('.import-review-row').first().click();
      const mobileDialog = page.getByRole('dialog', { name: /^Review/ }); await mobileDialog.waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const box = await mobileDialog.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width + 1 && box.y >= 0 && box.y + box.height <= viewport.height + 1, JSON.stringify(box));
      await page.screenshot({ path: path.join(output, 'review-' + viewport.width + '.png') }); await page.keyboard.press('Escape'); await mobileDialog.waitFor({ state: 'hidden' });
    }
    const portable = await json('/api/backup'); assert.equal(portable.schemaVersion, 5); assert.ok(portable.sourceData.discrepancies.length >= 51);
    assert.deepEqual(errors, []);
    console.log('PASS import review queue preserves active orders, protects reserved quantity, supports selected corrections/dismissal/pagination, traps focus and fits mobile');
  } finally {
    if (browser) await browser.close();
    await command({ type: 'workspace.restore', backup: original });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
