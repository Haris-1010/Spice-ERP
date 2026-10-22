import { Component, computed, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Api } from './core/api';
import { Auth } from './core/auth';
import { I18n, TPipe } from './core/i18n';
import { Sync } from './core/sync';
import { PkDatePipe } from './core/format';
import { Dialog, Toast, errorText } from './shared/ui';

export interface NavItem { path: string; key: string; perm?: string; icon: string; }

/** 24px stroke icons (simple paths, no icon font needed offline). */
const I = {
  dash: 'M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z',
  box: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  cart: 'M3 3h2l2.4 12.2a2 2 0 002 1.8h8.2a2 2 0 002-1.6L21 8H6M9 21a1 1 0 100-2 1 1 0 000 2zm9 0a1 1 0 100-2 1 1 0 000 2z',
  sack: 'M8 3h8l-2 4h-4zM6 9c-2 3-3 6-3 8a4 4 0 004 4h10a4 4 0 004-4c0-2-1-5-3-8z',
  gear2: 'M4 6h16M4 12h10M4 18h6M18 15l3 3-3 3',
  stack: 'M4 7h16v4H4zM4 13h16v4H4z',
  users: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM22 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8',
  truck: 'M1 4h14v12H1zM15 9h4l4 4v3h-8M5.5 21a2 2 0 100-4 2 2 0 000 4zm13 0a2 2 0 100-4 2 2 0 000 4z',
  receipt: 'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6',
  route: 'M6 19a2 2 0 100-4 2 2 0 000 4zM18 9a2 2 0 100-4 2 2 0 000 4zM6 15V9a4 4 0 014-4h4M18 9v6a4 4 0 01-4 4h-4',
  wallet: 'M3 7h18v13H3zM3 7l3-4h12l3 4M16 14h2',
  bill: 'M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 018 0v4',
  sync: 'M21 12a9 9 0 01-15.5 6.2L3 16M3 12a9 9 0 0115.5-6.2L21 8M21 3v5h-5M3 21v-5h5',
  cog: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z',
};

