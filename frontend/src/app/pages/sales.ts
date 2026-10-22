import { Component, OnInit, computed, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { Invoice, db } from '../core/db';
import { MoneyPipe, PkDatePipe, downloadText, pkDate, toCsv } from '../core/format';
import { I18n, TPipe } from '../core/i18n';
import { Store } from '../core/store';
import { Dialog, SHARED, Toast } from '../shared/ui';

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink, MoneyPipe, PkDatePipe, ...SHARED],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>{{ 'sales' | t }}</h1>
      @if (auth.can('sales.create')) { <a class="btn primary" routerLink="/sales/new">+ {{ 'newInvoice' | t }}</a> }
    </div>
    <div class="tabs">
      <button [class.active]="tab() === 'inv'" (click)="tab.set('inv')">{{ 'invoices' | t }}</button>
      <button [class.active]="tab() === 'orders'" (click)="tab.set('orders'); loadOrders()">{{ 'orders' | t }}</button>
      <button [class.active]="tab() === 'returns'" (click)="tab.set('returns'); loadReturns()">{{ 'returns' | t }}</button>
    </div>

    @if (tab() === 'inv') {
      <div class="card">
        <div class="card-body toolbar">
          <div class="field grow"><label>{{ 'search' | t }}</label><input [(ngModel)]="q" (ngModelChange)="filter()" [placeholder]="'invoiceNo' | t" /></div>
          <div class="field"><label>{{ 'from' | t }}</label><input type="date" [(ngModel)]="from" (ngModelChange)="filter()" /></div>
          <div class="field"><label>{{ 'to' | t }}</label><input type="date" [(ngModel)]="to" (ngModelChange)="filter()" /></div>
          <div class="field"><label>{{ 'status' | t }}</label>
            <select [(ngModel)]="status" (ngModelChange)="filter()"><option value="">{{ 'all' | t }}</option>
              <option value="unsynced">{{ 'st_local' | t }}</option><option value="POSTED">{{ 'POSTED' | t }}</option><option value="CANCELLED">{{ 'CANCELLED' | t }}</option></select></div>
          <button class="btn" (click)="exportCsv()">{{ 'export' | t }}</button>
        </div>
        @if (!api.online()) { <div class="alert info" style="margin:0 16px 12px">{{ 'showingCached' | t }}</div> }
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>{{ 'invoiceNo' | t }}</th><th>{{ 'date' | t }}</th><th>{{ 'customer' | t }}</th><th>{{ 'paymentMethod' | t }}</th>
              <th class="num">{{ 'total' | t }}</th><th class="num">{{ 'amountPaid' | t }}</th><th>{{ 'deliveryStatus' | t }}</th><th>{{ 'status' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (i of rows(); track i.id) {
                <tr class="clickable" (click)="router.navigate(['/sales', i.id])">
                  <td class="ltr"><strong>{{ i.invoiceNo }}</strong></td>
                  <td class="nowrap">{{ i.invoiceDate | pkdate: true }}</td>
                  <td>{{ names()[i.customerId] ?? '—' }}</td>
                  <td>{{ i.paymentMethod | t }}</td>
                  <td class="num">
                    {{ netTotal(i) | money }}
                    @if (i.returnedAmount > 0) { <div class="small muted">{{ 'returned' | t }} {{ i.returnedAmount | money }}</div> }
                  </td>
                  <td class="num">{{ i.amountPaid | money }}</td>
                  <td>{{ i.deliveryStatus | t }}</td>
                  <td>@if (i.status === 'CANCELLED') { <span class="badge bad">{{ 'CANCELLED' | t }}</span> } @else { <app-sync-badge [status]="i.syncStatus" [message]="i.serverMessage" /> }</td>
                  <td class="right">
                    @if (i.status === 'POSTED' && !i.returnedAmount && auth.can('sales.cancel') && (i.syncStatus === 'server' || i.syncStatus === 'synced')) {
                      <button class="btn sm danger" (click)="$event.stopPropagation(); deleteInvoice(i)" [disabled]="!api.online()">{{ 'delete' | t }}</button>
                    }
                  </td>
                </tr>
              } @empty { <tr><td colspan="9" class="empty">{{ 'noData' | t }}</td></tr> }
            </tbody>
            @if (rows().length) {
              <tfoot><tr><td colspan="4">{{ rows().length }} {{ 'invoicesCount' | t }}</td><td class="num">{{ sum() | money }}</td><td colspan="4"></td></tr></tfoot>
            }
          </table>
        </div>
      </div>
    }

    @if (tab() === 'orders') {
      <div class="card">
        @if (!api.online()) { <div class="empty">{{ 'onlineOnly' | t }}</div> } @else {
          <table class="data">
            <thead><tr><th>{{ 'orderNo' | t }}</th><th>{{ 'date' | t }}</th><th>{{ 'customer' | t }}</th><th class="num">{{ 'qty' | t }}</th><th>{{ 'notes' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (o of orders(); track o.id) {
                <tr><td class="ltr">{{ o.orderNo }}</td><td>{{ o.orderDate | pkdate }}</td><td>{{ o.customer }}</td><td class="num">{{ qtyOf(o) }}</td><td>{{ o.notes }}</td>
                  <td class="right"><a class="btn sm primary" routerLink="/sales/new" [queryParams]="{ order: o.id }">→ {{ 'invoice' | t }}</a>
                    <button class="btn sm danger" (click)="cancelOrder(o)">{{ 'cancel' | t }}</button></td></tr>
              } @empty { <tr><td colspan="6" class="empty">{{ 'noData' | t }}</td></tr> }
            </tbody>
          </table>
        }
      </div>
    }

    @if (tab() === 'returns') {
      <div class="card">
        @if (!api.online()) { <div class="empty">{{ 'onlineOnly' | t }}</div> } @else {
          <table class="data">
            <thead><tr><th>{{ 'returnNo' | t }}</th><th>{{ 'date' | t }}</th><th>{{ 'invoiceNo' | t }}</th><th>{{ 'customer' | t }}</th><th>{{ 'reason' | t }}</th><th>{{ 'settlement' | t }}</th><th class="num">{{ 'total' | t }}</th></tr></thead>
            <tbody>
              @for (r of returns(); track r.id) {
                <tr><td class="ltr">{{ r.returnNo }}</td><td>{{ r.returnDate | pkdate }}</td><td class="ltr">{{ r.invoiceNo }}</td><td>{{ r.customer }}</td><td>{{ r.reason }}</td>
                  <td>{{ r.settlement === 'CREDIT' ? ('credit' | t) : ('CASH_REFUND' | t) }}</td><td class="num">{{ r.total | money }}</td></tr>
              } @empty { <tr><td colspan="7" class="empty">{{ 'noData' | t }}</td></tr> }
            </tbody>
          </table>
        }
      </div>
    }
  </div>`,
})
export class SalesPage implements OnInit {
  tab = signal<'inv' | 'orders' | 'returns'>('inv');
  all = signal<Invoice[]>([]);
  rows = signal<Invoice[]>([]);
  names = signal<Partial<Record<string, string>>>({});
  orders = signal<any[]>([]);
  returns = signal<any[]>([]);
  q = ''; from = ''; to = ''; status = '';
  sum = computed(() => this.rows().filter(r => r.status !== 'CANCELLED').reduce((s, r) => s + this.netTotal(r), 0));

  constructor(public api: Api, public auth: Auth, public router: Router, private i18n: I18n, private store: Store, private toast: Toast, private dialog: Dialog) {
    effect(() => { this.store.version(); this.load(); });
  }

  async ngOnInit() {}

  async load() {
    const [inv, cust] = await Promise.all([db.invoices.orderBy('invoiceDate').reverse().toArray(), db.customers.toArray()]);
    const n: Record<string, string> = {}; cust.forEach(c => (n[c.id] = c.shopName));
    this.names.set(n); this.all.set(inv); this.filter();
  }

  filter() {
    const q = this.q.trim().toLowerCase(); const n = this.names();
    this.rows.set(this.all().filter(i =>
      (!q || i.invoiceNo.toLowerCase().includes(q) || (n[i.customerId] ?? '').toLowerCase().includes(q)) &&
      (!this.from || pkDay(i.invoiceDate) >= this.from) && (!this.to || pkDay(i.invoiceDate) <= this.to) &&
      (!this.status || (this.status === 'unsynced' ? i.syncStatus !== 'server' && i.syncStatus !== 'synced' : i.status === this.status))));
  }

  qtyOf(o: any) { return o.lines.reduce((s: number, l: any) => s + l.quantity, 0); }
  netTotal(i: Invoice) { return Math.max(0, i.total - (i.returnedAmount || 0)); }

  async loadOrders() { try { this.orders.set(await this.api.get('/api/sales-orders')); } catch (e) { this.toast.error(e); } }
  async loadReturns() { try { this.returns.set(await this.api.get('/api/sales-returns')); } catch (e) { this.toast.error(e); } }
  async cancelOrder(o: any) { try { await this.api.post(`/api/sales-orders/${o.id}/cancel`); await this.loadOrders(); } catch (e) { this.toast.error(e); } }
  async deleteInvoice(i: Invoice) {
    const reason = await this.dialog.prompt(this.i18n.t('deleteInvoice'), this.i18n.t('cancelReasonPrompt'));
    if (!reason) return;
    try {
      await this.api.post(`/api/sales-invoices/${i.id}/cancel`, { reason });
      await db.invoices.put({ ...i, status: 'CANCELLED' });
      this.store.touch();
      this.toast.ok(this.i18n.t('deletedOk'));
    } catch (e) { this.toast.error(e); }
  }

  exportCsv() {
    const n = this.names();
    downloadText('invoices.csv', toCsv(this.rows().map(i => ({ ...i, netTotal: this.netTotal(i), date: pkDate(i.invoiceDate, true), customer: n[i.customerId] })), [
      { key: 'invoiceNo', label: 'Invoice' }, { key: 'date', label: 'Date' }, { key: 'customer', label: 'Customer' },
      { key: 'paymentMethod', label: 'Payment' }, { key: 'netTotal', label: 'Net total' }, { key: 'returnedAmount', label: 'Returned' }, { key: 'amountPaid', label: 'Paid' },
      { key: 'status', label: 'Status' }, { key: 'syncStatus', label: 'Sync' }]));
  }
}

function pkDay(iso: string) { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' }); }
