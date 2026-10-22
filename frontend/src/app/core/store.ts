import { Injectable, signal } from '@angular/core';
import { liveQuery } from 'dexie';
import { Auth } from './auth';
import { Customer, Invoice, InvoiceLine, OutboxOp, Variation, db, getMeta, uuid } from './db';
import { round2 } from './format';

/** Operations whose local effects are not yet part of the last server snapshot. */
export function counts(op: OutboxOp): boolean {
  if (op.included) return false;
  return op.status === 'local' || op.status === 'syncing' || op.status === 'failed' || op.status === 'synced';
}

export interface NewInvoiceLine { variationId: string; quantity: number; unitPrice: number; discountAmount: number; }
export interface NewInvoice {
  customerId: string; paymentMethod: string; amountPaid: number; requiresDelivery: boolean; notes?: string; salesOrderId?: string | null; lines: NewInvoiceLine[];
}

/**
 * Local operational view and local business operations.
 *
 * Every operation is written in ONE IndexedDB transaction together with its outbox entry and
 * the device number counter — either everything is saved or nothing is. Nothing is reported
 * as saved before that transaction commits.
 */
@Injectable({ providedIn: 'root' })
export class Store {
  /** bumps whenever local data changes, so views can recompute */
  readonly version = signal(0);

  constructor(private auth: Auth) {
    liveQuery(() => Promise.all([db.outbox.count(), db.stock.count(), db.balances.count(), db.invoices.count(), db.customers.count(), db.products.count()]))
      .subscribe(() => this.version.update(v => v + 1));
  }

  touch() { this.version.update(v => v + 1); }

  // ------------------------------------------------------------ views (snapshot + pending effects)
  async pendingEffects() {
    const ops = (await db.outbox.toArray()).filter(counts);
    const stock: Record<string, number> = {}; const balance: Record<string, number> = {};
    for (const op of ops) {
      for (const [k, v] of Object.entries(op.effects.stock ?? {})) stock[k] = (stock[k] ?? 0) + v;
      for (const [k, v] of Object.entries(op.effects.balance ?? {})) balance[k] = (balance[k] ?? 0) + v;
    }
    return { stock, balance };
  }

  async stockMap(): Promise<Record<string, number>> {
    const snap = await db.stock.toArray();
    const { stock } = await this.pendingEffects();
    const m: Record<string, number> = {};
    snap.forEach(s => (m[s.variationId] = s.packets));
    for (const [k, v] of Object.entries(stock)) m[k] = (m[k] ?? 0) + v;
    return m;
  }

  async balanceOf(customerId: string): Promise<number> {
    const snap = await db.balances.get(customerId);
    const { balance } = await this.pendingEffects();
    return round2((snap?.balance ?? 0) + (balance[customerId] ?? 0));
  }

  async balanceMap(): Promise<Record<string, number>> {
    const m: Record<string, number> = {};
    (await db.balances.toArray()).forEach(b => (m[b.customerId] = b.balance));
    const { balance } = await this.pendingEffects();
    for (const [k, v] of Object.entries(balance)) m[k] = round2((m[k] ?? 0) + v);
    return m;
  }

  static priceFor(v: Variation, customerType: string): number {
    if (customerType === 'WHOLESALER') return v.wholesalePrice;
    if (customerType === 'DISTRIBUTOR') return v.dealerPrice ?? v.wholesalePrice;
    return v.retailPrice;
  }

  // ------------------------------------------------------------ numbering
  /** Next device document number, e.g. INV-D03-00017. Must run inside the caller's transaction. */
  private async nextNumber(doc: 'INV' | 'RC' | 'EXP' | 'RET'): Promise<string> {
    const prefix = this.auth.session()?.device.prefix;
    if (!prefix) throw new Error('This device is not registered. Sign in online once.');
    const key = `counter:${doc}`;
    const row = await db.meta.get(key);
    const n = (row?.value ?? 0) + 1;
    await db.meta.put({ key, value: n });
    return `${doc}-${prefix}-${String(n).padStart(5, '0')}`;
  }

