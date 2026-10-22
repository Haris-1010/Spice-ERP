import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { PkDatePipe } from '../core/format';
import { I18n, TPipe } from '../core/i18n';
import { Dialog, SHARED, Toast } from '../shared/ui';

const ROLES = ['Owner', 'Storekeeper', 'Packer', 'Salesperson', 'Delivery', 'Accountant'];

@Component({
  standalone: true,
  imports: [FormsModule, PkDatePipe, ...SHARED],
  template: `
  <div class="page">
    <div class="page-head"><h1>{{ 'users' | t }}</h1><button class="btn primary" (click)="edit(null)" [disabled]="!api.online()">+ {{ 'newUser' | t }}</button></div>
    @if (!api.online()) { <div class="card empty">{{ 'onlineOnly' | t }}</div> } @else {
      <div class="card table-wrap" style="margin-bottom:16px">
        <table class="data">
          <thead><tr><th>{{ 'fullName' | t }}</th><th>{{ 'username' | t }}</th><th>{{ 'phone' | t }}</th><th>{{ 'roles' | t }}</th><th>{{ 'language' | t }}</th><th>{{ 'status' | t }}</th><th></th></tr></thead>
          <tbody>@for (u of users(); track u.id) {
            <tr><td><strong>{{ u.fullName }}</strong></td><td class="ltr">{{ u.username }}</td><td class="ltr">{{ u.phone }}</td>
              <td>@for (r of u.roles; track r) { <span class="badge" style="margin-inline-end:4px">{{ 'role_' + r | t }}</span> }</td>
              <td>{{ u.preferredLanguage === 'ur' ? 'اردو' : 'English' }}</td>
              <td>@if (u.isActive) { <span class="badge ok">{{ 'active' | t }}</span> } @else { <span class="badge grey">{{ 'inactive' | t }}</span> }
                @if (u.lockedUntil) { <span class="badge bad">{{ 'lockedUntil' | t }} {{ u.lockedUntil | pkdate: true }}</span> }</td>
              <td class="right nowrap"><button class="btn sm" (click)="edit(u)">{{ 'edit' | t }}</button><button class="btn sm" (click)="reset(u)">{{ 'resetPassword' | t }}</button></td></tr>
          }</tbody>
        </table>
      </div>
      <div class="card">
        <div class="card-head"><h2>{{ 'devices' | t }}</h2></div>
        <p class="small muted" style="margin:12px 16px 0">{{ 'revokeNote' | t }}</p>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>{{ 'device' | t }}</th><th>{{ 'name' | t }}</th><th>{{ 'user' | t }}</th><th>{{ 'lastSync' | t }}</th><th>{{ 'status' | t }}</th><th></th></tr></thead>
          <tbody>@for (d of devices(); track d.id) {
            <tr><td class="ltr"><strong>{{ d.prefix }}</strong></td><td>{{ d.name }}</td><td>{{ d.lastUser }}</td><td>{{ d.lastPushAt ?? d.lastSeenAt | pkdate: true }}</td>
              <td>@if (d.isRevoked) { <span class="badge bad">{{ 'revoked' | t }}</span> } @else { <span class="badge ok">{{ 'active' | t }}</span> }</td>
              <td class="right"><button class="btn sm" [class.danger]="!d.isRevoked" (click)="toggleDevice(d)">{{ (d.isRevoked ? 'restore' : 'revoke') | t }}</button></td></tr>
          }</tbody>
        </table></div>
      </div>
    }
  </div>
  @if (form(); as f) {
    <app-modal [title]="(f.id ? 'edit' : 'newUser') | t" (closed)="form.set(null)">
      <div class="stack">
        <div class="form-grid">
          <div class="field"><label>{{ 'fullName' | t }} *</label><input [(ngModel)]="f.fullName" /></div>
          <div class="field"><label>{{ 'username' | t }} *</label><input [(ngModel)]="f.username" [disabled]="!!f.id" autocomplete="off" /></div>
          <div class="field"><label>{{ 'phone' | t }}</label><input [(ngModel)]="f.phone" /></div>
          @if (!f.id) { <div class="field"><label>{{ 'password' | t }} *</label><input type="password" [(ngModel)]="f.password" autocomplete="new-password" /><span class="hint">8+ letters & numbers</span></div> }
          <div class="field"><label>{{ 'language' | t }}</label><select [(ngModel)]="f.preferredLanguage"><option value="en">English</option><option value="ur">اردو</option></select></div>
          <label class="check"><input type="checkbox" [(ngModel)]="f.isActive" /> {{ 'active' | t }}</label>
        </div>
        <div class="field"><label>{{ 'roles' | t }}</label>
          <div class="row">@for (r of roles; track r) { <label class="check"><input type="checkbox" [checked]="f.roles.includes(r)" (change)="toggleRole(f, r)" /> {{ 'role_' + r | t }}</label> }</div></div>
      </div>
      <ng-container foot><button class="btn" (click)="form.set(null)">{{ 'cancel' | t }}</button>
        <button class="btn primary" (click)="save(f)" [disabled]="!f.fullName || !f.username || !f.roles.length">{{ 'save' | t }}</button></ng-container>
    </app-modal>
  }`,
})
export class UsersPage implements OnInit {
  users = signal<any[]>([]); devices = signal<any[]>([]); form = signal<any>(null);
  roles = ROLES;
  constructor(public api: Api, private auth: Auth, private i18n: I18n, private toast: Toast, private dialog: Dialog) {}
  ngOnInit() { this.load(); }
  async load() {
    if (!this.api.online()) return;
    try { const [u, d] = await Promise.all([this.api.get<any[]>('/api/users'), this.api.get<any[]>('/api/devices')]); this.users.set(u); this.devices.set(d); }
    catch (e) { this.toast.error(e); }
  }
  edit(u: any) { this.form.set(u ? { ...u, roles: [...u.roles] } : { fullName: '', username: '', phone: '', password: '', roles: ['Salesperson'], isActive: true, preferredLanguage: 'ur' }); }
  toggleRole(f: any, r: string) { f.roles = f.roles.includes(r) ? f.roles.filter((x: string) => x !== r) : [...f.roles, r]; }
  async save(f: any) {
    try {
      const body = { username: f.username, fullName: f.fullName, phone: f.phone, password: f.password, roles: f.roles, isActive: f.isActive, preferredLanguage: f.preferredLanguage };
      if (f.id) await this.api.put(`/api/users/${f.id}`, body); else await this.api.post('/api/users', body);
      this.form.set(null); this.toast.ok(this.i18n.t('savedOk')); await this.load();
    } catch (e) { this.toast.error(e); }
  }
  async reset(u: any) {
    const pwd = await this.dialog.prompt(`${this.i18n.t('resetPassword')} — ${u.fullName}`, this.i18n.t('newPassword'));
    if (!pwd) return;
    try { await this.api.post(`/api/users/${u.id}/reset-password`, { newPassword: pwd }); this.toast.ok(this.i18n.t('savedOk')); await this.load(); } catch (e) { this.toast.error(e); }
  }
  async toggleDevice(d: any) {
    if (!d.isRevoked && !(await this.dialog.confirm(`${this.i18n.t('revoke')} ${d.prefix}?`, this.i18n.t('revokeNote'), true))) return;
    try { await this.api.put(`/api/devices/${d.id}/revoked`, { revoked: !d.isRevoked }); await this.load(); } catch (e) { this.toast.error(e); }
  }
}
