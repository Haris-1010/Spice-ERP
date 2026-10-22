import { Component, EventEmitter, Injectable, Input, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
import { I18n, TPipe } from '../core/i18n';

// ---------------------------------------------------------------- toasts
export interface ToastMsg { id: number; kind: 'ok' | 'bad' | 'warn' | 'info'; text: string; }

@Injectable({ providedIn: 'root' })
export class Toast {
  readonly items = signal<ToastMsg[]>([]);
  private n = 0;
  show(text: string, kind: ToastMsg['kind'] = 'ok', ms = 4500) {
    const id = ++this.n;
    this.items.update(a => [...a, { id, kind, text }]);
    setTimeout(() => this.dismiss(id), ms);
  }
  ok(t: string) { this.show(t, 'ok'); }
  warn(t: string) { this.show(t, 'warn', 7000); }
  error(e: unknown) { this.show(errorText(e), 'bad', 8000); }
  dismiss(id: number) { this.items.update(a => a.filter(x => x.id !== id)); }
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.isNetwork) return I18n.translate((document.documentElement.lang as any) || 'en', 'onlineOnly');
    return e.message;
  }
  return (e as any)?.message ?? String(e);
}

// ---------------------------------------------------------------- dialogs (confirm / prompt)
interface DialogReq { title: string; message?: string; input?: boolean; placeholder?: string; danger?: boolean; resolve: (v: string | null) => void; }

@Injectable({ providedIn: 'root' })
export class Dialog {
  readonly current = signal<DialogReq | null>(null);
  confirm(title: string, message?: string, danger = false): Promise<boolean> {
    return new Promise(res => this.current.set({ title, message, danger, resolve: v => res(v !== null) }));
  }
  /** Asks for required text (e.g. a cancellation reason). Resolves null when dismissed. */
  prompt(title: string, placeholder = ''): Promise<string | null> {
    return new Promise(res => this.current.set({ title, input: true, placeholder, resolve: res }));
  }
  close(v: string | null) { const c = this.current(); this.current.set(null); c?.resolve(v); }
}

