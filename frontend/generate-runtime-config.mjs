import { writeFile } from 'node:fs/promises';

const apiBase = (process.env.SPICE_API_BASE_URL ?? '').replace(/\/+$/, '');
const content = `window.__SPICE_API_BASE__ = ${JSON.stringify(apiBase)};\n`;
await writeFile('public/runtime-config.js', content, 'utf8');
