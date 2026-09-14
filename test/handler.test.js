/**
 * The Vercel entry points. Deploying is the only way to test them for real, so
 * these drive the handlers the way the platform does — a Node-style request and
 * response — and check that a failure comes back readable instead of blank.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import handler from '../api/[...path].js';
import ping from '../api/ping.js';

/** A stand-in for the response object, using only plain Node methods. */
function mockResponse() {
  const out = { statusCode: null, headers: {}, body: null, ended: false };
  return {
    out,
    set statusCode(code) { out.statusCode = code; },
    get statusCode() { return out.statusCode; },
    setHeader(key, value) { out.headers[key] = value; },
    end(payload) {
      out.ended = true;
      out.body = payload ? JSON.parse(payload) : null;
    }
  };
}

const request = (method, url, body) => ({ method, url, headers: { host: 'party.vercel.app' }, body });

async function call(method, url, body) {
  const res = mockResponse();
  await handler(request(method, url, body), res);
  assert.equal(res.out.ended, true, 'the handler must always answer');
  return res.out;
}

test('ping answers without importing anything', async () => {
  const res = mockResponse();
  ping(request('GET', '/api/ping'), res);
  assert.equal(res.out.statusCode, 200);
  assert.equal(res.out.body.pong, true);
  assert.match(res.out.body.node, /^v\d+/);
});

test('ping reports which variables exist without revealing them', async () => {
  const res = mockResponse();
  ping(request('GET', '/api/ping'), res);
  const serialized = JSON.stringify(res.out.body);
  for (const value of Object.values(res.out.body.sees)) assert.equal(typeof value, 'boolean');
  assert.ok(!serialized.includes('sk-ant'), 'a key must never be echoed back');
});

test('the catch-all strips /api and routes the rest', async () => {
  const result = await call('GET', '/api/health');
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.match(result.headers['Content-Type'], /application\/json/);
});

test('a room can be created and read back through the handler', async () => {
  const created = await call('POST', '/api/rooms', { guestName: 'Hayden', name: 'Derek' });
  assert.equal(created.statusCode, 201);
  const { code, playerId, token } = created.body;

  const state = await call('GET', `/api/rooms/${code}/state?playerId=${playerId}&token=${token}`);
  assert.equal(state.statusCode, 200);
  assert.equal(state.body.phase, 'lobby');
  assert.equal(state.body.isHost, true);
});

test('a body that arrives as a string is still parsed', async () => {
  const result = await call('POST', '/api/rooms', JSON.stringify({ guestName: 'Hayden', name: 'Sam' }));
  assert.equal(result.statusCode, 201);
});

test('a missing or unusable body does not crash the function', async () => {
  for (const body of [undefined, '', 'not json', 42, null]) {
    const result = await call('POST', '/api/rooms', body);
    assert.equal(result.statusCode, 400);
    assert.match(result.body.error, /name/i);
  }
});

test('a request with no url at all still gets an answer', async () => {
  const res = mockResponse();
  await handler({ method: 'GET', headers: {}, body: undefined }, res);
  assert.equal(res.out.ended, true);
  assert.ok(res.out.statusCode >= 400);
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

test('an unexpected failure comes back as a readable message, not a blank crash', async () => {
  const res = mockResponse();
  // A response object that throws the way a broken runtime would.
  const hostile = { method: 'GET', get url() { throw new Error('boom from the runtime'); }, headers: {} };
  await handler(hostile, res);
  assert.equal(res.out.ended, true);
  assert.equal(res.out.statusCode, 500);
  assert.match(res.out.body.error, /boom from the runtime/);
  assert.ok(Array.isArray(res.out.body.stack), 'the stack helps whoever is debugging the deploy');
});
