import { Component, OnInit, computed, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { db } from '../core/db';
import { MoneyPipe, PkDatePipe, downloadText, toCsv } from '../core/format';
import { I18n, TPipe } from '../core/i18n';
import { Store } from '../core/store';
import { Sync } from '../core/sync';
import { Dialog, SHARED, Toast } from '../shared/ui';

export const EXPENSE_CATEGORIES = ['TRANSPORT', 'FUEL', 'RENT', 'SALARY', 'ELECTRICITY', 'PACKING_LABOUR', 'MAINTENANCE', 'MISC'];

@Component({
  standalone: true,
  imports: [FormsModule, MoneyPipe, PkDatePipe, ...SHARED],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>{{ 'expenses' | t }}</h1>
      <button class="btn" (click)="exportCsv()">{{ 'export' | t }}</button>
      <button class="btn primary" (click)="openNew()">+ {{ 'newExpense' | t }}</button>
    </div>
    <div class="card">
      <div class="card-body toolbar">
        <div class="field"><label>{{ 'category' | t }}</label><select [(ngModel)]="cat"><option value="">{{ 'all' | t }}</option>@for (c of cats; track c) { <option [value]="c">{{ c | t }}</option> }</select></div>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>#</th><th>{{ 'date' | t }}</th><th>{{ 'category' | t }}</th><th>{{ 'notes' | t }}</th><th class="num">{{ 'amount' | t }}</th><th>{{ 'status' | t }}</th><th></th></tr></thead>
        <tbody>@for (e of filtered(); track e.id) {
          <tr><td class="ltr">{{ e.expenseNo }}</td><td class="nowrap">{{ e.expenseDate | pkdate: true }}</td><td>{{ e.category | t }}</td>
            <td>{{ e.notes }} @if (e.attachmentUrl) { <a [href]="api.fileUrl(e.attachmentUrl)" target="_blank">📎</a> } @if (e.createdBy) { <span class="small muted">· {{ e.createdBy }}</span> }</td>
            <td class="num">{{ e.amount | money }}</td>
            <td>@if (e.status === 'CANCELLED') { <span class="badge bad">{{ 'CANCELLED' | t }}</span> } @else { <app-sync-badge [status]="e.syncStatus" /> }</td>
            <td>@if (auth.can('payments.manage') && e.syncStatus === 'server' && e.status === 'POSTED') { <button class="btn sm danger" (click)="cancel(e)">{{ 'cancel' | t }}</button> }</td></tr>
        } @empty { <tr><td colspan="7" class="empty">{{ 'noData' | t }}</td></tr> }</tbody>
        @if (filtered().length) { <tfoot><tr><td colspan="4">{{ 'total' | t }}</td><td class="num">{{ sum() | money }}</td><td colspan="2"></td></tr></tfoot> }
      </table></div>
    </div>
  </div>

  @if (form(); as f) {
    <app-modal [title]="'newExpense' | t" (closed)="form.set(null)">
      <div class="form-grid">
        <div class="field"><label>{{ 'category' | t }}</label><select [(ngModel)]="f.category">@for (c of cats; track c) { <option [value]="c">{{ c | t }}</option> }</select></div>
        <div class="field"><label>{{ 'amount' | t }} *</label><input type="number" min="1" [(ngModel)]="f.amount" /></div>
        <div class="field"><label>{{ 'method' | t }}</label><select [(ngModel)]="f.method">@for (m of ['CASH','BANK','WALLET']; track m) { <option [value]="m">{{ m | t }}</option> }</select></div>
        <div class="field"><label>{{ 'deliveries' | t }} <span class="muted">({{ 'optional' | t }})</span></label>
          <select [(ngModel)]="f.deliveryId"><option [ngValue]="null">—</option>@for (d of deliveries(); track d.id) { <option [ngValue]="d.id">{{ d.deliveryNo }} · {{ d.routeName }}</option> }</select></div>
        <div class="field span-all"><label>{{ 'notes' | t }}</label><input [(ngModel)]="f.notes" /></div>
        @if (api.online()) {
          <div class="field span-all"><label>{{ 'attachment' | t }}</label><input type="file" accept="image/*,application/pdf" (change)="attach($event, f)" />
            @if (f.attachmentUrl) { <span class="small">✓</span> }</div>
        }
      </div>
      <ng-container foot><button class="btn" (click)="form.set(null)">{{ 'cancel' | t }}</button>
        <button class="btn primary" (click)="save(f)" [disabled]="!(f.amount > 0) || busy()">{{ 'save' | t }}</button></ng-container>
    </app-modal>
  }`,
})
export class ExpensesPage implements OnInit {
  cats = EXPENSE_CATEGORIES; cat = '';
  rows = signal<any[]>([]); deliveries = signal<any[]>([]); form = signal<any>(null); busy = signal(false);
  filtered = () => this.rows().filter(e => !this.cat || e.category === this.cat);
  sum = () => this.filtered().filter(e => e.status !== 'CANCELLED').reduce((s, e) => s + Number(e.amount), 0);

  constructor(public api: Api, public auth: Auth, private i18n: I18n, private store: Store, private sync: Sync, private toast: Toast, private dialog: Dialog) {
    effect(() => { this.store.version(); this.load(); });
  }
  ngOnInit() {}

  async load() {
    const local: any[] = await db.expenses.orderBy('expenseDate').reverse().toArray();
    this.deliveries.set(await db.deliveries.toArray());
    let server: any[] = [];
    if (this.api.online()) try { server = (await this.api.get<any[]>('/api/expenses')).map(e => ({ ...e, syncStatus: 'server' })); } catch { /* offline */ }
    const ids = new Set(server.map(e => e.id));
    this.rows.set([...local.filter(e => !ids.has(e.id)), ...server].sort((a, b) => b.expenseDate.localeCompare(a.expenseDate)));
  }

  openNew() { this.form.set({ category: 'FUEL', amount: 0, method: 'CASH', deliveryId: null, notes: '', attachmentUrl: null }); }
  async attach(ev: Event, f: any) { const file = (ev.target as HTMLInputElement).files?.[0]; if (file) try { f.attachmentUrl = await this.api.upload('attachments', file); } catch (e) { this.toast.error(e); } }

  async save(f: any) {
    this.busy.set(true);
    try {
      const r = await this.store.createExpense(f.category, +f.amount, f.method, f.notes || undefined, f.deliveryId, f.attachmentUrl);
      this.toast.ok(`${r.expenseNo} — ${this.i18n.t('savedOk')}`); this.form.set(null); this.sync.kick();
    } catch (e) { this.toast.error(e); }
    finally { this.busy.set(false); }
  }

  async cancel(e: any) {
    const reason = await this.dialog.prompt(this.i18n.t('cancel') + ' ' + e.expenseNo, this.i18n.t('cancelReasonPrompt'));
    if (!reason) return;
    try { await this.api.post(`/api/expenses/${e.id}/cancel`, { reason }); await this.load(); } catch (x) { this.toast.error(x); }
  }

  exportCsv() { downloadText('expenses.csv', toCsv(this.filtered(), ['expenseNo', 'expenseDate', 'category', 'amount', 'notes', 'status'].map(k => ({ key: k, label: k })))); }
}
