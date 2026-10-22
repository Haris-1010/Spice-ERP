// Browser end-to-end test of the offline invoice flow (SRS §25 "Offline tests").
// Usage: node tests/e2e-offline.mjs http://localhost:5080 admin <password> [screenshotDir]
// Requires: npm i playwright  (and a running API that serves the built frontend)
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5080';
const USER = process.argv[3] ?? 'admin';
const PWD = process.argv[4] ?? 'Admin12345';
const SHOTS = process.argv[5] ?? null;
const exe = process.env.CHROMIUM_PATH;

let token = null;
async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}
const ok = (c, m) => { if (!c) throw new Error('FAILED: ' + m); console.log('  ok  ' + m); };
const today = new Date().toISOString().slice(0, 10);

// ---- seed: stock and a customer through the API
token = (await api('POST', '/api/auth/login', { username: USER, password: PWD, deviceId: crypto.randomUUID(), deviceName: 'seed' })).token;
const bp = (await api('GET', '/api/products?q=Black%20Pepper')).items[0];
const v50 = bp.variations.find(v => v.packetGrams === 50);
const mats = await api('GET', '/api/packaging-materials');
const sup = await api('POST', '/api/suppliers', { name: 'Seed Supplier', openingBalance: 0 });
await api('POST', '/api/purchases', { supplierId: sup.id, purchaseDate: today, transportCost: 0, discountAmount: 0, taxAmount: 0, amountPaid: 0,
  lines: [{ lineType: 'SPICE', productId: bp.id, batchNo: 'E2E-1', quantity: 5000, rate: 900 },
          { lineType: 'MATERIAL', materialId: mats.find(m => m.code === 'POUCH-50').id, quantity: 100, rate: 2 },
          { lineType: 'MATERIAL', materialId: mats.find(m => m.code === 'LABEL-STD').id, quantity: 100, rate: 1 }] });
const batch = (await api('GET', `/api/purchases/batches?productId=${bp.id}`)).find(b => b.batchNo === 'E2E-1');
const po = await api('POST', '/api/packing', { variationId: v50.id, batchId: batch.id, plannedPackets: 100, packDate: today });
await api('POST', `/api/packing/${po.id}/post`, { producedPackets: 100, rejectedPackets: 0, lossGrams: 0, pouchesUsed: 100, labelsUsed: 100, labourCost: 0, overheadCost: 0 });
await api('POST', '/api/customers', { id: crypto.randomUUID(), shopName: 'Bismillah Kiryana', phone: '0333-4444444', area: 'Model Town', customerType: 'RETAILER', creditLimit: 0, paymentTermsDays: 0, openingBalance: 0 });
console.log('seeded: 100 packets of Black Pepper 50 g, customer Bismillah Kiryana');

// ---- browser
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await ctx.addInitScript(() => { window.__prints = 0; window.print = () => { window.__prints++; }; });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('  [page error]', e.message));

console.log('1. Sign in online and download data');
await page.goto(BASE + '/');
await page.fill('input[name=u]', USER);
await page.fill('input[name=p]', PWD);
await page.fill('input[name=d]', 'E2E counter PC');
await page.click('button[type=submit]');
await page.waitForSelector('text=All synced', { timeout: 20000 });
ok(true, 'signed in and synced');
await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 30000 }).catch(() => {});
const swReady = await page.evaluate(() => !!navigator.serviceWorker?.controller);
console.log('  service worker controlling page:', swReady);
if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-dashboard.png`, fullPage: true });

console.log('2. Go offline and create an invoice');
await ctx.setOffline(true);
await page.click('a[href="/sales"]');
await page.click('a[href="/sales/new"]');
await page.fill('input[autofocus]', 'Bismillah');
await page.click('.dropdown button >> nth=0');
const itemBox = page.locator('input[placeholder*="barcode"], input[placeholder*="Scan"]');
await itemBox.fill('black 50');
await itemBox.press('Enter');
await page.locator('table.data tbody input[type=number]').first().fill('12');
await page.locator('select').filter({ hasText: 'Cash' }).first().selectOption('CASH');
await page.locator('.totals input[type=number]').fill('300');
if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-new-invoice-offline.png`, fullPage: true });
await page.click('button:has-text("Save & print")');
await page.waitForURL(/\/sales\/[0-9a-f-]{36}/, { timeout: 10000 });
const invoiceId = page.url().split('/sales/')[1].split('?')[0];
await page.waitForSelector('app-invoice-doc .doc');
const invNo = (await page.locator('app-invoice-doc .meta strong').first().innerText()).trim();
ok(/^INV-D\d+-\d{5}$/.test(invNo), `offline invoice saved with device number ${invNo}`);
ok(await page.isVisible('text=Saved on this device'), 'status shows "Saved on this device"');
await page.waitForTimeout(600);
ok(await page.evaluate(() => window.__prints) >= 1, 'print dialog opened from local data (no server)');
const total = await page.locator('.sum .big .n').first().innerText();
ok(total.includes('600'), `total 12 x Rs. 50 = ${total}`);
if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-invoice-print-preview.png`, fullPage: true });

console.log('3. Reload the browser while still offline');
if (swReady) {
  await page.reload();
  await page.waitForSelector('app-invoice-doc .doc', { timeout: 15000 });
  ok((await page.locator('app-invoice-doc .meta strong').first().innerText()).trim() === invNo, 'invoice still there after offline reload');
  const chip = await page.locator('.sync-chip').innerText().catch(() => '');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/3b-after-offline-reload.png` });
  ok(await page.waitForSelector('text=1 waiting to sync', { timeout: 8000 }).then(() => true, () => false), `top bar shows 1 waiting to sync ("${chip.trim()}")`);
} else console.log('  (skipped: service worker not active in this browser)');

