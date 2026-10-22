import { Component, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { MoneyPipe, PkDatePipe, downloadText, money, monthStart, num, pkDate, pkToday, toCsv, weight } from '../core/format';
import { I18n, TPipe } from '../core/i18n';
import { printArea } from '../shared/invoice-doc';
import { SHARED, Toast } from '../shared/ui';

type Fmt = 'money' | 'num' | 'grams' | 'date' | 'datetime' | 'text' | 'pct';
interface Col { key: string; label: string; fmt?: Fmt; total?: boolean; }
interface ReportDef { id: string; label: string; perm: string; url: string; group?: string[]; cols: (g: string) => Col[]; pick?: (r: any) => any[]; noDates?: boolean; }

const SALES_GROUPS = ['product', 'variation', 'size', 'customer', 'area', 'salesperson', 'payment', 'day', 'month'];
const GROUP_KEY: Record<string, string> = { product: 'byProduct', variation: 'byVariation', size: 'bySize', customer: 'byCustomer', area: 'byArea',
  salesperson: 'bySalesperson', payment: 'byPayment', day: 'byDay', month: 'byMonth', supplier: 'bySupplier' };

const REPORTS: ReportDef[] = [
  { id: 'sales', label: 'salesReport', perm: 'reports.view', url: '/api/reports/sales', group: SALES_GROUPS, cols: () => [
    { key: 'label', label: 'name' }, { key: 'invoices', label: 'invoices', fmt: 'num', total: true }, { key: 'packets', label: 'packets', fmt: 'num', total: true },
    { key: 'grams', label: 'quantity', fmt: 'grams', total: true }, { key: 'discounts', label: 'discounts', fmt: 'money', total: true },
    { key: 'amount', label: 'amount', fmt: 'money', total: true }, { key: 'cost', label: 'cost', fmt: 'money', total: true },
    { key: 'grossProfit', label: 'grossProfit', fmt: 'money', total: true }, { key: 'returnedPackets', label: 'returned', fmt: 'num', total: true }] },
  { id: 'stock', label: 'inventoryReport', perm: 'inventory.view', url: '/api/inventory/stock', noDates: true, pick: r => r.finished, cols: () => [
    { key: 'name', label: 'name' }, { key: 'packetGrams', label: 'packetGrams', fmt: 'num' }, { key: 'sku', label: 'sku' },
    { key: 'packets', label: 'saleable', fmt: 'num', total: true }, { key: 'damaged', label: 'damaged', fmt: 'num', total: true },
    { key: 'avgCost', label: 'unitCost', fmt: 'money' }, { key: 'value', label: 'value', fmt: 'money', total: true }] },
  { id: 'bulk', label: 'bulkStock', perm: 'inventory.view', url: '/api/inventory/stock', noDates: true, pick: r => r.bulk, cols: () => [
    { key: 'name', label: 'name' }, { key: 'batchNo', label: 'batchNo' }, { key: 'receivedAt', label: 'received', fmt: 'date' }, { key: 'expiryDate', label: 'expiryDate', fmt: 'date' },
    { key: 'grams', label: 'remaining', fmt: 'grams', total: true }, { key: 'costPerKg', label: 'costPerKg', fmt: 'money' }, { key: 'value', label: 'value', fmt: 'money', total: true }] },
  { id: 'materials', label: 'materials', perm: 'inventory.view', url: '/api/inventory/stock', noDates: true, pick: r => r.materials, cols: () => [
    { key: 'name', label: 'name' }, { key: 'kind', label: 'kind' }, { key: 'quantity', label: 'inStock', fmt: 'num', total: true }, { key: 'minimum', label: 'minStock', fmt: 'num' },
    { key: 'avgCost', label: 'avgCost', fmt: 'money' }, { key: 'value', label: 'value', fmt: 'money', total: true }] },
  { id: 'packing', label: 'packingReport', perm: 'reports.view', url: '/api/reports/packing', cols: () => [
    { key: 'orderNo', label: 'orderNo' }, { key: 'packDate', label: 'packDate', fmt: 'date' }, { key: 'product', label: 'name' }, { key: 'packetGrams', label: 'packetGrams', fmt: 'num' },
    { key: 'batchNo', label: 'batchNo' }, { key: 'planned', label: 'planned', fmt: 'num', total: true }, { key: 'produced', label: 'produced', fmt: 'num', total: true },
    { key: 'rejected', label: 'rejected', fmt: 'num', total: true }, { key: 'lossGrams', label: 'lossGrams', fmt: 'grams', total: true }, { key: 'consumedGrams', label: 'consumed', fmt: 'grams', total: true },
    { key: 'yieldPercent', label: 'yield', fmt: 'pct' }, { key: 'materialCost', label: 'materials', fmt: 'money', total: true }, { key: 'totalCost', label: 'cost', fmt: 'money', total: true },
    { key: 'unitCost', label: 'unitCost', fmt: 'money' }] },
  { id: 'purchases', label: 'purchaseReport', perm: 'reports.view', url: '/api/reports/purchases', group: ['supplier', 'product'], cols: g => g === 'product'
    ? [{ key: 'label', label: 'name' }, { key: 'type', label: 'type' }, { key: 'quantity', label: 'quantity', fmt: 'num', total: true }, { key: 'amount', label: 'amount', fmt: 'money', total: true }, { key: 'avgRate', label: 'rate', fmt: 'money' }]
    : [{ key: 'label', label: 'supplier' }, { key: 'purchases', label: 'purchases', fmt: 'num', total: true }, { key: 'amount', label: 'amount', fmt: 'money', total: true },
       { key: 'paidAtPurchase', label: 'amountPaid', fmt: 'money', total: true }, { key: 'currentBalance', label: 'balance', fmt: 'money', total: true }] },
  { id: 'deliveries', label: 'deliveryReport', perm: 'reports.view', url: '/api/reports/deliveries', cols: () => [
    { key: 'deliveryNo', label: 'deliveryNo' }, { key: 'date', label: 'date', fmt: 'date' }, { key: 'route', label: 'route' }, { key: 'assignedTo', label: 'assignedTo' },
    { key: 'stops', label: 'stops', fmt: 'num', total: true }, { key: 'delivered', label: 'DELIVERED', fmt: 'num', total: true }, { key: 'partial', label: 'PARTIAL', fmt: 'num', total: true },
    { key: 'failed', label: 'FAILED', fmt: 'num', total: true }, { key: 'pending', label: 'pending', fmt: 'num', total: true },
    { key: 'expected', label: 'expected', fmt: 'money', total: true }, { key: 'collected', label: 'collected', fmt: 'money', total: true }, { key: 'expenses', label: 'expenses', fmt: 'money', total: true }] },
  { id: 'expenses', label: 'expenseReport', perm: 'reports.financial', url: '/api/reports/expenses', cols: () => [
    { key: 'category', label: 'category' }, { key: 'count', label: 'qty', fmt: 'num', total: true }, { key: 'amount', label: 'amount', fmt: 'money', total: true }] },
];

@Component({
  standalone: true,
  imports: [FormsModule, MoneyPipe, PkDatePipe, ...SHARED],
  template: `
  <div class="page">
    <div class="page-head no-print"><h1>{{ 'reports' | t }}</h1></div>
    <div class="tabs no-print">
      @for (r of available; track r.id) { <button [class.active]="tab() === r.id" (click)="select(r.id)">{{ r.label | t }}</button> }
      @if (auth.can('reports.financial')) {
        <button [class.active]="tab() === 'pl'" (click)="select('pl')">{{ 'profitLoss' | t }}</button>
        <button [class.active]="tab() === 'cash'" (click)="select('cash')">{{ 'cashBook' | t }}</button>
      }
      @if (auth.can('audit.view')) { <button [class.active]="tab() === 'audit'" (click)="select('audit')">{{ 'auditLog' | t }}</button> }
    </div>
    @if (!api.online()) { <div class="card empty">{{ 'onlineOnly' | t }}</div> } @else {
      <div class="card card-body toolbar no-print" style="margin-bottom:12px">
        @if (!def()?.noDates && tab() !== 'audit') {
          <div class="field"><label>{{ 'from' | t }}</label><input type="date" [(ngModel)]="from" /></div>
          <div class="field"><label>{{ 'to' | t }}</label><input type="date" [(ngModel)]="to" /></div>
        }
        @if (def()?.group; as groups) {
          <div class="field"><label>{{ 'groupBy' | t }}</label><select [(ngModel)]="groupBy">@for (g of groups; track g) { <option [value]="g">{{ groupKey(g) | t }}</option> }</select></div>
        }
        @if (tab() === 'audit') { <div class="field grow"><label>{{ 'search' | t }}</label><input [(ngModel)]="auditQ" (keyup.enter)="run()" /></div> }
        <button class="btn primary" (click)="run()">{{ 'apply' | t }}</button>
        <span class="spacer"></span>
        <button class="btn" (click)="exportCsv()" [disabled]="!rows().length && tab() !== 'pl'">{{ 'export' | t }}</button>
        <button class="btn" (click)="print()">{{ 'print' | t }}</button>
      </div>

      <div class="print-area">
        <div class="print-only"><h2>{{ title() | t }}</h2><p>{{ from | pkdate }} – {{ to | pkdate }}</p></div>
        @if (tab() === 'pl') {
          @if (pl(); as p) {
            <div class="card"><table class="data pl">
              <tbody>
                <tr><td>{{ 'salesInPeriod' | t }} ({{ p.summary.invoices }} {{ 'invoicesCount' | t }})</td><td class="num">{{ p.summary.salesTotal | money }}</td></tr>
                <tr><td class="ind">{{ 'returns' | t }}</td><td class="num">-{{ p.summary.returnsTotal | money }}</td></tr>
                <tr class="sub"><td>{{ 'netSales' | t }}</td><td class="num">{{ p.summary.netSales | money }}</td></tr>
                <tr><td class="ind">{{ 'cogs' | t }}</td><td class="num">-{{ p.summary.cogs | money }}</td></tr>
                <tr class="sub"><td>{{ 'grossProfit' | t }}</td><td class="num">{{ p.summary.grossProfit | money }}</td></tr>
                @for (e of p.expenses; track e.category) { <tr><td class="ind">{{ e.category | t }}</td><td class="num">-{{ e.amount | money }}</td></tr> }
                @if (p.summary.capitalisedLabour > 0) { <tr><td class="ind">{{ 'capitalised' | t }}</td><td class="num">+{{ p.summary.capitalisedLabour | money }}</td></tr> }
                <tr><td class="ind">{{ 'stockLosses' | t }}</td><td class="num">-{{ p.summary.stockLosses | money }}</td></tr>
                <tr class="total"><td>{{ 'netProfit' | t }}</td><td class="num" [style.color]="p.summary.netProfit < 0 ? 'var(--bad)' : 'var(--ok)'">{{ p.summary.netProfit | money }}</td></tr>
              </tbody>
            </table></div>
            <p class="small muted"><strong>{{ 'costingMethod' | t }}:</strong> {{ p.method }} {{ 'provisionalProfit' | t }}</p>
          }
        } @else if (tab() === 'cash') {
          @if (cash(); as c) {
            <div class="grid grid-3" style="margin-bottom:12px">
              @for (a of c.accounts; track a.accountId) {
                <div class="card kpi"><span class="label">{{ i18n.pick(a.name, a.nameUr) }}</span><span class="value">{{ a.closing | money }}</span>
                  <span class="sub">{{ 'opening' | t }} {{ a.opening | money }} · {{ 'moneyIn' | t }} {{ a.moneyIn | money }} · {{ 'moneyOut' | t }} {{ a.moneyOut | money }}</span></div>
              }
            </div>
            <div class="card table-wrap"><table class="data">
              <thead><tr><th>{{ 'date' | t }}</th><th>{{ 'account' | t }}</th><th>{{ 'type' | t }}</th><th>{{ 'description' | t }}</th><th class="num">{{ 'moneyIn' | t }}</th><th class="num">{{ 'moneyOut' | t }}</th><th>{{ 'user' | t }}</th></tr></thead>
              <tbody>@for (r of c.rows; track $index) {
                <tr><td class="nowrap">{{ r.at | pkdate: true }}</td><td>{{ r.account }}</td><td class="small">{{ r.type }}</td><td>{{ r.description }}</td>
                  <td class="num">{{ r.moneyIn ? (r.moneyIn | money) : '' }}</td><td class="num">{{ r.moneyOut ? (r.moneyOut | money) : '' }}</td><td class="small">{{ r.user }}</td></tr>
              } @empty { <tr><td colspan="7" class="empty">{{ 'noData' | t }}</td></tr> }</tbody>
            </table></div>
          }
        } @else if (tab() === 'audit') {
          <div class="card table-wrap"><table class="data">
            <thead><tr><th>{{ 'time' | t }}</th><th>{{ 'user' | t }}</th><th>{{ 'device' | t }}</th><th>{{ 'actions' | t }}</th><th>{{ 'type' | t }}</th><th>{{ 'description' | t }}</th></tr></thead>
            <tbody>@for (a of rows(); track a.id) {
              <tr><td class="nowrap small">{{ a.occurredAt | pkdate: true }}</td><td>{{ a.user }}</td><td class="ltr">{{ a.device }}</td><td><span class="badge grey">{{ a.action }}</span></td><td class="small">{{ a.entityType }}</td><td>{{ a.summary }}</td></tr>
            } @empty { <tr><td colspan="6" class="empty">{{ 'noData' | t }}</td></tr> }</tbody>
          </table></div>
        } @else if (def()) {
          <div class="card table-wrap"><table class="data">
            <thead><tr>@for (c of cols(); track c.key) { <th [class.num]="isNum(c)">{{ c.label | t }}</th> }</tr></thead>
            <tbody>@for (r of rows(); track $index) {
              <tr>@for (c of cols(); track c.key) { <td [class.num]="isNum(c)">{{ fmt(r, c) }}</td> }</tr>
            } @empty { <tr><td [attr.colspan]="cols().length" class="empty">{{ 'noData' | t }}</td></tr> }</tbody>
            @if (rows().length) {
              <tfoot><tr>@for (c of cols(); track c.key; let first = $first) { <td [class.num]="isNum(c)">{{ first ? ('total' | t) : (c.total ? fmtVal(totalOf(c.key), c.fmt) : '') }}</td> }</tr></tfoot>
            }
          </table></div>
        }
      </div>
    }
  </div>`,
  styles: [`.pl td { padding: 10px 16px; } .pl .ind { padding-inline-start: 36px; color: var(--text-2); } .pl .sub td { font-weight: 600; border-top: 1px solid var(--border-strong); }
            .pl .total td { font-weight: 700; font-size: 16px; background: var(--navy-50); }`],
})
export class ReportsPage implements OnInit {
  available: ReportDef[] = [];
  tab = signal('sales');
  rows = signal<any[]>([]); pl = signal<any>(null); cash = signal<any>(null);
  from = monthStart(); to = pkToday(); groupBy = 'product'; auditQ = '';
  def = computed(() => REPORTS.find(r => r.id === this.tab()));
  cols = signal<Col[]>([]);
  title = computed(() => this.def()?.label ?? ({ pl: 'profitLoss', cash: 'cashBook', audit: 'auditLog' } as any)[this.tab()]);

  constructor(public api: Api, public auth: Auth, public i18n: I18n, private toast: Toast) {}

  ngOnInit() {
    this.available = REPORTS.filter(r => this.auth.can(r.perm));
    if (this.available.length) this.select(this.available[0].id);
  }

  groupKey(g: string) { return GROUP_KEY[g] ?? g; }

  select(id: string) {
    this.tab.set(id); this.rows.set([]);
    const d = REPORTS.find(r => r.id === id);
    if (d?.group && !d.group.includes(this.groupBy)) this.groupBy = d.group[0];
    this.run();
  }

  async run() {
    if (!this.api.online()) return;
    try {
      const t = this.tab();
      if (t === 'pl') { this.pl.set(await this.api.get('/api/reports/profit-loss', { from: this.from, to: this.to })); return; }
      if (t === 'cash') { this.cash.set(await this.api.get('/api/reports/cash-book', { from: this.from, to: this.to })); return; }
      if (t === 'audit') { this.rows.set((await this.api.get<any>('/api/audit-logs', { q: this.auditQ, pageSize: 200 })).items); return; }
      const d = this.def()!;
      const r = await this.api.get<any>(d.url, d.noDates ? {} : { from: this.from, to: this.to, groupBy: d.group ? this.groupBy : undefined });
      this.cols.set(d.cols(this.groupBy).filter(c => this.auth.can('reports.financial') || !['cost', 'grossProfit', 'value', 'avgCost', 'unitCost', 'costPerKg', 'totalCost', 'materialCost'].includes(c.key)));
      this.rows.set(d.pick ? d.pick(r) : r);
    } catch (e) { this.toast.error(e); }
  }

  isNum(c: Col) { return !!c.fmt && c.fmt !== 'text' && c.fmt !== 'date' && c.fmt !== 'datetime'; }
  totalOf(key: string) { return this.rows().reduce((s, r) => s + (Number(r[key]) || 0), 0); }
  fmt(r: any, c: Col): string {
    let v = r[c.key];
    if (c.key === 'label' && r.labelUr && this.i18n.isUr() && this.groupBy !== 'customer') v = r.labelUr;
    if (c.key === 'label' && this.groupBy === 'payment') v = this.i18n.t(v);
    if ((c.key === 'name' || c.key === 'product') && (r.nameUr || r.productUr)) v = this.i18n.pick(v, r.nameUr ?? r.productUr);
    if (c.key === 'category' || c.key === 'kind') v = this.i18n.t(v);
    return this.fmtVal(v, c.fmt);
  }
  fmtVal(v: any, f?: Fmt): string {
    if (v === null || v === undefined || v === '') return '';
    switch (f) {
      case 'money': return money(v);
      case 'num': return num(v);
      case 'grams': return weight(v, this.i18n.isUr());
      case 'pct': return `${num(v)}%`;
      case 'date': return pkDate(v);
      case 'datetime': return pkDate(v, true);
      default: return String(v);
    }
  }

  exportCsv() {
    const t = this.tab();
    if (t === 'pl' && this.pl()) {
      const s = this.pl().summary;
      downloadText('profit-loss.csv', toCsv(Object.entries(s).map(([k, v]) => ({ k, v })), [{ key: 'k', label: 'Item' }, { key: 'v', label: 'Amount' }]));
    } else if (t === 'cash' && this.cash()) {
      downloadText('cash-book.csv', toCsv(this.cash().rows, ['at', 'account', 'type', 'description', 'moneyIn', 'moneyOut', 'user'].map(k => ({ key: k, label: k }))));
    } else if (t === 'audit') {
      downloadText('audit-log.csv', toCsv(this.rows(), ['occurredAt', 'user', 'device', 'action', 'entityType', 'summary'].map(k => ({ key: k, label: k }))));
    } else {
      downloadText(`${t}-${this.from}-${this.to}.csv`, toCsv(this.rows(), this.cols().map(c => ({ key: c.key, label: I18n.translate('en', c.label) }))));
    }
  }

  print() { printArea('a4'); }
}
