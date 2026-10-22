import { Component, EventEmitter, Input, OnInit, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { MoneyPipe, NumPipe, PkDatePipe, WeightPipe, downloadText, monthStart, pkToday, toCsv } from '../core/format';
import { I18n, TPipe } from '../core/i18n';
import { SHARED, Toast } from '../shared/ui';
import { Store } from '../core/store';
import { db } from '../core/db';

// ---------------------------------------------------------------- movement ledger (shared)
@Component({
  selector: 'app-ledger',
  standalone: true,
  imports: [FormsModule, NumPipe, PkDatePipe, MoneyPipe, ...SHARED],
  template: `
  <app-modal [title]="('stockLedger' | t) + ' — ' + title" [wide]="true" (closed)="closed.emit()">
    <div class="stack">
      <div class="toolbar">
        <div class="field"><label>{{ 'from' | t }}</label><input type="date" [(ngModel)]="from" (change)="load()" /></div>
        <div class="field"><label>{{ 'to' | t }}</label><input type="date" [(ngModel)]="to" (change)="load()" /></div>
        <button class="btn" (click)="exportCsv()">{{ 'export' | t }}</button>
      </div>
      @if (data(); as d) {
        <div class="table-wrap" style="max-height:60vh">
          <table class="data">
            <thead><tr><th>{{ 'date' | t }}</th><th>{{ 'movement' | t }}</th>@if (bucket === 'BULK') { <th>{{ 'batchNo' | t }}</th> }<th>{{ 'source' | t }}</th>
              <th class="num">{{ 'quantity' | t }}</th><th class="num">{{ 'balance' | t }}</th>@if (showCost) { <th class="num">{{ 'unitCost' | t }}</th> }<th>{{ 'user' | t }}</th></tr></thead>
            <tbody>
              <tr><td colspan="4"><em>{{ 'opening' | t }}</em></td><td></td><td class="num"><strong>{{ d.opening | num }}</strong></td><td colspan="2"></td></tr>
              @for (r of d.rows; track $index) {
                <tr><td class="nowrap small">{{ r.at | pkdate: true }}</td><td><span class="badge grey">{{ r.type }}</span>
                  @if (r.reason) { <div class="small muted">{{ r.reason }}</div> }</td>
                  @if (bucket === 'BULK') { <td class="ltr small">{{ r.batchNo }}</td> }
                  <td class="small">{{ r.sourceType }}</td>
                  <td class="num" [style.color]="r.quantity < 0 ? 'var(--bad)' : 'var(--ok)'">{{ r.quantity > 0 ? '+' : '' }}{{ r.quantity | num }}</td>
                  <td class="num">{{ d.opening + r.runningInPeriod | num }}</td>
                  @if (showCost) { <td class="num small">{{ r.unitCost | money }}</td> }
                  <td class="small">{{ r.user }}</td></tr>
              }
            </tbody>
          </table>
        </div>
        @if (d.total > d.pageSize) { <p class="small muted">{{ d.pageSize }} / {{ d.total }}</p> }
      } @else { <div class="empty">{{ 'loading' | t }}</div> }
    </div>
    <ng-container foot><button class="btn" (click)="closed.emit()">{{ 'close' | t }}</button></ng-container>
  </app-modal>`,
})
export class LedgerComponent implements OnInit {
  @Input() bucket = 'FINISHED';
  @Input() title = '';
  @Input() query: Record<string, string> = {};
  @Output() closed = new EventEmitter<void>();
  data = signal<any>(null);
  from = monthStart(); to = pkToday();
  showCost = false;
  constructor(private api: Api, private toast: Toast, auth: Auth) { this.showCost = auth.can('reports.financial'); }
  ngOnInit() { this.load(); }
  async load() {
    try { this.data.set(await this.api.get('/api/inventory/ledger', { bucket: this.bucket, ...this.query, from: this.from, to: this.to, pageSize: 500 })); }
    catch (e) { this.toast.error(e); }
  }
  exportCsv() {
    const d = this.data(); if (!d) return;
    downloadText('stock-ledger.csv', toCsv(d.rows.map((r: any) => ({ ...r, balance: d.opening + r.runningInPeriod })),
      ['at', 'item', 'batchNo', 'type', 'sourceType', 'quantity', 'balance', 'reason', 'user'].map(k => ({ key: k, label: k }))));
  }
}

// ---------------------------------------------------------------- adjustment form (shared)
@Component({
  selector: 'app-adjust',
  standalone: true,
  imports: [FormsModule, NumPipe, ...SHARED],
  template: `
  <app-modal [title]="title" (closed)="closed.emit()">
    <div class="stack">
      <div class="tabs" style="margin-bottom:0">
        <button [class.active]="mode === 'count'" (click)="mode = 'count'">{{ 'physicalCount' | t }}</button>
        <button [class.active]="mode === 'adjust'" (click)="mode = 'adjust'">{{ 'stockAdjustment' | t }}</button>
        @if (target === 'FINISHED') { <button [class.active]="mode === 'damage'" (click)="mode = 'damage'">{{ 'markDamaged' | t }}</button> }
      </div>
      <div class="row"><span class="muted">{{ 'systemQty' | t }}:</span> <strong class="num">{{ current | num }} {{ unit }}</strong></div>
      @if (mode === 'count') { <div class="field"><label>{{ 'countedQty' | t }} ({{ unit }})</label><input type="number" min="0" [(ngModel)]="value" /></div> }
      @if (mode === 'adjust') { <div class="field"><label>{{ 'adjustDelta' | t }} ({{ unit }})</label><input type="number" [(ngModel)]="value" /></div> }
      @if (mode === 'damage') { <div class="field"><label>{{ 'quantity' | t }} ({{ unit }})</label><input type="number" min="1" [(ngModel)]="value" /></div> }
      <div class="field"><label>{{ 'reason' | t }} *</label><input [(ngModel)]="reason" /></div>
    </div>
    <ng-container foot>
      <button class="btn" (click)="closed.emit()">{{ 'cancel' | t }}</button>
      <button class="btn primary" [disabled]="!reason.trim() || value === null || busy()" (click)="save()">{{ 'save' | t }}</button>
    </ng-container>
  </app-modal>`,
})
export class AdjustComponent {
  @Input() title = ''; @Input() target = 'FINISHED'; @Input() unit = '';
  @Input() current = 0; @Input() ids: { batchId?: string; variationId?: string; materialId?: string } = {};
  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>();
  mode: 'count' | 'adjust' | 'damage' = 'count';
  value: number | null = null; reason = ''; busy = signal(false);
  constructor(private api: Api, private toast: Toast, private i18n: I18n) {}
  async save() {
    this.busy.set(true);
    try {
      const v = Math.round(Number(this.value));
      let r: any;
      if (this.mode === 'count') r = await this.api.post('/api/inventory/counts', { target: this.target, ...this.ids, countedQuantity: v, reason: this.reason });
      else if (this.mode === 'adjust') r = await this.api.post('/api/inventory/adjustments', { target: this.target, ...this.ids, quantityDelta: v, reason: this.reason });
      else r = await this.api.post('/api/inventory/damage', { variationId: this.ids.variationId, quantity: v, reason: this.reason });
      this.toast.ok((r?.warnings?.[0]) ?? this.i18n.t('savedOk'));
      this.saved.emit();
    } catch (e) { this.toast.error(e); }
    finally { this.busy.set(false); }
  }
}

// ---------------------------------------------------------------- bulk page
@Component({
  standalone: true,
  imports: [FormsModule, MoneyPipe, PkDatePipe, WeightPipe, LedgerComponent, AdjustComponent, ...SHARED],
  template: `
  <div class="page">
    <div class="page-head"><h1>{{ 'bulkInventory' | t }}</h1><button class="btn" (click)="load()">{{ 'refresh' | t }}</button></div>
    @if (!api.online()) { <div class="card empty">{{ 'onlineOnly' | t }}</div> } @else {
      <div class="grid grid-3" style="margin-bottom:16px">
        @for (p of totals(); track p.productId) {
          <div class="card kpi"><span class="label">{{ i18n.pick(p.name, p.nameUr) }}</span><span class="value">{{ p.grams | weight }}</span>
            @if (showCost) { <span class="sub">{{ 'value' | t }} {{ p.value | money }}</span> }</div>
        }
      </div>
      <div class="card">
        <div class="card-head"><h2>{{ 'batches' | t }}</h2></div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>{{ 'name' | t }}</th><th>{{ 'batchNo' | t }}</th><th>{{ 'received' | t }}</th><th>{{ 'expiryDate' | t }}</th>
              <th class="num">{{ 'received' | t }}</th><th class="num">{{ 'remaining' | t }}</th>@if (showCost) { <th class="num">{{ 'costPerKg' | t }}</th><th class="num">{{ 'value' | t }}</th> }<th></th></tr></thead>
            <tbody>
              @for (b of bulk(); track b.batchId) {
                <tr><td>{{ i18n.pick(b.name, b.nameUr) }}</td><td class="ltr">{{ b.batchNo }}</td><td>{{ b.receivedAt | pkdate }}</td>
                  <td>{{ b.expiryDate | pkdate }} @if (isExpired(b.expiryDate)) { <span class="badge bad">{{ 'expired' | t }}</span> }</td>
                  <td class="num">{{ b.receivedGrams | weight }}</td><td class="num"><strong>{{ b.grams | weight }}</strong></td>
                  @if (showCost) { <td class="num">{{ b.costPerKg | money }}</td><td class="num">{{ b.value | money }}</td> }
                  <td class="right nowrap">
                    <button class="btn sm" (click)="ledger.set({ title: b.name + ' ' + b.batchNo, query: { batchId: b.batchId } })">{{ 'stockLedger' | t }}</button>
                    @if (auth.can('inventory.adjust')) { <button class="btn sm" (click)="adjust.set(b)">{{ 'adjust' | t }}</button> }
                  </td></tr>
              } @empty { <tr><td colspan="9" class="empty">{{ 'noData' | t }}</td></tr> }
            </tbody>
          </table>
        </div>
      </div>
    }
  </div>
  @if (ledger(); as l) { <app-ledger bucket="BULK" [title]="l.title" [query]="l.query" (closed)="ledger.set(null)" /> }
  @if (adjust(); as b) {
    <app-adjust [title]="b.name + ' · ' + b.batchNo" target="BULK" [unit]="'grams' | t" [current]="b.grams" [ids]="{ batchId: b.batchId }"
                (closed)="adjust.set(null)" (saved)="adjust.set(null); load()" />
  }`,
})
export class BulkPage implements OnInit {
  bulk = signal<any[]>([]); totals = signal<any[]>([]);
  ledger = signal<any>(null); adjust = signal<any>(null);
  showCost = false;
  constructor(public api: Api, public auth: Auth, public i18n: I18n, private toast: Toast) { this.showCost = auth.can('reports.financial'); }
  ngOnInit() { this.load(); }
  isExpired(d: string | null) { return !!d && d < pkToday(); }
  async load() {
    if (!this.api.online()) return;
    try {
      const s: any = await this.api.get('/api/inventory/stock');
      this.bulk.set(s.bulk);
      const m = new Map<string, any>();
      for (const b of s.bulk) {
        const t = m.get(b.productId) ?? { productId: b.productId, name: b.name, nameUr: b.nameUr, grams: 0, value: 0 };
        t.grams += Number(b.grams); t.value += Number(b.value); m.set(b.productId, t);
      }
      this.totals.set([...m.values()]);
    } catch (e) { this.toast.error(e); }
  }
}

// ---------------------------------------------------------------- finished & materials page
@Component({
  standalone: true,
  imports: [FormsModule, MoneyPipe, NumPipe, LedgerComponent, AdjustComponent, ...SHARED],
  template: `
  <div class="page">
    <div class="page-head"><h1>{{ 'finishedStock' | t }}</h1><button class="btn" (click)="load()">{{ 'refresh' | t }}</button></div>
    <div class="tabs">
      <button [class.active]="tab() === 'f'" (click)="tab.set('f')">{{ 'finishedStock' | t }}</button>
      <button [class.active]="tab() === 'm'" (click)="tab.set('m')">{{ 'materials' | t }}</button>
    </div>
    @if (!api.online()) {
      <div class="alert info" style="margin-bottom:12px">{{ 'showingCached' | t }}</div>
    }
    @if (tab() === 'f') {
      <div class="card">
        <div class="card-body toolbar"><div class="field grow"><label>{{ 'search' | t }}</label><input [(ngModel)]="q" [placeholder]="'searchPlaceholder' | t" /></div></div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th></th><th>{{ 'name' | t }}</th><th>{{ 'sku' | t }}</th><th class="num">{{ 'saleable' | t }}</th><th class="num">{{ 'damaged' | t }}</th>
              <th class="num">{{ 'minPackets' | t }}</th>@if (showCost) { <th class="num">{{ 'unitCost' | t }}</th><th class="num">{{ 'value' | t }}</th> }<th></th></tr></thead>
            <tbody>
              @for (v of filtered(); track v.variationId) {
                <tr><td><app-thumb [src]="v.imageUrl" [name]="v.name" /></td><td>{{ i18n.pick(v.name, v.nameUr) }} <strong>{{ v.packetGrams }} {{ 'grams' | t }}</strong></td><td class="ltr small">{{ v.sku }}</td>
                  <td class="num"><strong [style.color]="v.packets < v.minimum ? 'var(--bad)' : ''">{{ v.packets | num }}</strong></td>
                  <td class="num">{{ v.damaged | num }}</td><td class="num muted">{{ v.minimum }}</td>
                  @if (showCost) { <td class="num">{{ v.avgCost | money }}</td><td class="num">{{ v.value | money }}</td> }
                  <td class="right nowrap">@if (api.online()) {
                    <button class="btn sm" (click)="ledger.set({ bucket: 'FINISHED', title: v.name + ' ' + v.packetGrams + ' g', query: { variationId: v.variationId } })">{{ 'stockLedger' | t }}</button>
                    @if (auth.can('inventory.adjust')) { <button class="btn sm" (click)="adjust.set({ target: 'FINISHED', title: v.name + ' ' + v.packetGrams + ' g', unit: i18n.t('packets'), current: v.packets, ids: { variationId: v.variationId } })">{{ 'adjust' | t }}</button> }
                  }</td></tr>
              } @empty { <tr><td colspan="9" class="empty">{{ 'noData' | t }}</td></tr> }
            </tbody>
          </table>
        </div>
      </div>
    }
    @if (tab() === 'm') {
      <div class="card">
        @if (!api.online()) { <div class="empty">{{ 'onlineOnly' | t }}</div> } @else {
          <table class="data">
            <thead><tr><th>{{ 'code' | t }}</th><th>{{ 'name' | t }}</th><th>{{ 'kind' | t }}</th><th class="num">{{ 'inStock' | t }}</th><th class="num">{{ 'minStock' | t }}</th>
              @if (showCost) { <th class="num">{{ 'avgCost' | t }}</th><th class="num">{{ 'value' | t }}</th> }<th></th></tr></thead>
            <tbody>
              @for (m of materials(); track m.materialId) {
                <tr><td class="ltr">{{ m.code }}</td><td>{{ i18n.pick(m.name, m.nameUr) }}</td><td>{{ m.kind | t }}</td>
                  <td class="num"><strong [style.color]="m.quantity < m.minimum ? 'var(--bad)' : ''">{{ m.quantity | num }} {{ m.unit }}</strong></td><td class="num muted">{{ m.minimum | num }}</td>
                  @if (showCost) { <td class="num">{{ m.avgCost | money }}</td><td class="num">{{ m.value | money }}</td> }
                  <td class="right nowrap">
                    <button class="btn sm" (click)="ledger.set({ bucket: 'MATERIAL', title: m.name, query: { materialId: m.materialId } })">{{ 'stockLedger' | t }}</button>
                    @if (auth.can('inventory.adjust')) { <button class="btn sm" (click)="adjust.set({ target: 'MATERIAL', title: m.name, unit: m.unit, current: m.quantity, ids: { materialId: m.materialId } })">{{ 'adjust' | t }}</button> }
                  </td></tr>
              } @empty { <tr><td colspan="8" class="empty">{{ 'noData' | t }}</td></tr> }
            </tbody>
          </table>
        }
      </div>
    }
  </div>
  @if (ledger(); as l) { <app-ledger [bucket]="l.bucket" [title]="l.title" [query]="l.query" (closed)="ledger.set(null)" /> }
  @if (adjust(); as a) { <app-adjust [title]="a.title" [target]="a.target" [unit]="a.unit" [current]="a.current" [ids]="a.ids" (closed)="adjust.set(null)" (saved)="adjust.set(null); load()" /> }`,
})
export class FinishedPage implements OnInit {
  tab = signal<'f' | 'm'>('f');
  finished = signal<any[]>([]); materials = signal<any[]>([]);
  ledger = signal<any>(null); adjust = signal<any>(null);
  q = ''; showCost = false;
  constructor(public api: Api, public auth: Auth, public i18n: I18n, private toast: Toast, private store: Store) { this.showCost = auth.can('reports.financial'); }
  filtered() { const q = this.q.toLowerCase(); return this.finished().filter(v => !q || `${v.name} ${v.nameUr ?? ''} ${v.sku}`.toLowerCase().includes(q)); }
  ngOnInit() { this.load(); }
  async load() {
    if (this.api.online()) {
      try { const s: any = await this.api.get('/api/inventory/stock'); this.finished.set(s.finished); this.materials.set(s.materials); return; }
      catch (e) { this.toast.error(e); }
    }
    // Offline: device snapshot of saleable packets including unsynced sales from this device.
    const [ps, vs, stock] = await Promise.all([db.products.toArray(), db.variations.toArray(), this.store.stockMap()]);
    const pm = new Map(ps.map(p => [p.id, p]));
    this.finished.set(vs.filter(v => v.isActive).map(v => ({ variationId: v.id, name: pm.get(v.productId)?.name, nameUr: pm.get(v.productId)?.nameUr, imageUrl: pm.get(v.productId)?.imageUrl,
      sku: v.sku, packetGrams: v.packetGrams, packets: stock[v.id] ?? 0, damaged: 0, minimum: v.minStockPackets })));
  }
}
