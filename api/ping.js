/**
 * A deliberately boring endpoint: no imports, no storage, no model.
 *
 * If /api/ping answers but /api/health crashes, the platform wiring is fine and
 * the fault is in this app's code. If even this crashes, the project's build or
 * runtime settings are wrong, not the game.
 */

export default function handler(req, res) {
  const body = {
    pong: true,
    node: process.version,
    region: process.env.VERCEL_REGION ?? null,
    url: req.url ?? null,
    // Booleans only — never echo the values of secrets.
    sees: {
      KV_REST_API_URL: Boolean(process.env.KV_REST_API_URL),
      KV_REST_API_TOKEN: Boolean(process.env.KV_REST_API_TOKEN),
      UPSTASH_REDIS_REST_URL: Boolean(process.env.UPSTASH_REDIS_REST_URL),
      UPSTASH_REDIS_REST_TOKEN: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN),
      REDIS_URL: Boolean(process.env.REDIS_URL),
      ANTHROPIC_API_KEY: Boolean(process.env.ANTHROPIC_API_KEY)
    }
  };
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body, null, 2));
}
