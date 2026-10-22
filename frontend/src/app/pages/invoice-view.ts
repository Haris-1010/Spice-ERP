import { Component, OnInit, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { Customer, Invoice, db, getMeta } from '../core/db';
import { I18n, TPipe } from '../core/i18n';
import { Store } from '../core/store';
import { Sync } from '../core/sync';
import { InvoiceDocComponent, PrintLang, printArea } from '../shared/invoice-doc';
import { Dialog, SHARED, Toast, errorText } from '../shared/ui';

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink, InvoiceDocComponent, ...SHARED],
  template: `
  <div class="page">
    @if (invoice(); as inv) {
      <div class="page-head no-print">
        <a class="btn ghost" routerLink="/sales">← {{ 'back' | t }}</a>
        <h1>{{ 'invoice' | t }} <span class="ltr">{{ inv.invoiceNo }}</span></h1>
        <app-sync-badge [status]="inv.syncStatus" [message]="inv.serverMessage" />
      </div>

      <div class="card card-body no-print stack" style="margin-bottom:16px">
        <div class="row">
          <div class="field"><label>{{ 'printLanguage' | t }}</label>
            <select [(ngModel)]="lang"><option value="en">English</option><option value="ur">اردو</option><option value="both">English + اردو</option></select>
          </div>
          <div class="field"><label>{{ 'defaultPrint' | t }}</label>
            <select [(ngModel)]="layout"><option value="a4">A4</option><option value="thermal">{{ 'thermal' | t }}</option></select>
          </div>
          <span class="spacer"></span>
          <button class="btn primary" (click)="print()">{{ 'print' | t }}</button>
          @if (inv.status === 'POSTED' && auth.can('returns.create')) { <button class="btn" (click)="openReturn()">{{ 'recordReturn' | t }}</button> }
          @if (inv.status === 'POSTED' && auth.can('receipts.create') && inv.balanceAfter > 0) {
            <a class="btn" routerLink="/payments" [queryParams]="{ customer: inv.customerId, invoice: inv.id }">{{ 'newReceipt' | t }}</a>
          }
          @if (inv.status === 'POSTED' && auth.can('sales.cancel') && (inv.syncStatus === 'server' || inv.syncStatus === 'synced')) {
            <button class="btn danger" (click)="cancelInvoice()" [disabled]="!api.online()">{{ 'cancelInvoice' | t }}</button>
          }
        </div>
        <p class="small muted" style="margin:0">{{ 'reprintNote' | t }}</p>
        @if (inv.syncStatus === 'local' || inv.syncStatus === 'failed') { <div class="alert warn">{{ 'localNotice' | t }}</div> }
        @if (inv.serverMessage) { <div class="alert bad"><strong>{{ 'serverMessage' | t }}:</strong> {{ inv.serverMessage }}</div> }
        @if (inv.warnings?.length) { <div class="alert warn"><strong>{{ 'warnings' | t }}</strong><ul>@for (w of inv.warnings; track w) { <li>{{ w }}</li> }</ul></div> }
      </div>

      <div class="print-area">
        <app-invoice-doc [invoice]="inv" [customer]="customer()" [business]="business()" [salesperson]="salesperson()" [layout]="layout" [lang]="lang" />
      </div>

      @if (returning()) {
        <app-modal [title]="'recordReturn' | t" [wide]="true" (closed)="returning.set(false)">
          <div class="stack">
            <table class="data">
              <thead><tr><th>{{ 'item' | t }}</th><th class="num">{{ 'returnable' | t }}</th><th class="num">{{ 'qty' | t }}</th><th>{{ 'condition' | t }}</th></tr></thead>
              <tbody>
                @for (r of returnRows; track r.lineId) {
                  <tr><td>{{ r.label }}</td><td class="num">{{ r.max }}</td>
                    <td style="width:100px"><input type="number" min="0" [max]="r.max" [(ngModel)]="r.quantity" class="num" /></td>
                    <td><select [(ngModel)]="r.condition">@for (c of ['GOOD','DAMAGED','EXPIRED','WRONG_ITEM']; track c) { <option [value]="c">{{ c | t }}</option> }</select></td></tr>
                }
              </tbody>
            </table>
            <div class="form-grid">
              <div class="field"><label>{{ 'settlement' | t }}</label>
                <select [(ngModel)]="settlement"><option value="CREDIT">{{ 'credit' | t }}</option><option value="CASH_REFUND">{{ 'CASH_REFUND' | t }}</option></select></div>
              <div class="field span-2"><label>{{ 'reason' | t }}</label><input [(ngModel)]="returnReason" /></div>
            </div>
          </div>
          <ng-container foot>
            <button class="btn" (click)="returning.set(false)">{{ 'cancel' | t }}</button>
            <button class="btn primary" (click)="saveReturn()" [disabled]="busy()">{{ 'save' | t }}</button>
          </ng-container>
        </app-modal>
      }
    } @else if (notFound()) {
      <div class="card empty">{{ 'noData' | t }}</div>
    } @else { <div class="empty">{{ 'loading' | t }}</div> }
  </div>`,
})
export class InvoiceViewPage implements OnInit {
  invoice = signal<Invoice | null>(null);
  customer = signal<Customer | null>(null);
  business = signal<any>(null);
  salesperson = signal<string | null>(null);
  notFound = signal(false);
  returning = signal(false);
  busy = signal(false);
  layout: 'a4' | 'thermal' = 'a4';
  lang: PrintLang = 'en';
  returnRows: { lineId: string; label: string; max: number; quantity: number; condition: string }[] = [];
  settlement = 'CREDIT'; returnReason = '';

