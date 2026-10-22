import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { db } from '../core/db';
import { MoneyPipe, PkDatePipe } from '../core/format';
import { I18n, TPipe } from '../core/i18n';
import { Store } from '../core/store';
import { Sync } from '../core/sync';
import { printArea } from '../shared/invoice-doc';
import { SHARED, Toast } from '../shared/ui';

interface StopVm {
  id: string; seq: number; status: string; customerId: string; customer: string; address: string; phone: string; invoiceId?: string | null; invoiceNo?: string;
  total: number; expected: number; collected: number; outstanding: number; local: boolean;
  lines: { id: string; label: string; loadedQty: number; deliveredQty: number; returnedQty: number }[];
}

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink, MoneyPipe, PkDatePipe, ...SHARED],
  template: `
  <div class="page">
    @if (head(); as h) {
      <div class="page-head no-print">
        <a class="btn ghost" routerLink="/deliveries">← {{ 'back' | t }}</a>
        <h1>{{ 'deliverySheet' | t }} <span class="ltr">{{ h.deliveryNo }}</span></h1>
        <span class="badge" [class.ok]="h.status === 'COMPLETED'" [class.warn]="h.status === 'OUT'">{{ h.status | t }}</span>
        <button class="btn" (click)="print()">{{ 'print' | t }}</button>
        @if (h.status === 'PLANNED' && api.online()) { <button class="btn" (click)="start()">{{ 'start' | t }}</button> }
        @if (h.status !== 'COMPLETED' && api.online()) { <button class="btn primary" (click)="complete()" [disabled]="pendingStops() > 0 || sync.pending() > 0">{{ 'complete' | t }}</button> }
        @if (api.online()) { <button class="btn" (click)="loadRecon()">{{ 'reconciliation' | t }}</button> }
      </div>

      <div class="print-area">
        <div class="card card-body sheet-head">
          <div><span class="muted small">{{ 'route' | t }}</span><div><strong>{{ h.route }}</strong></div></div>
          <div><span class="muted small">{{ 'deliveryDate' | t }}</span><div>{{ h.deliveryDate | pkdate }}</div></div>
          <div><span class="muted small">{{ 'assignedTo' | t }}</span><div>{{ h.assignedTo }}</div></div>
          <div><span class="muted small">{{ 'vehicle' | t }}</span><div>{{ h.vehicle || '—' }}</div></div>
          <div><span class="muted small">{{ 'expectedCollection' | t }}</span><div class="num"><strong>{{ totalExpected() | money }}</strong></div></div>
        </div>
        <p class="small muted no-print">{{ 'goodsReturnedWarehouse' | t }}</p>
        <div class="stack">
          @for (s of stops(); track s.id) {
            <div class="card stop" [class.done]="s.status !== 'PENDING'">
              <div class="card-head">
                <span class="seq">{{ s.seq }}</span>
                <div class="grow"><strong>{{ s.customer }}</strong> <span class="small muted">{{ s.address }} · <span class="ltr">{{ s.phone }}</span></span></div>
                @if (s.invoiceNo) { <span class="ltr small">{{ s.invoiceNo }}</span> }
                <span class="badge" [class.ok]="s.status === 'DELIVERED'" [class.warn]="s.status === 'PARTIAL' || s.status === 'PENDING'" [class.bad]="s.status === 'FAILED'">{{ s.status | t }}</span>
                @if (s.local) { <app-sync-badge status="local" /> }
              </div>
              <div class="card-body">
                @if (s.lines.length) {
                  <table class="data"><thead><tr><th>{{ 'item' | t }}</th><th class="num">{{ 'loaded' | t }}</th><th class="num">{{ 'delivered' | t }}</th><th class="num">{{ 'returned' | t }}</th></tr></thead>
                    <tbody>@for (l of s.lines; track l.id) { <tr><td>{{ l.label }}</td><td class="num">{{ l.loadedQty }}</td><td class="num">{{ s.status === 'PENDING' ? '' : l.deliveredQty }}</td><td class="num">{{ s.status === 'PENDING' ? '' : l.returnedQty }}</td></tr> }</tbody></table>
                }
                <div class="row" style="margin-top:8px">
                  @if (s.invoiceNo) { <span>{{ 'total' | t }}: <strong class="num">{{ s.total | money }}</strong></span> }
                  <span>{{ 'outstandingNow' | t }}: <strong class="num">{{ s.outstanding | money }}</strong></span>
                  <span>{{ 'expected' | t }}: <strong class="num">{{ s.expected | money }}</strong></span>
                  @if (s.status !== 'PENDING') { <span>{{ 'collected' | t }}: <strong class="num">{{ s.collected | money }}</strong></span> }
                  <span class="spacer"></span>
                  @if (s.status === 'PENDING' && h.status !== 'COMPLETED' && canExecute()) { <button class="btn primary no-print" (click)="openVisit(s)">{{ 'recordVisit' | t }}</button> }
                </div>
                <div class="print-only small" style="margin-top:10px">{{ 'collected' | t }}: __________ &nbsp; {{ 'acknowledgedBy' | t }}: __________________</div>
              </div>
            </div>
          } @empty { <div class="card empty">{{ 'noData' | t }}</div> }
        </div>
      </div>

      @if (recon(); as r) {
        <app-modal [title]="'reconciliation' | t" [wide]="true" (closed)="recon.set(null)">
          <div class="stack">
            <table class="data">
              <thead><tr><th>{{ 'item' | t }}</th><th class="num">{{ 'loaded' | t }}</th><th class="num">{{ 'delivered' | t }}</th><th class="num">{{ 'returned' | t }}</th><th class="num">{{ 'pending' | t }}</th></tr></thead>
              <tbody>@for (g of r.goods; track $index) {
                <tr><td>{{ i18n.pick(g.product, g.productUr) }} {{ g.packetGrams }} g</td><td class="num">{{ g.loaded }}</td><td class="num">{{ g.delivered }}</td><td class="num">{{ g.returned }}</td><td class="num">{{ g.pending }}</td></tr>
              }</tbody>
            </table>
            <div class="grid grid-4">
              <div class="card kpi"><span class="label">{{ 'expected' | t }}</span><span class="value">{{ r.money.expected | money }}</span></div>
              <div class="card kpi good"><span class="label">{{ 'collected' | t }}</span><span class="value">{{ r.money.collected | money }}</span></div>
              <div class="card kpi"><span class="label">{{ 'outstanding' | t }}</span><span class="value">{{ r.money.outstanding | money }}</span></div>
              <div class="card kpi"><span class="label">{{ 'deliveryExpenses' | t }}</span><span class="value">{{ r.money.expenses | money }}</span></div>
            </div>
            @if (sync.pending() > 0) { <div class="alert warn">{{ 'pendingSync' | t: sync.pending() }}</div> }
          </div>
          <ng-container foot><button class="btn" (click)="recon.set(null)">{{ 'close' | t }}</button></ng-container>
        </app-modal>
      }

      @if (visit(); as v) {
        <app-modal [title]="('recordVisit' | t) + ' — ' + v.stop.customer" (closed)="visit.set(null)">
          <div class="stack">
            <div class="row">
              @for (st of ['DELIVERED','PARTIAL','FAILED']; track st) {
                <button class="btn" [class.primary]="v.status === st" (click)="v.status = st">{{ st | t }}</button>
              }
            </div>
            @if (v.status === 'PARTIAL') {
              <table class="data"><thead><tr><th>{{ 'item' | t }}</th><th class="num">{{ 'loaded' | t }}</th><th class="num">{{ 'delivered' | t }}</th></tr></thead>
                <tbody>@for (l of v.stop.lines; track l.id) {
                  <tr><td>{{ l.label }}</td><td class="num">{{ l.loadedQty }}</td><td style="width:110px"><input type="number" min="0" [max]="l.loadedQty" [(ngModel)]="v.delivered[l.id]" /></td></tr>
                }</tbody></table>
            }
            @if (v.status === 'FAILED') { <div class="field"><label>{{ 'failReason' | t }} *</label><input [(ngModel)]="v.failReason" /></div> }
            <div class="form-grid">
              <div class="field"><label>{{ 'collectedAmount' | t }}</label><input type="number" min="0" [(ngModel)]="v.collected" /></div>
              <div class="field"><label>{{ 'method' | t }}</label><select [(ngModel)]="v.method">@for (m of ['CASH','BANK','WALLET']; track m) { <option [value]="m">{{ m | t }}</option> }</select></div>
              <div class="field"><label>{{ 'acknowledgedBy' | t }}</label><input [(ngModel)]="v.acknowledgedBy" /></div>
              <div class="field"><label>{{ 'nextVisit' | t }}</label><input type="date" [(ngModel)]="v.nextVisitDate" /></div>
              <div class="field span-all"><label>{{ 'notes' | t }}</label><input [(ngModel)]="v.notes" /></div>
            </div>
            @if (v.status !== 'DELIVERED' && v.stop.invoiceNo) { <div class="alert info">{{ 'goodsReturnedWarehouse' | t }}</div> }
          </div>
          <ng-container foot><button class="btn" (click)="visit.set(null)">{{ 'cancel' | t }}</button>
            <button class="btn primary" (click)="saveVisit(v)" [disabled]="busy() || (v.status === 'FAILED' && !v.failReason?.trim())">{{ 'save' | t }}</button></ng-container>
        </app-modal>
      }
    } @else { <div class="empty">{{ 'loading' | t }}</div> }
  </div>`,
  styles: [`.sheet-head { display: flex; gap: 28px; flex-wrap: wrap; margin-bottom: 8px; }
    .seq { width: 28px; height: 28px; border-radius: 50%; background: var(--navy-700); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-family: var(--font); }
    .stop.done { opacity: .8; } .stop.done .seq { background: var(--ok); }
    @media print { .stop { break-inside: avoid; border: 1px solid #999 !important; } }`],
})
export class DeliveryRunPage implements OnInit {
  head = signal<any>(null); stops = signal<StopVm[]>([]); recon = signal<any>(null); visit = signal<any>(null); busy = signal(false);
  private offline = false;
  private id = '';