  private op(type: OutboxOp['type'], entityId: string, label: string, payload: any, effects: OutboxOp['effects']): OutboxOp {
    return { opId: uuid(), type, entityId, label, payload, createdAt: new Date().toISOString(), status: 'local', attempts: 0, effects };
  }

  // ------------------------------------------------------------ invoice
  async createInvoice(input: NewInvoice): Promise<Invoice> {
    if (!input.lines.length) throw new Error('Add at least one item.');
    if (input.lines.some(l => !(l.quantity > 0) || l.unitPrice < 0 || l.discountAmount < 0)) throw new Error('Check quantities and prices.');
    if (input.amountPaid < 0) throw new Error('Amount paid cannot be negative.');
    const userId = this.auth.user()?.id;

    return db.transaction('rw', [db.invoices, db.outbox, db.meta, db.customers, db.variations, db.products, db.balances], async () => {
      const customer = await db.customers.get(input.customerId);
      if (!customer) throw new Error('Customer not found on this device.');
      const lines: InvoiceLine[] = [];
      for (const l of input.lines) {
        const v = await db.variations.get(l.variationId);
        const p = v ? await db.products.get(v.productId) : undefined;
        if (!v || !p) throw new Error('A product is missing on this device. Sync and try again.');
        const gross = round2(l.quantity * l.unitPrice);
        const disc = Math.min(round2(l.discountAmount), gross);
        const tax = round2((gross - disc) * (p.taxRate ?? 0) / 100);
        lines.push({
          id: uuid(), variationId: v.id, productId: p.id, description: `${p.name} ${v.packetGrams} g`,
          descriptionUr: p.nameUr ? `${p.nameUr} ${v.packetGrams} گرام` : null, packetGrams: v.packetGrams,
          quantity: l.quantity, unitPrice: round2(l.unitPrice), discountAmount: disc, taxAmount: tax, lineTotal: round2(gross - disc + tax), returnedQty: 0,
        });
      }
      const subTotal = round2(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0));
      const discountAmount = round2(lines.reduce((s, l) => s + l.discountAmount, 0));
      const taxAmount = round2(lines.reduce((s, l) => s + l.taxAmount, 0));
      const total = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
      const previousBalance = await this.balanceOf(customer.id);
      const amountPaid = round2(input.amountPaid);
      const id = uuid();
      const invoiceNo = await this.nextNumber('INV');
      const now = new Date().toISOString();

      const inv: Invoice = {
        id, invoiceNo, invoiceDate: now, customerId: customer.id, salespersonId: userId, status: 'POSTED',
        paymentMethod: input.paymentMethod, subTotal, discountAmount, taxAmount, total, previousBalance, amountPaid,
        balanceAfter: round2(previousBalance + total - amountPaid), returnedAmount: 0,
        deliveryStatus: input.requiresDelivery ? 'PENDING' : 'NOT_REQUIRED', notes: input.notes ?? null, lines, syncStatus: 'local',
      };
      const stock: Record<string, number> = {};
      lines.forEach(l => (stock[l.variationId] = (stock[l.variationId] ?? 0) - l.quantity));

      await db.invoices.add(inv);
      await db.outbox.add(this.op('invoice.create', id, invoiceNo, {
        id, invoiceNo, invoiceDate: now, customerId: customer.id, paymentMethod: input.paymentMethod, amountPaid,
        paymentReceiptId: amountPaid > 0 ? uuid() : null, requiresDelivery: input.requiresDelivery, notes: input.notes ?? null, salesOrderId: input.salesOrderId ?? null,
        lines: lines.map(l => ({ id: l.id, variationId: l.variationId, quantity: l.quantity, unitPrice: l.unitPrice, discountAmount: l.discountAmount })),
      }, { stock, balance: { [customer.id]: round2(total - amountPaid) } }));
      return inv;
    });
  }

  // ------------------------------------------------------------ receipt
  async createReceipt(customerId: string, amount: number, method: string, invoiceId?: string | null, reference?: string) {
    if (!(amount > 0)) throw new Error('Amount must be greater than zero.');
    return db.transaction('rw', [db.receipts, db.outbox, db.meta, db.customers], async () => {
      if (!(await db.customers.get(customerId))) throw new Error('Customer not found on this device.');
      const id = uuid(); const receiptNo = await this.nextNumber('RC'); const now = new Date().toISOString();
      await db.receipts.add({ id, receiptNo, customerId, invoiceId: invoiceId ?? null, receiptDate: now, amount: round2(amount), method, reference, syncStatus: 'local' });
      await db.outbox.add(this.op('receipt.create', id, receiptNo,
        { id, receiptNo, customerId, invoiceId: invoiceId ?? null, receiptDate: now, amount: round2(amount), method, reference: reference ?? null },
        { balance: { [customerId]: -round2(amount) } }));
      return { id, receiptNo };
    });
  }

  // ------------------------------------------------------------ expense
  async createExpense(category: string, amount: number, method: string, notes?: string, deliveryId?: string | null, attachmentUrl?: string | null) {
    if (!(amount > 0)) throw new Error('Amount must be greater than zero.');
    return db.transaction('rw', [db.expenses, db.outbox, db.meta], async () => {
      const id = uuid(); const expenseNo = await this.nextNumber('EXP'); const now = new Date().toISOString();
      await db.expenses.add({ id, expenseNo, expenseDate: now, category, amount: round2(amount), notes, deliveryId: deliveryId ?? null, syncStatus: 'local' });
      await db.outbox.add(this.op('expense.create', id, expenseNo,
        { id, expenseNo, expenseDate: now, category, amount: round2(amount), method, notes: notes ?? null, deliveryId: deliveryId ?? null, attachmentUrl: attachmentUrl ?? null },
        { cash: -round2(amount) }));
      return { id, expenseNo };
    });
  }

  // ------------------------------------------------------------ customer
  async saveCustomer(c: Partial<Customer> & { shopName: string }, openingBalance = 0) {
    return db.transaction('rw', [db.customers, db.outbox], async () => {
      const existing = c.id ? await db.customers.get(c.id) : undefined;
      const id = existing?.id ?? uuid();
      const rec: Customer = {
        ...(existing ?? { code: '(new)', version: 0, isActive: true, creditLimit: 0, paymentTermsDays: 0, customerType: 'RETAILER' }),
        ...c, id, localOnly: true,
      } as Customer;
      await db.customers.put(rec);
      await db.outbox.add(this.op('customer.upsert', id, rec.shopName, {
        id, baseVersion: existing && existing.version > 0 ? existing.version : null, code: existing?.code === '(new)' ? null : existing?.code ?? null,
        shopName: rec.shopName, contactPerson: rec.contactPerson ?? null, phone: rec.phone ?? null, whatsApp: rec.whatsApp ?? null,
        address: rec.address ?? null, area: rec.area ?? null, city: rec.city ?? null, customerType: rec.customerType,
        salespersonId: rec.salespersonId ?? null, routeId: rec.routeId ?? null, creditLimit: rec.creditLimit ?? 0,
        paymentTermsDays: rec.paymentTermsDays ?? 0, openingBalance: existing ? 0 : openingBalance, notes: rec.notes ?? null, isActive: rec.isActive,
      }, existing ? {} : { balance: { [id]: round2(openingBalance) } }));
      return rec;
    });
  }

  // ------------------------------------------------------------ sales return
  async createReturn(invoice: Invoice, lines: { invoiceLineId: string; quantity: number; condition: string }[], settlement: string, reason: string) {
    const picked = lines.filter(l => l.quantity > 0);
    if (!picked.length) throw new Error('Enter a quantity for at least one item.');
    return db.transaction('rw', [db.invoices, db.outbox, db.meta], async () => {
      const inv = await db.invoices.get(invoice.id);
      if (!inv) throw new Error('Invoice not found on this device.');
      const stock: Record<string, number> = {}; let value = 0;
      for (const r of picked) {
        const line = inv.lines.find(l => l.id === r.invoiceLineId)!;
        const already = line.returnedQty + picked.filter(p => p.invoiceLineId === line.id && p !== r).reduce((s, p) => s + p.quantity, 0);
        if (r.quantity + already > line.quantity) throw new Error(`${line.description}: only ${line.quantity - line.returnedQty} can be returned.`);
        value += round2(line.lineTotal / line.quantity * r.quantity);
        if (r.condition === 'GOOD') stock[line.variationId] = (stock[line.variationId] ?? 0) + r.quantity;
      }
      picked.forEach(r => { inv.lines.find(l => l.id === r.invoiceLineId)!.returnedQty += r.quantity; });
      inv.returnedAmount = round2(inv.returnedAmount + value);
      await db.invoices.put(inv);
      const id = uuid(); const returnNo = await this.nextNumber('RET');
      const balanceDelta = settlement === 'CASH_REFUND' ? 0 : -round2(value);
      await db.outbox.add(this.op('return.create', id, `${returnNo} (${inv.invoiceNo})`,
        { id, returnNo, invoiceId: inv.id, returnDate: new Date().toISOString(), settlement, reason, lines: picked },
        { stock, balance: { [inv.customerId]: balanceDelta } }));
      return { id, returnNo, value: round2(value) };
    });
  }

  // ------------------------------------------------------------ delivery stop
  async updateStop(deliveryId: string, stopId: string, status: string, delivered: Record<string, number>, collected: number,
                   method: string, failReason: string, acknowledgedBy: string, notes: string, nextVisitDate: string | null) {
    return db.transaction('rw', [db.deliveries, db.outbox, db.meta, db.invoices], async () => {
      const d = await db.deliveries.get(deliveryId);
      const stop = d?.stops.find(s => s.id === stopId);
      if (!d || !stop) throw new Error('Delivery stop not found on this device.');
      if (stop.status !== 'PENDING' || stop.localUpdate) throw new Error('This stop has already been recorded.');
      const inv = stop.invoiceId ? await db.invoices.get(stop.invoiceId) : undefined;
      const stock: Record<string, number> = {}; let returnValue = 0;
      const lineInputs: { lineId: string; deliveredQty: number }[] = [];
      for (const l of stop.lines ?? []) {
        const q = status === 'DELIVERED' ? l.loadedQty : status === 'FAILED' ? 0 : Math.max(0, Math.min(l.loadedQty, delivered[l.id] ?? 0));
        l.deliveredQty = q; l.returnedQty = l.loadedQty - q;
        lineInputs.push({ lineId: l.id, deliveredQty: q });
        if (l.returnedQty > 0) {
          stock[l.variationId] = (stock[l.variationId] ?? 0) + l.returnedQty;
          const il = inv?.lines.find(x => x.variationId === l.variationId);
          if (il) returnValue += round2(il.lineTotal / il.quantity * l.returnedQty);
        }
      }
      const hasReturn = Object.keys(stock).length > 0 && !!stop.invoiceId;
      const receiptNo = collected > 0 ? await this.nextNumber('RC') : null;
      const returnNo = hasReturn ? await this.nextNumber('RET') : null;
      stop.status = status; stop.collectedAmount = round2(collected); stop.localUpdate = true;
      await db.deliveries.put(d);
      if (inv) { inv.deliveryStatus = status; await db.invoices.put(inv); }
      await db.outbox.add(this.op('delivery.stop.update', stopId, `${d.deliveryNo} #${stop.seq}`, {
        stopId, status, lines: lineInputs, failReason: failReason || null, collectedAmount: round2(collected), collectionMethod: method,
        receiptId: collected > 0 ? uuid() : null, receiptNo, returnId: hasReturn ? uuid() : null, returnNo,
        acknowledgedBy: acknowledgedBy || null, notes: notes || null, nextVisitDate: nextVisitDate || null, visitedAt: new Date().toISOString(),
      }, { stock: hasReturn ? stock : {}, balance: { [stop.customerId]: -round2(collected) - (hasReturn ? round2(returnValue) : 0) } }));
    });
  }

  async pendingCount() { return db.outbox.where('status').anyOf(['local', 'syncing', 'failed']).count(); }
  async lastSync() { return getMeta<string>('lastSync'); }
}
