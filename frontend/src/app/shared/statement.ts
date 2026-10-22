import { Component, EventEmitter, Input, OnInit, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { getMeta } from '../core/db';
import { MoneyPipe, PkDatePipe, monthStart, pkToday } from '../core/format';
import { SHARED, Toast } from './ui';

/** Statement (ledger) of a customer or supplier — printable. */
@Component({
  selector: 'app-statement',
  standalone: true,
  imports: [FormsModule, MoneyPipe, PkDatePipe, ...SHARED],
  template: `
  <app-modal [title]="('statement' | t) + ' — ' + name" [wide]="true" (closed)="closed()">
    <div class="stack">
      <div class="toolbar no-print">
        <div class="field"><label>{{ 'from' | t }}</label><input type="date" [(ngModel)]="from" (change)="load()" /></div>
        <div class="field"><label>{{ 'to' | t }}</label><input type="date" [(ngModel)]="to" (change)="load()" /></div>
        <button class="btn" (click)="print()">{{ 'print' | t }}</button>
      </div>
      @if (data(); as d) {
        <div class="print-area">
          <div class="print-only"><h2>{{ business?.name }}</h2><p>{{ 'statement' | t }} — {{ name }} · {{ from | pkdate }} – {{ to | pkdate }}</p></div>
          <table class="data">
            <thead><tr><th>{{ 'date' | t }}</th><th>{{ 'description' | t }}</th><th class="num">{{ 'debit' | t }}</th><th class="num">{{ 'credit' | t }}</th><th class="num">{{ 'balance' | t }}</th></tr></thead>
            <tbody>
              <tr><td></td><td><em>{{ 'openingBalance' | t }}</em></td><td></td><td></td><td class="num"><strong>{{ d.opening | money }}</strong></td></tr>
              @for (r of d.rows; track $index) {
                <tr><td class="nowrap">{{ r.date | pkdate }}</td><td>{{ r.description }}</td>
                  <td class="num">{{ r.debit ? (r.debit | money) : '' }}</td><td class="num">{{ r.credit ? (r.credit | money) : '' }}</td><td class="num">{{ r.balance | money }}</td></tr>
              }
            </tbody>
            <tfoot><tr><td colspan="4">{{ 'closing' | t }}</td><td class="num">{{ d.closing | money }}</td></tr></tfoot>
          </table>
        </div>
      } @else { <div class="empty">{{ 'loading' | t }}</div> }
    </div>
    <ng-container foot><button class="btn" (click)="closed()">{{ 'close' | t }}</button></ng-container>
  </app-modal>`,
})
export class StatementComponent implements OnInit {
  @Input() kind: 'customer' | 'supplier' = 'customer';
  @Input() id = '';
  @Input() name = '';
  @Output() close = new EventEmitter<void>();
  from = monthStart(); to = pkToday();
  data = signal<any>(null);
  business: any;
  constructor(private api: Api, private toast: Toast) {}
  async ngOnInit() { this.business = await getMeta('business'); this.load(); }
  closed() { this.close.emit(); }
  async load() {
    try { this.data.set(await this.api.get(`/api/reports/${this.kind}-statement/${this.id}`, { from: this.from, to: this.to })); }
    catch (e) { this.toast.error(e); }
  }
  print() { const s = document.createElement('style'); s.id = 'print-page-style'; document.getElementById('print-page-style')?.remove();
    s.textContent = '@media print{body *{visibility:hidden!important}.print-area,.print-area *{visibility:visible!important}.print-area{position:absolute;top:0;inset-inline-start:0;width:100%}}';
    document.head.appendChild(s); setTimeout(() => window.print(), 50); }
}