@Component({
  selector: 'app-overlays',
  standalone: true,
  imports: [FormsModule, TPipe],
  template: `
    <div class="toasts" role="status" aria-live="polite">
      @for (t of toast.items(); track t.id) {
        <div class="alert {{ t.kind }} toast" (click)="toast.dismiss(t.id)">{{ t.text }}</div>
      }
    </div>
    @if (dialog.current(); as d) {
      <div class="modal-backdrop" (click)="dialog.close(null)">
        <div class="modal" style="max-width:440px" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
          <div class="modal-head"><h2>{{ d.title }}</h2></div>
          <div class="modal-body stack">
            @if (d.message) { <p style="margin:0">{{ d.message }}</p> }
            @if (d.input) {
              <textarea [(ngModel)]="text" [placeholder]="d.placeholder ?? ''" rows="3" autofocus></textarea>
            }
          </div>
          <div class="modal-foot">
            <button class="btn" (click)="dialog.close(null)">{{ 'cancel' | t }}</button>
            <button class="btn" [class.primary]="!d.danger" [class.danger]="d.danger" [disabled]="d.input && !text.trim()"
                    (click)="dialog.close(d.input ? text.trim() : 'ok'); text = ''">{{ 'confirm' | t }}</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`.toasts{position:fixed;inset-block-end:16px;inset-inline-end:16px;display:flex;flex-direction:column;gap:8px;z-index:200;max-width:420px}
            .toast{box-shadow:0 6px 20px rgba(0,0,0,.15);cursor:pointer}`],
})
export class OverlaysComponent {
  text = '';
  constructor(public toast: Toast, public dialog: Dialog) {}
}

// ---------------------------------------------------------------- modal shell
@Component({
  selector: 'app-modal',
  standalone: true,
  template: `
    <div class="modal-backdrop" (mousedown)="onBackdrop($event)">
      <div class="modal" [class.wide]="wide" role="dialog" aria-modal="true" (mousedown)="$event.stopPropagation()">
        <div class="modal-head"><h2>{{ title }}</h2><button class="btn ghost sm" (click)="closed.emit()" aria-label="Close">✕</button></div>
        <div class="modal-body"><ng-content /></div>
        <div class="modal-foot"><ng-content select="[foot]" /></div>
      </div>
    </div>`,
})
export class ModalComponent {
  @Input() title = '';
  @Input() wide = false;
  @Output() closed = new EventEmitter<void>();
  onBackdrop(_: Event) { /* clicks outside do not close forms, to avoid losing typed data */ }
}

// ---------------------------------------------------------------- image picker (product images, logo)
@Component({
  selector: 'app-image-picker',
  standalone: true,
  imports: [TPipe],
  template: `
    <div class="row" style="align-items:flex-start">
      @if (url) { <img class="thumb lg" [src]="api.fileUrl(url)" alt="" /> }
      @else { <div class="thumb lg">{{ initials }}</div> }
      <div class="stack" style="gap:6px">
        <label class="btn sm" [class.disabled]="busy()">
          {{ (url ? 'changeImage' : 'uploadImage') | t }}
          <input type="file" accept="image/png,image/jpeg,image/webp" hidden (change)="pick($event)" [disabled]="busy()" />
        </label>
        @if (url) { <button type="button" class="btn sm ghost" (click)="urlChange.emit(null)">{{ 'removeImage' | t }}</button> }
        <span class="small muted">JPG / PNG / WEBP · max 3 MB</span>
        @if (busy()) { <span class="small muted">{{ 'saving' | t }}</span> }
      </div>
    </div>`,
})
export class ImagePickerComponent {
  @Input() url: string | null | undefined = null;
  @Input() kind: 'products' | 'logo' = 'products';
  @Input() initials = '';
  @Output() urlChange = new EventEmitter<string | null>();
  busy = signal(false);
  constructor(public api: Api, private toast: Toast) {}

  async pick(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) { this.toast.warn('Image is larger than 3 MB.'); return; }
    this.busy.set(true);
    try {
      const resized = await resizeImage(file, 800);
      this.urlChange.emit(await this.api.upload(this.kind, resized));
    } catch (e) { this.toast.error(e); }
    finally { this.busy.set(false); }
  }
}

/** Downscales large photos in the browser so uploads stay small and quick on mobile data. */
async function resizeImage(file: File, max: number): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 400_000) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob: Blob = await new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('Could not process image'))), 'image/jpeg', 0.85));
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}

// ---------------------------------------------------------------- product thumbnail
@Component({
  selector: 'app-thumb',
  standalone: true,
  template: `@if (src && !failed) { <img class="thumb" [src]="api.fileUrl(src)" alt="" loading="lazy" (error)="failed = true" /> }
             @else { <span class="thumb">{{ (name || '?').slice(0, 2).toUpperCase() }}</span> }`,
})
export class ThumbComponent {
  @Input() src: string | null | undefined;
  @Input() name = '';
  failed = false;
  constructor(public api: Api) {}
}

// ---------------------------------------------------------------- sync status badge
@Component({
  selector: 'app-sync-badge',
  standalone: true,
  imports: [TPipe],
  template: `@if (status !== 'server') { <span class="badge {{ cls }}" [title]="message ?? ''">{{ ('st_' + status) | t }}</span> }
             @else { <span class="badge ok">{{ 'st_synced' | t }}</span> }`,
})
export class SyncBadgeComponent {
  @Input() status: string = 'local';
  @Input() message: string | null | undefined;
  get cls() {
    return ({ local: 'warn', syncing: 'grey', synced: 'ok', failed: 'bad', conflict: 'bad', rejected: 'bad' } as any)[this.status] ?? 'grey';
  }
}

// ---------------------------------------------------------------- pager
@Component({
  selector: 'app-pager',
  standalone: true,
  imports: [TPipe],
  template: `@if (total > pageSize) {
    <div class="row" style="justify-content:flex-end;padding:10px 12px">
      <span class="small muted">{{ 'page' | t }} {{ page }} {{ 'of' | t }} {{ pages }}</span>
      <button class="btn sm" [disabled]="page <= 1" (click)="pageChange.emit(page - 1)">{{ 'prev' | t }}</button>
      <button class="btn sm" [disabled]="page >= pages" (click)="pageChange.emit(page + 1)">{{ 'next' | t }}</button>
    </div>}`,
})
export class PagerComponent {
  @Input() page = 1; @Input() pageSize = 50; @Input() total = 0;
  @Output() pageChange = new EventEmitter<number>();
  get pages() { return Math.max(1, Math.ceil(this.total / this.pageSize)); }
}

export const SHARED = [TPipe, ModalComponent, ImagePickerComponent, ThumbComponent, SyncBadgeComponent, PagerComponent] as const;