  constructor(private route: ActivatedRoute, public api: Api, public auth: Auth, public i18n: I18n, private store: Store, public sync: Sync, private toast: Toast) {}

  pendingStops() { return this.stops().filter(s => s.status === 'PENDING').length; }
  totalExpected() { return this.stops().reduce((s, x) => s + x.expected, 0); }
  canExecute() { return this.auth.can('delivery.manage') || this.head()?.assignedUserId === this.auth.user()?.id || this.offline; }

  async ngOnInit() { this.id = this.route.snapshot.paramMap.get('id')!; await this.load(); }

  async load() {
    const local = await db.deliveries.get(this.id);
    const balances = await this.store.balanceMap();
    if (this.api.online()) {
      try {
        const d: any = await this.api.get(`/api/deliveries/${this.id}`);
        this.offline = false;
        this.head.set(d);
        this.stops.set(d.stops.map((s: any) => {
          const ls = local?.stops.find(x => x.id === s.id);
          const pendingLocal = !!ls?.localUpdate && s.status === 'PENDING';
          return {
            id: s.id, seq: s.seq, status: pendingLocal ? ls!.status : s.status, customerId: s.customer.id, customer: s.customer.shopName,
            address: [s.customer.address, s.customer.area].filter(Boolean).join(', '), phone: s.customer.phone ?? '', invoiceId: s.invoice?.id, invoiceNo: s.invoice?.invoiceNo,
            total: Number(s.invoice?.total ?? 0), expected: Number(s.expectedCollection), collected: pendingLocal ? ls!.collectedAmount : Number(s.collectedAmount),
            outstanding: balances[s.customer.id] ?? Number(s.outstanding), local: pendingLocal,
            lines: s.lines.map((l: any) => {
              const ll = pendingLocal ? ls!.lines?.find(x => x.id === l.id) : null;
              return { id: l.id, label: this.i18n.isUr() && l.descriptionUr ? l.descriptionUr : l.description, loadedQty: l.loadedQty,
                deliveredQty: ll?.deliveredQty ?? l.deliveredQty, returnedQty: ll?.returnedQty ?? l.returnedQty };
            }),
          } as StopVm;
        }));
        return;
      } catch { /* fall back to the device copy */ }
    }
    if (!local) return;
    this.offline = true;
    const [custs, vars, prods, invs] = await Promise.all([db.customers.toArray(), db.variations.toArray(), db.products.toArray(), db.invoices.toArray()]);
    const cm = new Map(custs.map(c => [c.id, c])); const vm = new Map(vars.map(v => [v.id, v])); const pm = new Map(prods.map(p => [p.id, p])); const im = new Map(invs.map(i => [i.id, i]));
    this.head.set({ ...local, route: local.routeName, assignedTo: this.auth.user()?.fullName, assignedUserId: this.auth.user()?.id });
    this.stops.set(local.stops.map(s => {
      const c = cm.get(s.customerId); const inv = s.invoiceId ? im.get(s.invoiceId) : undefined;
      return {
        id: s.id, seq: s.seq, status: s.status, customerId: s.customerId, customer: c?.shopName ?? '?', address: [c?.address, c?.area].filter(Boolean).join(', '),
        phone: c?.phone ?? '', invoiceId: s.invoiceId, invoiceNo: inv?.invoiceNo, total: inv?.total ?? 0, expected: s.expectedCollection, collected: s.collectedAmount,
        outstanding: balances[s.customerId] ?? 0, local: !!s.localUpdate,
        lines: (s.lines ?? []).map(l => { const v = vm.get(l.variationId); const p = v ? pm.get(v.productId) : undefined;
          return { id: l.id, label: `${this.i18n.pick(p?.name, p?.nameUr)} ${v?.packetGrams ?? ''} g`, loadedQty: l.loadedQty, deliveredQty: l.deliveredQty, returnedQty: l.returnedQty }; }),
      };
    }));
  }

