/**
 * Vercel entry point.
 *
 * Every /api/* request lands here; the routing itself lives in src/router.js so
 * that the local dev server runs exactly the same code.
 */

import { handleApi } from '../src/router.js';
import { sharedStore } from '../src/store.js';

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host ?? 'localhost'}`);
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] === 'api') segments.shift();

  // Vercel parses JSON bodies already; fall back to reading the stream if not.
  let body = req.body ?? {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch { body = {}; }
  }

  try {
    const result = await handleApi({
      method: req.method,
      segments,
      query: Object.fromEntries(url.searchParams),
      body,
      store: sharedStore(),
      env: process.env
    });
    res.status(result.status);
    res.setHeader('Cache-Control', 'no-store');
    res.json(result.json);
  } catch (error) {
    res.status(500).json({ error: error?.message ?? 'Something went wrong.' });
  }
}
