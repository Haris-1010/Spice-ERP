import { Pipe, PipeTransform } from '@angular/core';
import { I18n } from './i18n';

export const TZ = 'Asia/Karachi';

export function round2(n: number) { return Math.round((n + Number.EPSILON) * 100) / 100; }

export function money(v: number | string | null | undefined, symbol = 'Rs.'): string {
  const n = Number(v ?? 0);
  const s = Math.abs(n).toLocaleString('en-PK', { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}${symbol} ${s}`;
}

/** Grams shown as kg + g for bulk quantities, e.g. 2,500 → "2.5 kg". */
export function weight(grams: number | string | null | undefined, ur = false): string {
  const g = Number(grams ?? 0);
  if (Math.abs(g) >= 1000) return `${(g / 1000).toLocaleString('en-PK', { maximumFractionDigits: 3 })} ${ur ? 'کلو' : 'kg'}`;
  return `${g.toLocaleString('en-PK')} ${ur ? 'گرام' : 'g'}`;
}

export function num(v: number | string | null | undefined): string {
  return Number(v ?? 0).toLocaleString('en-PK', { maximumFractionDigits: 2 });
}

export function pkDate(iso: string | Date | null | undefined, withTime = false): string {
  if (!iso) return '';
  const d = typeof iso === 'string' ? new Date(iso.length === 10 ? iso + 'T00:00:00+05:00' : iso) : iso;
  if (isNaN(d.getTime())) return String(iso);
  const opts: Intl.DateTimeFormatOptions = { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('en-GB', opts);
}

/** Today's date in Pakistan as yyyy-mm-dd. */
export function pkToday(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

export function monthStart(): string { return pkToday().slice(0, 8) + '01'; }

export function toCsv(rows: any[], columns: { key: string; label: string }[]): string {
  const esc = (v: any) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(c => esc(c.label)).join(','), ...rows.map(r => columns.map(c => esc(r[c.key])).join(','))].join('\n');
}

export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob(['﻿' + text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

@Pipe({ name: 'money', standalone: true })
export class MoneyPipe implements PipeTransform { transform(v: any, symbol = 'Rs.') { return money(v, symbol); } }

@Pipe({ name: 'weight', standalone: true, pure: false })
export class WeightPipe implements PipeTransform {
  constructor(private i18n: I18n) {}
  transform(v: any) { return weight(v, this.i18n.isUr()); }
}

@Pipe({ name: 'num', standalone: true })
export class NumPipe implements PipeTransform { transform(v: any) { return num(v); } }

@Pipe({ name: 'pkdate', standalone: true })
export class PkDatePipe implements PipeTransform { transform(v: any, withTime = false) { return pkDate(v, withTime); } }
