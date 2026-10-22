import { Injectable, signal } from '@angular/core';
import { environment } from '../../environments/environment';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
  get isNetwork() { return this.status === 0; }
}

/**
 * Thin fetch wrapper. The API base is relative ('' = same origin) so the app and API can be
 * served together; in development the Angular dev-server proxies /api and /uploads.
 * No secrets live in the frontend — only the user's access token, held in memory and IndexedDB.
 */
@Injectable({ providedIn: 'root' })
export class Api {
  readonly online = signal<boolean>(navigator.onLine);
  token: string | null = null;
  onUnauthorized: (() => void) | null = null;

  constructor() {
    window.addEventListener('online', () => this.online.set(true));
    window.addEventListener('offline', () => this.online.set(false));
  }

  url(path: string) { return environment.apiBase + path; }

  /** Absolute URL for an uploaded file (product images, logo). */
  fileUrl(path: string | null | undefined): string | null {
    if (!path) return null;
    return /^https?:|^data:|^blob:/.test(path) ? path : environment.apiBase + path;
  }

  async request<T = any>(method: string, path: string, body?: any, timeoutMs = 30000): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const headers: Record<string, string> = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

    let res: Response;
    try {
      res = await fetch(this.url(path), { method, headers, body: payload, signal: ctrl.signal });
    } catch {
      this.online.set(false);
      throw new ApiError(0, 'network', 'The server could not be reached.');
    } finally {
      clearTimeout(timer);
    }
    this.online.set(true);
    const text = await res.text();
    let data: any = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    if (!res.ok) {
      if (res.status === 401 && this.onUnauthorized && !path.startsWith('/api/auth/login')) this.onUnauthorized();
      const e = data?.error;
      throw new ApiError(res.status, e?.code ?? 'http_' + res.status, e?.message ?? `Request failed (${res.status}).`, e?.details);
    }
    return data as T;
  }

  get<T = any>(path: string, params?: Record<string, any>) {
    const q = params ? Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
    return this.request<T>('GET', q ? `${path}?${q}` : path);
  }
  post<T = any>(path: string, body?: any, timeoutMs?: number) { return this.request<T>('POST', path, body ?? {}, timeoutMs); }
  put<T = any>(path: string, body?: any) { return this.request<T>('PUT', path, body ?? {}); }
  delete<T = any>(path: string) { return this.request<T>('DELETE', path); }

  async upload(kind: 'products' | 'logo' | 'attachments', file: File): Promise<string> {
    const fd = new FormData();
    fd.append('file', file);
    const r = await this.request<{ url: string }>('POST', `/api/uploads/${kind}`, fd, 60000);
    return r.url;
  }
}
