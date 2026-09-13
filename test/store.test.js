/**
 * Storage.
 *
 * The memory store is tested directly. The Redis store is tested against a
 * stand-in that speaks Upstash's REST protocol, which checks the commands and
 * the wire format this code sends without needing a real database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore, createRedisStore, createStore, redisConfig } from '../src/store.js';

/** A tiny Redis that understands only the commands this app sends. */
function fakeUpstash() {
  const data = new Map();
  const sent = [];

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
      case 'HGETALL': {
        const hash = data.get(args[0]);
        if (!hash) return [];
        // Upstash returns a hash as a flat array.
        return [...hash.entries()].flat();
      }
      default:
        throw new Error(`fake redis does not know ${verb}`);
    }
  };

  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (options.headers.Authorization !== 'Bearer test-token') {
      return { ok: false, status: 401, json: async () => ({}) };
    }
    sent.push({ url, body });
    if (url.endsWith('/pipeline')) {
      return { ok: true, status: 200, json: async () => body.map((command) => ({ result: run(command) })) };
    }
    return { ok: true, status: 200, json: async () => ({ result: run(body) }) };
  };

  return { fetchImpl, sent, data };
}

const room = (code = 'ABCD') => ({ code, guestName: 'Hayden', phase: 'lobby', questions: [], version: 1 });

function suite(name, makeStore) {
  test(`${name}: a room survives a round trip`, async () => {
    const store = await makeStore();
    assert.equal(await store.loadRoom('ABCD'), null);
    await store.saveRoom(room());
    const loaded = await store.loadRoom('ABCD');
    assert.equal(loaded.guestName, 'Hayden');
    assert.equal(loaded.phase, 'lobby');
  });

  test(`${name}: players are stored per player, not as one blob`, async () => {
    const store = await makeStore();
    await store.saveRoom(room());
    await store.savePlayer('ABCD', { id: 'p1', name: 'Derek', score: 0 });
    await store.savePlayer('ABCD', { id: 'p2', name: 'Sam', score: 0 });
    // Two writers touching different players must not lose either.
    await Promise.all([
      store.savePlayer('ABCD', { id: 'p1', name: 'Derek', score: 100 }),
      store.savePlayer('ABCD', { id: 'p2', name: 'Sam', score: 250 })
    ]);
    const players = await store.loadPlayers('ABCD');
    assert.equal(players.length, 2);
    assert.equal(players.find((player) => player.id === 'p1').score, 100);
    assert.equal(players.find((player) => player.id === 'p2').score, 250);
  });

  test(`${name}: savePlayers writes a whole scoreboard at once`, async () => {
    const store = await makeStore();
    await store.savePlayers('ABCD', [{ id: 'p1', score: 10 }, { id: 'p2', score: 20 }]);
    const players = await store.loadPlayers('ABCD');
    assert.equal(players.length, 2);
  });

  test(`${name}: topics accumulate and can be replaced by id`, async () => {
    const store = await makeStore();
    await store.addTopics('ABCD', [{ id: 't1', text: 'climbs', playerId: 'p1' }]);
    await store.addTopics('ABCD', [{ id: 't2', text: 'bakes', playerId: 'p2' }]);
    assert.equal((await store.loadTopics('ABCD')).length, 2);

    await store.addTopics('ABCD', [{ id: 't1', text: 'climbs', playerId: 'p1', retired: true }]);
    const topics = await store.loadTopics('ABCD');
    assert.equal(topics.length, 2);
    assert.equal(topics.find((topic) => topic.id === 't1').retired, true);
  });

  test(`${name}: answers are keyed by question and player`, async () => {
    const store = await makeStore();
    assert.deepEqual(await store.loadAnswers('ABCD', 'q1'), {});
    await store.saveAnswer('ABCD', 'q1', 'p1', { choice: 2, correct: true });
    await store.saveAnswer('ABCD', 'q1', 'p2', { choice: 0, correct: false });
    await store.saveAnswer('ABCD', 'q2', 'p1', { choice: 1, correct: false });

    const first = await store.loadAnswers('ABCD', 'q1');
    assert.equal(Object.keys(first).length, 2);
    assert.equal(first.p1.correct, true);
    assert.equal(Object.keys(await store.loadAnswers('ABCD', 'q2')).length, 1);
  });

  test(`${name}: a lock is granted exactly once`, async () => {
    const store = await makeStore();
    const results = await Promise.all([
      store.tryLock('close:ABCD:q1'),
      store.tryLock('close:ABCD:q1'),
      store.tryLock('close:ABCD:q1')
    ]);
    assert.equal(results.filter(Boolean).length, 1, `expected one winner, got ${results}`);
    assert.equal(await store.tryLock('close:ABCD:q2'), true, 'a different round has its own lock');
  });

  test(`${name}: deleting a room clears it`, async () => {
    const store = await makeStore();
    await store.saveRoom(room());
    await store.deleteRoom('ABCD');
    assert.equal(await store.loadRoom('ABCD'), null);
  });
}

