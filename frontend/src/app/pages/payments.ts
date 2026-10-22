import { Component, OnInit, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { Customer, Invoice, Receipt, db, getMeta } from '../core/db';
import { MoneyPipe, PkDatePipe, downloadText, toCsv } from '../core/format';
import { I18n, TPipe } from '../core/i18n';
import { Store } from '../core/store';
import { Sync } from '../core/sync';
import { printArea } from '../shared/invoice-doc';
import { Dialog, SHARED, Toast } from '../shared/ui';

@Component({
  standalone: true,
  imports: [FormsModule, MoneyPipe, PkDatePipe, ...SHARED],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>{{ 'payments' | t }}</h1>
      <button class="btn primary" (click)="openNew()">+ {{ 'newReceipt' | t }}</button>
    </div>
    <div class="tabs">
      <button [class.active]="tab() === 'r'" (click)="tab.set('r')">{{ 'customerReceipts' | t }}</button>
      @if (auth.can('reports.financial')) { <button [class.active]="tab() === 'a'" (click)="tab.set('a'); loadAging()">{{ 'aging' | t }}</button> }
      @if (auth.can('payments.manage')) { <button [class.active]="tab() === 's'" (click)="tab.set('s'); loadSupplierPayments()">{{ 'supplierPayments' | t }}</button> }
    </div>

    @if (tab() === 'r') {
      <div class="card table-wrap">
        <table class="data">
          <thead><tr><th>{{ 'receiptNo' | t }}</th><th>{{ 'date' | t }}</th><th>{{ 'customer' | t }}</th><th>{{ 'method' | t }}</th><th>{{ 'reference' | t }}</th><th class="num">{{ 'amount' | t }}</th><th>{{ 'status' | t }}</th><th></th></tr></thead>
          <tbody>
            @for (r of receipts(); track r.id) {
              <tr><td class="ltr"><strong>{{ r.receiptNo }}</strong></td><td class="nowrap">{{ r.receiptDate | pkdate: true }}</td><td>{{ names()[r.customerId] ?? r.customer }}</td>
                <td>{{ r.method | t }}</td><td>{{ r.reference }}</td><td class="num">{{ r.amount | money }}</td>
                <td>@if (r.status === 'CANCELLED') { <span class="badge bad">{{ 'CANCELLED' | t }}</span> } @else { <app-sync-badge [status]="r.syncStatus" /> }</td>
                <td class="right nowrap"><button class="btn sm" (click)="printReceipt(r)">{{ 'printReceipt' | t }}</button>
                  @if (auth.can('payments.manage') && r.syncStatus === 'server' && r.status !== 'CANCELLED') { <button class="btn sm danger" (click)="cancelReceipt(r)">{{ 'cancel' | t }}</button> }</td></tr>
            } @empty { <tr><td colspan="8" class="empty">{{ 'noData' | t }}</td></tr> }
          </tbody>
        </table>
      </div>
    }

    @if (tab() === 'a') {
      <div class="card">
        <div class="card-head"><h2>{{ 'aging' | t }}</h2><button class="btn sm" (click)="exportAging()">{{ 'export' | t }}</button></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>{{ 'customer' | t }}</th><th>{{ 'area' | t }}</th><th class="num">{{ 'd0_30' | t }}</th><th class="num">{{ 'd31_60' | t }}</th><th class="num">{{ 'd61_90' | t }}</th><th class="num">{{ 'd90plus' | t }}</th><th class="num">{{ 'balance' | t }}</th></tr></thead>
          <tbody>@for (a of aging(); track a.customerId) {
            <tr><td><strong>{{ a.shopName }}</strong> <span class="small muted">{{ a.code }}</span></td><td>{{ a.area }}</td>
              <td class="num">{{ a.d0_30 | money }}</td><td class="num">{{ a.d31_60 | money }}</td><td class="num">{{ a.d61_90 | money }}</td>
              <td class="num" [style.color]="a.d90plus > 0 ? 'var(--bad)' : ''">{{ a.d90plus | money }}</td><td class="num"><strong>{{ a.ledgerBalance | money }}</strong></td></tr>
          } @empty { <tr><td colspan="7" class="empty">{{ 'noData' | t }}</td></tr> }</tbody>
        </table></div>
      </div>
    }

    @if (tab() === 's') {
      <div class="card table-wrap"><table class="data">
        <thead><tr><th>#</th><th>{{ 'date' | t }}</th><th>{{ 'supplier' | t }}</th><th>{{ 'method' | t }}</th><th>{{ 'account' | t }}</th><th class="num">{{ 'amount' | t }}</th><th>{{ 'status' | t }}</th><th></th></tr></thead>
        <tbody>@for (p of supplierPayments(); track p.id) {
          <tr><td class="ltr">{{ p.paymentNo }}</td><td>{{ p.paymentDate | pkdate }}</td><td>{{ p.supplier }}</td><td>{{ p.method | t }}</td><td>{{ p.account }}</td><td class="num">{{ p.amount | money }}</td>
            <td><span class="badge" [class.bad]="p.status === 'CANCELLED'">{{ p.status | t }}</span></td>
            <td>@if (p.status === 'POSTED') { <button class="btn sm danger" (click)="cancelSupplierPayment(p)">{{ 'cancel' | t }}</button> }</td></tr>
        } @empty { <tr><td colspan="8" class="empty">{{ 'noData' | t }}</td></tr> }</tbody>
      </table></div>
    }
  </div>

  @if (form(); as f) {
    <app-modal [title]="'newReceipt' | t" (closed)="form.set(null)">
      <div class="stack">
        <div class="field"><label>{{ 'customer' | t }} *</label>
          <select [(ngModel)]="f.customerId" (ngModelChange)="customerChanged(f)"><option value="">—</option>
            @for (c of customers(); track c.id) { <option [value]="c.id">{{ c.shopName }} · {{ c.area }} ({{ c.code }})</option> }</select></div>
        @if (f.customerId) { <div class="alert info">{{ 'balance' | t }}: <strong>{{ f.balance | money }}</strong></div> }
        <div class="form-grid">
          <div class="field"><label>{{ 'amount' | t }} *</label><input type="number" min="1" [(ngModel)]="f.amount" autofocus /></div>
          <div class="field"><label>{{ 'method' | t }}</label><select [(ngModel)]="f.method">@for (m of ['CASH','BANK','WALLET']; track m) { <option [value]="m">{{ m | t }}</option> }</select></div>
          <div class="field"><label>{{ 'invoice' | t }} <span class="muted">({{ 'optional' | t }})</span></label>
            <select [(ngModel)]="f.invoiceId"><option [ngValue]="null">—</option>@for (i of openInvoices(); track i.id) { <option [ngValue]="i.id">{{ i.invoiceNo }} · {{ i.total | money }}</option> }</select></div>
          <div class="field"><label>{{ 'reference' | t }}</label><input [(ngModel)]="f.reference" /></div>
        </div>
        <p class="small muted" style="margin:0">{{ 'localNotice' | t }}</p>
      </div>
      <ng-container foot><button class="btn" (click)="form.set(null)">{{ 'cancel' | t }}</button>
        <button class="btn primary" (click)="save(f)" [disabled]="!f.customerId || !(f.amount > 0) || busy()">{{ 'save' | t }}</button></ng-container>
    </app-modal>
  }

  @if (printing(); as r) {
    <div class="print-area receipt">
      <h2>{{ business()?.name }}</h2>
      @if (business()?.nameUr) { <div class="ur">{{ business()?.nameUr }}</div> }
      <div class="small">{{ business()?.address }} {{ business()?.phone }}</div>
      <hr />
      <h3>{{ 'printReceipt' | t }} — <span class="ltr">{{ r.receiptNo }}</span></h3>
      <p>{{ 'date' | t }}: {{ r.receiptDate | pkdate: true }}<br />{{ 'customer' | t }}: <strong>{{ names()[r.customerId] ?? r.customer }}</strong><br />
        {{ 'method' | t }}: {{ r.method | t }} @if (r.reference) { · {{ r.reference }} }</p>
      <p class="amt">{{ 'amount' | t }}: {{ r.amount | money }}</p>
      @if (r.syncStatus !== 'server' && r.syncStatus !== 'synced') { <p class="small">{{ 'localCopy' | t }}</p> }
      <p style="margin-top:40px">______________________<br />{{ 'signature' | t }}</p>
    </div>
  }`,
  styles: [`.receipt { display: none; } @media print { .receipt { display: block; padding: 4mm; font-size: 12px; } .amt { font-size: 18px; font-weight: 700; } }`],
})
export class PaymentsPage implements OnInit {
  tab = signal<'r' | 'a' | 's'>('r');
  receipts = signal<any[]>([]); names = signal<Partial<Record<string, string>>>({}); customers = signal<Customer[]>([]);
  aging = signal<any[]>([]); supplierPayments = signal<any[]>([]);
  form = signal<any>(null); openInvoices = signal<Invoice[]>([]); busy = signal(false);
  printing = signal<any>(null); business = signal<any>(null);

  constructor(public api: Api, public auth: Auth, private i18n: I18n, private store: Store, private sync: Sync, private toast: Toast,
              private route: ActivatedRoute, private dialog: Dialog) {
    effect(() => { this.store.version(); this.load(); });
  }

  async ngOnInit() {
    this.business.set(await getMeta('business'));
    const q = this.route.snapshot.queryParamMap;
    if (q.get('customer')) setTimeout(() => this.openNew(q.get('customer')!, q.get('invoice')), 100);
  }

  async load() {
    const cs = await db.customers.orderBy('shopName').toArray();
    const n: Record<string, string> = {}; cs.forEach(c => (n[c.id] = c.shopName));
    this.names.set(n); this.customers.set(cs.filter(c => c.isActive));
    const local: any[] = await db.receipts.orderBy('receiptDate').reverse().toArray();
    let server: any[] = [];
    if (this.api.online()) {
      try { server = (await this.api.get<any[]>('/api/customer-receipts')).map(r => ({ ...r, syncStatus: 'server' })); } catch { /* offline */ }
    }
    const ids = new Set(server.map(r => r.id));
    this.receipts.set([...local.filter(r => !ids.has(r.id)), ...server].sort((a, b) => b.receiptDate.localeCompare(a.receiptDate)));
  }

  async openNew(customerId = '', invoiceId: string | null = null) {
    const f: any = { customerId, amount: 0, method: 'CASH', invoiceId, reference: '', balance: 0 };
    if (customerId) await this.customerChanged(f);
    if (invoiceId) f.invoiceId = invoiceId;
    this.form.set(f);
  }

  async customerChanged(f: any) {
    f.balance = await this.store.balanceOf(f.customerId);
    f.amount = Math.max(0, f.balance); f.invoiceId = null;
    this.openInvoices.set((await db.invoices.where('customerId').equals(f.customerId).toArray())
      .filter(i => i.status === 'POSTED' && (i.openAmount ?? i.balanceAfter) > 0).sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate)));
  }

  async save(f: any) {
    this.busy.set(true);
    try {
      const r = await this.store.createReceipt(f.customerId, +f.amount, f.method, f.invoiceId, f.reference || undefined);
      this.toast.ok(`${r.receiptNo} — ${this.i18n.t('savedOk')}`);
      this.form.set(null); this.sync.kick();
      const rec = await db.receipts.get(r.id);
      if (rec && await this.dialog.confirm(this.i18n.t('printReceipt') + '?')) this.printReceipt(rec);
    } catch (e) { this.toast.error(e); }
    finally { this.busy.set(false); }
  }

  printReceipt(r: Receipt | any) { this.printing.set(r); setTimeout(() => printArea('thermal'), 50); }

  async cancelReceipt(r: any) {
    const reason = await this.dialog.prompt(this.i18n.t('cancel') + ' ' + r.receiptNo, this.i18n.t('cancelReasonPrompt'));
    if (!reason) return;
    try { await this.api.post(`/api/customer-receipts/${r.id}/cancel`, { reason }); await this.sync.run(); await this.load(); } catch (e) { this.toast.error(e); }
  }

  async loadAging() { try { this.aging.set(await this.api.get('/api/reports/aging')); } catch (e) { this.toast.error(e); } }
  exportAging() { downloadText('aging.csv', toCsv(this.aging(), ['code', 'shopName', 'area', 'phone', 'd0_30', 'd31_60', 'd61_90', 'd90plus', 'ledgerBalance'].map(k => ({ key: k, label: k })))); }
  async loadSupplierPayments() { try { this.supplierPayments.set(await this.api.get('/api/supplier-payments')); } catch (e) { this.toast.error(e); } }
  async cancelSupplierPayment(p: any) {
    const reason = await this.dialog.prompt(this.i18n.t('cancel') + ' ' + p.paymentNo, this.i18n.t('cancelReasonPrompt'));
    if (!reason) return;
    try { await this.api.post(`/api/supplier-payments/${p.id}/cancel`, { reason }); await this.loadSupplierPayments(); } catch (e) { this.toast.error(e); }
  }
}
