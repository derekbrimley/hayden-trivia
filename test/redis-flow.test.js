/**
 * The whole game, played through the Redis store rather than the in-memory one.
 *
 * Every other API test runs against memory, which hides anything specific to the
 * Redis wire format — and production only ever uses Redis. The stand-in below
 * answers the way Upstash's REST API does, including returning hashes as flat
 * arrays, so the parsing this app depends on is exercised for real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { handleApi } from '../src/router.js';
import { createRedisStore } from '../src/store.js';

/** A small Redis that speaks Upstash's REST protocol over real HTTP. */
function startFakeUpstash() {
  const data = new Map();
  const run = ([name, ...args]) => {
    const verb = String(name).toUpperCase();
    switch (verb) {
      case 'SET': {
        const [key, value, ...rest] = args;
        const flags = rest.map((flag) => String(flag).toUpperCase());
        if (flags.includes('NX') && data.has(key)) return null;
        data.set(key, value);
        return 'OK';
      }
      case 'GET': return data.get(args[0]) ?? null;
      case 'DEL': {
        let removed = 0;
        for (const key of args) removed += data.delete(key) ? 1 : 0;
        return removed;
      }
      case 'EXPIRE': return data.has(args[0]) ? 1 : 0;
      case 'HSET': {
        const [key, ...pairs] = args;
        const hash = data.get(key) ?? new Map();
        for (let i = 0; i < pairs.length; i += 2) hash.set(pairs[i], pairs[i + 1]);
        data.set(key, hash);
        return pairs.length / 2;
      }
      // Upstash returns a hash as a flat [field, value, field, value] array,
      // and an empty array for a key that does not exist.
      case 'HGETALL': {
        const hash = data.get(args[0]);
        return hash ? [...hash.entries()].flat() : [];
      }
      default: throw new Error(`fake redis does not know ${verb}`);
    }
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer test-token') {
        res.writeHead(401).end('{"error":"unauthorized"}');
        return;
      }
      try {
        const parsed = JSON.parse(body);
        const payload = req.url.endsWith('/pipeline')
          ? parsed.map((command) => ({ result: run(command) }))
          : { result: run(parsed) };
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
      } catch (error) {
        res.writeHead(400).end(JSON.stringify({ error: error.message }));
      }
    });
  });
  return server;
}

const NOTES = {
  derek: ['always cold, hoodie indoors', 'reads three books at once', 'refuses to eat olives'],
  sam: ['quotes the same film daily', 'names every houseplant', 'up before sunrise'],
  priya: ['keeps every receipt', 'cannot parallel park', 'spreadsheets every trip']
};

test('a full game runs against Redis, not just memory', async (t) => {
  const redis = startFakeUpstash();
  redis.listen(0, '127.0.0.1');
  await once(redis, 'listening');
  t.after(() => { redis.closeAllConnections?.(); redis.close(); });

  const store = createRedisStore({
    url: `http://127.0.0.1:${redis.address().port}`,
    token: 'test-token'
  });
  const env = {};
  const call = (method, path, { body = {}, query = {} } = {}) => handleApi({
    method, segments: path.split('/').filter(Boolean), query, body, store, env
  });

  // Create a room and read it straight back — this is the path that failed for a
  // real deployment while the in-memory tests all passed.
  const created = await call('POST', 'rooms', {
    body: { guestName: 'Hayden', name: 'Derek', settings: { questionCount: 3, questionSeconds: 20 } }
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const host = created.json;

  const first = await call('GET', `rooms/${host.code}/state`,
    { query: { playerId: host.playerId, token: host.token } });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.phase, 'lobby');
  assert.equal(first.json.players.length, 1, 'the host must come back out of the players hash');
  assert.equal(first.json.isHost, true);

  // Everyone joins and writes notes.
  const guests = {};
  for (const name of ['Sam', 'Priya']) {
    const joined = await call('POST', `rooms/${host.code}/join`, { body: { name } });
    assert.equal(joined.status, 201);
    guests[name.toLowerCase()] = joined.json;
  }
  await call('POST', `rooms/${host.code}/topics`,
    { body: { playerId: host.playerId, token: host.token, topics: NOTES.derek } });
  for (const [key, topics] of [['sam', NOTES.sam], ['priya', NOTES.priya]]) {
    await call('POST', `rooms/${host.code}/topics`,
      { body: { playerId: guests[key].playerId, token: guests[key].token, topics } });
  }

  const lobby = await call('GET', `rooms/${host.code}/state`,
    { query: { playerId: host.playerId, token: host.token } });
  assert.equal(lobby.json.players.length, 3, 'every player is readable back from Redis');
  assert.equal(lobby.json.topicCount, 9, 'every note is readable back from Redis');

  // Build, start, answer, reveal.
  const built = await call('POST', `rooms/${host.code}/host`,
    { body: { token: host.hostToken, action: 'build' } });
  assert.equal(built.status, 200, JSON.stringify(built.json));
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'start' } });

  const room = await store.loadRoom(host.code);
  const question = room.questions[room.currentIndex];
  const answerer = [host, guests.sam, guests.priya]
    .find((who) => !question.contributorIds.includes(who.playerId));
  const answered = await call('POST', `rooms/${host.code}/answer`, {
    body: {
      playerId: answerer.playerId, token: answerer.token,
      questionId: question.id, choice: question.answerIndex
    }
  });
  assert.equal(answered.status, 200, JSON.stringify(answered.json));

  const answers = await store.loadAnswers(host.code, question.id);
  assert.equal(Object.keys(answers).length, 1, 'the answer is readable back from Redis');
  assert.equal(answers[answerer.playerId].correct, true);
});

test('a room that has expired reports itself gone rather than erroring', async (t) => {
  const redis = startFakeUpstash();
  redis.listen(0, '127.0.0.1');
  await once(redis, 'listening');
  t.after(() => { redis.closeAllConnections?.(); redis.close(); });

  const store = createRedisStore({
    url: `http://127.0.0.1:${redis.address().port}`, token: 'test-token'
  });
  const result = await handleApi({
    method: 'GET',
    segments: ['rooms', 'DEAD', 'state'],
    query: { playerId: 'gone', token: 'gone' },
    body: {},
    store,
    env: {}
  });
  assert.equal(result.status, 404);
  assert.match(result.json.error, /No room with that code/);
});
