import { Component, Input } from '@angular/core';
import { Api } from '../core/api';
import { Customer, Invoice } from '../core/db';
import { MoneyPipe, PkDatePipe } from '../core/format';
import { I18n, Lang } from '../core/i18n';

export type PrintLang = 'en' | 'ur' | 'both';

/**
 * Printable invoice rendered purely from data stored on the device — printing never calls the
 * server, never creates a sale and never changes stock.
 */
@Component({
  selector: 'app-invoice-doc',
  standalone: true,
  imports: [MoneyPipe, PkDatePipe],
  template: `
  <div class="doc" [class.thermal]="layout === 'thermal'" [attr.dir]="lang === 'ur' ? 'rtl' : 'ltr'" [class.urdu]="lang === 'ur'">
    <header class="hd">
      @if (business?.logoUrl && layout === 'a4') { <img class="logo" [src]="api.fileUrl(business.logoUrl)" alt="" /> }
      <div class="biz">
        <div class="bname">{{ lang === 'ur' ? (business?.nameUr || business?.name) : business?.name }}</div>
        @if (lang === 'both' && business?.nameUr) { <div class="ur bname-ur">{{ business.nameUr }}</div> }
        <div class="small">{{ lang === 'ur' ? (business?.addressUr || business?.address) : business?.address }}</div>
        @if (business?.phone) { <div class="small"><span class="ltr">{{ business.phone }}</span></div> }
      </div>
      <div class="meta">
        <div class="title">{{ L('invoice') }}</div>
        <div><span class="k">{{ L('invoiceNo') }}</span> <strong class="ltr">{{ invoice.invoiceNo }}</strong></div>
        <div><span class="k">{{ L('date') }}</span> <span class="ltr">{{ invoice.invoiceDate | pkdate: true }}</span></div>
        @if (invoice.status === 'CANCELLED') { <div class="stamp">{{ L('cancelled') }}</div> }
      </div>
    </header>

    <section class="party">
      <div class="k">{{ L('customer') }}</div>
      <div><strong>{{ customer?.shopName }}</strong>&nbsp; <span class="ltr small">{{ customer?.code }}</span></div>
      @if (customer?.contactPerson) { <div class="small">{{ customer?.contactPerson }}</div> }
      <div class="small">{{ customer?.address }} {{ customer?.area }} {{ customer?.city }}</div>
      @if (customer?.phone) { <div class="small"><span class="ltr">{{ customer?.phone }}</span></div> }
      @if (salesperson) { <div class="small">{{ L('salesperson') }}: {{ salesperson }}</div> }
    </section>

    <table class="items">
      <thead><tr>
        @if (layout === 'a4') { <th class="c">#</th> }
        <th>{{ L('item') }}</th><th class="n">{{ L('qty') }}</th><th class="n">{{ L('rate') }}</th>
        @if (layout === 'a4' && invoice.discountAmount) { <th class="n">{{ L('discount') }}</th> }
        <th class="n">{{ L('total') }}</th>
      </tr></thead>
      <tbody>
        @for (l of invoice.lines; track l.id; let i = $index) {
          <tr>
            @if (layout === 'a4') { <td class="c">{{ i + 1 }}</td> }
            <td>
              @if (lang !== 'ur') { {{ l.description }} }
              @if (lang === 'both' && l.descriptionUr) { <div class="ur small">{{ l.descriptionUr }}</div> }
              @if (lang === 'ur') { {{ l.descriptionUr || l.description }} }
            </td>
            <td class="n">{{ l.quantity }}</td>
            <td class="n">{{ l.unitPrice | money: sym }}</td>
            @if (layout === 'a4' && invoice.discountAmount) { <td class="n">{{ l.discountAmount ? (l.discountAmount | money: sym) : '' }}</td> }
            <td class="n">{{ l.lineTotal | money: sym }}</td>
          </tr>
        }
      </tbody>
    </table>

    <section class="sum">
      <div class="r"><span>{{ L('subTotal') }}</span><span class="n">{{ invoice.subTotal | money: sym }}</span></div>
      @if (invoice.discountAmount) { <div class="r"><span>{{ L('discount') }}</span><span class="n">-{{ invoice.discountAmount | money: sym }}</span></div> }
      @if (invoice.taxAmount) { <div class="r"><span>{{ L('tax') }}</span><span class="n">{{ invoice.taxAmount | money: sym }}</span></div> }
      <div class="r big"><span>{{ L('grandTotal') }}</span><span class="n">{{ invoice.total | money: sym }}</span></div>
      <div class="r"><span>{{ L('previousBalance') }}</span><span class="n">{{ invoice.previousBalance | money: sym }}</span></div>
      <div class="r"><span>{{ L('paymentReceived') }} ({{ L(invoice.paymentMethod) }})</span><span class="n">{{ invoice.amountPaid | money: sym }}</span></div>
      <div class="r big"><span>{{ L('remainingBalance') }}</span><span class="n">{{ invoice.balanceAfter | money: sym }}</span></div>
      @if (invoice.returnedAmount) { <div class="r"><span>{{ L('returned') }}</span><span class="n">-{{ invoice.returnedAmount | money: sym }}</span></div> }
    </section>

    @if (terms) { <section class="terms"><div class="k">{{ L('terms') }}</div><div class="small">{{ terms }}</div></section> }
    @if (layout === 'a4') {
      <section class="sign">
        <div>{{ L('customerSignature') }}</div><div>{{ L('signature') }}</div>
      </section>
    } @else {
      <div class="thanks">{{ L('thankYou') }}</div>
    }
    @if (invoice.syncStatus !== 'server' && invoice.syncStatus !== 'synced') { <div class="localnote">{{ L('localCopy') }}</div> }
  </div>`,
  styles: [`
    .doc { background: #fff; color: #111; font-family: var(--font); font-size: 12.5px; line-height: 1.45; padding: 28px; max-width: 800px; margin: 0 auto; border: 1px solid var(--border); }
    .doc.urdu, .doc .ur { font-family: var(--font-ur), var(--font); line-height: 2; }
    .ltr { direction: ltr; unicode-bidi: isolate; font-family: var(--font); }
    .hd { display: flex; gap: 14px; align-items: flex-start; border-bottom: 2px solid #0b1f3a; padding-bottom: 12px; }
    .logo { width: 64px; height: 64px; object-fit: contain; }
    .biz { flex: 1; }
    .bname { font-size: 20px; font-weight: 700; color: #0b1f3a; }
    .bname-ur { font-size: 18px; }
    .meta { text-align: end; }
    .title { font-size: 18px; font-weight: 700; letter-spacing: .06em; color: #0b1f3a; text-transform: uppercase; }
    .meta .k { margin-inline-end: 6px; }
    .k { color: #555; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    .stamp { margin-top: 6px; display: inline-block; border: 2px solid #b3261e; color: #b3261e; padding: 2px 10px; font-weight: 700; transform: rotate(-4deg); }
    .party { padding: 12px 0; border-bottom: 1px solid #ddd; }
    .items { width: 100%; border-collapse: collapse; margin: 12px 0; }
    .items th { background: #eef2f7; text-align: start; padding: 6px 8px; font-size: 11.5px; border-bottom: 1px solid #0b1f3a; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .items td { padding: 6px 8px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
    .n { text-align: end; white-space: nowrap; font-variant-numeric: tabular-nums; font-family: var(--font); direction: ltr; }
    .c { text-align: center; width: 28px; }
    .sum { margin-inline-start: auto; width: 320px; max-width: 100%; }
    .sum .r { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0; }
    .sum .big { font-weight: 700; font-size: 14px; border-top: 1px solid #0b1f3a; padding-top: 5px; }
    .terms { margin-top: 16px; border-top: 1px solid #ddd; padding-top: 8px; }
    .sign { display: flex; justify-content: space-between; margin-top: 56px; gap: 40px; }
    .sign div { flex: 1; border-top: 1px solid #333; padding-top: 4px; text-align: center; font-size: 11.5px; }
    .localnote { margin-top: 12px; font-size: 10.5px; color: #8a5a00; text-align: center; }
    .thanks { text-align: center; margin-top: 10px; font-weight: 600; }
    .small { font-size: 11.5px; }

    /* 80 mm thermal roll */
    .doc.thermal { width: 76mm; max-width: 76mm; padding: 2mm; font-size: 11px; border: none; }
    .doc.thermal .hd { flex-direction: column; align-items: center; text-align: center; border-bottom: 1px dashed #000; }
    .doc.thermal .meta { text-align: center; }
    .doc.thermal .title { font-size: 13px; }
    .doc.thermal .bname { font-size: 15px; }
    .doc.thermal .items th { background: none; border-bottom: 1px dashed #000; padding: 3px 2px; }
    .doc.thermal .items td { padding: 3px 2px; border-bottom: none; }
    .doc.thermal .sum { width: 100%; }
    .doc.thermal .sum .big { border-top: 1px dashed #000; }
    @media print { .doc { border: none; padding: 0; max-width: none; } }
  `],
})
export class InvoiceDocComponent {
  @Input({ required: true }) invoice!: Invoice;
  @Input() customer: Customer | null | undefined;
  @Input() business: any;
  @Input() salesperson: string | null = null;
  @Input() layout: 'a4' | 'thermal' = 'a4';
  @Input() lang: PrintLang = 'en';
  constructor(public api: Api) {}

