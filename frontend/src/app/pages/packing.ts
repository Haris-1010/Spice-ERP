import { Component, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { MoneyPipe, NumPipe, PkDatePipe, WeightPipe, pkToday } from '../core/format';
import { I18n, TPipe } from '../core/i18n';
import { Dialog, SHARED, Toast } from '../shared/ui';

@Component({
  standalone: true,
  imports: [FormsModule, MoneyPipe, NumPipe, PkDatePipe, WeightPipe, ...SHARED],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>{{ 'packing' | t }}</h1>
      <select [(ngModel)]="status" (ngModelChange)="load()" style="width:160px">
        <option value="">{{ 'all' | t }}</option><option value="PLANNED">{{ 'PLANNED' | t }}</option><option value="POSTED">{{ 'POSTED' | t }}</option><option value="CANCELLED">{{ 'CANCELLED' | t }}</option>
      </select>
      @if (auth.can('packing.manage')) { <button class="btn primary" (click)="openNew()" [disabled]="!api.online()">+ {{ 'newPackingOrder' | t }}</button> }
    </div>
    @if (!api.online()) { <div class="card empty">{{ 'onlineOnly' | t }}</div> } @else {
      <div class="card table-wrap">
        <table class="data">
          <thead><tr><th>{{ 'orderNo' | t }}</th><th>{{ 'packDate' | t }}</th><th>{{ 'name' | t }}</th><th>{{ 'sourceBatch' | t }}</th>
            <th class="num">{{ 'planned' | t }}</th><th class="num">{{ 'produced' | t }}</th><th class="num">{{ 'rejected' | t }}</th><th class="num">{{ 'consumed' | t }}</th>
            @if (showCost) { <th class="num">{{ 'unitCost' | t }}</th> }<th>{{ 'assignedTo' | t }}</th><th>{{ 'status' | t }}</th><th></th></tr></thead>
          <tbody>
            @for (o of list(); track o.id) {
              <tr>
                <td class="ltr"><strong>{{ o.orderNo }}</strong></td><td>{{ o.packDate | pkdate }}</td>
                <td>{{ i18n.pick(o.product, o.productUr) }} <strong>{{ o.packetGrams }} {{ 'grams' | t }}</strong></td><td class="ltr">{{ o.batchNo }}</td>
                <td class="num">{{ o.plannedPackets | num }}</td><td class="num">{{ o.producedPackets | num }}</td><td class="num">{{ o.rejectedPackets | num }}</td>
                <td class="num">{{ o.consumedGrams | weight }}</td>
                @if (showCost) { <td class="num">{{ o.unitCost !== null ? (o.unitCost | money) : '' }}</td> }
                <td>{{ o.assignedTo }}</td>
                <td><span class="badge" [class.ok]="o.status === 'POSTED'" [class.warn]="o.status === 'PLANNED'" [class.bad]="o.status === 'CANCELLED'">{{ o.status | t }}</span></td>
                <td class="right nowrap">
                  @if (o.status === 'PLANNED' && auth.can('packing.post')) { <button class="btn sm primary" (click)="openPost(o)">{{ 'recordProduction' | t }}</button> }
                  @if (o.status !== 'CANCELLED' && auth.can('packing.manage')) { <button class="btn sm danger" (click)="cancel(o)">{{ 'cancel' | t }}</button> }
                </td>
              </tr>
            } @empty { <tr><td colspan="12" class="empty">{{ 'noData' | t }}</td></tr> }
          </tbody>
        </table>
      </div>
    }
  </div>

  @if (newForm()) {
    <app-modal [title]="'newPackingOrder' | t" (closed)="newForm.set(false)">
      <div class="form-grid">
        <div class="field span-all"><label>{{ 'name' | t }}</label>
          <select [(ngModel)]="nf.productId" (ngModelChange)="productChanged()"><option value="">—</option>
            @for (p of products(); track p.id) { <option [value]="p.id">{{ i18n.pick(p.name, p.nameUr) }} — {{ p.bulkGrams | weight }}</option> }</select></div>
        <div class="field"><label>{{ 'packetSize' | t }}</label>
          <select [(ngModel)]="nf.variationId" (ngModelChange)="tickNew()"><option value="">—</option>@for (v of sizes(); track v.id) { <option [value]="v.id">{{ v.packetGrams }} {{ 'grams' | t }}</option> }</select></div>
        <div class="field span-2"><label>{{ 'sourceBatch' | t }}</label>
          <select [(ngModel)]="nf.batchId" (ngModelChange)="tickNew()"><option value="">—</option>
            @for (b of batches(); track b.id) { <option [value]="b.id">{{ b.batchNo }} — {{ b.grams | weight }}{{ b.expiryDate ? ' · exp ' + b.expiryDate : '' }}</option> }</select></div>
        <div class="field"><label>{{ 'plannedPackets' | t }}</label><input type="number" min="1" [(ngModel)]="nf.plannedPackets" (ngModelChange)="tickNew()" /></div>
        <div class="field"><label>{{ 'plannedGrams' | t }}</label><div class="big num" [style.color]="planExceeds() ? 'var(--bad)' : ''">{{ plannedGrams() | weight }}</div></div>
        <div class="field"><label>{{ 'packDate' | t }}</label><input type="date" [(ngModel)]="nf.packDate" /></div>
        <div class="field"><label>{{ 'assignedTo' | t }}</label>
          <select [(ngModel)]="nf.assignedToUserId"><option [ngValue]="null">—</option>@for (u of users(); track u.id) { <option [ngValue]="u.id">{{ u.fullName }}</option> }</select></div>
        <div class="field span-all"><label>{{ 'notes' | t }}</label><input [(ngModel)]="nf.notes" /></div>
        @if (planExceeds()) { <div class="alert bad span-all">{{ 'exceedsBatch' | t }}</div> }
      </div>
      <ng-container foot>
        <button class="btn" (click)="newForm.set(false)">{{ 'cancel' | t }}</button>
        <button class="btn primary" (click)="create()" [disabled]="busy() || !nf.variationId || !nf.batchId || !(nf.plannedPackets > 0) || planExceeds()">{{ 'save' | t }}</button>
      </ng-container>
    </app-modal>
  }

  @if (postOrder(); as o) {
    <app-modal [title]="('recordProduction' | t) + ' — ' + o.orderNo" (closed)="postOrder.set(null)">
      <div class="stack">
        <div class="alert info">{{ i18n.pick(o.product, o.productUr) }} {{ o.packetGrams }} g · {{ 'planned' | t }} {{ o.plannedPackets }} · {{ 'batchNo' | t }} {{ o.batchNo }} ({{ batchGrams() | weight }})</div>
        <div class="form-grid">
          <div class="field"><label>{{ 'producedPackets' | t }}</label><input type="number" min="0" [(ngModel)]="pf.producedPackets" (ngModelChange)="tickPost()" /></div>
          <div class="field"><label>{{ 'rejectedPackets' | t }}</label><input type="number" min="0" [(ngModel)]="pf.rejectedPackets" (ngModelChange)="tickPost()" /></div>
          <div class="field"><label>{{ 'lossGrams' | t }}</label><input type="number" min="0" [(ngModel)]="pf.lossGrams" (ngModelChange)="tickPost()" /></div>
          <div class="field"><label>{{ 'pouchesUsed' | t }}</label><input type="number" min="0" [(ngModel)]="pf.pouchesUsed" /></div>
          <div class="field"><label>{{ 'labelsUsed' | t }}</label><input type="number" min="0" [(ngModel)]="pf.labelsUsed" /></div>
          @if (auth.can('packing.manage')) {
            <div class="field"><label>{{ 'labourCost' | t }}</label><input type="number" min="0" [(ngModel)]="pf.labourCost" /></div>
            <div class="field"><label>{{ 'overheadCost' | t }}</label><input type="number" min="0" [(ngModel)]="pf.overheadCost" /></div>
          }
        </div>
        <div class="grid grid-3">
          <div class="card kpi"><span class="label">{{ 'consumed' | t }}</span><span class="value" [style.color]="postExceeds() ? 'var(--bad)' : ''">{{ consumed() | weight }}</span></div>
          <div class="card kpi"><span class="label">{{ 'leftover' | t }}</span><span class="value">{{ batchGrams() - consumed() | weight }}</span></div>
          <div class="card kpi"><span class="label">{{ 'yield' | t }}</span><span class="value">{{ yieldPct() | num }}%</span></div>
        </div>
        <p class="small muted" style="margin:0">{{ 'packingHelp' | t }}</p>
        @if (postExceeds()) { <div class="alert bad">{{ 'exceedsBatch' | t }}</div> }
        @if (warnings().length) { <div class="alert warn"><ul>@for (w of warnings(); track w) { <li>{{ w }}</li> }</ul></div> }
      </div>
      <ng-container foot>
        <button class="btn" (click)="postOrder.set(null)">{{ 'cancel' | t }}</button>
        <button class="btn primary" (click)="post()" [disabled]="busy() || postExceeds() || consumed() <= 0">{{ 'save' | t }}</button>
      </ng-container>
    </app-modal>
  }`,
  styles: [`.big { height: 36px; display: flex; align-items: center; font-weight: 700; font-size: 16px; }`],
})
export class PackingPage implements OnInit {
  list = signal<any[]>([]); products = signal<any[]>([]); batches = signal<any[]>([]); users = signal<any[]>([]);
  newForm = signal(false); postOrder = signal<any>(null); busy = signal(false); warnings = signal<string[]>([]);
  status = ''; showCost = false;
  nf: any = {}; pf: any = {};
  private tn = signal(0); private tp = signal(0);
  private postBatch = signal(0);

  sizes = computed(() => { this.tn(); return (this.products().find(p => p.id === this.nf.productId)?.variations ?? []).filter((v: any) => v.isActive); });
  plannedGrams = computed(() => { this.tn(); const v = this.sizes().find((x: any) => x.id === this.nf.variationId); return v ? v.packetGrams * (+this.nf.plannedPackets || 0) : 0; });
  planExceeds = computed(() => { this.tn(); const b = this.batches().find(x => x.id === this.nf.batchId); return !!b && this.plannedGrams() > b.grams; });
  batchGrams = computed(() => this.postBatch());
  consumed = computed(() => { this.tp(); const o = this.postOrder(); if (!o) return 0;
    return ((+this.pf.producedPackets || 0) + (+this.pf.rejectedPackets || 0)) * o.packetGrams + (+this.pf.lossGrams || 0); });
  postExceeds = computed(() => this.consumed() > this.batchGrams());
  yieldPct = computed(() => { const o = this.postOrder(); const c = this.consumed(); return o && c ? Math.round(1000 * (+this.pf.producedPackets || 0) * o.packetGrams / c) / 10 : 0; });

  constructor(public api: Api, public auth: Auth, public i18n: I18n, private toast: Toast, private dialog: Dialog) { this.showCost = auth.can('reports.financial') || auth.can('packing.manage'); }

  ngOnInit() { this.load(); }
  tickNew() { this.tn.update(x => x + 1); }
  tickPost() { this.tp.update(x => x + 1); }

  async load() {
    if (!this.api.online()) return;
    try { this.list.set((await this.api.get<any>('/api/packing', { status: this.status, pageSize: 200 })).items); } catch (e) { this.toast.error(e); }
  }

  async openNew() {
    try {
      const [p, u] = await Promise.all([this.api.get<any>('/api/products', { pageSize: 500, active: true }), this.auth.can('users.manage') ? this.api.get<any[]>('/api/users') : Promise.resolve([])]);
      this.products.set(p.items); this.users.set(u.filter((x: any) => x.isActive));
      this.nf = { productId: '', variationId: '', batchId: '', plannedPackets: 0, packDate: pkToday(), assignedToUserId: null, notes: '' };
      this.batches.set([]); this.tickNew(); this.newForm.set(true);
    } catch (e) { this.toast.error(e); }
  }

  async productChanged() {
    this.nf.variationId = ''; this.nf.batchId = '';
    this.batches.set(this.nf.productId ? await this.api.get('/api/purchases/batches', { productId: this.nf.productId }) : []);
    if (this.batches().length) this.nf.batchId = this.batches()[0].id; // oldest batch first (FIFO)
    this.tickNew();
  }

  async create() {
    this.busy.set(true);
    try {
      const r: any = await this.api.post('/api/packing', { ...this.nf, plannedPackets: +this.nf.plannedPackets });
      r.warnings?.forEach((w: string) => this.toast.warn(w));
      this.toast.ok(`${r.number} — ${this.i18n.t('savedOk')}`);
      this.newForm.set(false); await this.load();
    } catch (e) { this.toast.error(e); }
    finally { this.busy.set(false); }
  }

  async openPost(o: any) {
    this.warnings.set([]);
    this.pf = { producedPackets: o.plannedPackets, rejectedPackets: 0, lossGrams: 0, pouchesUsed: o.plannedPackets, labelsUsed: o.plannedPackets, labourCost: 0, overheadCost: 0, notes: '' };
    try {
      const all: any[] = await this.api.get('/api/purchases/batches', { openOnly: false });
      this.postBatch.set(Number(all.find(b => b.id === o.batchId)?.grams ?? 0));
    } catch { this.postBatch.set(0); }
    this.postOrder.set(o); this.tickPost();
  }

  async post() {
    this.busy.set(true);
    try {
      const n = (k: string) => Math.max(0, +this.pf[k] || 0);
      const r: any = await this.api.post(`/api/packing/${this.postOrder().id}/post`, {
        producedPackets: n('producedPackets'), rejectedPackets: n('rejectedPackets'), lossGrams: n('lossGrams'), pouchesUsed: n('pouchesUsed'),
        labelsUsed: n('labelsUsed'), labourCost: n('labourCost'), overheadCost: n('overheadCost'), notes: this.pf.notes || null,
      });
      r.warnings?.forEach((w: string) => this.toast.warn(w));
      this.toast.ok(this.i18n.t('savedOk'));
      this.postOrder.set(null); await this.load();
    } catch (e) { this.toast.error(e); }
    finally { this.busy.set(false); }
  }

  async cancel(o: any) {
    const reason = await this.dialog.prompt(`${this.i18n.t('cancel')} ${o.orderNo}`, this.i18n.t('cancelReasonPrompt'));
    if (!reason) return;
    try { await this.api.post(`/api/packing/${o.id}/cancel`, { reason }); await this.load(); } catch (e) { this.toast.error(e); }
  }
}
