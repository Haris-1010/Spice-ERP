import { Component, OnInit, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { db } from '../core/db';
import { MoneyPipe, PkDatePipe, pkToday } from '../core/format';
import { I18n, TPipe } from '../core/i18n';
import { Store } from '../core/store';
import { SHARED, Toast } from '../shared/ui';

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink, MoneyPipe, PkDatePipe, ...SHARED],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>{{ 'deliveries' | t }}</h1>
      @if (auth.can('delivery.manage')) {
        <button class="btn" (click)="routeForm.set({ name: '', area: '', defaultUserId: null, isActive: true })" [disabled]="!api.online()">+ {{ 'newRoute' | t }}</button>
        <button class="btn primary" (click)="openNew()" [disabled]="!api.online()">+ {{ 'newDelivery' | t }}</button>
      }
    </div>
    @if (!api.online()) { <div class="alert info" style="margin-bottom:12px">{{ 'showingCached' | t }}</div> }
    <div class="card table-wrap">
      <table class="data">
        <thead><tr><th>{{ 'deliveryNo' | t }}</th><th>{{ 'deliveryDate' | t }}</th><th>{{ 'route' | t }}</th><th>{{ 'assignedTo' | t }}</th><th>{{ 'vehicle' | t }}</th>
          <th class="num">{{ 'stops' | t }}</th><th class="num">{{ 'pending' | t }}</th><th>{{ 'status' | t }}</th></tr></thead>
        <tbody>
          @for (d of list(); track d.id) {
            <tr class="clickable" [routerLink]="['/deliveries', d.id]">
              <td class="ltr"><strong>{{ d.deliveryNo }}</strong></td><td>{{ d.deliveryDate | pkdate }}</td><td>{{ d.route ?? d.routeName }}</td><td>{{ d.assignedTo }}</td><td>{{ d.vehicle }}</td>
              <td class="num">{{ d.stops }}</td><td class="num">{{ d.pending }}</td>
              <td><span class="badge" [class.ok]="d.status === 'COMPLETED'" [class.warn]="d.status === 'OUT'">{{ d.status | t }}</span></td>
            </tr>
          } @empty { <tr><td colspan="8" class="empty">{{ 'noData' | t }}</td></tr> }
        </tbody>
      </table>
    </div>

    @if (auth.can('delivery.manage') && api.online()) {
      <div class="card" style="margin-top:16px">
        <div class="card-head"><h2>{{ 'routes' | t }}</h2></div>
        <table class="data"><tbody>
          @for (r of routes(); track r.id) {
            <tr><td><strong>{{ r.name }}</strong></td><td>{{ r.area }}</td><td class="num">{{ r.customers }} {{ 'customers' | t }}</td>
              <td class="right"><button class="btn sm" (click)="editRoute(r)">{{ 'edit' | t }}</button></td></tr>
          } @empty { <tr><td class="empty">{{ 'noData' | t }}</td></tr> }
        </tbody></table>
      </div>
    }
  </div>

  @if (form(); as f) {
    <app-modal [title]="'newDelivery' | t" [wide]="true" (closed)="form.set(null)">
      <div class="stack">
        <div class="form-grid">
          <div class="field"><label>{{ 'route' | t }} *</label><select [(ngModel)]="f.routeId" (ngModelChange)="routeChanged(f)"><option value="">—</option>@for (r of routes(); track r.id) { <option [value]="r.id">{{ r.name }}</option> }</select></div>
          <div class="field"><label>{{ 'deliveryDate' | t }}</label><input type="date" [(ngModel)]="f.deliveryDate" /></div>
          <div class="field"><label>{{ 'assignedTo' | t }} *</label><select [(ngModel)]="f.assignedUserId"><option value="">—</option>@for (u of users(); track u.id) { <option [value]="u.id">{{ u.fullName }}</option> }</select></div>
          <div class="field"><label>{{ 'vehicle' | t }}</label><input [(ngModel)]="f.vehicle" /></div>
        </div>
        <h3>{{ 'pendingInvoices' | t }}</h3>
        <div class="table-wrap" style="max-height:40vh">
          <table class="data">
            <thead><tr><th><input type="checkbox" (change)="toggleAll($event, f)" /></th><th>{{ 'invoiceNo' | t }}</th><th>{{ 'date' | t }}</th><th>{{ 'customer' | t }}</th><th>{{ 'area' | t }}</th><th class="num">{{ 'total' | t }}</th></tr></thead>
            <tbody>
              @for (i of pendingInvoices(); track i.id) {
                <tr><td><input type="checkbox" [checked]="f.invoiceIds.includes(i.id)" (change)="toggle(f.invoiceIds, i.id)" /></td><td class="ltr">{{ i.invoiceNo }}</td><td>{{ i.invoiceDate | pkdate }}</td>
                  <td>{{ i.customer }}</td><td>{{ areaOf(i.customerId) }}</td><td class="num">{{ i.total | money }}</td></tr>
              } @empty { <tr><td colspan="6" class="empty">{{ 'noData' | t }}</td></tr> }
            </tbody>
          </table>
        </div>
        <h3>{{ 'visitOnly' | t }}</h3>
        <div class="visit-list">
          @for (c of routeCustomers(); track c.id) {
            <label class="check"><input type="checkbox" [checked]="f.visitCustomerIds.includes(c.id)" (change)="toggle(f.visitCustomerIds, c.id)" /> {{ c.shopName }} <span class="small muted">{{ c.area }}</span></label>
          } @empty { <span class="muted small">—</span> }
        </div>
      </div>
      <ng-container foot><button class="btn" (click)="form.set(null)">{{ 'cancel' | t }}</button>
        <button class="btn primary" (click)="create(f)" [disabled]="!f.routeId || !f.assignedUserId || (!f.invoiceIds.length && !f.visitCustomerIds.length) || busy()">{{ 'save' | t }}</button></ng-container>
    </app-modal>
  }

  @if (routeForm(); as r) {
    <app-modal [title]="(r.id ? 'edit' : 'newRoute') | t" (closed)="routeForm.set(null)">
      <div class="form-grid">
        <div class="field"><label>{{ 'name' | t }}</label><input [(ngModel)]="r.name" placeholder="Route A – Township" /></div>
        <div class="field"><label>{{ 'area' | t }}</label><input [(ngModel)]="r.area" /></div>
        <div class="field"><label>{{ 'assignedTo' | t }}</label><select [(ngModel)]="r.defaultUserId"><option [ngValue]="null">—</option>@for (u of users(); track u.id) { <option [ngValue]="u.id">{{ u.fullName }}</option> }</select></div>
        <label class="check"><input type="checkbox" [(ngModel)]="r.isActive" /> {{ 'active' | t }}</label>
      </div>
      <ng-container foot><button class="btn" (click)="routeForm.set(null)">{{ 'cancel' | t }}</button><button class="btn primary" (click)="saveRoute(r)" [disabled]="!r.name">{{ 'save' | t }}</button></ng-container>
    </app-modal>
  }`,
  styles: [`.visit-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px; max-height: 200px; overflow-y: auto; }`],
})
export class DeliveriesPage implements OnInit {
  list = signal<any[]>([]); routes = signal<any[]>([]); users = signal<any[]>([]);
  pendingInvoices = signal<any[]>([]); routeCustomers = signal<any[]>([]); customers: any[] = [];
  form = signal<any>(null); routeForm = signal<any>(null); busy = signal(false);

  constructor(public api: Api, public auth: Auth, private i18n: I18n, private toast: Toast, private store: Store) {
    effect(() => { this.store.version(); this.load(); });
  }
  ngOnInit() {}

  async load() {
    if (this.api.online()) {
      try {
        this.list.set(await this.api.get('/api/deliveries'));
        if (this.auth.can('delivery.manage')) this.routes.set(await this.api.get('/api/routes'));
        return;
      } catch { /* fall through to device copy */ }
    }
    const ds = await db.deliveries.toArray();
    this.list.set(ds.map(d => ({ ...d, assignedTo: this.auth.user()?.fullName, stops: d.stops.length, pending: d.stops.filter(s => s.status === 'PENDING' && !s.localUpdate).length })));
  }

  areaOf(id: string) { return this.customers.find(c => c.id === id)?.area ?? ''; }

  async openNew() {
    try {
      const [inv, users, cust] = await Promise.all([
        this.api.get<any>('/api/sales-invoices', { status: 'POSTED', pageSize: 200 }),
        this.auth.can('users.manage') ? this.api.get<any[]>('/api/users') : Promise.resolve([{ id: this.auth.user()!.id, fullName: this.auth.user()!.fullName, isActive: true }]),
        db.customers.toArray(),
      ]);
      this.customers = cust;
      this.pendingInvoices.set(inv.items.filter((i: any) => i.deliveryStatus === 'PENDING'));
      this.users.set(users.filter((u: any) => u.isActive));
      this.routeCustomers.set([]);
      this.form.set({ routeId: '', deliveryDate: pkToday(), assignedUserId: '', vehicle: '', notes: '', invoiceIds: [], visitCustomerIds: [] });
    } catch (e) { this.toast.error(e); }
  }

  routeChanged(f: any) {
    const r = this.routes().find(x => x.id === f.routeId);
    if (r?.defaultUserId) f.assignedUserId = r.defaultUserId;
    const onRoute = new Set(this.customers.filter(c => c.routeId === f.routeId).map(c => c.id));
    f.invoiceIds = this.pendingInvoices().filter(i => onRoute.has(i.customerId)).map(i => i.id);
    this.routeCustomers.set(this.customers.filter(c => c.routeId === f.routeId && c.isActive));
  }

  editRoute(r: any) { this.routeForm.set(Object.assign({}, r)); }

  toggle(arr: string[], id: string) { const i = arr.indexOf(id); if (i >= 0) arr.splice(i, 1); else arr.push(id); }
  toggleAll(ev: Event, f: any) { f.invoiceIds = (ev.target as HTMLInputElement).checked ? this.pendingInvoices().map(i => i.id) : []; }

  async create(f: any) {
    this.busy.set(true);
    try {
      const r: any = await this.api.post('/api/deliveries', f);
      this.toast.ok(`${r.number} — ${this.i18n.t('savedOk')}`); this.form.set(null); await this.load();
    } catch (e) { this.toast.error(e); }
    finally { this.busy.set(false); }
  }

  async saveRoute(r: any) {
    try { if (r.id) await this.api.put(`/api/routes/${r.id}`, r); else await this.api.post('/api/routes', r); this.routeForm.set(null); await this.load(); }
    catch (e) { this.toast.error(e); }
  }
}
