/**
 * The polling loop the browser runs.
 *
 * This is client code, but it is plain ESM and the interesting part is timing,
 * not the DOM: a poller that has been replaced must not act on a reply that
 * arrives after it was stopped. That race tore down freshly created sessions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Just enough DOM for the connection banner to exist.
globalThis.document = {
  createElement: () => ({ className: '', textContent: '', remove() {} }),
  body: { append() {} }
};

const { startPolling, api } = await import('../public/js/common.js');

/** Replace global fetch for one test. */
function withFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('api attaches the status code to its errors', async () => {
  const restore = withFetch(async () => jsonResponse(404, { error: 'No room with that code.' }));
  try {
    await assert.rejects(() => api('/api/rooms/DEAD/state', null, 'GET'), (error) => {
      assert.equal(error.status, 404);
      assert.match(error.message, /No room/);
      return true;
    });
  } finally {
    restore();
  }
});

test('a stopped poller ignores a reply that arrives late', async () => {
  let seen = 0;
  const restore = withFetch(async () => {
    await wait(60);
    return jsonResponse(200, { phase: 'lobby', serverTime: Date.now() });
  });
  try {
    const poller = startPolling({
      url: () => '/api/rooms/AAAA/state',
      intervalFor: () => 10,
      onState: () => { seen += 1; }
    });
    poller.stop();            // stopped while the first request is in flight
    await wait(200);
    assert.equal(seen, 0, 'a superseded poller must stay silent');
  } finally {
    restore();
  }
});

test('a stopped poller ignores a late failure too', async () => {
  let errors = 0;
  const restore = withFetch(async () => {
    await wait(60);
    return jsonResponse(404, { error: 'No room with that code.' });
  });
  try {
    const poller = startPolling({
      url: () => '/api/rooms/DEAD/state',
      intervalFor: () => 10,
      onError: () => { errors += 1; }
    });
    poller.stop();
    await wait(200);
    assert.equal(errors, 0, 'a superseded poller must not report errors either');
  } finally {
    restore();
  }
});

test('a refusal reaches onError on the first try, with its status', async () => {
  const seen = [];
  const restore = withFetch(async () => jsonResponse(403, { error: 'We lost track of you.' }));
  try {
    const poller = startPolling({
      url: () => '/api/rooms/AAAA/state',
      intervalFor: () => 10000,
      onError: (error, attempt) => seen.push({ status: error.status, attempt })
    });
    await wait(120);
    poller.stop();
    assert.equal(seen.length, 1, 'no waiting for three strikes before saying the room is gone');
    assert.equal(seen[0].status, 403);
    assert.equal(seen[0].attempt, 1);
  } finally {
    restore();
  }
});

test('a recovered poll clears the failure count', async () => {
  let call = 0;
  const attempts = [];
  const restore = withFetch(async () => {
    call += 1;
    if (call === 1) return jsonResponse(500, { error: 'boom' });
    return jsonResponse(200, { phase: 'lobby', serverTime: Date.now() });
  });
  try {
    const poller = startPolling({
      url: () => '/api/rooms/AAAA/state',
      intervalFor: () => 20,
      onState: () => {},
      onError: (error, attempt) => attempts.push(attempt)
    });
    await wait(250);
    poller.stop();
    assert.deepEqual(attempts, [1], 'the failure count resets once a poll succeeds');
  } finally {
    restore();
  }
});