  constructor(private route: ActivatedRoute, public api: Api, public auth: Auth, private i18n: I18n, private store: Store,
              private sync: Sync, private toast: Toast, private dialog: Dialog) {
    // Refresh when sync confirms the invoice or a return/receipt changes it.
    let first = true;
    effect(() => { this.store.version(); if (first) { first = false; return; } if (this.invoice()) this.load(); });
  }

  async ngOnInit() {
    try { this.layout = (localStorage.getItem('printLayout') as any) || 'a4'; } catch { /* default */ }
    this.lang = this.i18n.lang();
    await this.load();
    if (this.route.snapshot.queryParamMap.get('print') && this.invoice()) setTimeout(() => this.print(), 400);
  }

  async load() {
    const id = this.route.snapshot.paramMap.get('id')!;
    let inv = await db.invoices.get(id);
    // Older invoices that are not cached on this device are read from the server.
    if (!inv && this.api.online()) {
      try {
        const r: any = await this.api.get(`/api/sales-invoices/${id}`);
        inv = { ...r.invoice, lines: r.invoice.lines, syncStatus: 'server', openAmount: r.openAmount };
        if (!(await db.customers.get(r.invoice.customerId))) this.customer.set(r.customer);
        this.salesperson.set(r.salesperson);
      } catch { /* shown as not found */ }
    }
    if (!inv) { this.notFound.set(true); return; }
    this.invoice.set(inv);
    const c = await db.customers.get(inv.customerId); if (c) this.customer.set(c);
    const u = inv.salespersonId ? await db.users.get(inv.salespersonId) : null;
    if (u) this.salesperson.set(u.name);
    this.business.set(await getMeta('business'));
  }

  print() {
    try { localStorage.setItem('printLayout', this.layout); } catch { /* ignore */ }
    printArea(this.layout);
  }

  openReturn() {
    const inv = this.invoice()!;
    this.returnRows = inv.lines.filter(l => l.quantity - l.returnedQty > 0)
      .map(l => ({ lineId: l.id, label: this.i18n.isUr() && l.descriptionUr ? l.descriptionUr : l.description, max: l.quantity - l.returnedQty, quantity: 0, condition: 'GOOD' }));
    this.settlement = 'CREDIT'; this.returnReason = '';
    this.returning.set(true);
  }

  async saveReturn() {
    this.busy.set(true);
    try {
      const r = await this.store.createReturn(this.invoice()!, this.returnRows.map(x => ({ invoiceLineId: x.lineId, quantity: Number(x.quantity) || 0, condition: x.condition })),
        this.settlement, this.returnReason);
      this.toast.ok(`${r.returnNo} — ${this.i18n.t('savedOk')}`);
      this.returning.set(false);
      this.sync.kick();
      await this.load();
    } catch (e) { this.toast.error(e); }
    finally { this.busy.set(false); }
  }

  async cancelInvoice() {
    const reason = await this.dialog.prompt(this.i18n.t('cancelInvoice'), this.i18n.t('cancelReasonPrompt'));
    if (!reason) return;
    try {
      await this.api.post(`/api/sales-invoices/${this.invoice()!.id}/cancel`, { reason });
      await this.sync.run();
      this.toast.ok(this.i18n.t('savedOk'));
      await this.load();
    } catch (e) { this.toast.error(errorText(e)); }
  }
}
