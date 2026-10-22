import { Component, OnInit, computed, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { db } from '../core/db';
import { MoneyPipe, NumPipe, PkDatePipe, WeightPipe, monthStart, pkToday } from '../core/format';
import { I18n, TPipe } from '../core/i18n';
import { Store } from '../core/store';
import { Sync } from '../core/sync';
import { SHARED } from '../shared/ui';

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink, MoneyPipe, NumPipe, PkDatePipe, WeightPipe, ...SHARED],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>{{ 'dashboard' | t }}</h1>
      @if (canReport) {
        <div class="row">
          <button class="btn sm" [class.primary]="preset() === 'today'" (click)="setPreset('today')">{{ 'today' | t }}</button>
          <button class="btn sm" [class.primary]="preset() === 'month'" (click)="setPreset('month')">{{ 'thisMonth' | t }}</button>
          <input type="date" [(ngModel)]="from" (change)="preset.set('custom'); load()" style="width:150px" />
          <input type="date" [(ngModel)]="to" (change)="preset.set('custom'); load()" style="width:150px" />
        </div>
      }
    </div>

    <!-- always available: this device -->
    <div class="grid grid-4" style="margin-bottom:16px">
      <div class="card kpi"><span class="label">{{ 'localToday' | t }}</span><span class="value">{{ local().sales | money }}</span><span class="sub">{{ local().count }} {{ 'invoicesCount' | t }}</span></div>
      <div class="card kpi" [class.alert]="sync.pending() > 0"><span class="label">{{ 'unsyncedDevice' | t }}</span><span class="value">{{ sync.pending() }}</span>
        <span class="sub">{{ 'lastSync' | t }}: {{ sync.lastSync() ? (sync.lastSync() | pkdate: true) : ('never' | t) }}</span></div>
      <div class="card kpi"><span class="label">{{ 'collections' | t }} ({{ 'today' | t }})</span><span class="value">{{ local().collected | money }}</span><span class="sub">{{ 'localToday' | t }}</span></div>
      <div class="card kpi"><span class="label">{{ 'pendingDeliveries' | t }}</span><span class="value">{{ local().deliveries }}</span><span class="sub"><a routerLink="/deliveries">{{ 'myDeliveries' | t }}</a></span></div>
    </div>

    @if (!canReport) {
      <div class="alert info">{{ 'reports' | t }}: —</div>
    } @else if (!api.online() && !data()) {
      <div class="alert info">{{ 'onlineOnly' | t }}</div>
    } @else {
      @if (data(); as d) {
      @if (!api.online()) { <div class="alert info" style="margin-bottom:12px">{{ 'showingCached' | t }}</div> }
      <div class="grid grid-4" style="margin-bottom:16px">
        <div class="card kpi"><span class="label">{{ 'netSales' | t }}</span><span class="value">{{ d.profit.netSales | money }}</span><span class="sub">{{ d.profit.invoices }} {{ 'invoicesCount' | t }} · {{ 'creditSales' | t }} {{ d.profit.creditSales | money }}</span></div>
        <div class="card kpi"><span class="label">{{ 'purchasesInPeriod' | t }}</span><span class="value">{{ d.totals.purchases | money }}</span></div>
        <div class="card kpi"><span class="label">{{ 'collections' | t }}</span><span class="value">{{ d.totals.collections | money }}</span></div>
        <div class="card kpi"><span class="label">{{ 'cashInHand' | t }}</span><span class="value">{{ d.totals.cashInHand | money }}</span><span class="sub">{{ 'bankWallet' | t }} {{ d.totals.bankAndWallet | money }}</span></div>
        <div class="card kpi"><span class="label">{{ 'receivables' | t }}</span><span class="value">{{ d.totals.receivables | money }}</span></div>
        <div class="card kpi"><span class="label">{{ 'payables' | t }}</span><span class="value">{{ d.totals.payables | money }}</span></div>
        <div class="card kpi"><span class="label">{{ 'stockValue' | t }}</span><span class="value">{{ d.totals.stockValue | money }}</span></div>
        <div class="card kpi"><span class="label">{{ 'pendingDeliveries' | t }} / {{ 'returnsCount' | t }}</span><span class="value">{{ d.totals.pendingDeliveries }} / {{ d.totals.returnsCount }}</span></div>
        @if (auth.can('reports.financial')) {
          <div class="card kpi good"><span class="label">{{ 'grossProfit' | t }}</span><span class="value">{{ d.profit.grossProfit | money }}</span><span class="sub">{{ 'netSales' | t }} {{ d.profit.netSales | money }}</span></div>
          <div class="card kpi" [class.alert]="d.profit.netProfit < 0" [class.good]="d.profit.netProfit >= 0"><span class="label">{{ 'netProfit' | t }}</span><span class="value">{{ d.profit.netProfit | money }}</span><span class="sub">{{ 'expenses' | t }} {{ d.profit.expenses | money }}</span></div>
        }
        <div class="card kpi" [class.alert]="d.totals.openConflicts > 0"><span class="label">{{ 'openConflicts' | t }}</span><span class="value">{{ d.totals.openConflicts }}</span><span class="sub"><a routerLink="/sync">{{ 'sync' | t }}</a></span></div>
        <div class="card kpi" [class.alert]="d.lowStock.length > 0"><span class="label">{{ 'lowStock' | t }}</span><span class="value">{{ d.lowStock.length }}</span></div>
      </div>
      @if (auth.can('reports.financial')) { <p class="small muted">{{ 'provisionalProfit' | t }}</p> }

      <div class="grid grid-2" style="margin-bottom:16px">
        <div class="card">
          <div class="card-head"><h2>{{ 'salesTrend' | t }}</h2></div>
          <div class="card-body">
            @if (maxTrend() > 0) {
              <svg [attr.viewBox]="'0 0 ' + chartW + ' 180'" class="chart" role="img" [attr.aria-label]="'salesTrend' | t">
                @for (p of d.trend; track p.date; let i = $index) {
                  <rect [attr.x]="i * barW() + 2" [attr.y]="160 - (p.sales / maxTrend()) * 150" [attr.width]="barW() - 4" [attr.height]="(p.sales / maxTrend()) * 150" rx="2" fill="var(--navy-600)">
                    <title>{{ p.date | pkdate }}: {{ p.sales | money }} ({{ p.invoices }})</title>
                  </rect>
                }
                <line x1="0" y1="160" [attr.x2]="chartW" y2="160" stroke="var(--border-strong)" />
                <text x="2" y="176" font-size="10" fill="var(--text-3)">{{ d.trend[0]?.date | pkdate }}</text>
                <text [attr.x]="chartW - 2" y="176" font-size="10" text-anchor="end" fill="var(--text-3)">{{ d.trend[d.trend.length - 1]?.date | pkdate }}</text>
              </svg>
            } @else { <div class="empty">{{ 'noData' | t }}</div> }
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>{{ 'topSpices' | t }}</h2></div>
          <table class="data"><tbody>
            @for (p of d.topProducts; track p.name) {
              <tr><td>{{ i18n.pick(p.name, p.nameUr) }}</td><td class="num">{{ p.grams | weight }}</td><td class="num">{{ p.packets | num }} {{ 'pkt' | t }}</td><td class="num">{{ p.amount | money }}</td></tr>
            } @empty { <tr><td class="empty">{{ 'noData' | t }}</td></tr> }
          </tbody></table>
        </div>
        <div class="card">
          <div class="card-head"><h2>{{ 'bestCustomers' | t }}</h2></div>
          <table class="data"><tbody>
            @for (c of d.topCustomers; track c.name) {
              <tr><td>{{ c.name }} <span class="small muted">{{ c.area }}</span></td><td class="num">{{ c.invoices }}</td><td class="num">{{ c.amount | money }}</td></tr>
            } @empty { <tr><td class="empty">{{ 'noData' | t }}</td></tr> }
          </tbody></table>
        </div>
        <div class="card">
          <div class="card-head"><h2>{{ 'lowStock' | t }}</h2></div>
          <table class="data"><tbody>
            @for (s of d.lowStock.slice(0, 8); track s.id) {
              <tr><td>{{ i18n.pick(s.name, s.nameUr) }} {{ s.packetGrams ? s.packetGrams + ' g' : '' }}</td><td><span class="badge grey">{{ s.kind }}</span></td>
                <td class="num" style="color:var(--bad)">{{ s.unit === 'g' ? (s.quantity | weight) : (s.quantity | num) + ' ' + s.unit }}</td>
                <td class="num muted">{{ s.unit === 'g' ? (s.minimum | weight) : (s.minimum | num) }}</td></tr>
            } @empty { <tr><td class="empty">✓</td></tr> }
            @if (d.lowStock.length > 8) { <tr><td colspan="4"><a routerLink="/reports">+ {{ d.lowStock.length - 8 }} …</a></td></tr> }
          </tbody></table>
        </div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h2>{{ 'expiring' | t }}</h2></div>
          <table class="data"><tbody>
            @for (e of d.expiring; track e.batchNo) {
              <tr><td>{{ i18n.pick(e.product, e.productUr) }}</td><td class="ltr">{{ e.batchNo }}</td><td class="num">{{ e.grams | weight }}</td>
                <td>{{ e.expiryDate | pkdate }} @if (e.expired) { <span class="badge bad">{{ 'expired' | t }}</span> }</td></tr>
            } @empty { <tr><td class="empty">✓</td></tr> }
          </tbody></table>
        </div>
        <div class="card">
          <div class="card-head"><h2>{{ 'recentActivity' | t }}</h2></div>
          <table class="data"><tbody>
            @for (a of d.activity; track $index) {
              <tr><td class="nowrap small">{{ a.at | pkdate: true }}</td><td class="small">{{ a.summary }}</td><td class="small muted">{{ a.user }}</td></tr>
            } @empty { <tr><td class="empty">{{ 'noData' | t }}</td></tr> }
          </tbody></table>
        </div>
      </div>
      } @else { <div class="empty">{{ 'loading' | t }}</div> }
    }
  </div>`,
  styles: [`.chart { width: 100%; height: 190px; }`],
})
export class DashboardPage implements OnInit {
  canReport = false;
  preset = signal<'today' | 'month' | 'custom'>('today');
  from = pkToday(); to = pkToday();
  data = signal<any>(null);
  local = signal({ sales: 0, count: 0, collected: 0, deliveries: 0 });
  chartW = 600;
  maxTrend = computed(() => Math.max(0, ...(this.data()?.trend ?? []).map((t: any) => Number(t.sales))));
  barW = computed(() => this.chartW / Math.max(1, this.data()?.trend?.length ?? 1));

  constructor(public api: Api, public auth: Auth, public sync: Sync, public i18n: I18n, private store: Store) {
    effect(() => { this.store.version(); this.loadLocal(); });
  }

  ngOnInit() { this.canReport = this.auth.can('reports.view'); this.load(); }

  setPreset(p: 'today' | 'month') { this.preset.set(p); this.from = p === 'today' ? pkToday() : monthStart(); this.to = pkToday(); this.load(); }

  async load() {
    if (!this.canReport || !this.api.online()) return;
    try { this.data.set(await this.api.get('/api/reports/dashboard', { from: this.from, to: this.to })); } catch { /* offline: keep last */ }
  }

  /** This device's figures for today, including records not yet synced (each counted once). */
  async loadLocal() {
    const today = pkToday();
    const day = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
    const me = this.auth.user()?.id;
    const inv = (await db.invoices.toArray()).filter(i => i.status === 'POSTED' && day(i.invoiceDate) === today && (i.salespersonId === me || i.syncStatus !== 'server'));
    const ops = (await db.outbox.toArray()).filter(o => day(o.createdAt) === today && o.status !== 'rejected' && o.status !== 'conflict');
    const collected = ops.reduce((s, o) => s + (o.type === 'receipt.create' ? o.payload.amount : o.type === 'invoice.create' ? o.payload.amountPaid
      : o.type === 'delivery.stop.update' ? o.payload.collectedAmount : 0), 0);
    const deliveries = (await db.deliveries.toArray()).reduce((s, d) => s + d.stops.filter(x => x.status === 'PENDING' && !x.localUpdate).length, 0);
    this.local.set({ sales: inv.reduce((s, i) => s + Math.max(0, i.total - (i.returnedAmount || 0)), 0), count: inv.length, collected, deliveries });
  }
}
