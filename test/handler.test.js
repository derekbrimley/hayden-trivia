/**
 * The Vercel entry point. Deploying is the only way to test it for real, so
 * this at least drives it the way Vercel does: a Node request in, a JSON
 * response out, through the catch-all route.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import handler from '../api/[...path].js';

/** Stand-ins for Vercel's req/res, which are Node's with a few helpers. */
function mockResponse() {
  const out = { statusCode: null, headers: {}, body: null };
  return {
    out,
    status(code) { out.statusCode = code; return this; },
    setHeader(key, value) { out.headers[key] = value; },
    json(payload) { out.body = payload; return this; }
  };
}

const request = (method, url, body) => ({ method, url, headers: { host: 'party.vercel.app' }, body });

async function call(method, url, body) {
  const res = mockResponse();
  await handler(request(method, url, body), res);
  return res.out;
}

test('the catch-all strips /api and routes the rest', async () => {
  const result = await call('GET', '/api/health');
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('a room can be created and read back through the handler', async () => {
  const created = await call('POST', '/api/rooms', { guestName: 'Hayden', name: 'Derek' });
  assert.equal(created.statusCode, 201);
  const { code, playerId, token } = created.body;

  const state = await call('GET', `/api/rooms/${code}/state?playerId=${playerId}&token=${token}`);
  assert.equal(state.statusCode, 200);
  assert.equal(state.body.phase, 'lobby');
  assert.equal(state.body.guestName, 'Hayden');
  assert.equal(state.body.isHost, true);
});

test('a body that arrives as a string is still parsed', async () => {
  const result = await call('POST', '/api/rooms', JSON.stringify({ guestName: 'Hayden', name: 'Sam' }));
  assert.equal(result.statusCode, 201);
});

test('a missing body does not crash the function', async () => {
  const result = await call('POST', '/api/rooms', undefined);
  assert.equal(result.statusCode, 400);
  assert.match(result.body.error, /name/i);
});

test('an unknown path is a 404, not a crash', async () => {
  const result = await call('GET', '/api/nope');
  assert.equal(result.statusCode, 404);
});

test('query parameters survive the trip', async () => {
  const created = await call('POST', '/api/rooms', { guestName: 'Hayden', name: 'Derek' });
  const bad = await call('GET', `/api/rooms/${created.body.code}/state?playerId=x&token=y`);
  assert.equal(bad.statusCode, 403);
});
