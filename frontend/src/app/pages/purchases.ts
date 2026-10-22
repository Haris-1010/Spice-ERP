import { Component, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { MoneyPipe, NumPipe, PkDatePipe, WeightPipe, pkToday, round2 } from '../core/format';
import { I18n, TPipe } from '../core/i18n';
import { Dialog, SHARED, Toast } from '../shared/ui';

interface PLine { lineType: 'SPICE' | 'MATERIAL'; productId: string | null; materialId: string | null; qty: number; rate: number; batchNo: string; mfgDate: string; expiryDate: string; }

@Component({
  standalone: true,
  imports: [FormsModule, MoneyPipe, NumPipe, PkDatePipe, WeightPipe, ...SHARED],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>{{ 'purchases' | t }}</h1>
      @if (auth.can('purchases.manage')) { <button class="btn primary" (click)="openNew()" [disabled]="!api.online()">+ {{ 'newPurchase' | t }}</button> }
    </div>
    @if (!api.online()) { <div class="card empty">{{ 'onlineOnly' | t }}</div> } @else {
      <div class="card">
        <div class="card-body toolbar">
          <div class="field grow"><label>{{ 'search' | t }}</label><input [(ngModel)]="q" (keyup.enter)="load()" /></div>
          <div class="field"><label>{{ 'supplier' | t }}</label><select [(ngModel)]="supplierId" (ngModelChange)="load()"><option value="">{{ 'all' | t }}</option>
            @for (s of suppliers(); track s.id) { <option [value]="s.id">{{ s.name }}</option> }</select></div>
          <div class="field"><label>{{ 'from' | t }}</label><input type="date" [(ngModel)]="from" (change)="load()" /></div>
          <div class="field"><label>{{ 'to' | t }}</label><input type="date" [(ngModel)]="to" (change)="load()" /></div>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>{{ 'purchaseNo' | t }}</th><th>{{ 'date' | t }}</th><th>{{ 'supplier' | t }}</th><th>{{ 'supplierInvoiceNo' | t }}</th>
              <th class="num">{{ 'total' | t }}</th><th class="num">{{ 'amountPaid' | t }}</th><th>{{ 'status' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (p of list(); track p.id) {
                <tr class="clickable" (click)="view(p.id)">
                  <td class="ltr"><strong>{{ p.purchaseNo }}</strong></td><td>{{ p.purchaseDate | pkdate }}</td><td>{{ p.supplier }}</td><td>{{ p.supplierInvoiceNo }}</td>
                  <td class="num">{{ p.total | money }}</td><td class="num">{{ p.amountPaid | money }}</td>
                  <td><span class="badge" [class.ok]="p.status === 'POSTED'" [class.bad]="p.status === 'CANCELLED'">{{ p.status | t }}</span></td>
                  <td></td>
                </tr>
              } @empty { <tr><td colspan="8" class="empty">{{ 'noData' | t }}</td></tr> }
            </tbody>
          </table>
        </div>
        <app-pager [page]="page" [pageSize]="50" [total]="total()" (pageChange)="page = $event; load()" />
      </div>
    }
  </div>

  @if (form()) {
    <app-modal [title]="'newPurchase' | t" [wide]="true" (closed)="form.set(false)">
      <div class="stack">
        <div class="form-grid">
          <div class="field span-2"><label>{{ 'supplier' | t }} *</label>
            <select [(ngModel)]="f.supplierId"><option value="">—</option>@for (s of suppliers(); track s.id) { <option [value]="s.id">{{ s.name }} ({{ s.code }})</option> }</select></div>
          <div class="field"><label>{{ 'supplierInvoiceNo' | t }}</label><input [(ngModel)]="f.supplierInvoiceNo" /></div>
          <div class="field"><label>{{ 'purchaseDate' | t }}</label><input type="date" [(ngModel)]="f.purchaseDate" /></div>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>{{ 'type' | t }}</th><th>{{ 'item' | t }}</th><th>{{ 'quantity' | t }}</th><th>{{ 'rate' | t }}</th><th>{{ 'batchNo' | t }}</th><th>{{ 'expiryDate' | t }}</th><th class="num">{{ 'total' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (l of f.lines; track $index; let i = $index) {
                <tr>
                  <td class="small">{{ (l.lineType === 'SPICE' ? 'spiceLine' : 'materialLine') | t }}</td>
                  <td>
                    @if (l.lineType === 'SPICE') {
                      <select [(ngModel)]="l.productId" (ngModelChange)="recalc()"><option [ngValue]="null">—</option>@for (p of products(); track p.id) { <option [ngValue]="p.id">{{ i18n.pick(p.name, p.nameUr) }}</option> }</select>
                    } @else {
                      <select [(ngModel)]="l.materialId"><option [ngValue]="null">—</option>@for (m of materials(); track m.id) { <option [ngValue]="m.id">{{ i18n.pick(m.name, m.nameUr) }}</option> }</select>
                    }
                  </td>
                  <td style="width:120px"><input type="number" min="0" [step]="l.lineType === 'SPICE' ? 0.001 : 1" [(ngModel)]="l.qty" (ngModelChange)="recalc()" class="num" />
                    <div class="small muted">{{ l.lineType === 'SPICE' ? ('quantityKg' | t) : ('quantity' | t) }}</div></td>
                  <td style="width:110px"><input type="number" min="0" [(ngModel)]="l.rate" (ngModelChange)="recalc()" class="num" />
                    <div class="small muted">{{ (l.lineType === 'SPICE' ? 'ratePerKg' : 'ratePerUnit') | t }}</div></td>
                  <td style="width:120px">@if (l.lineType === 'SPICE') { <input [(ngModel)]="l.batchNo" [placeholder]="'optional' | t" /> }</td>
                  <td style="width:150px">@if (l.lineType === 'SPICE') { <input type="date" [(ngModel)]="l.expiryDate" [class.invalid]="needsExpiry(l)" /> }</td>
                  <td class="num">{{ lineTotal(l) | money }}</td>
                  <td><button class="btn sm ghost" (click)="f.lines.splice(i, 1); recalc()">✕</button></td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <div class="row">
          <button class="btn sm" (click)="addLine('SPICE')">+ {{ 'addSpice' | t }}</button>
          <button class="btn sm" (click)="addLine('MATERIAL')">+ {{ 'addMaterial' | t }}</button>
        </div>
        <div class="form-grid">
          <div class="field"><label>{{ 'transport' | t }}</label><input type="number" min="0" [(ngModel)]="f.transportCost" (ngModelChange)="recalc()" /></div>
          <div class="field"><label>{{ 'discount' | t }}</label><input type="number" min="0" [(ngModel)]="f.discountAmount" (ngModelChange)="recalc()" /></div>
          <div class="field"><label>{{ 'tax' | t }}</label><input type="number" min="0" [(ngModel)]="f.taxAmount" (ngModelChange)="recalc()" /></div>
          <div class="field"><label>{{ 'grandTotal' | t }}</label><div class="kpi-inline num">{{ grand() | money }}</div></div>
          <div class="field"><label>{{ 'amountPaid' | t }}</label><input type="number" min="0" [(ngModel)]="f.amountPaid" (ngModelChange)="recalc()" /></div>
          <div class="field"><label>{{ 'paymentMethod' | t }}</label><select [(ngModel)]="f.paymentMethod">@for (m of ['CASH','BANK','WALLET']; track m) { <option [value]="m">{{ m | t }}</option> }</select></div>
          <div class="field"><label>{{ 'outstanding' | t }}</label><div class="kpi-inline num">{{ grand() - (+f.amountPaid || 0) | money }}</div></div>
          <div class="field"><label>{{ 'attachment' | t }}</label>
            <input type="file" accept="image/*,application/pdf" (change)="attach($event)" />
            @if (f.attachmentUrl) { <a class="small" [href]="api.fileUrl(f.attachmentUrl)" target="_blank">✓ {{ 'view' | t }}</a> }</div>
          <div class="field span-all"><label>{{ 'notes' | t }}</label><input [(ngModel)]="f.notes" /></div>
        </div>
        @if (error()) { <div class="alert bad">{{ error() }}</div> }
      </div>
      <ng-container foot>
        <button class="btn" (click)="form.set(false)">{{ 'cancel' | t }}</button>
        <button class="btn primary" (click)="save()" [disabled]="busy() || !valid()">{{ (busy() ? 'saving' : 'save') | t }}</button>
      </ng-container>
    </app-modal>
  }

  @if (detail(); as d) {
    <app-modal [title]="d.purchase.purchaseNo" [wide]="true" (closed)="detail.set(null)">
      <div class="stack">
        <div class="row"><strong>{{ d.supplier.name }}</strong><span class="muted">{{ d.purchase.purchaseDate | pkdate }}</span>
          <span class="badge" [class.bad]="d.purchase.status === 'CANCELLED'">{{ d.purchase.status | t }}</span>
          @if (d.purchase.attachmentUrl) { <a [href]="api.fileUrl(d.purchase.attachmentUrl)" target="_blank">{{ 'attachment' | t }}</a> }</div>
        <table class="data">
          <thead><tr><th>{{ 'item' | t }}</th><th>{{ 'batchNo' | t }}</th><th class="num">{{ 'quantity' | t }}</th><th class="num">{{ 'rate' | t }}</th><th class="num">{{ 'total' | t }}</th><th class="num">{{ 'landedCost' | t }}</th></tr></thead>
          <tbody>@for (l of d.lines; track l.id) {
            <tr><td>{{ l.item }}</td><td class="ltr">{{ l.batchNo }}</td><td class="num">{{ l.lineType === 'SPICE' ? (l.quantity | weight) : (l.quantity | num) }}</td>
              <td class="num">{{ l.rate | money }}</td><td class="num">{{ l.lineTotal | money }}</td><td class="num">{{ l.lineTotal + l.landedCost | money }}</td></tr> }</tbody>
          <tfoot><tr><td colspan="4">{{ 'grandTotal' | t }}</td><td class="num" colspan="2">{{ d.purchase.total | money }}</td></tr></tfoot>
        </table>
        @if (d.purchase.cancelReason) { <div class="alert warn">{{ 'reason' | t }}: {{ d.purchase.cancelReason }}</div> }
      </div>
      <ng-container foot>
        @if (d.purchase.status === 'POSTED' && auth.can('purchases.manage')) { <button class="btn danger" (click)="cancel(d.purchase.id)">{{ 'cancelPurchase' | t }}</button> }
        <button class="btn" (click)="detail.set(null)">{{ 'close' | t }}</button>
      </ng-container>
    </app-modal>
  }`,
  styles: [`.kpi-inline { height: 36px; display: flex; align-items: center; font-weight: 700; font-size: 16px; color: var(--navy-900); }`],
})
export class PurchasesPage implements OnInit {
  list = signal<any[]>([]); total = signal(0); page = 1;
  suppliers = signal<any[]>([]); products = signal<any[]>([]); materials = signal<any[]>([]);
  form = signal(false); detail = signal<any>(null);
  busy = signal(false); error = signal<string | null>(null);
  q = ''; supplierId = ''; from = ''; to = '';
  f: any = {};
  private tick = signal(0);
  grand = computed(() => {
    this.tick();
    const sub = (this.f.lines ?? []).reduce((s: number, l: PLine) => s + this.lineTotal(l), 0);
    return round2(sub + (+this.f.transportCost || 0) + (+this.f.taxAmount || 0) - (+this.f.discountAmount || 0));
  });

  constructor(public api: Api, public auth: Auth, public i18n: I18n, private toast: Toast, private dialog: Dialog) {}

  async ngOnInit() {
    if (!this.api.online()) return;
    try {
      const [s, p] = await Promise.all([this.api.get<any[]>('/api/suppliers'), this.api.get<any>('/api/products', { pageSize: 500 })]);
      this.suppliers.set(s); this.products.set(p.items);
      if (this.auth.can('inventory.view')) this.materials.set(await this.api.get('/api/packaging-materials'));
    } catch (e) { this.toast.error(e); }
    await this.load();
  }

  async load() {
    try {
      const r = await this.api.get<any>('/api/purchases', { q: this.q, supplierId: this.supplierId, from: this.from, to: this.to, page: this.page });
      this.list.set(r.items); this.total.set(r.total);
    } catch (e) { this.toast.error(e); }
  }

  recalc() { this.tick.update(x => x + 1); }
  lineTotal(l: PLine) { return round2((+l.qty || 0) * (+l.rate || 0)); }
  needsExpiry(l: PLine) { return l.lineType === 'SPICE' && !!this.products().find(p => p.id === l.productId)?.trackExpiry && !l.expiryDate; }
  valid() { return !!this.f.supplierId && this.f.lines?.length > 0 && this.f.lines.every((l: PLine) => (l.productId || l.materialId) && +l.qty > 0 && +l.rate >= 0 && !this.needsExpiry(l)); }

  openNew() {
    this.error.set(null);
    this.f = { supplierId: '', supplierInvoiceNo: '', purchaseDate: pkToday(), transportCost: 0, discountAmount: 0, taxAmount: 0, amountPaid: 0, paymentMethod: 'CASH', notes: '', attachmentUrl: null, lines: [] };
    this.addLine('SPICE');
    this.form.set(true);
  }

  addLine(t: 'SPICE' | 'MATERIAL') { this.f.lines.push({ lineType: t, productId: null, materialId: null, qty: 0, rate: 0, batchNo: '', mfgDate: '', expiryDate: '' }); this.recalc(); }

  async attach(ev: Event) {
    const file = (ev.target as HTMLInputElement).files?.[0]; if (!file) return;
    try { this.f.attachmentUrl = await this.api.upload('attachments', file); } catch (e) { this.toast.error(e); }
  }

  async save() {
    this.busy.set(true); this.error.set(null);
    try {
      await this.api.post('/api/purchases', {
        ...this.f, transportCost: +this.f.transportCost || 0, discountAmount: +this.f.discountAmount || 0, taxAmount: +this.f.taxAmount || 0, amountPaid: +this.f.amountPaid || 0,
        lines: this.f.lines.map((l: PLine) => ({
          lineType: l.lineType, productId: l.productId, materialId: l.materialId, batchNo: l.batchNo || null,
          // spice quantity is entered in kg and stored in whole grams
          quantity: l.lineType === 'SPICE' ? Math.round(+l.qty * 1000) : Math.round(+l.qty), rate: +l.rate,
          mfgDate: l.mfgDate || null, expiryDate: l.expiryDate || null,
        })),
      });
      this.toast.ok(this.i18n.t('savedOk'));
      this.form.set(false);
      await this.load();
    } catch (e: any) { this.error.set(e.message); }
    finally { this.busy.set(false); }
  }

  async view(id: string) { try { this.detail.set(await this.api.get(`/api/purchases/${id}`)); } catch (e) { this.toast.error(e); } }

  async cancel(id: string) {
    const reason = await this.dialog.prompt(this.i18n.t('cancelPurchase'), this.i18n.t('cancelReasonPrompt'));
    if (!reason) return;
    try { await this.api.post(`/api/purchases/${id}/cancel`, { reason }); this.detail.set(null); await this.load(); this.toast.ok(this.i18n.t('savedOk')); }
    catch (e) { this.toast.error(e); }
  }
}
