import { Component, OnInit, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { OutboxOp, db } from '../core/db';
import { PkDatePipe } from '../core/format';
import { I18n, TPipe } from '../core/i18n';
import { Store } from '../core/store';
import { Sync } from '../core/sync';
import { Dialog, SHARED, Toast } from '../shared/ui';

@Component({
  standalone: true,
  imports: [FormsModule, PkDatePipe, ...SHARED],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>{{ 'sync' | t }}</h1>
      <button class="btn primary" (click)="sync.run(true)" [disabled]="sync.state() === 'syncing' || !api.online()">{{ (sync.state() === 'syncing' ? 'syncing' : 'syncNow') | t }}</button>
    </div>
    <div class="grid grid-4" style="margin-bottom:16px">
      <div class="card kpi"><span class="label">{{ 'status' | t }}</span><span class="value" style="font-size:16px">{{ (api.online() ? 'online' : 'offline') | t }} · {{ sync.state() }}</span>
        @if (sync.lastError()) { <span class="sub" style="color:var(--bad)">{{ sync.lastError() }}</span> }</div>
      <div class="card kpi" [class.alert]="sync.pending() > 0"><span class="label">{{ 'unsyncedDevice' | t }}</span><span class="value">{{ sync.pending() }}</span></div>
      <div class="card kpi"><span class="label">{{ 'lastSync' | t }}</span><span class="value" style="font-size:15px">{{ sync.lastSync() ? (sync.lastSync() | pkdate: true) : ('never' | t) }}</span></div>
      <div class="card kpi"><span class="label">{{ 'deviceInfo' | t }}</span><span class="value ltr" style="font-size:16px">{{ auth.session()?.device?.prefix }}</span><span class="sub">{{ auth.session()?.device?.name }}</span></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h2>{{ 'outbox' | t }}</h2>
        <select [(ngModel)]="filter" (ngModelChange)="load()" style="width:200px"><option value="open">{{ 'pending' | t }} / {{ 'st_failed' | t }}</option><option value="problems">{{ 'st_rejected' | t }} / {{ 'st_conflict' | t }}</option><option value="all">{{ 'all' | t }}</option></select></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>{{ 'time' | t }}</th><th>{{ 'opType' | t }}</th><th>{{ 'reference' | t }}</th><th>{{ 'status' | t }}</th><th class="num">#</th><th>{{ 'serverMessage' | t }}</th></tr></thead>
        <tbody>@for (o of ops(); track o.seq) {
          <tr><td class="nowrap small">{{ o.createdAt | pkdate: true }}</td><td class="small">{{ o.type }}</td><td class="ltr"><strong>{{ o.label }}</strong></td>
            <td><app-sync-badge [status]="o.status" /></td><td class="num small">{{ o.attempts }}</td>
            <td class="small">{{ o.lastError }}@for (w of o.serverResult?.warnings ?? []; track w) { <div style="color:var(--warn)">⚠ {{ w }}</div> }</td></tr>
        } @empty { <tr><td colspan="6" class="empty">{{ 'allSynced' | t }}</td></tr> }</tbody>
      </table></div>
    </div>

    @if (auth.can('sync.review')) {
      <div class="card">
        <div class="card-head"><h2>{{ 'conflicts' | t }}</h2><button class="btn sm" (click)="loadConflicts()" [disabled]="!api.online()">{{ 'refresh' | t }}</button></div>
        @if (!api.online()) { <div class="empty">{{ 'onlineOnly' | t }}</div> } @else {
          <div class="table-wrap"><table class="data">
            <thead><tr><th>{{ 'time' | t }}</th><th>{{ 'type' | t }}</th><th>{{ 'device' | t }}</th><th>{{ 'details' | t }}</th><th></th></tr></thead>
            <tbody>@for (c of conflicts(); track c.id) {
              <tr><td class="nowrap small">{{ c.createdAt | pkdate: true }}</td><td><span class="badge bad">{{ c.conflictType }}</span></td><td class="ltr">{{ c.device }}</td><td>{{ c.details }}</td>
                <td><button class="btn sm" (click)="resolve(c)">{{ 'resolve' | t }}</button></td></tr>
            } @empty { <tr><td colspan="5" class="empty">✓</td></tr> }</tbody>
          </table></div>
        }
      </div>
    }
  </div>`,
})
export class SyncPage implements OnInit {
  ops = signal<OutboxOp[]>([]); conflicts = signal<any[]>([]);
  filter = 'open';
  constructor(public api: Api, public auth: Auth, public sync: Sync, private i18n: I18n, private store: Store, private toast: Toast, private dialog: Dialog) {
    effect(() => { this.store.version(); this.load(); });
  }
  ngOnInit() { this.loadConflicts(); }
  async load() {
    const all = (await db.outbox.orderBy('seq').reverse().limit(500).toArray());
    this.ops.set(all.filter(o => this.filter === 'all' || (this.filter === 'open' ? ['local', 'syncing', 'failed'].includes(o.status) : ['rejected', 'conflict'].includes(o.status))));
  }
  async loadConflicts() { if (this.auth.can('sync.review') && this.api.online()) try { this.conflicts.set(await this.api.get('/api/sync/conflicts')); } catch (e) { this.toast.error(e); } }
  async resolve(c: any) {
    const note = await this.dialog.prompt(this.i18n.t('resolve'), this.i18n.t('resolutionNote'));
    if (!note) return;
    try { await this.api.post(`/api/sync/conflicts/${c.id}/resolve`, { note }); await this.loadConflicts(); } catch (e) { this.toast.error(e); }
  }
}
