/**
 * The dev server file, which doubles as an entrypoint some hosts will run
 * directly. Its default export is part of that contract: a host that wraps this
 * file wants a plain (req, res) handler, and importing it must not bind a port.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

const { default: handler, requestListener, server: devServer } = await import('../server.js');

test('the default export is a request handler function', () => {
  assert.equal(typeof handler, 'function');
  assert.equal(handler, requestListener, 'the default is the handler, not the server object');
  assert.equal(handler.length, 2, 'it takes (req, res)');
});

test('importing the module does not bind a port', () => {
  assert.equal(devServer.listening, false);
});

test('the handler serves the app and the API', async () => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Guest of Honor Trivia/);

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const created = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestName: 'Hayden', name: 'Derek' })
    });
    assert.equal(created.status, 201);
    const room = await created.json();
    assert.match(room.code, /^[A-HJ-NP-Z2-9]{4}$/);

    const joined = await fetch(`${base}/api/rooms/${room.code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sam' })
    });
    assert.equal(joined.status, 201);

    const missing = await fetch(`${base}/api/rooms/ZZZZ`);
    assert.equal(missing.status, 404);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('paths cannot escape the public directory', async () => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/../server.js`, { redirect: 'manual' });
    const body = await response.text();
    assert.ok(!body.includes('createServer'), 'source files must not be served');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('the single-process flag is not set merely by importing the file', () => {
  // A host that imports this module may run many copies of it, and each one
  // would have its own memory. Claiming otherwise would hide a real problem.
  assert.notEqual(process.env.GOH_SINGLE_PROCESS, '1');
});
