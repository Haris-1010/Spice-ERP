// Development: `ng serve` proxies /api and /uploads to the API (see proxy.conf.json).
declare global {
  interface Window { __SPICE_API_BASE__?: string; }
}

export const environment = { production: false, apiBase: globalThis.window?.__SPICE_API_BASE__ ?? '' };
