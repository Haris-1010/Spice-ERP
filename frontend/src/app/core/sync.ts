import { Injectable, signal } from '@angular/core';
import { Api, ApiError } from './api';
import { Auth } from './auth';
import { OutboxOp, db, getMeta, setMeta } from './db';
import { Store } from './store';

export type SyncState = 'idle' | 'syncing' | 'error' | 'offline' | 'expired';

const BATCH = 50;
const MAX_BACKOFF_MS = 10 * 60 * 1000;

/**
 * Client sync engine.
 *  push: outbox operations in creation order (dependency order), each with a stable opId used by
 *        the server as an idempotency key — retrying after a timeout can never duplicate a record.
 *        Failures back off exponentially; nothing is removed from the outbox until confirmed.
 *  pull: master data and authoritative stock / balance snapshots. After a pull, the effects of
 *        operations that were already confirmed are marked as "included" so they are not counted twice.
 */
@Injectable({ providedIn: 'root' })
export class Sync {
  readonly state = signal<SyncState>('idle');
  readonly pending = signal(0);
  readonly lastSync = signal<string | null>(null);
  readonly lastError = signal<string | null>(null);
  readonly openConflicts = signal(0);
  private running = false;
  private again = false;
  private timer: any;

  constructor(private api: Api, private auth: Auth, private store: Store) {}

