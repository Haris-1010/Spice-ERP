// Production: the API serves the built app from the same origin, so the base is relative.
// Never put secrets in this file — it is shipped to every browser.
declare global {
  interface Window { __SPICE_API_BASE__?: string; }
}

export const environment = { production: true, apiBase: globalThis.window?.__SPICE_API_BASE__ ?? '' };
