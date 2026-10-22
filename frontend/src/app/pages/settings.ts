import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { setMeta } from '../core/db';
import { MoneyPipe } from '../core/format';
import { I18n, TPipe } from '../core/i18n';
import { Sync } from '../core/sync';
import { Dialog, SHARED, Toast, errorText } from '../shared/ui';

@Component({
  standalone: true,
  imports: [FormsModule, MoneyPipe, ...SHARED],
  template: `
  <div class="page">
    <div class="page-head"><h1>{{ 'settings' | t }}</h1></div>
    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><h2>{{ 'language' | t }} · {{ 'printerSetup' | t }}</h2></div>
        <div class="card-body stack">
          <div class="row">
            <button class="btn" [class.primary]="!i18n.isUr()" (click)="setLang('en')">English</button>
            <button class="btn" [class.primary]="i18n.isUr()" (click)="setLang('ur')">اردو</button>
          </div>
          <div class="field"><label>{{ 'defaultPrint' | t }}</label>
            <select [(ngModel)]="layout" (ngModelChange)="saveLayout()"><option value="a4">A4</option><option value="thermal">{{ 'thermal' | t }}</option></select></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>{{ 'changePassword' | t }}</h2></div>
        <div class="card-body stack">
          <div class="field"><label>{{ 'currentPassword' | t }}</label><input type="password" [(ngModel)]="cur" autocomplete="current-password" /></div>
          <div class="field"><label>{{ 'newPassword' | t }}</label><input type="password" [(ngModel)]="nw" autocomplete="new-password" /></div>
          <button class="btn primary" style="align-self:flex-start" (click)="changePassword()" [disabled]="!cur || !nw || !api.online()">{{ 'save' | t }}</button>
        </div>
      </div>
    </div>

    @if (auth.can('settings.manage')) {
      @if (!api.online()) { <div class="card empty" style="margin-top:16px">{{ 'onlineOnly' | t }}</div> }
      @else if (b()) {
        @let b = biz;
        <div class="card" style="margin-top:16px">
          <div class="card-head"><h2>{{ 'businessSettings' | t }}</h2></div>
          <div class="card-body stack">
            <app-image-picker kind="logo" [url]="b.logoUrl" [initials]="(b.name || '?').slice(0, 2)" (urlChange)="b.logoUrl = $event" />
            <div class="form-grid">
              <div class="field span-2"><label>{{ 'businessName' | t }}</label><input [(ngModel)]="b.name" /></div>
              <div class="field span-2"><label>{{ 'businessNameUr' | t }}</label><input class="ur" dir="rtl" [(ngModel)]="b.nameUr" /></div>
              <div class="field span-2"><label>{{ 'address' | t }}</label><input [(ngModel)]="b.address" /></div>
              <div class="field span-2"><label>{{ 'addressUr' | t }}</label><input class="ur" dir="rtl" [(ngModel)]="b.addressUr" /></div>
              <div class="field"><label>{{ 'phone' | t }}</label><input [(ngModel)]="b.phone" /></div>
              <div class="field"><label>{{ 'currency' | t }}</label><input [(ngModel)]="b.currencySymbol" /></div>
              <div class="field span-all"><label>{{ 'invoiceTerms' | t }}</label><textarea rows="2" [(ngModel)]="b.invoiceTerms"></textarea></div>
              <div class="field span-all"><label>{{ 'invoiceTermsUr' | t }}</label><textarea rows="2" class="ur" dir="rtl" [(ngModel)]="b.invoiceTermsUr"></textarea></div>
              <label class="check span-all"><input type="checkbox" [(ngModel)]="b.allowNegativeStock" /> {{ 'allowNegative' | t }}</label>
            </div>
            <button class="btn primary" style="align-self:flex-start" (click)="saveBusiness(b)">{{ 'save' | t }}</button>
          </div>
        </div>
        <div class="card" style="margin-top:16px">
          <div class="card-head"><h2>{{ 'cashAccounts' | t }}</h2><button class="btn sm" (click)="newAccount()">+ {{ 'newAccount' | t }}</button></div>
          <table class="data"><tbody>@for (a of accounts(); track a.id) {
            <tr><td><strong>{{ i18n.pick(a.name, a.nameUr) }}</strong></td><td>{{ a.kind | t }}</td><td class="num">{{ a.balance | money }}</td></tr>
          }</tbody></table>
        </div>
      }
    }

    <div class="card" style="margin-top:16px">
      <div class="card-head"><h2>{{ 'deviceInfo' | t }}</h2></div>
      <div class="card-body stack">
        <div class="ltr">{{ auth.session()?.device?.prefix }} · {{ auth.session()?.device?.name }}</div>
        <button class="btn danger" style="align-self:flex-start" (click)="clearDevice()">{{ 'clearDeviceData' | t }}</button>
      </div>
    </div>
  </div>`,
})
export class SettingsPage implements OnInit {
  b = signal<any>(null);
  get biz() { return this.b(); }
  accounts = signal<any[]>([]);
  layout: 'a4' | 'thermal' = 'a4'; cur = ''; nw = '';
  constructor(public api: Api, public auth: Auth, public i18n: I18n, private toast: Toast, private dialog: Dialog, private sync: Sync) {}

  async ngOnInit() {
    try { this.layout = (localStorage.getItem('printLayout') as any) || 'a4'; } catch { /* default */ }
    if (this.auth.can('settings.manage') && this.api.online()) {
      try { const [b, a] = await Promise.all([this.api.get('/api/settings/business'), this.api.get<any[]>('/api/cash-accounts')]); this.b.set(b); this.accounts.set(a); }
      catch (e) { this.toast.error(e); }
    }
  }

  async setLang(l: 'en' | 'ur') { this.i18n.set(l); if (this.api.online()) this.api.put('/api/auth/language', { language: l }).catch(() => {}); }
  saveLayout() { try { localStorage.setItem('printLayout', this.layout); } catch { /* ignore */ } }

  async saveBusiness(b: any) {
    try { const saved = await this.api.put('/api/settings/business', b); await setMeta('business', saved); this.toast.ok(this.i18n.t('savedOk')); this.sync.run(); }
    catch (e) { this.toast.error(e); }
  }

  async newAccount() {
    const name = await this.dialog.prompt(this.i18n.t('newAccount'), 'e.g. Meezan Bank / JazzCash');
    if (!name) return;
    const kind = /jazz|easy|wallet/i.test(name) ? 'WALLET' : 'BANK';
    try { await this.api.post('/api/cash-accounts', { name, kind, openingBalance: 0 }); this.accounts.set(await this.api.get('/api/cash-accounts')); } catch (e) { this.toast.error(e); }
  }

  async changePassword() {
    try { await this.api.post('/api/auth/change-password', { currentPassword: this.cur, newPassword: this.nw }); this.cur = this.nw = ''; this.toast.ok(this.i18n.t('savedOk')); }
    catch (e) { this.toast.error(e); }
  }

  async clearDevice() {
    if (!(await this.dialog.confirm(this.i18n.t('clearDeviceData') + '?', undefined, true))) return;
    try { await this.auth.logout(true); location.reload(); } catch (e) { this.toast.warn(errorText(e)); }
  }
}
