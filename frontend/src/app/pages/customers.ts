import { Component, OnInit, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { Customer, db } from '../core/db';
import { MoneyPipe, downloadText, toCsv } from '../core/format';
import { I18n, TPipe } from '../core/i18n';
import { Store } from '../core/store';
import { Sync } from '../core/sync';
import { SHARED, Toast } from '../shared/ui';
import { StatementComponent } from '../shared/statement';

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink, MoneyPipe, StatementComponent, ...SHARED],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>{{ 'customers' | t }}</h1>
      <button class="btn" (click)="exportCsv()">{{ 'export' | t }}</button>
      @if (auth.can('customers.manage')) { <button class="btn primary" (click)="edit(null)">+ {{ 'newCustomer' | t }}</button> }
    </div>
    <div class="card">
      <div class="card-body toolbar">
        <div class="field grow"><label>{{ 'search' | t }}</label><input [(ngModel)]="q" (ngModelChange)="filter()" placeholder="{{ 'shopName' | t }}, {{ 'phone' | t }}, {{ 'area' | t }}, {{ 'code' | t }}" /></div>
        <div class="field"><label>{{ 'route' | t }}</label><select [(ngModel)]="routeId" (ngModelChange)="filter()"><option value="">{{ 'all' | t }}</option>
          @for (r of routes(); track r.id) { <option [value]="r.id">{{ r.name }}</option> }</select></div>
        <label class="check"><input type="checkbox" [(ngModel)]="owingOnly" (ngModelChange)="filter()" /> {{ 'outstanding' | t }}</label>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>{{ 'code' | t }}</th><th>{{ 'shopName' | t }}</th><th>{{ 'contactPerson' | t }}</th><th>{{ 'phone' | t }}</th><th>{{ 'area' | t }}</th>
            <th>{{ 'customerType' | t }}</th><th class="num">{{ 'creditLimit' | t }}</th><th class="num">{{ 'balance' | t }}</th><th></th></tr></thead>
          <tbody>
            @for (c of rows(); track c.id) {
              <tr>
                <td class="ltr">{{ c.code }} @if (c.localOnly) { <app-sync-badge status="local" /> }</td>
                <td><strong>{{ c.shopName }}</strong> @if (!c.isActive) { <span class="badge grey">{{ 'inactive' | t }}</span> }</td>
                <td>{{ c.contactPerson }}</td><td class="ltr">{{ c.phone }}</td><td>{{ c.area }}</td><td>{{ c.customerType | t }}</td>
                <td class="num">{{ c.creditLimit | money }}</td>
                <td class="num"><strong [style.color]="c.creditLimit > 0 && (balances()[c.id] ?? 0) > c.creditLimit ? 'var(--bad)' : ''">{{ balances()[c.id] ?? 0 | money }}</strong></td>
                <td class="right nowrap">
                  @if (auth.can('sales.create')) { <a class="btn sm primary" routerLink="/sales/new" [queryParams]="{ customer: c.id }">{{ 'invoice' | t }}</a> }
                  @if (auth.can('receipts.create')) { <a class="btn sm" routerLink="/payments" [queryParams]="{ customer: c.id }">{{ 'newReceipt' | t }}</a> }
                  <button class="btn sm" (click)="statement(c)" [disabled]="!api.online() || c.localOnly">{{ 'statement' | t }}</button>
                  @if (auth.can('customers.manage')) { <button class="btn sm" (click)="edit(c)">{{ 'edit' | t }}</button> }
                </td>
              </tr>
            } @empty { <tr><td colspan="9" class="empty">{{ 'noData' | t }}</td></tr> }
          </tbody>
        </table>
      </div>
    </div>
  </div>

  @if (form(); as f) {
    <app-modal [title]="(f.id ? 'edit' : 'newCustomer') | t" [wide]="true" (closed)="form.set(null)">
      <div class="stack">
        <div class="form-grid">
          <div class="field span-2"><label>{{ 'shopName' | t }} *</label><input [(ngModel)]="f.shopName" (ngModelChange)="checkDup(f)" /></div>
          <div class="field"><label>{{ 'contactPerson' | t }}</label><input [(ngModel)]="f.contactPerson" /></div>
          <div class="field"><label>{{ 'phone' | t }}</label><input [(ngModel)]="f.phone" (ngModelChange)="checkDup(f)" inputmode="tel" /></div>
          <div class="field"><label>{{ 'whatsApp' | t }}</label><input [(ngModel)]="f.whatsApp" inputmode="tel" /></div>
          <div class="field span-2"><label>{{ 'address' | t }}</label><input [(ngModel)]="f.address" /></div>
          <div class="field"><label>{{ 'area' | t }}</label><input [(ngModel)]="f.area" (ngModelChange)="checkDup(f)" list="areas" /><datalist id="areas">@for (a of areas(); track a) { <option [value]="a"></option> }</datalist></div>
          <div class="field"><label>{{ 'city' | t }}</label><input [(ngModel)]="f.city" /></div>
          <div class="field"><label>{{ 'customerType' | t }}</label><select [(ngModel)]="f.customerType">@for (t of ['RETAILER','WHOLESALER','DISTRIBUTOR']; track t) { <option [value]="t">{{ t | t }}</option> }</select></div>
          <div class="field"><label>{{ 'route' | t }}</label><select [(ngModel)]="f.routeId"><option [ngValue]="null">—</option>@for (r of routes(); track r.id) { <option [ngValue]="r.id">{{ r.name }}</option> }</select></div>
          <div class="field"><label>{{ 'salesperson' | t }}</label><select [(ngModel)]="f.salespersonId"><option [ngValue]="null">—</option>@for (u of users(); track u.id) { <option [ngValue]="u.id">{{ u.name }}</option> }</select></div>
          <div class="field"><label>{{ 'creditLimit' | t }}</label><input type="number" min="0" [(ngModel)]="f.creditLimit" /></div>
          <div class="field"><label>{{ 'paymentTerms' | t }}</label><input type="number" min="0" [(ngModel)]="f.paymentTermsDays" /></div>
          @if (!f.id) { <div class="field"><label>{{ 'openingBalance' | t }}</label><input type="number" [(ngModel)]="opening" /></div> }
          <div class="field"><label>GPS</label><button class="btn" type="button" (click)="locate(f)">📍 {{ 'useLocation' | t }}</button>
            @if (f.latitude) { <span class="small muted ltr">{{ f.latitude }}, {{ f.longitude }}</span> }</div>
          <div class="field span-all"><label>{{ 'notes' | t }}</label><textarea rows="2" [(ngModel)]="f.notes"></textarea></div>
          <label class="check"><input type="checkbox" [(ngModel)]="f.isActive" /> {{ 'active' | t }}</label>
        </div>
        @if (dups().length) {
          <div class="alert warn"><strong>{{ 'duplicateWarning' | t }}:</strong>
            <ul>@for (d of dups(); track d.id) { <li>{{ d.shopName }} · {{ d.area }} · {{ d.phone }} ({{ d.code }})</li> }</ul></div>
        }
        @if (!api.online()) { <div class="alert info">{{ 'localNotice' | t }}</div> }
      </div>
      <ng-container foot>
        <button class="btn" (click)="form.set(null)">{{ 'cancel' | t }}</button>
        <button class="btn primary" (click)="save(f)" [disabled]="!f.shopName?.trim() || busy()">{{ 'save' | t }}</button>
      </ng-container>
    </app-modal>
  }
  @if (stmt(); as s) { <app-statement kind="customer" [id]="s.id" [name]="s.name" (close)="stmt.set(null)" /> }`,
})
export class CustomersPage implements OnInit {
  all = signal<Customer[]>([]); rows = signal<Customer[]>([]); balances = signal<Partial<Record<string, number>>>({});
  routes = signal<any[]>([]); users = signal<any[]>([]); areas = signal<string[]>([]);
  form = signal<any>(null); dups = signal<Customer[]>([]); busy = signal(false); stmt = signal<any>(null);
  q = ''; routeId = ''; owingOnly = false; opening = 0;

  constructor(public api: Api, public auth: Auth, private i18n: I18n, private store: Store, private sync: Sync, private toast: Toast, private route: ActivatedRoute) {
    effect(() => { this.store.version(); this.load(); });
  }

  async ngOnInit() {
    if (this.route.snapshot.queryParamMap.get('new') && this.auth.can('customers.manage')) setTimeout(() => this.edit(null), 50);
  }

  async load() {
    const [cs, routes, users, bal] = await Promise.all([db.customers.orderBy('shopName').toArray(), db.routes.toArray(), db.users.toArray(), this.store.balanceMap()]);
    this.all.set(cs); this.routes.set(routes); this.users.set(users.filter(u => u.isActive !== false)); this.balances.set(bal);
    this.areas.set([...new Set(cs.map(c => c.area).filter(Boolean) as string[])].sort());
    this.filter();
  }

  filter() {
    const q = this.q.trim().toLowerCase(); const b = this.balances();
    this.rows.set(this.all().filter(c => (!q || `${c.shopName} ${c.code} ${c.phone ?? ''} ${c.area ?? ''} ${c.contactPerson ?? ''}`.toLowerCase().includes(q))
      && (!this.routeId || c.routeId === this.routeId) && (!this.owingOnly || (b[c.id] ?? 0) > 0)));
  }

  edit(c: Customer | null) {
    this.opening = 0; this.dups.set([]);
    this.form.set(c ? { ...c } : { shopName: '', contactPerson: '', phone: '', whatsApp: '', address: '', area: '', city: '', customerType: 'RETAILER',
      routeId: null, salespersonId: this.auth.hasRole('Salesperson') ? this.auth.user()?.id : null, creditLimit: 0, paymentTermsDays: 0, notes: '', isActive: true });
  }

  checkDup(f: any) {
    const phone = (f.phone ?? '').replace(/\D/g, ''); const name = (f.shopName ?? '').trim().toLowerCase();
    this.dups.set(this.all().filter(c => c.id !== f.id && ((phone.length >= 7 && (c.phone ?? '').replace(/\D/g, '') === phone)
      || (name.length > 2 && c.shopName.toLowerCase() === name && (c.area ?? '') === (f.area ?? '')))).slice(0, 5));
  }

  locate(f: any) {
    navigator.geolocation?.getCurrentPosition(p => { f.latitude = +p.coords.latitude.toFixed(6); f.longitude = +p.coords.longitude.toFixed(6); },
      () => this.toast.warn('Location unavailable'), { enableHighAccuracy: true, timeout: 10000 });
  }

  async save(f: any) {
    this.busy.set(true);
    try {
      await this.store.saveCustomer({ ...f, creditLimit: +f.creditLimit || 0, paymentTermsDays: +f.paymentTermsDays || 0 }, +this.opening || 0);
      this.toast.ok(this.i18n.t(this.api.online() ? 'savedOk' : 'localNotice'));
      this.form.set(null);
      this.sync.kick();
    } catch (e) { this.toast.error(e); }
    finally { this.busy.set(false); }
  }

  statement(c: Customer) { this.stmt.set({ id: c.id, name: c.shopName }); }

  exportCsv() {
    const b = this.balances();
    downloadText('customers.csv', toCsv(this.rows().map(c => ({ ...c, balance: b[c.id] ?? 0 })),
      ['code', 'shopName', 'contactPerson', 'phone', 'area', 'city', 'customerType', 'creditLimit', 'balance'].map(k => ({ key: k, label: k }))));
  }
}

