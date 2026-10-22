import Dexie, { Table } from 'dexie';

// ---------------------------------------------------------------- local record shapes
export interface Meta { key: string; value: any; }

export interface Product {
  id: string; categoryId?: string | null; code: string; name: string; nameUr?: string | null; spiceType?: string | null;
  brand?: string | null; barcode?: string | null; taxRate: number; imageUrl?: string | null; minStockGrams: number;
  trackExpiry: boolean; isActive: boolean; version: number;
}
export interface Variation {
  id: string; productId: string; sku: string; barcode?: string | null; packetGrams: number; retailPrice: number;
  wholesalePrice: number; dealerPrice?: number | null; minPrice?: number | null; minStockPackets: number; isActive: boolean; version: number;
}
export interface Customer {
  id: string; code: string; shopName: string; contactPerson?: string | null; phone?: string | null; whatsApp?: string | null;
  address?: string | null; area?: string | null; city?: string | null; customerType: string; salespersonId?: string | null;
  routeId?: string | null; creditLimit: number; paymentTermsDays: number; isActive: boolean; version: number; notes?: string | null;
  /** true while created/edited on this device and not yet confirmed */
  localOnly?: boolean;
}
export interface Lookup { id: string; name: string; nameUr?: string | null; kind?: string; isActive?: boolean; area?: string | null; fullName?: string; }

export type LocalStatus = 'local' | 'syncing' | 'synced' | 'failed' | 'conflict' | 'rejected';

export interface InvoiceLine {
  id: string; variationId: string; productId: string; description: string; descriptionUr?: string | null; packetGrams: number;
  quantity: number; unitPrice: number; discountAmount: number; taxAmount: number; lineTotal: number; returnedQty: number;
}
export interface Invoice {
  id: string; invoiceNo: string; invoiceDate: string; customerId: string; salespersonId?: string | null; status: string;
  paymentMethod: string; subTotal: number; discountAmount: number; taxAmount: number; total: number;
  previousBalance: number; amountPaid: number; balanceAfter: number; returnedAmount: number; deliveryStatus: string;
  notes?: string | null; openAmount?: number; lines: InvoiceLine[];
  /** 'server' = pulled from the server; otherwise the outbox status of the device copy */
  syncStatus: LocalStatus | 'server';
  serverMessage?: string | null; warnings?: string[];
}
export interface Receipt {
  id: string; receiptNo: string; customerId: string; invoiceId?: string | null; receiptDate: string; amount: number;
  method: string; reference?: string | null; syncStatus: LocalStatus | 'server';
}
export interface ExpenseRec {
  id: string; expenseNo: string; expenseDate: string; category: string; amount: number; notes?: string | null;
  deliveryId?: string | null; syncStatus: LocalStatus | 'server';
}
export interface DeliveryRec {
  id: string; deliveryNo: string; deliveryDate: string; status: string; vehicle?: string | null; routeName: string;
  stops: Array<{ id: string; seq: number; customerId: string; invoiceId?: string | null; status: string; expectedCollection: number;
    collectedAmount: number; lines: Array<{ id: string; variationId: string; loadedQty: number; deliveredQty: number; returnedQty: number }> | null;
    localUpdate?: boolean }>;
}

/**
 * Durable queue of business operations created on this device. Rows are only marked
 * 'synced' after the server confirms them; they are never deleted while unconfirmed.
 * `effects` describe the local stock / balance changes the operation made, so the
 * local view = last server snapshot + effects of operations the snapshot does not yet include.
 */
export interface OutboxOp {
  seq?: number;
  opId: string;
  type: 'invoice.create' | 'receipt.create' | 'expense.create' | 'customer.upsert' | 'return.create' | 'delivery.stop.update';
  entityId: string;
  label: string;
  payload: any;
  createdAt: string;
  status: LocalStatus;
  attempts: number;
  nextAttemptAt?: number;
  lastError?: string | null;
  syncedAt?: string | null;
  serverResult?: any;
  /** true once a server snapshot that contains this operation has been pulled */
  included?: boolean;
  effects: { stock?: Record<string, number>; balance?: Record<string, number>; cash?: number };
}

export interface StockSnap { variationId: string; packets: number; }
export interface BalanceSnap { customerId: string; balance: number; }

export class LocalDb extends Dexie {
  meta!: Table<Meta, string>;
  products!: Table<Product, string>;
  variations!: Table<Variation, string>;
  customers!: Table<Customer, string>;
  categories!: Table<Lookup, string>;
  routes!: Table<Lookup, string>;
  accounts!: Table<Lookup, string>;
  users!: Table<Lookup, string>;
  invoices!: Table<Invoice, string>;
  receipts!: Table<Receipt, string>;
  expenses!: Table<ExpenseRec, string>;
  deliveries!: Table<DeliveryRec, string>;
  stock!: Table<StockSnap, string>;
  balances!: Table<BalanceSnap, string>;
  outbox!: Table<OutboxOp, number>;

  constructor() {
    super('spice-erp');
    // Versioned schema: add a new this.version(n) block for every change; never edit old ones.
    this.version(1).stores({
      meta: 'key',
      products: 'id, code, name, barcode',
      variations: 'id, productId, sku, barcode',
      customers: 'id, code, shopName, phone, area, routeId',
      categories: 'id', routes: 'id', accounts: 'id', users: 'id',
      invoices: 'id, invoiceNo, invoiceDate, customerId, syncStatus',
      receipts: 'id, receiptNo, customerId, receiptDate, syncStatus',
      expenses: 'id, expenseDate, syncStatus',
      deliveries: 'id, deliveryDate, status',
      stock: 'variationId',
      balances: 'customerId',
      outbox: '++seq, &opId, status, type, entityId',
    });
  }
}

export const db = new LocalDb();

export async function getMeta<T = any>(key: string, fallback: T | null = null): Promise<T | null> {
  const row = await db.meta.get(key);
  return row ? (row.value as T) : fallback;
}
export async function setMeta(key: string, value: any) { await db.meta.put({ key, value }); }

export function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