suite('memory', async () => createMemoryStore());
suite('redis', async () => {
  const fake = fakeUpstash();
  return createRedisStore({ url: 'https://redis.test', token: 'test-token', fetchImpl: fake.fetchImpl });
});

test('redis: writes go out as Upstash commands', async () => {
  const fake = fakeUpstash();
  const store = createRedisStore({ url: 'https://redis.test', token: 'test-token', fetchImpl: fake.fetchImpl });
  await store.saveRoom(room());
  await store.savePlayer('ABCD', { id: 'p1', name: 'Derek' });

  const pipelines = fake.sent.filter((entry) => entry.url.endsWith('/pipeline'));
  assert.equal(pipelines.length, 2, 'a write and its expiry travel together');
  assert.deepEqual(pipelines[0].body[0].slice(0, 2), ['SET', 'gt:room:ABCD']);
  assert.equal(pipelines[0].body[1][0], 'EXPIRE', 'rooms clean themselves up');
  assert.deepEqual(pipelines[1].body[0].slice(0, 3), ['HSET', 'gt:players:ABCD', 'p1']);
});

test('redis: a rejected request is reported, not swallowed', async () => {
  const store = createRedisStore({
    url: 'https://redis.test',
    token: 'wrong-token',
    fetchImpl: fakeUpstash().fetchImpl
  });
  await assert.rejects(() => store.loadRoom('ABCD'), /credentials/i);
});

test('redis is used when credentials are present, memory otherwise', () => {
  assert.equal(createStore({}).kind, 'memory');
  assert.equal(createStore({ KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't' }).kind, 'redis');
  assert.equal(
    createStore({ UPSTASH_REDIS_REST_URL: 'https://x', UPSTASH_REDIS_REST_TOKEN: 't' }).kind,
    'redis'
  );
});

test('a trailing slash on the Redis URL does not become a double slash', () => {
  assert.equal(redisConfig({ KV_REST_API_URL: 'https://x/', KV_REST_API_TOKEN: 't' }).url, 'https://x');
});

test('the TCP connection string is recognised as the wrong credential', async () => {
  const { storageDiagnosis } = await import('../src/store.js');

  const tcpOnly = storageDiagnosis({ REDIS_URL: 'redis://default:pw@db.upstash.io:6379' });
  assert.equal(tcpOnly.kind, 'memory');
  assert.equal(tcpOnly.ok, false);
  assert.match(tcpOnly.problem, /REST/);

  const tcpInRestSlot = storageDiagnosis({
    KV_REST_API_URL: 'rediss://default:pw@db.upstash.io:6379',
    KV_REST_API_TOKEN: 'token'
  });
  assert.equal(tcpInRestSlot.ok, false);
  assert.match(tcpInRestSlot.problem, /https:\/\//);
});

test('half-configured credentials are reported, not ignored', async () => {
  const { storageDiagnosis } = await import('../src/store.js');
  assert.match(storageDiagnosis({ KV_REST_API_URL: 'https://db.upstash.io' }).problem, /token is missing/);
  assert.match(storageDiagnosis({ KV_REST_API_TOKEN: 'token' }).problem, /URL is missing/);
});

test('a correct REST pair is accepted under either naming', async () => {
  const { storageDiagnosis } = await import('../src/store.js');
  for (const env of [
    { KV_REST_API_URL: 'https://db.upstash.io', KV_REST_API_TOKEN: 't' },
    { UPSTASH_REDIS_REST_URL: 'https://db.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' }
  ]) {
    const diagnosis = storageDiagnosis(env);
    assert.equal(diagnosis.kind, 'redis');
    assert.equal(diagnosis.ok, true);
    assert.equal(diagnosis.problem, undefined);
  }
});

test('a store built from broken credentials falls back rather than throwing', async () => {
  const { createStore } = await import('../src/store.js');
  const store = createStore({ REDIS_URL: 'redis://x' });
  assert.equal(store.kind, 'memory');
  assert.match(store.problem, /REST/);
});