  async start() {
    this.lastSync.set(await getMeta<string>('lastSync'));
    await this.refreshPending();
    // Operations interrupted mid-push (app closed while syncing) are retried; the server dedupes them.
    await db.outbox.where('status').equals('syncing').modify({ status: 'failed', nextAttemptAt: 0 });
    window.addEventListener('online', () => this.run());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.run(); });
    this.timer = setInterval(() => this.run(), 60_000);
    this.run();
  }

  async refreshPending() { this.pending.set(await this.store.pendingCount()); }

  /** Called after every local save. */
  kick() { this.refreshPending(); setTimeout(() => this.run(), 300); }

  async run(manual = false): Promise<void> {
    if (!this.auth.session()) return;
    if (this.running) { this.again = true; return; }
    if (this.auth.expired()) { this.state.set('expired'); return; }
    // No point waiting on requests that cannot succeed; the 'online' event restarts sync.
    if (!navigator.onLine) { this.state.set('offline'); await this.refreshPending(); return; }
    this.running = true;
    this.state.set('syncing');
    try {
      if (manual) await db.outbox.where('status').equals('failed').modify({ nextAttemptAt: 0 });
      await this.push();
      await this.pull();
      this.lastError.set(null);
      this.state.set('idle');
      const now = new Date().toISOString();
      await setMeta('lastSync', now);
      this.lastSync.set(now);
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 401) { this.auth.expired.set(true); this.state.set('expired'); }
      else if (e instanceof ApiError && e.isNetwork) this.state.set('offline');
      else { this.state.set('error'); this.lastError.set(e?.message ?? String(e)); }
      if (e instanceof ApiError && e.code === 'device_revoked') this.lastError.set(e.message);
    } finally {
      this.running = false;
      await this.refreshPending();
      this.store.touch();
      if (this.again) { this.again = false; setTimeout(() => this.run(), 500); }
    }
  }

  private async push() {
    const deviceId = await this.auth.deviceId();
    for (let round = 0; round < 100; round++) {
      const now = Date.now();
      const ops = (await db.outbox.where('status').anyOf(['local', 'failed']).sortBy('seq'))
        .filter(o => !o.nextAttemptAt || o.nextAttemptAt <= now).slice(0, BATCH);
      if (!ops.length) return;
      const seqs = ops.map(o => o.seq!);
      await db.outbox.where('seq').anyOf(seqs).modify({ status: 'syncing' });

      let results: any[];
      try {
        const r = await this.api.post<{ results: any[] }>('/api/sync/push', {
          deviceId, operations: ops.map(o => ({ opId: o.opId, type: o.type, payload: o.payload, createdAt: o.createdAt })),
        }, 45_000);
        results = r.results;
      } catch (e) {
        // Transient failure: the server may or may not have applied these. Retrying is safe (idempotent).
        await db.transaction('rw', db.outbox, async () => {
          for (const o of ops) {
            const attempts = o.attempts + 1;
            await db.outbox.update(o.seq!, {
              status: 'failed', attempts, lastError: (e as any)?.message ?? 'Network error',
              nextAttemptAt: Date.now() + Math.min(MAX_BACKOFF_MS, 5000 * 2 ** Math.min(attempts, 10)),
            });
          }
        });
        throw e;
      }
      await this.applyResults(ops, results);
    }
  }

  private async applyResults(ops: OutboxOp[], results: any[]) {
    const byId = new Map(results.map(r => [r.opId, r]));
    await db.transaction('rw', [db.outbox, db.invoices, db.receipts, db.expenses, db.customers], async () => {
      for (const o of ops) {
        const r = byId.get(o.opId);
        if (!r) { await db.outbox.update(o.seq!, { status: 'failed', lastError: 'No result returned', nextAttemptAt: Date.now() + 30000 }); continue; }
        const status = r.status === 'applied' ? 'synced' : r.status === 'conflict' ? 'conflict' : 'rejected';
        await db.outbox.update(o.seq!, { status, serverResult: r, lastError: r.message ?? null, syncedAt: new Date().toISOString() });
        const entityStatus = status;
        if (o.type === 'invoice.create') {
          const inv = await db.invoices.get(o.entityId);
          if (inv) {
            inv.syncStatus = entityStatus; inv.serverMessage = r.message ?? null; inv.warnings = r.warnings ?? [];
            const s = r.server;
            if (s && status === 'synced') Object.assign(inv, {
              total: s.total, subTotal: s.subTotal, discountAmount: s.discountAmount, taxAmount: s.taxAmount,
              previousBalance: s.previousBalance, amountPaid: s.amountPaid, balanceAfter: s.balanceAfter,
            });
            await db.invoices.put(inv);
          }
        } else if (o.type === 'receipt.create') await db.receipts.update(o.entityId, { syncStatus: entityStatus });
        else if (o.type === 'expense.create') await db.expenses.update(o.entityId, { syncStatus: entityStatus });
        else if (o.type === 'customer.upsert' && status === 'synced' && r.server) {
          await db.customers.update(o.entityId, { code: r.server.code, version: r.server.version, localOnly: false });
        }
      }
    });
  }

  private async pull() {
    const deviceId = await this.auth.deviceId();
    const since = await getMeta<string>('lastPull');
    // Operations confirmed before this pull started are contained in the snapshot it returns.
    const confirmed = (await db.outbox.where('status').equals('synced').toArray()).filter(o => !o.included).map(o => o.seq!);
    const d = await this.api.get<any>('/api/sync/pull', { deviceId, since: since ?? undefined });
    const pendingCustomerIds = new Set((await db.outbox.where('type').equals('customer.upsert').toArray())
      .filter(o => o.status === 'local' || o.status === 'syncing' || o.status === 'failed').map(o => o.entityId));
    const pendingInvoiceIds = new Set((await db.outbox.where('type').equals('invoice.create').toArray())
      .filter(o => o.status !== 'synced').map(o => o.entityId));

    await db.transaction('rw', [db.meta, db.products, db.variations, db.customers, db.categories, db.routes, db.accounts, db.users,
      db.stock, db.balances, db.invoices, db.deliveries, db.outbox], async () => {
      if (d.full) { await db.products.clear(); await db.variations.clear(); }
      await db.products.bulkPut(d.products.map(num));
      await db.variations.bulkPut(d.variations.map(num));
      await db.categories.bulkPut(d.categories);
      await db.routes.clear(); await db.routes.bulkPut(d.routes);
      await db.accounts.clear(); await db.accounts.bulkPut(d.accounts);
      await db.users.clear(); await db.users.bulkPut(d.users.map((u: any) => ({ ...u, name: u.fullName })));
      await db.customers.bulkPut(d.customers.filter((c: any) => !pendingCustomerIds.has(c.id)).map((c: any) => ({ ...num(c), localOnly: false })));

      await db.stock.clear();
      await db.stock.bulkPut(d.stock.finished.map((s: any) => ({ variationId: s.variationId, packets: Number(s.packets) })));
      await db.balances.clear();
      await db.balances.bulkPut(d.balances.map((b: any) => ({ customerId: b.customerId, balance: Number(b.balance) })));

      for (const i of d.invoices) {
        if (pendingInvoiceIds.has(i.id)) continue;
        const lines = JSON.parse(i.linesJson ?? '[]').map(num);
        delete i.linesJson;
        await db.invoices.put({ ...num(i), lines, syncStatus: 'server' });
      }
      await db.deliveries.clear();
      await db.deliveries.bulkPut(d.deliveries.map((x: any) => {
        const stops = JSON.parse(x.stopsJson ?? '[]').map((s: any) => ({ ...num(s), lines: (s.lines ?? []).map(num) }));
        delete x.stopsJson;
        return { ...x, stops };
      }));
      await db.outbox.where('seq').anyOf(confirmed).modify({ included: true });
      await db.meta.bulkPut([{ key: 'lastPull', value: d.serverTime }, { key: 'business', value: d.business }]);
    });
    this.openConflicts.set(d.openConflicts ?? 0);
  }
}

/** Dapper returns numerics as numbers already, but strings like "12.50" are normalised defensively. */
function num<T extends Record<string, any>>(o: T): T {
  const out: any = { ...o };
  for (const k of ['taxRate', 'retailPrice', 'wholesalePrice', 'dealerPrice', 'minPrice', 'creditLimit', 'total', 'subTotal', 'discountAmount',
    'taxAmount', 'previousBalance', 'amountPaid', 'balanceAfter', 'returnedAmount', 'openAmount', 'unitPrice', 'lineTotal',
    'expectedCollection', 'collectedAmount'])
    if (out[k] !== undefined && out[k] !== null) out[k] = Number(out[k]);
  return out;
}
