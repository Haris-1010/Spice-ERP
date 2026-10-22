import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { MoneyPipe, downloadText, toCsv } from '../core/format';
import { I18n, TPipe } from '../core/i18n';
import { StatementComponent } from '../shared/statement';
import { SHARED, Toast } from '../shared/ui';

@Component({
  standalone: true,
  imports: [FormsModule, MoneyPipe, StatementComponent, ...SHARED],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>{{ 'suppliers' | t }}</h1>
      <button class="btn" (click)="exportCsv()" [disabled]="!list().length">{{ 'export' | t }}</button>
      @if (auth.can('suppliers.manage')) { <button class="btn primary" (click)="edit(null)" [disabled]="!api.online()">+ {{ 'newSupplier' | t }}</button> }
    </div>
    @if (!api.online()) { <div class="card empty">{{ 'onlineOnly' | t }}</div> } @else {
      <div class="card">
        <div class="card-body toolbar"><div class="field grow"><label>{{ 'search' | t }}</label><input [(ngModel)]="q" (keyup.enter)="load()" /></div><button class="btn" (click)="load()">{{ 'search' | t }}</button></div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>{{ 'code' | t }}</th><th>{{ 'name' | t }}</th><th>{{ 'contactPerson' | t }}</th><th>{{ 'phone' | t }}</th><th>{{ 'city' | t }}</th><th class="num">{{ 'payables' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (s of list(); track s.id) {
                <tr><td class="ltr">{{ s.code }}</td><td><strong>{{ s.name }}</strong></td><td>{{ s.contactPerson }}</td><td class="ltr">{{ s.phone }}</td><td>{{ s.city }}</td>
                  <td class="num"><strong>{{ s.balance | money }}</strong></td>
                  <td class="right nowrap">
                    @if (auth.can('payments.manage')) { <button class="btn sm primary" (click)="pay(s)">{{ 'paySupplier' | t }}</button> }
                    <button class="btn sm" (click)="stmt.set(s)">{{ 'statement' | t }}</button>
                    @if (auth.can('suppliers.manage')) { <button class="btn sm" (click)="edit(s)">{{ 'edit' | t }}</button> }
                  </td></tr>
              } @empty { <tr><td colspan="7" class="empty">{{ 'noData' | t }}</td></tr> }
            </tbody>
          </table>
        </div>
      </div>
    }
  </div>

  @if (form(); as f) {
    <app-modal [title]="(f.id ? 'edit' : 'newSupplier') | t" (closed)="form.set(null)">
      <div class="form-grid">
        <div class="field span-2"><label>{{ 'name' | t }} *</label><input [(ngModel)]="f.name" /></div>
        <div class="field"><label>{{ 'contactPerson' | t }}</label><input [(ngModel)]="f.contactPerson" /></div>
        <div class="field"><label>{{ 'phone' | t }}</label><input [(ngModel)]="f.phone" /></div>
        <div class="field span-2"><label>{{ 'address' | t }}</label><input [(ngModel)]="f.address" /></div>
        <div class="field"><label>{{ 'city' | t }}</label><input [(ngModel)]="f.city" /></div>
        @if (!f.id) { <div class="field"><label>{{ 'openingBalance' | t }}</label><input type="number" [(ngModel)]="f.openingBalance" /></div> }
        <div class="field span-all"><label>{{ 'notes' | t }}</label><input [(ngModel)]="f.notes" /></div>
        <label class="check"><input type="checkbox" [(ngModel)]="f.isActive" /> {{ 'active' | t }}</label>
      </div>
      <ng-container foot><button class="btn" (click)="form.set(null)">{{ 'cancel' | t }}</button>
        <button class="btn primary" (click)="save(f)" [disabled]="!f.name?.trim()">{{ 'save' | t }}</button></ng-container>
    </app-modal>
  }

  @if (payForm(); as p) {
    <app-modal [title]="('paySupplier' | t) + ' — ' + p.name" (closed)="payForm.set(null)">
      <div class="form-grid">
        <div class="field"><label>{{ 'payables' | t }}</label><strong class="num">{{ p.balance | money }}</strong></div>
        <div class="field"><label>{{ 'amount' | t }} *</label><input type="number" min="1" [(ngModel)]="p.amount" /></div>
        <div class="field"><label>{{ 'method' | t }}</label><select [(ngModel)]="p.method">@for (m of ['CASH','BANK','WALLET']; track m) { <option [value]="m">{{ m | t }}</option> }</select></div>
        <div class="field"><label>{{ 'reference' | t }}</label><input [(ngModel)]="p.reference" /></div>
        <div class="field span-all"><label>{{ 'notes' | t }}</label><input [(ngModel)]="p.notes" /></div>
      </div>
      <ng-container foot><button class="btn" (click)="payForm.set(null)">{{ 'cancel' | t }}</button>
        <button class="btn primary" (click)="savePay(p)" [disabled]="!(p.amount > 0) || busy()">{{ 'save' | t }}</button></ng-container>
    </app-modal>
  }
  @if (stmt(); as s) { <app-statement kind="supplier" [id]="s.id" [name]="s.name" (close)="stmt.set(null)" /> }`,
})
export class SuppliersPage implements OnInit {
  list = signal<any[]>([]); form = signal<any>(null); payForm = signal<any>(null); stmt = signal<any>(null); busy = signal(false);
  q = '';
  constructor(public api: Api, public auth: Auth, private i18n: I18n, private toast: Toast) {}
  ngOnInit() { this.load(); }
  async load() { if (this.api.online()) try { this.list.set(await this.api.get('/api/suppliers', { q: this.q || undefined })); } catch (e) { this.toast.error(e); } }
  edit(s: any) { this.form.set(s ? { ...s } : { name: '', contactPerson: '', phone: '', address: '', city: '', openingBalance: 0, notes: '', isActive: true }); }
  async save(f: any) {
    try {
      if (f.id) await this.api.put(`/api/suppliers/${f.id}`, f); else await this.api.post('/api/suppliers', { ...f, openingBalance: +f.openingBalance || 0 });
      this.form.set(null); this.toast.ok(this.i18n.t('savedOk')); await this.load();
    } catch (e) { this.toast.error(e); }
  }
  pay(s: any) { this.payForm.set({ supplierId: s.id, name: s.name, balance: s.balance, amount: Math.max(0, s.balance), method: 'CASH', reference: '', notes: '' }); }
  async savePay(p: any) {
    this.busy.set(true);
    try {
      const r: any = await this.api.post('/api/supplier-payments', { supplierId: p.supplierId, paymentDate: new Date().toISOString(), amount: +p.amount, method: p.method, reference: p.reference, notes: p.notes });
      this.toast.ok(`${r.number} — ${this.i18n.t('savedOk')}`); this.payForm.set(null); await this.load();
    } catch (e) { this.toast.error(e); }
    finally { this.busy.set(false); }
  }
  exportCsv() { downloadText('suppliers.csv', toCsv(this.list(), ['code', 'name', 'contactPerson', 'phone', 'city', 'balance'].map(k => ({ key: k, label: k })))); }
}
