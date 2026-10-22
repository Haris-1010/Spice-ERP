import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { db } from '../core/db';
import { MoneyPipe, NumPipe, WeightPipe, downloadText, toCsv } from '../core/format';
import { I18n, TPipe } from '../core/i18n';
import { Sync } from '../core/sync';
import { Dialog, SHARED, Toast } from '../shared/ui';

const KINDS = ['POUCH', 'LABEL', 'WRAPPER', 'CARTON', 'SEALING', 'OTHER'];

@Component({
  standalone: true,
  imports: [FormsModule, MoneyPipe, NumPipe, WeightPipe, ...SHARED],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>{{ 'products' | t }}</h1>
      @if (auth.can('products.manage')) {
        <label class="btn">{{ 'importProducts' | t }}<input type="file" accept=".csv,text/csv" hidden (change)="importCsv($event)" /></label>
        <button class="btn primary" (click)="edit(null)" [disabled]="!api.online()">+ {{ 'newProduct' | t }}</button>
      }
    </div>
    <div class="tabs">
      <button [class.active]="tab() === 'p'" (click)="tab.set('p')">{{ 'products' | t }}</button>
      <button [class.active]="tab() === 'm'" (click)="tab.set('m'); loadMaterials()">{{ 'materials' | t }}</button>
      <button [class.active]="tab() === 'c'" (click)="tab.set('c')">{{ 'categories' | t }}</button>
    </div>

    @if (tab() === 'p') {
      <div class="card">
        <div class="card-body toolbar">
          <div class="field grow"><label>{{ 'search' | t }}</label><input [(ngModel)]="q" (keyup.enter)="load()" (ngModelChange)="offlineFilter()" [placeholder]="'searchPlaceholder' | t" /></div>
          <div class="field"><label>{{ 'category' | t }}</label>
            <select [(ngModel)]="cat" (ngModelChange)="load()"><option value="">{{ 'all' | t }}</option>@for (c of categories(); track c.id) { <option [value]="c.id">{{ i18n.pick(c.name, c.nameUr) }}</option> }</select></div>
          <button class="btn" (click)="load()">{{ 'search' | t }}</button>
          <button class="btn" (click)="exportCsv()">{{ 'export' | t }}</button>
        </div>
        @if (offline()) { <div class="alert info" style="margin:0 16px 12px">{{ 'showingCached' | t }}</div> }
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th></th><th>{{ 'code' | t }}</th><th>{{ 'name' | t }}</th><th>{{ 'category' | t }}</th><th class="num">{{ 'bulkStock' | t }}</th>
              <th>{{ 'packetSizes' | t }}</th><th>{{ 'status' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (p of items(); track p.id) {
                <tr>
                  <td><app-thumb [src]="p.imageUrl" [name]="p.name" /></td>
                  <td class="ltr">{{ p.code }}</td>
                  <td><strong>{{ p.name }}</strong>@if (p.nameUr) { <div class="ur small">{{ p.nameUr }}</div> }</td>
                  <td>{{ catName(p.categoryId) }}</td>
                  <td class="num">@if (p.bulkGrams !== undefined) { <span [style.color]="p.bulkGrams < p.minStockGrams ? 'var(--bad)' : ''">{{ p.bulkGrams | weight }}</span> }</td>
                  <td>
                    <div class="sizes">
                      @for (v of p.variations; track v.id) {
                        <span class="size" [class.off]="!v.isActive">{{ v.packetGrams }}g · {{ v.retailPrice | money }}
                          @if (v.packets !== undefined) { · <b [style.color]="v.packets < v.minStockPackets ? 'var(--bad)' : ''">{{ v.packets }}</b> }</span>
                      }
                    </div>
                  </td>
                  <td>@if (p.isActive) { <span class="badge ok">{{ 'active' | t }}</span> } @else { <span class="badge grey">{{ 'inactive' | t }}</span> }</td>
                  <td class="right">
                    @if (auth.can('products.manage')) {
                      <button class="btn sm" (click)="edit(p)" [disabled]="!api.online()">{{ 'edit' | t }}</button>
                      @if (p.isActive) { <button class="btn sm danger" (click)="deleteProduct(p)" [disabled]="!api.online()">{{ 'delete' | t }}</button> }
                    }
                  </td>
                </tr>
              } @empty { <tr><td colspan="8" class="empty">{{ 'noData' | t }}</td></tr> }
            </tbody>
          </table>
        </div>
      </div>
    }

    @if (tab() === 'm') {
      <div class="card">
        <div class="card-head"><h2>{{ 'materials' | t }}</h2>
          @if (auth.can('purchases.manage')) { <button class="btn sm primary" (click)="editMaterial(null)" [disabled]="!api.online()">+ {{ 'newMaterial' | t }}</button> }</div>
        @if (!api.online()) { <div class="empty">{{ 'onlineOnly' | t }}</div> } @else {
          <table class="data">
            <thead><tr><th>{{ 'code' | t }}</th><th>{{ 'name' | t }}</th><th>{{ 'kind' | t }}</th><th class="num">{{ 'inStock' | t }}</th><th class="num">{{ 'minStock' | t }}</th>
              @if (auth.can('reports.financial')) { <th class="num">{{ 'avgCost' | t }}</th> }<th></th></tr></thead>
            <tbody>
              @for (m of materials(); track m.id) {
                <tr><td class="ltr">{{ m.code }}</td><td>{{ i18n.pick(m.name, m.nameUr) }}</td><td>{{ m.kind | t }}</td>
                  <td class="num" [style.color]="m.quantity < m.minStock ? 'var(--bad)' : ''">{{ m.quantity | num }} {{ m.unit }}</td><td class="num">{{ m.minStock | num }}</td>
                  @if (auth.can('reports.financial')) { <td class="num">{{ m.avgCost | money }}</td> }
                  <td class="right">@if (auth.can('purchases.manage')) { <button class="btn sm" (click)="editMaterial(m)">{{ 'edit' | t }}</button> }</td></tr>
              } @empty { <tr><td colspan="7" class="empty">{{ 'noData' | t }}</td></tr> }
            </tbody>
          </table>
        }
      </div>
    }

    @if (tab() === 'c') {
      <div class="card">
        <div class="card-head"><h2>{{ 'categories' | t }}</h2>
          @if (auth.can('products.manage')) { <button class="btn sm primary" (click)="newCategory()" [disabled]="!api.online()">+ {{ 'newCategory' | t }}</button> }</div>
        <table class="data"><tbody>
          @for (c of categories(); track c.id) { <tr><td>{{ c.name }}</td><td class="ur">{{ c.nameUr }}</td></tr> }
          @empty { <tr><td class="empty">{{ 'noData' | t }}</td></tr> }
        </tbody></table>
      </div>
    }
  </div>

  @if (form(); as f) {
    <app-modal [title]="(f.id ? 'editProduct' : 'newProduct') | t" [wide]="true" (closed)="form.set(null)">
      <div class="stack">
        <app-image-picker [url]="f.imageUrl" [initials]="(f.name || '?').slice(0, 2).toUpperCase()" (urlChange)="f.imageUrl = $event" />
        <div class="form-grid">
          <div class="field"><label>{{ 'code' | t }} *</label><input [(ngModel)]="f.code" /></div>
          <div class="field span-2"><label>{{ 'name' | t }} *</label><input [(ngModel)]="f.name" /></div>
          <div class="field"><label>{{ 'nameUr' | t }}</label><input class="ur" dir="rtl" [(ngModel)]="f.nameUr" /></div>
          <div class="field"><label>{{ 'category' | t }}</label>
            <select [(ngModel)]="f.categoryId"><option [ngValue]="null">—</option>@for (c of categories(); track c.id) { <option [ngValue]="c.id">{{ c.name }}</option> }</select></div>
          <div class="field"><label>{{ 'spiceType' | t }}</label><input [(ngModel)]="f.spiceType" /></div>
          <div class="field"><label>{{ 'brand' | t }}</label><input [(ngModel)]="f.brand" /></div>
          <div class="field"><label>{{ 'barcode' | t }}</label><input [(ngModel)]="f.barcode" /></div>
          <div class="field"><label>{{ 'minStockGrams' | t }}</label><input type="number" min="0" [(ngModel)]="f.minStockGrams" /></div>
          <div class="field"><label>{{ 'reorderGrams' | t }}</label><input type="number" min="0" [(ngModel)]="f.reorderGrams" /></div>
          <div class="field"><label>{{ 'taxRate' | t }}</label><input type="number" min="0" max="100" [(ngModel)]="f.taxRate" /></div>
          <div class="field span-all"><label>{{ 'description' | t }}</label><textarea rows="2" [(ngModel)]="f.description"></textarea></div>
          <label class="check"><input type="checkbox" [(ngModel)]="f.trackExpiry" /> {{ 'trackExpiry' | t }}</label>
          <label class="check"><input type="checkbox" [(ngModel)]="f.isActive" /> {{ 'active' | t }}</label>
        </div>
        <h3>{{ 'packetSizes' | t }}</h3>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>{{ 'packetGrams' | t }}</th><th>{{ 'sku' | t }}</th><th>{{ 'barcode' | t }}</th><th>{{ 'retailPrice' | t }}</th><th>{{ 'wholesalePrice' | t }}</th>
              <th>{{ 'dealerPrice' | t }}</th><th>{{ 'minPrice' | t }}</th><th>{{ 'pouch' | t }}</th><th>{{ 'label' | t }}</th><th>{{ 'minPackets' | t }}</th><th>{{ 'active' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (v of f.variations; track $index; let i = $index) {
                <tr>
                  <td style="min-width:90px"><input type="number" min="1" [(ngModel)]="v.packetGrams" /></td>
                  <td style="width:110px"><input [(ngModel)]="v.sku" [placeholder]="f.code + '-' + v.packetGrams" /></td>
                  <td style="width:110px"><input [(ngModel)]="v.barcode" /></td>
                  <td style="width:90px"><input type="number" min="0" [(ngModel)]="v.retailPrice" /></td>
                  <td style="width:90px"><input type="number" min="0" [(ngModel)]="v.wholesalePrice" /></td>
                  <td style="width:90px"><input type="number" min="0" [(ngModel)]="v.dealerPrice" /></td>
                  <td style="width:90px"><input type="number" min="0" [(ngModel)]="v.minPrice" /></td>
                  <td style="min-width:130px"><select [(ngModel)]="v.pouchMaterialId"><option [ngValue]="null">—</option>@for (m of materialsOf('POUCH'); track m.id) { <option [ngValue]="m.id">{{ m.name }}</option> }</select></td>
                  <td style="min-width:130px"><select [(ngModel)]="v.labelMaterialId"><option [ngValue]="null">—</option>@for (m of materialsOf('LABEL'); track m.id) { <option [ngValue]="m.id">{{ m.name }}</option> }</select></td>
                  <td style="width:80px"><input type="number" min="0" [(ngModel)]="v.minStockPackets" /></td>
                  <td><input type="checkbox" [(ngModel)]="v.isActive" /></td>
                  <td>@if (!v.id) { <button class="btn sm ghost" (click)="f.variations.splice(i, 1)">✕</button> }</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <button class="btn sm" style="align-self:flex-start" (click)="addSize(f)">+ {{ 'addSize' | t }}</button>
        @if (error()) { <div class="alert bad">{{ error() }}</div> }
      </div>
      <ng-container foot>
        <button class="btn" (click)="form.set(null)">{{ 'cancel' | t }}</button>
        <button class="btn primary" (click)="save(f)" [disabled]="busy() || !f.code || !f.name">{{ (busy() ? 'saving' : 'save') | t }}</button>
      </ng-container>
    </app-modal>
  }

  @if (matForm(); as m) {
    <app-modal [title]="(m.id ? 'edit' : 'newMaterial') | t" (closed)="matForm.set(null)">
      <div class="form-grid">
        <div class="field"><label>{{ 'code' | t }}</label><input [(ngModel)]="m.code" /></div>
        <div class="field"><label>{{ 'name' | t }}</label><input [(ngModel)]="m.name" /></div>
        <div class="field"><label>{{ 'nameUr' | t }}</label><input class="ur" dir="rtl" [(ngModel)]="m.nameUr" /></div>
        <div class="field"><label>{{ 'kind' | t }}</label><select [(ngModel)]="m.kind">@for (k of kinds; track k) { <option [value]="k">{{ k | t }}</option> }</select></div>
        <div class="field"><label>{{ 'unit' | t }}</label><input [(ngModel)]="m.unit" /></div>
        <div class="field"><label>{{ 'minStock' | t }}</label><input type="number" min="0" [(ngModel)]="m.minStock" /></div>
        <label class="check"><input type="checkbox" [(ngModel)]="m.isActive" /> {{ 'active' | t }}</label>
      </div>
      <ng-container foot>
        <button class="btn" (click)="matForm.set(null)">{{ 'cancel' | t }}</button>
        <button class="btn primary" (click)="saveMaterial(m)" [disabled]="!m.code || !m.name">{{ 'save' | t }}</button>
      </ng-container>
    </app-modal>
  }`,
  styles: [`.sizes { display: flex; flex-wrap: wrap; gap: 4px; } .size { font-size: 11.5px; background: var(--navy-50); border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px; white-space: nowrap; font-family: var(--font); }
            .size.off { opacity: .45; text-decoration: line-through; }`],
})
export class ProductsPage implements OnInit {
  tab = signal<'p' | 'm' | 'c'>('p');
  items = signal<any[]>([]);
  categories = signal<any[]>([]);
  materials = signal<any[]>([]);
  offline = signal(false);
  form = signal<any>(null);
  matForm = signal<any>(null);
  busy = signal(false); error = signal<string | null>(null);
  q = ''; cat = '';
  kinds = KINDS;

  constructor(public api: Api, public auth: Auth, public i18n: I18n, private toast: Toast, private sync: Sync, private dialog: Dialog) {}

  ngOnInit() { this.load(); }

  catName(id: string | null) { const c = this.categories().find(x => x.id === id); return c ? this.i18n.pick(c.name, c.nameUr) : '—'; }
  materialsOf(kind: string) { return this.materials().filter(m => m.kind === kind || (kind === 'LABEL' && m.kind === 'WRAPPER')); }

  async load() {
    if (this.api.online()) {
      try {
        const [r, cats] = await Promise.all([this.api.get<any>('/api/products', { q: this.q, categoryId: this.cat, pageSize: 500 }), this.api.get<any[]>('/api/product-categories')]);
        this.items.set(r.items); this.categories.set(cats); this.offline.set(false);
        return;
      } catch { /* fall back to device copy */ }
    }
    this.offline.set(true);
    await this.offlineFilter();
  }

  async offlineFilter() {
    if (!this.offline()) return;
    const q = this.q.trim().toLowerCase();
    const [ps, vs, cats] = await Promise.all([db.products.toArray(), db.variations.toArray(), db.categories.toArray()]);
    this.categories.set(cats);
    this.items.set(ps.filter(p => (!q || `${p.name} ${p.nameUr ?? ''} ${p.code}`.toLowerCase().includes(q)) && (!this.cat || p.categoryId === this.cat))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(p => ({ ...p, variations: vs.filter(v => v.productId === p.id).sort((a, b) => a.packetGrams - b.packetGrams) })));
  }

  async loadMaterials() { if (this.api.online()) try { this.materials.set(await this.api.get('/api/packaging-materials')); } catch (e) { this.toast.error(e); } }

  async edit(p: any) {
    this.error.set(null);
    await this.loadMaterials();
    this.form.set(p ? JSON.parse(JSON.stringify(p)) : {
      code: '', name: '', nameUr: '', categoryId: null, spiceType: '', brand: '', description: '', barcode: '', minStockGrams: 0, reorderGrams: 0,
      trackExpiry: false, taxRate: 0, imageUrl: null, isActive: true, variations: [20, 50, 100].map(g => this.blankSize(g)),
    });
  }

  blankSize(g = 0) { return { packetGrams: g, sku: '', barcode: '', retailPrice: g, wholesalePrice: g, dealerPrice: null, minPrice: null, pouchMaterialId: null, labelMaterialId: null, minStockPackets: 0, isActive: true }; }
  addSize(f: any) { f.variations.push(this.blankSize()); }

  async save(f: any) {
    this.busy.set(true); this.error.set(null);
    try {
      const body = { ...f, minStockGrams: +f.minStockGrams || 0, reorderGrams: +f.reorderGrams || 0, taxRate: +f.taxRate || 0,
        variations: f.variations.map((v: any) => ({ ...v, packetGrams: +v.packetGrams, retailPrice: +v.retailPrice || 0, wholesalePrice: +v.wholesalePrice || 0,
          dealerPrice: v.dealerPrice === null || v.dealerPrice === '' ? null : +v.dealerPrice, minPrice: v.minPrice === null || v.minPrice === '' ? null : +v.minPrice,
          minStockPackets: +v.minStockPackets || 0, sku: v.sku?.trim() || '' })) };
      if (f.id) await this.api.put(`/api/products/${f.id}`, body); else await this.api.post('/api/products', body);
      this.toast.ok(this.i18n.t('savedOk'));
      this.form.set(null);
      await this.load();
      this.sync.run();
    } catch (e: any) { this.error.set(e.message); }
    finally { this.busy.set(false); }
  }

  async deleteProduct(p: any) {
    const ok = await this.dialog.confirm(this.i18n.t('deleteProduct'), `${p.name} (${p.code})`, true);
    if (!ok) return;
    try {
      await this.api.delete(`/api/products/${p.id}`);
      this.toast.ok(this.i18n.t('deletedOk'));
      await this.load();
      this.sync.run();
    } catch (e) { this.toast.error(e); }
  }

  editMaterial(m: any) { this.matForm.set(m ? { ...m } : { code: '', name: '', nameUr: '', kind: 'POUCH', unit: 'pcs', minStock: 0, isActive: true }); }
  async saveMaterial(m: any) {
    try {
      if (m.id) await this.api.put(`/api/packaging-materials/${m.id}`, m); else await this.api.post('/api/packaging-materials', m);
      this.matForm.set(null); await this.loadMaterials();
    } catch (e) { this.toast.error(e); }
  }

  async newCategory() {
    const name = await this.dialog.prompt(this.i18n.t('newCategory'), this.i18n.t('name'));
    if (!name?.trim()) return;
    try { await this.api.post('/api/product-categories', { name: name.trim(), isActive: true }); await this.load(); } catch (e) { this.toast.error(e); }
  }

  exportCsv() {
    const rows = this.items().flatMap(p => p.variations.map((v: any) => ({ code: p.code, name: p.name, nameUr: p.nameUr, packetGrams: v.packetGrams, sku: v.sku,
      retailPrice: v.retailPrice, wholesalePrice: v.wholesalePrice, packets: v.packets ?? '' })));
    downloadText('products.csv', toCsv(rows, ['code', 'name', 'nameUr', 'packetGrams', 'sku', 'retailPrice', 'wholesalePrice', 'packets'].map(k => ({ key: k, label: k }))));
  }

  async importCsv(ev: Event) {
    const input = ev.target as HTMLInputElement; const file = input.files?.[0]; input.value = '';
    if (!file) return;
    const lines = (await file.text()).replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
    const head = parseCsvLine(lines.shift() ?? '').map(h => h.trim());
    const idx = (k: string) => head.indexOf(k);
    if (idx('code') < 0 || idx('name') < 0 || idx('packetGrams') < 0) { this.toast.warn(this.i18n.t('importHelp')); return; }
    const byCode = new Map<string, any>();
    for (const l of lines) {
      const c = parseCsvLine(l); const code = c[idx('code')]?.trim(); if (!code) continue;
      const p = byCode.get(code) ?? { code, name: c[idx('name')], nameUr: idx('nameUr') >= 0 ? c[idx('nameUr')] : null, minStockGrams: 0, reorderGrams: 0,
        trackExpiry: false, taxRate: 0, isActive: true, variations: [] };
      const g = +c[idx('packetGrams')];
      if (g > 0) p.variations.push({ packetGrams: g, sku: '', retailPrice: +(c[idx('retailPrice')] ?? 0) || 0, wholesalePrice: +(c[idx('wholesalePrice')] ?? 0) || 0, minStockPackets: 0, isActive: true });
      byCode.set(code, p);
    }
    try {
      const r: any = await this.api.post('/api/products/import', [...byCode.values()]);
      this.toast.ok(this.i18n.t('imported', r.created, r.skipped.length));
      await this.load();
    } catch (e) { this.toast.error(e); }
  }
}

function parseCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}
