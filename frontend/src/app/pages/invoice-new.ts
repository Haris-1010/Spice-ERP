import { Component, HostListener, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { Customer, Product, Variation, db } from '../core/db';
import { MoneyPipe, round2 } from '../core/format';
import { I18n, TPipe } from '../core/i18n';
import { Store } from '../core/store';
import { Sync } from '../core/sync';
import { SHARED, Toast, errorText } from '../shared/ui';

interface Line { variation: Variation; product: Product; quantity: number; unitPrice: number; discountAmount: number; listPrice: number; }
interface Option { v: Variation; p: Product; stock: number; label: string; }

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink, MoneyPipe, ...SHARED],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>{{ 'newInvoice' | t }}</h1>
      <span class="small muted">{{ 'keyboardHint' | t }}</span>
      <a class="btn" routerLink="/sales">{{ 'cancel' | t }}</a>
    </div>

    <div class="grid layout">
      <div class="stack">
        <!-- customer -->
        <div class="card card-body stack">
          <div class="field">
            <label>{{ 'customer' | t }}</label>
            @if (customer(); as c) {
              <div class="row cust">
                <div class="grow">
                  <strong>{{ c.shopName }}</strong>&nbsp; <span class="muted small">{{ c.code }}</span>
                  <div class="small muted">{{ c.area }} {{ c.phone ? '· ' + c.phone : '' }} · {{ c.customerType | t }}</div>
                </div>
                <div class="right">
                  <div class="small muted">{{ 'previousBalance' | t }}</div>
                  <strong class="num">{{ prevBalance() | money }}</strong>
                </div>
                <button class="btn sm" (click)="clearCustomer()">{{ 'edit' | t }}</button>
              </div>
            } @else {
              <input #cs [(ngModel)]="custQuery" (ngModelChange)="searchCustomers()" [placeholder]="'searchPlaceholder' | t" autofocus
                     (keydown.enter)="custResults()[0] && chooseCustomer(custResults()[0])" />
              @if (custResults().length) {
                <div class="dropdown">
                  @for (c of custResults(); track c.id) {
                    <button type="button" (click)="chooseCustomer(c)"><strong>{{ c.shopName }}</strong> <span class="muted small">{{ c.code }} · {{ c.area }} · {{ c.phone }}</span></button>
                  }
                </div>
              }
              <a class="small" routerLink="/customers" [queryParams]="{ new: 1 }">+ {{ 'newCustomer' | t }}</a>
            }
          </div>
        </div>

        <!-- items -->
        <div class="card">
          <div class="card-head"><h2>{{ 'item' | t }}</h2></div>
          <div class="card-body stack">
            <div class="field" style="position:relative">
              <input #ps [(ngModel)]="itemQuery" (ngModelChange)="searchItems()" [placeholder]="'scanBarcode' | t"
                     (keydown.enter)="$event.preventDefault(); addFirst()" (keydown.arrowDown)="hi = Math.min(hi + 1, itemResults().length - 1)"
                     (keydown.arrowUp)="hi = Math.max(hi - 1, 0)" [disabled]="!customer()" />
              @if (itemResults().length) {
                <div class="dropdown">
                  @for (o of itemResults(); track o.v.id; let i = $index) {
                    <button type="button" [class.hi]="i === hi" (click)="add(o)">
                      <app-thumb [src]="o.p.imageUrl" [name]="o.p.name" />
                      <span class="grow">{{ o.label }} <span class="muted small">{{ o.v.sku }}</span></span>
                      <span class="small" [class.bad]="o.stock <= 0">{{ 'inStock' | t }}: {{ o.stock }}</span>
                      <strong class="num">{{ priceOf(o.v) | money }}</strong>
                    </button>
                  }
                </div>
              }
            </div>
            <div class="table-wrap">
              <table class="data">
                <thead><tr><th></th><th>{{ 'item' | t }}</th><th class="num">{{ 'qty' | t }}</th><th class="num">{{ 'rate' | t }}</th>
                  <th class="num">{{ 'discount' | t }}</th><th class="num">{{ 'lineTotal' | t }}</th><th></th></tr></thead>
                <tbody>
                  @for (l of lines(); track l.variation.id; let i = $index) {
                    <tr>
                      <td><app-thumb [src]="l.product.imageUrl" [name]="l.product.name" /></td>
                      <td>
                        {{ i18n.pick(l.product.name, l.product.nameUr) }} {{ l.variation.packetGrams }} {{ 'grams' | t }}
                        @if (stockWarn(l); as w) { <div class="small" style="color:var(--warn)">{{ w }}</div> }
                        @if (l.unitPrice < l.listPrice) { <div class="small muted">{{ 'belowList' | t }} ({{ l.listPrice | money }})</div> }
                      </td>
                      <td class="num" style="width:90px"><input type="number" min="1" step="1" [(ngModel)]="l.quantity" (ngModelChange)="touch()" class="num" /></td>
                      <td class="num" style="width:110px"><input type="number" min="0" step="0.5" [(ngModel)]="l.unitPrice" (ngModelChange)="touch()" [readonly]="!canDiscount" class="num" /></td>
                      <td class="num" style="width:100px"><input type="number" min="0" step="1" [(ngModel)]="l.discountAmount" (ngModelChange)="touch()" [readonly]="!canDiscount" class="num" /></td>
                      <td class="num nowrap">{{ lineTotal(l) | money }}</td>
                      <td><button class="btn sm ghost" (click)="remove(i)" [attr.aria-label]="'remove' | t">✕</button></td>
                    </tr>
                  } @empty {
                    <tr><td colspan="7" class="empty">{{ customer() ? ('scanBarcode' | t) : ('selectCustomer' | t) }}</td></tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- totals -->
      <div class="card card-body stack totals">
        <div class="trow"><span>{{ 'subTotal' | t }}</span><span class="num">{{ totals().subTotal | money }}</span></div>
        @if (totals().discount) { <div class="trow"><span>{{ 'discount' | t }}</span><span class="num">-{{ totals().discount | money }}</span></div> }
        @if (totals().tax) { <div class="trow"><span>{{ 'tax' | t }}</span><span class="num">{{ totals().tax | money }}</span></div> }
        <div class="trow big"><span>{{ 'grandTotal' | t }}</span><span class="num">{{ totals().total | money }}</span></div>
        <div class="trow"><span>{{ 'previousBalance' | t }}</span><span class="num">{{ prevBalance() | money }}</span></div>
        <div class="field">
          <label>{{ 'paymentMethod' | t }}</label>
          <select [(ngModel)]="paymentMethod" (ngModelChange)="methodChanged()">
            @for (m of ['CASH','CREDIT','BANK','WALLET']; track m) { <option [value]="m">{{ m | t }}</option> }
          </select>
        </div>
        <div class="field">
          <label>{{ 'paymentReceived' | t }}</label>
          <input type="number" min="0" [(ngModel)]="amountPaid" (ngModelChange)="touch()" class="num" />
          @if (paymentMethod !== 'CREDIT') { <button class="btn sm ghost" style="align-self:flex-start" (click)="amountPaid = totals().total">= {{ 'grandTotal' | t }}</button> }
        </div>
        <div class="trow big"><span>{{ 'remainingBalance' | t }}</span><span class="num">{{ remaining() | money }}</span></div>
        @if (creditExceeded()) { <div class="alert warn">{{ 'creditWarning' | t: (remaining() | money) : (customer()!.creditLimit | money) }}</div> }
        <label class="check"><input type="checkbox" [(ngModel)]="requiresDelivery" /> {{ 'requiresDelivery' | t }}</label>
        <div class="field"><label>{{ 'notes' | t }}</label><textarea rows="2" [(ngModel)]="notes"></textarea></div>
        @if (error()) { <div class="alert bad">{{ error() }}</div> }
        <button class="btn primary lg" (click)="save(true)" [disabled]="!canSave() || busy()">{{ 'saveAndPrint' | t }}</button>
        <button class="btn" (click)="save(false)" [disabled]="!canSave() || busy()">{{ 'saveInvoice' | t }}</button>
        <p class="small muted" style="margin:0">{{ 'localNotice' | t }}</p>
      </div>
    </div>
  </div>`,
  styles: [`
    .layout { grid-template-columns: minmax(0, 1fr) 340px; align-items: start; }
    @media (max-width: 1000px) { .layout { grid-template-columns: minmax(0, 1fr); } }
    .dropdown { position: absolute; z-index: 30; inset-inline: 0; top: 100%; background: #fff; border: 1px solid var(--border-strong); border-radius: 8px; box-shadow: var(--shadow); max-height: 340px; overflow-y: auto; margin-top: 4px; }
    .field { position: relative; }
    .dropdown button { display: flex; align-items: center; gap: 10px; width: 100%; text-align: start; padding: 8px 12px; border: none; background: none; font: inherit; cursor: pointer; border-bottom: 1px solid var(--border); }
    .dropdown button:hover, .dropdown button.hi { background: var(--navy-50); }
    .bad { color: var(--bad); }
    .cust { padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--navy-50); }
    .totals { position: sticky; top: 72px; }
    .trow { display: flex; justify-content: space-between; gap: 8px; }
    .trow.big { font-size: 17px; font-weight: 700; color: var(--navy-900); border-top: 1px solid var(--border); padding-top: 8px; }
  `],
})
export class InvoiceNewPage implements OnInit, OnDestroy {
  Math = Math;
  customer = signal<Customer | null>(null);
  prevBalance = signal(0);
  lines = signal<Line[]>([]);
  custQuery = ''; itemQuery = ''; hi = 0;
  custResults = signal<Customer[]>([]);
  itemResults = signal<Option[]>([]);
  paymentMethod = 'CASH'; amountPaid = 0; requiresDelivery = false; notes = '';
  busy = signal(false); error = signal<string | null>(null);
  private options: Option[] = [];
  private stock: Record<string, number> = {};
  private tick = signal(0);
  canDiscount = false;
  private orderId: string | null = null;

  totals = computed(() => {
    this.tick();
    let subTotal = 0, discount = 0, tax = 0, total = 0;
    for (const l of this.lines()) {
      const gross = round2((l.quantity || 0) * (l.unitPrice || 0));
      const d = Math.min(round2(l.discountAmount || 0), gross);
      const t = round2((gross - d) * (l.product.taxRate || 0) / 100);
      subTotal += gross; discount += d; tax += t; total += gross - d + t;
    }
    return { subTotal: round2(subTotal), discount: round2(discount), tax: round2(tax), total: round2(total) };
  });
  remaining = computed(() => { this.tick(); return round2(this.prevBalance() + this.totals().total - (Number(this.amountPaid) || 0)); });
  creditExceeded = computed(() => { const c = this.customer(); return !!c && c.creditLimit > 0 && this.remaining() > c.creditLimit; });
  canSave = computed(() => { this.tick(); return !!this.customer() && this.lines().length > 0 && this.lines().every(l => l.quantity > 0 && l.unitPrice >= 0); });

  constructor(public i18n: I18n, private store: Store, private sync: Sync, private auth: Auth, private toast: Toast,
              private router: Router, private route: ActivatedRoute, private api: Api) {}

  async ngOnInit() {
    this.canDiscount = this.auth.can('sales.discount');
    const [products, variations] = await Promise.all([db.products.toArray(), db.variations.toArray()]);
    this.stock = await this.store.stockMap();
    const pmap = new Map(products.map(p => [p.id, p]));
    this.options = variations.filter(v => v.isActive && pmap.get(v.productId)?.isActive)
      .map(v => { const p = pmap.get(v.productId)!; return { v, p, stock: this.stock[v.id] ?? 0, label: `${this.i18n.pick(p.name, p.nameUr)} ${v.packetGrams} ${this.i18n.t('grams')}` }; })
      .sort((a, b) => a.label.localeCompare(b.label) || a.v.packetGrams - b.v.packetGrams);

    const q = this.route.snapshot.queryParamMap;
    if (q.get('customer')) { const c = await db.customers.get(q.get('customer')!); if (c) await this.chooseCustomer(c); }
    if (q.get('order') && this.api.online()) {
      try {
        const orders: any[] = await this.api.get('/api/sales-orders');
        const o = orders.find(x => x.id === q.get('order'));
        if (o) {
          const c = await db.customers.get(o.customerId); if (c) await this.chooseCustomer(c);
          for (const l of o.lines) { const opt = this.options.find(x => x.v.id === l.variationId); if (opt) { this.add(opt); this.lines().at(-1)!.quantity = l.quantity; } }
          this.orderId = o.id; this.notes = `Order ${o.orderNo}`; this.touch();
        }
      } catch { /* order conversion is optional */ }
    }
  }

  ngOnDestroy() {}

  @HostListener('window:beforeunload', ['$event'])
  beforeUnload(e: BeforeUnloadEvent) { if (this.lines().length) { e.preventDefault(); e.returnValue = ''; } }

  @HostListener('document:keydown', ['$event'])
  keys(e: KeyboardEvent) { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (this.canSave()) this.save(false); } }

  touch() { this.tick.update(x => x + 1); }

  async searchCustomers() {
    const q = this.custQuery.trim().toLowerCase();
    if (!q) { this.custResults.set([]); return; }
    const all = await db.customers.filter(c => c.isActive && (c.shopName.toLowerCase().includes(q) || (c.code ?? '').toLowerCase().includes(q)
      || (c.phone ?? '').includes(q) || (c.area ?? '').toLowerCase().includes(q) || (c.contactPerson ?? '').toLowerCase().includes(q))).limit(12).toArray();
    this.custResults.set(all);
  }

  async chooseCustomer(c: Customer) {
    this.customer.set(c);
    this.prevBalance.set(await this.store.balanceOf(c.id));
    this.custResults.set([]); this.custQuery = '';
    this.lines.update(ls => ls.map(l => ({ ...l, listPrice: Store.priceFor(l.variation, c.customerType), unitPrice: Store.priceFor(l.variation, c.customerType) })));
    setTimeout(() => (document.querySelector('input[placeholder]:not([disabled])') as HTMLInputElement | null)?.focus());
  }

  clearCustomer() { this.customer.set(null); this.prevBalance.set(0); }

  priceOf(v: Variation) { return Store.priceFor(v, this.customer()?.customerType ?? 'RETAILER'); }

  searchItems() {
    const q = this.itemQuery.trim().toLowerCase();
    this.hi = 0;
    if (!q) { this.itemResults.set([]); return; }
    const exact = this.options.filter(o => o.v.barcode === q || o.v.sku.toLowerCase() === q || o.p.barcode === q);
    if (exact.length === 1 && (exact[0].v.barcode === q || exact[0].v.sku.toLowerCase() === q)) { this.add(exact[0]); return; }
    const terms = q.split(/\s+/);
    this.itemResults.set(this.options.filter(o => {
      const hay = `${o.p.name} ${o.p.nameUr ?? ''} ${o.v.sku} ${o.p.code} ${o.v.packetGrams}g ${o.v.packetGrams}`.toLowerCase();
      return terms.every(t => hay.includes(t));
    }).slice(0, 15));
  }

  addFirst() { const r = this.itemResults(); if (r.length) this.add(r[Math.min(this.hi, r.length - 1)]); }

  add(o: Option) {
    const existing = this.lines().find(l => l.variation.id === o.v.id);
    if (existing) existing.quantity += 1;
    else {
      const price = this.priceOf(o.v);
      this.lines.update(ls => [...ls, { variation: o.v, product: o.p, quantity: 1, unitPrice: price, listPrice: price, discountAmount: 0 }]);
    }
    this.itemQuery = ''; this.itemResults.set([]); this.touch();
  }

  remove(i: number) { this.lines.update(ls => ls.filter((_, j) => j !== i)); }

  lineTotal(l: Line) {
    const gross = round2((l.quantity || 0) * (l.unitPrice || 0));
    const d = Math.min(l.discountAmount || 0, gross);
    return round2(gross - d + round2((gross - d) * (l.product.taxRate || 0) / 100));
  }

  stockWarn(l: Line): string | null {
    const s = this.stock[l.variation.id] ?? 0;
    return l.quantity > s ? this.i18n.t('stockShort', s) : null;
  }

  methodChanged() { if (this.paymentMethod === 'CREDIT') this.amountPaid = 0; this.touch(); }

  async save(print: boolean) {
    if (!this.canSave() || this.busy()) return;
    this.busy.set(true); this.error.set(null);
    try {
      const inv = await this.store.createInvoice({
        customerId: this.customer()!.id, paymentMethod: this.paymentMethod, amountPaid: Number(this.amountPaid) || 0,
        requiresDelivery: this.requiresDelivery, notes: this.notes.trim() || undefined, salesOrderId: this.orderId,
        lines: this.lines().map(l => ({ variationId: l.variation.id, quantity: Math.round(l.quantity), unitPrice: Number(l.unitPrice), discountAmount: Number(l.discountAmount) || 0 })),
      });
      // Only now — after the IndexedDB transaction committed — is the invoice reported as saved.
      this.toast.ok(this.i18n.t('invoiceSaved', inv.invoiceNo));
      this.lines.set([]);
      this.sync.kick();
      this.router.navigate(['/sales', inv.id], { queryParams: print ? { print: 1 } : {} });
    } catch (e) { this.error.set(errorText(e)); }
    finally { this.busy.set(false); }
  }
}