export const NAV: NavItem[] = [
  { path: '/dashboard', key: 'dashboard', icon: I.dash },
  { path: '/products', key: 'products', perm: 'products.view', icon: I.box },
  { path: '/purchases', key: 'purchases', perm: 'purchases.view', icon: I.cart },
  { path: '/bulk', key: 'bulkInventory', perm: 'inventory.view', icon: I.sack },
  { path: '/packing', key: 'packing', perm: 'packing.post', icon: I.gear2 },
  { path: '/stock', key: 'finishedStock', perm: 'inventory.view', icon: I.stack },
  { path: '/customers', key: 'customers', perm: 'customers.view', icon: I.users },
  { path: '/suppliers', key: 'suppliers', perm: 'suppliers.view', icon: I.truck },
  { path: '/sales', key: 'sales', perm: 'sales.view', icon: I.receipt },
  { path: '/deliveries', key: 'deliveries', perm: 'delivery.execute', icon: I.route },
  { path: '/payments', key: 'payments', perm: 'receipts.create', icon: I.wallet },
  { path: '/expenses', key: 'expenses', perm: 'expenses.create', icon: I.bill },
  { path: '/reports', key: 'reports', perm: 'reports.view', icon: I.chart },
  { path: '/users', key: 'users', perm: 'users.manage', icon: I.lock },
  { path: '/sync', key: 'sync', icon: I.sync },
  { path: '/settings', key: 'settings', icon: I.cog },
];

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TPipe, PkDatePipe],
  template: `
    <div class="layout" [class.open]="menuOpen()">
      <aside class="sidebar">
        <div class="brand">
          <span class="logo">✦</span>
          <div><div class="bname">{{ 'appName' | t }}</div><div class="small sub">{{ auth.user()?.fullName }}</div></div>
        </div>
        <nav>
          @for (n of nav(); track n.path) {
            <a [routerLink]="n.path" routerLinkActive="active" (click)="menuOpen.set(false)">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path [attr.d]="n.icon" /></svg>
              <span>{{ n.key | t }}</span>
              @if (n.key === 'sync' && sync.pending() > 0) { <span class="count">{{ sync.pending() }}</span> }
            </a>
          }
        </nav>
      </aside>
      <div class="scrim" (click)="menuOpen.set(false)"></div>
      <div class="main">
        <header class="topbar">
          <button class="btn ghost sm menu-btn" (click)="menuOpen.set(!menuOpen())" [attr.aria-label]="'menu' | t">☰</button>
          <span class="conn" [class.on]="api.online()" [class.off]="!api.online()">
            <span class="dot"></span>{{ (api.online() ? 'online' : 'offline') | t }}
          </span>
          <a routerLink="/sync" class="sync-chip" [class.warn]="sync.pending() > 0" [class.bad]="sync.state() === 'error' || sync.state() === 'expired'">
            @switch (sync.state()) {
              @case ('syncing') { {{ 'syncing' | t }} @if (sync.pending() > 0) { · {{ 'pendingSync' | t: sync.pending() }} } }
              @case ('expired') { {{ 'sessionExpired' | t }} }
              @default {
                @if (sync.pending() > 0) { {{ 'pendingSync' | t: sync.pending() }} } @else { {{ 'allSynced' | t }} }
              }
            }
            <span class="small muted last">· {{ 'lastSync' | t }}: {{ sync.lastSync() ? (sync.lastSync() | pkdate: true) : ('never' | t) }}</span>
          </a>
          <button class="btn sm" (click)="sync.run(true)" [disabled]="sync.state() === 'syncing' || !api.online()">{{ 'syncNow' | t }}</button>
          <span class="spacer"></span>
          <button class="btn sm" (click)="i18n.set(i18n.isUr() ? 'en' : 'ur')">{{ i18n.isUr() ? 'English' : 'اردو' }}</button>
          <button class="btn sm ghost" (click)="logout()">{{ 'logout' | t }}</button>
        </header>
        @if (auth.expired()) {
          <div class="alert warn banner">{{ 'sessionExpired' | t }} <button class="btn sm" (click)="reauth()">{{ 'signIn' | t }}</button></div>
        }
        <main><router-outlet /></main>
      </div>
    </div>
  `,
  styles: [`
    .layout { display: flex; min-height: 100vh; }
    .sidebar { width: var(--sidebar-w); background: var(--navy-900); color: #cdd8e8; flex-shrink: 0; position: sticky; top: 0; height: 100vh; overflow-y: auto; display: flex; flex-direction: column; }
    .brand { display: flex; gap: 10px; align-items: center; padding: 18px 18px 14px; border-bottom: 1px solid rgba(255,255,255,.08); }
    .logo { width: 34px; height: 34px; border-radius: 9px; background: var(--accent); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 18px; }
    .bname { color: #fff; font-weight: 700; font-size: 15px; }
    .sub { color: #93a5bf; }
    nav { padding: 10px 8px; display: flex; flex-direction: column; gap: 2px; }
    nav a { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 8px; color: #cdd8e8; font-size: 13.5px; }
    nav a:hover { background: rgba(255,255,255,.06); text-decoration: none; }
    nav a.active { background: var(--navy-700); color: #fff; }
    nav a .count { margin-inline-start: auto; background: var(--accent); color: #fff; border-radius: 999px; font-size: 11px; padding: 0 7px; font-family: var(--font); }
    .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .topbar { height: 56px; background: #fff; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; padding: 0 16px; position: sticky; top: 0; z-index: 20; }
    .conn { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; }
    .conn .dot { width: 8px; height: 8px; border-radius: 50%; }
    .conn.on { color: var(--ok); } .conn.on .dot { background: var(--ok); }
    .conn.off { color: var(--warn); } .conn.off .dot { background: var(--warn); }
    .sync-chip { font-size: 12.5px; color: var(--text-2); padding: 4px 10px; border-radius: 999px; background: var(--navy-50); }
    .sync-chip.warn { background: var(--warn-bg); color: var(--warn); }
    .sync-chip.bad { background: var(--bad-bg); color: var(--bad); }
    .banner { margin: 12px 24px 0; display: flex; gap: 10px; align-items: center; }
    .menu-btn { display: none; }
    .scrim { display: none; }
    @media (max-width: 900px) {
      .sidebar { position: fixed; inset-inline-start: 0; z-index: 50; transform: translateX(-100%); transition: transform .2s; }
      :host-context([dir=rtl]) .sidebar { transform: translateX(100%); }
      .layout.open .sidebar { transform: none; }
      .layout.open .scrim { display: block; position: fixed; inset: 0; background: rgba(0,0,0,.35); z-index: 40; }
      .menu-btn { display: inline-flex; }
      .last { display: none; }
    }
    @media print { .sidebar, .topbar, .banner { display: none !important; } }
  `],
})
export class ShellComponent {
  menuOpen = signal(false);
  nav = computed(() => NAV.filter(n => !n.perm || this.auth.can(n.perm)));
  constructor(public api: Api, public auth: Auth, public sync: Sync, public i18n: I18n, private router: Router,
              private dialog: Dialog, private toast: Toast) {}