  openVisit(s: StopVm) {
    const delivered: Record<string, number> = {}; s.lines.forEach(l => (delivered[l.id] = l.loadedQty));
    this.visit.set({ stop: s, status: 'DELIVERED', delivered, collected: Math.max(0, s.expected), method: 'CASH', failReason: '', acknowledgedBy: '', notes: '', nextVisitDate: '' });
  }

  async saveVisit(v: any) {
    this.busy.set(true);
    try {
      const inDevice = !!(await db.deliveries.get(this.id));
      if (inDevice) {
        await this.store.updateStop(this.id, v.stop.id, v.status, v.delivered, +v.collected || 0, v.method, v.failReason, v.acknowledgedBy, v.notes, v.nextVisitDate || null);
        this.sync.kick();
      } else {
        // A manager recording a stop of someone else's run: straight to the server.
        await this.api.post('/api/deliveries/stops', { stopId: v.stop.id, status: v.status,
          lines: v.stop.lines.map((l: any) => ({ lineId: l.id, deliveredQty: +v.delivered[l.id] || 0 })), failReason: v.failReason || null,
          collectedAmount: +v.collected || 0, collectionMethod: v.method, acknowledgedBy: v.acknowledgedBy || null, notes: v.notes || null, nextVisitDate: v.nextVisitDate || null });
        await this.sync.run();
      }
      this.toast.ok(this.i18n.t('savedOk')); this.visit.set(null); await this.load();
    } catch (e) { this.toast.error(e); }
    finally { this.busy.set(false); }
  }

  async start() { try { await this.api.post(`/api/deliveries/${this.id}/start`); await this.sync.run(); await this.load(); } catch (e) { this.toast.error(e); } }
  async complete() { try { await this.api.post(`/api/deliveries/${this.id}/complete`); await this.sync.run(); await this.load(); this.loadRecon(); } catch (e) { this.toast.error(e); } }
  async loadRecon() { try { this.recon.set(await this.api.get(`/api/deliveries/${this.id}/reconciliation`)); } catch (e) { this.toast.error(e); } }
  print() { printArea('a4'); }
}