  get sym() { return this.business?.currencySymbol || 'Rs.'; }
  get terms() {
    const b = this.business; if (!b) return '';
    if (this.lang === 'ur') return b.invoiceTermsUr || b.invoiceTerms;
    if (this.lang === 'both') return [b.invoiceTerms, b.invoiceTermsUr].filter(Boolean).join(' — ');
    return b.invoiceTerms;
  }
  /** Labels: Urdu, English, or "English / اردو" for bilingual prints. */
  L(key: string) {
    if (this.lang === 'both') {
      const en = I18n.translate('en', key), ur = I18n.translate('ur', key);
      return en === ur ? en : `${en} / ${ur}`;
    }
    return I18n.translate(this.lang as Lang, key);
  }
}

/** Prints only the element marked .print-area, with the right page size for the layout. */
export function printArea(layout: 'a4' | 'thermal') {
  const style = document.createElement('style');
  style.id = 'print-page-style';
  style.textContent = `@media print {
    @page { size: ${layout === 'thermal' ? '80mm auto' : 'A4'}; margin: ${layout === 'thermal' ? '2mm' : '12mm'}; }
    body * { visibility: hidden !important; }
    .print-area, .print-area * { visibility: visible !important; }
    .print-area { position: absolute; inset-inline-start: 0; top: 0; width: 100%; }
  }`;
  document.getElementById('print-page-style')?.remove();
  document.head.appendChild(style);
  setTimeout(() => { window.print(); }, 50);
}
