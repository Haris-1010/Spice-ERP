import { Injectable, computed, signal } from '@angular/core';
import { Api } from './api';
import { db, getMeta, setMeta, uuid } from './db';
import { I18n, Lang } from './i18n';

export interface SessionUser {
  id: string; username: string; fullName: string; roles: string[]; permissions: string[]; preferredLanguage: Lang;
}
export interface Session { token: string; expiresAt: string; user: SessionUser; device: { id: string; prefix: string; name: string }; }

/**
 * Session handling.
 *  - The device id is generated once and kept in IndexedDB; the server allocates a short prefix
 *    (e.g. D03) used in offline document numbers.
 *  - The session (access token + cached permissions) is stored encrypted with a non-extractable
 *    WebCrypto key, so it is never in plain text on disk. The password is never stored.
 *  - Offline, the cached session lets the user keep working; syncing requires a valid token.
 */
@Injectable({ providedIn: 'root' })
export class Auth {
  readonly session = signal<Session | null>(null);
  readonly user = computed(() => this.session()?.user ?? null);
  readonly expired = signal(false);
  readonly ready = signal(false);

  constructor(private api: Api, private i18n: I18n) {
    api.onUnauthorized = () => this.expired.set(true);
  }

  async init() {
    try {
      const s = await this.readSession();
      if (s) {
        this.session.set(s);
        this.api.token = s.token;
        this.expired.set(new Date(s.expiresAt).getTime() < Date.now());
      }
    } catch { /* corrupt or missing session: user signs in again */ }
    this.ready.set(true);
  }

  can(perm: string): boolean { return this.user()?.permissions.includes(perm) ?? false; }
  hasRole(role: string): boolean { return this.user()?.roles.includes(role) ?? false; }

  async deviceId(): Promise<string> {
    let id = await getMeta<string>('deviceId');
    if (!id) { id = uuid(); await setMeta('deviceId', id); }
    return id;
  }

  async login(username: string, password: string, deviceName?: string) {
    const deviceId = await this.deviceId();
    const r = await this.api.post<Session>('/api/auth/login', { username, password, deviceId, deviceName });
    const previousUser = (await this.readSession())?.user.id;
    if (previousUser && previousUser !== r.user.id) {
      // A different person on this device: keep unsynced records, but drop cached customer data
      // that this user may not be allowed to see. It is re-downloaded on the next sync.
      const pending = await db.outbox.where('status').noneOf(['synced']).count();
      if (pending === 0) await Promise.all([db.customers.clear(), db.invoices.clear(), db.receipts.clear(), db.balances.clear(), db.deliveries.clear(), setMeta('lastPull', null)]);
    }
    this.api.token = r.token;
    this.session.set(r);
    this.expired.set(false);
    await this.writeSession(r);
    await setMeta('devicePrefix', r.device.prefix);
    if (r.user.preferredLanguage) this.i18n.set(r.user.preferredLanguage);
  }

  /** Signs out. Unsynced records always stay on the device. */
  async logout(clearDevice = false) {
    if (clearDevice) {
      const pending = await db.outbox.where('status').noneOf(['synced']).count();
      if (pending > 0) throw new Error(this.i18n.t('cannotClearPending'));
      const deviceId = await getMeta('deviceId');
      const counters = await db.meta.where('key').startsWith('counter:').toArray();
      await Promise.all(db.tables.map(t => t.clear()));
      // Keep the device identity and number counters so document numbers are never reused.
      await setMeta('deviceId', deviceId);
      await db.meta.bulkPut(counters);
    }
    await db.meta.delete('session');
    this.api.token = null;
    this.session.set(null);
  }

  // ------------------------------------------------------------ encrypted session storage
  private async key(): Promise<CryptoKey> {
    let k = await getMeta<CryptoKey>('sessionKey');
    if (!k) {
      k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await setMeta('sessionKey', k);
    }
    return k;
  }

  private async writeSession(s: Session) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.key(), new TextEncoder().encode(JSON.stringify(s)));
    await setMeta('session', { iv, data });
  }

  private async readSession(): Promise<Session | null> {
    const stored = await getMeta<{ iv: Uint8Array; data: ArrayBuffer }>('session');
    if (!stored) return null;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv }, await this.key(), stored.data);
    return JSON.parse(new TextDecoder().decode(plain));
  }
}