  async logout() {
    const pending = this.sync.pending();
    if (pending > 0 && !(await this.dialog.confirm(this.i18n.t('logout'), this.i18n.t('logoutPending', pending)))) return;
    await this.auth.logout(false);
    this.router.navigateByUrl('/');
  }

  async reauth() {
    // Keep local data; sign in again only to refresh the token.
    await this.auth.logout(false);
  }
}

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule, TPipe],
  template: `
    <div class="wrap">
      <form class="card box" (ngSubmit)="submit()">
        <div class="head">
          <span class="logo">✦</span>
          <h1>{{ 'appName' | t }}</h1>
          <button type="button" class="btn sm" (click)="i18n.set(i18n.isUr() ? 'en' : 'ur')">{{ i18n.isUr() ? 'English' : 'اردو' }}</button>
        </div>
        <div class="field"><label>{{ 'username' | t }}</label><input name="u" [(ngModel)]="username" autocomplete="username" required autofocus /></div>
        <div class="field"><label>{{ 'password' | t }}</label><input name="p" type="password" [(ngModel)]="password" autocomplete="current-password" required /></div>
        <div class="field"><label>{{ 'deviceName' | t }} <span class="muted">({{ 'optional' | t }})</span></label><input name="d" [(ngModel)]="deviceName" placeholder="Counter PC, Rider phone…" /></div>
        @if (error()) { <div class="alert bad">{{ error() }}</div> }
        <button class="btn primary lg" type="submit" [disabled]="busy() || !username || !password">{{ (busy() ? 'signingIn' : 'signIn') | t }}</button>
        <p class="small muted" style="margin:0">{{ 'firstSignInOnline' | t }}</p>
      </form>
    </div>`,
  styles: [`
    .wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px;
            background: linear-gradient(160deg, var(--navy-900), var(--navy-700) 60%, var(--navy-600)); }
    .box { width: 100%; max-width: 380px; padding: 26px; display: flex; flex-direction: column; gap: 14px; }
    .head { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
    .head h1 { margin-inline-end: auto; }
    .logo { width: 36px; height: 36px; border-radius: 9px; background: var(--accent); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 18px; }
  `],
})
export class LoginComponent {
  username = ''; password = ''; deviceName = '';
  busy = signal(false); error = signal<string | null>(null);
  constructor(private auth: Auth, public i18n: I18n, private sync: Sync, private router: Router) {}
  async submit() {
    this.busy.set(true); this.error.set(null);
    try {
      await this.auth.login(this.username.trim(), this.password, this.deviceName.trim() || undefined);
      this.password = '';
      this.sync.run();
      this.router.navigateByUrl('/dashboard');
    } catch (e) { this.error.set(errorText(e)); }
    finally { this.busy.set(false); }
  }
}
