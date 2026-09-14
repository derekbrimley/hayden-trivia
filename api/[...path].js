/**
 * Vercel entry point.
 *
 * Every /api/* request lands here; the routing lives in src/router.js so the
 * local dev server runs exactly the same code.
 *
 * Two deliberate choices, both about failing usefully:
 *
 * The modules are imported inside the handler rather than at the top of the
 * file. A module that throws while loading takes the whole function down before
 * any of our code runs, and the platform can only answer with a blank crash
 * page. Loading here means even that failure comes back as a readable message.
 *
 * The response is written with plain Node methods instead of the platform's
 * `res.status().json()` helpers, so this file does not depend on sugar that
 * may not exist in every runtime.
 */

let modules = null;

async function load() {
  if (!modules) {
    const [router, store] = await Promise.all([
      import('../src/router.js'),
      import('../src/store.js')
    ]);
    modules = { handleApi: router.handleApi, sharedStore: store.sharedStore };
  }
  return modules;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  try {
    const { handleApi, sharedStore } = await load();

    const url = new URL(req.url ?? '/', `https://${req.headers?.host ?? 'localhost'}`);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] === 'api') segments.shift();

    // The platform usually parses JSON bodies; cope with a string or nothing.
    let body = req.body ?? {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body || '{}'); } catch { body = {}; }
    }
    if (typeof body !== 'object' || body === null) body = {};

    const result = await handleApi({
      method: req.method,
      segments,
      query: Object.fromEntries(url.searchParams),
      body,
      store: sharedStore(),
      env: process.env
    });
    send(res, result.status, result.json);
  } catch (error) {
    // Say what actually went wrong, rather than leaving a blank crash page.
    console.error('api handler failed', error);
    try {
      send(res, 500, {
        error: error?.message ?? 'Something went wrong.',
        name: error?.name ?? 'Error',
        code: error?.code ?? null,
        where: 'api handler',
        stack: String(error?.stack ?? '').split('\n').slice(0, 6)
      });
    } catch {
      res.statusCode = 500;
      res.end('{"error":"handler failed"}');
    }
  }
}