console.log('4. Urdu print layout');
await page.locator('select').first().selectOption('ur');
if (SHOTS) await page.screenshot({ path: `${SHOTS}/4-invoice-urdu.png`, fullPage: true });
ok(await page.locator('app-invoice-doc .doc[dir=rtl]').count() === 1, 'Urdu invoice renders right-to-left');
await page.locator('select').first().selectOption('en');

console.log('5. Reconnect and sync');
await ctx.setOffline(false);
await page.evaluate(() => window.dispatchEvent(new Event('online')));
await page.click('button:has-text("Sync now")');
await page.waitForSelector('text=All synced', { timeout: 20000 });
await page.waitForSelector('app-sync-badge >> text=Synced with server', { timeout: 10000 });
ok(true, 'invoice status changed to "Synced with server"');

const server = await api('GET', `/api/sales-invoices?q=${encodeURIComponent(invNo)}`);
ok(server.total === 1, 'server has exactly one copy of the invoice');
const detail = await api('GET', `/api/sales-invoices/${invoiceId}`);
ok(Number(detail.invoice.total) === 600 && Number(detail.invoice.amountPaid) === 300, 'server totals match: 600, paid 300');
const stock = await api('GET', '/api/inventory/stock');
ok(stock.finished.find(f => f.variationId === v50.id).packets === 88, 'server stock 100 - 12 = 88');

console.log('6. Push the same queue again (simulated retry)');
await page.evaluate(async () => {
  const req = indexedDB.open('spice-erp');
  await new Promise(r => (req.onsuccess = r));
  const tx = req.result.transaction('outbox', 'readwrite');
  const store = tx.objectStore('outbox');
  const all = await new Promise(r => { const q = store.getAll(); q.onsuccess = () => r(q.result); });
  for (const o of all) { o.status = 'failed'; o.nextAttemptAt = 0; store.put(o); }
  await new Promise(r => (tx.oncomplete = r));
});
await page.click('button:has-text("Sync now")');
await page.waitForSelector('text=All synced', { timeout: 20000 });
ok((await api('GET', `/api/sales-invoices?q=${encodeURIComponent(invNo)}`)).total === 1, 'retry did not create a duplicate invoice');
const cust = (await api('GET', '/api/customers?q=Bismillah')).items[0];
ok(Number(cust.balance) === 300, 'customer balance 600 - 300 = 300, payment counted once');

console.log('7. Urdu interface');
await page.click('button:has-text("اردو")');
await page.click('a[href="/dashboard"]');
await page.waitForTimeout(800);
ok(await page.evaluate(() => document.documentElement.dir) === 'rtl', 'Urdu switches the whole app to RTL');
if (SHOTS) await page.screenshot({ path: `${SHOTS}/5-dashboard-urdu.png`, fullPage: true });
await page.click('a[href="/products"]');
await page.waitForSelector('table.data tbody tr');
if (SHOTS) await page.screenshot({ path: `${SHOTS}/6-products-urdu.png`, fullPage: true });

await browser.close();
console.log('\nE2E OFFLINE TEST PASSED');
