/**
 * The whole API, exercised the way the app uses it. No HTTP and no network:
 * the router is called directly against an in-memory store, and question
 * writing falls back to the offline generator because no API key is set.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleApi } from '../src/router.js';
import { createMemoryStore } from '../src/store.js';

const ENV = {}; // no ANTHROPIC_API_KEY: questions come from the notes

function harness() {
  const store = createMemoryStore();
  const call = (method, path, { body = {}, query = {} } = {}) => handleApi({
    method,
    segments: path.split('/').filter(Boolean),
    query,
    body,
    store,
    env: ENV
  });
  return { store, call };
}

const NOTES = {
  derek: ['always cold, hoodie indoors', 'reads three books at once', 'refuses to eat olives'],
  sam: ['quotes the same film daily', 'names every houseplant', 'up before sunrise'],
  priya: ['keeps every receipt', 'terrible at parallel parking', 'makes a spreadsheet for holidays']
};

async function startedRoom({ questionCount = 4 } = {}) {
  const { store, call } = harness();
  const created = await call('POST', 'rooms', {
    body: { guestName: 'Hayden', name: 'Derek', settings: { questionCount, questionSeconds: 20 } }
  });
  const host = created.json;

  const guests = {};
  for (const name of ['Sam', 'Priya']) {
    const joined = await call('POST', `rooms/${host.code}/join`, { body: { name } });
    guests[name.toLowerCase()] = joined.json;
  }

  await call('POST', `rooms/${host.code}/topics`,
    { body: { playerId: host.playerId, token: host.token, topics: NOTES.derek } });
  for (const [key, notes] of [['sam', NOTES.sam], ['priya', NOTES.priya]]) {
    await call('POST', `rooms/${host.code}/topics`,
      { body: { playerId: guests[key].playerId, token: guests[key].token, topics: notes } });
  }
  return { store, call, host, guests };
}

const stateFor = (call, host, who) => call('GET', `rooms/${host.code}/state`,
  { query: { playerId: who.playerId, token: who.token } });

test('health reports how the deployment is configured', async () => {
  const { call } = harness();
  const result = await call('GET', 'health');
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.storage, 'memory');
  assert.equal(result.json.claude, false);
});

test('starting a room needs a name', async () => {
  const { call } = harness();
  const result = await call('POST', 'rooms', { body: { guestName: 'Hayden' } });
  assert.equal(result.status, 400);
});

test('the person who starts the room is a player and the host', async () => {
  const { call } = harness();
  const created = await call('POST', 'rooms', { body: { guestName: 'Hayden', name: 'Derek' } });
  assert.equal(created.status, 201);
  assert.match(created.json.code, /^[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(created.json.state.isHost, true);
  assert.equal(created.json.state.players.length, 1);
  assert.ok(created.json.hostToken);
});

test('joining an unknown room says so kindly', async () => {
  const { call } = harness();
  const result = await call('POST', 'rooms/ZZZZ/join', { body: { name: 'Nobody' } });
  assert.equal(result.status, 404);
  assert.match(result.json.error, /room with that code/i);
});

test('every player contributes their own notes', async () => {
  const { call, host, guests } = await startedRoom();
  const view = (await stateFor(call, host, host)).json;
  assert.equal(view.topicCount, 9);
  assert.equal(view.players.length, 3);
  assert.ok(view.players.every((player) => player.topicCount === 3));
  assert.ok(guests.sam.playerId);
});

test('resubmitting notes replaces the earlier ones instead of piling up', async () => {
  const { call, host } = await startedRoom();
  await call('POST', `rooms/${host.code}/topics`,
    { body: { playerId: host.playerId, token: host.token, topics: ['brand new note'] } });
  const view = (await stateFor(call, host, host)).json;
  assert.equal(view.topicCount, 7, 'six from the others plus one new one');
  assert.equal(view.me.topicCount, 1);
});

test('notes are never echoed back to any device', async () => {
  const { call, host, guests } = await startedRoom();
  const view = await stateFor(call, host, guests.sam);
  assert.ok(!JSON.stringify(view.json).includes('olives'));
});

test('a stranger cannot read the room state', async () => {
  const { call, host } = await startedRoom();
  const result = await call('GET', `rooms/${host.code}/state`,
    { query: { playerId: host.playerId, token: 'not-the-token' } });
  assert.equal(result.status, 403);
});

test('only the host can drive the game', async () => {
  const { call, host, guests } = await startedRoom();
  const result = await call('POST', `rooms/${host.code}/host`,
    { body: { token: guests.sam.token, action: 'build' } });
  assert.equal(result.status, 403);
});

test('a room without enough notes cannot build questions', async () => {
  const { call } = harness();
  const created = await call('POST', 'rooms', { body: { guestName: 'Hayden', name: 'Derek' } });
  const host = created.json;
  await call('POST', `rooms/${host.code}/topics`,
    { body: { playerId: host.playerId, token: host.token, topics: ['one thing'] } });
  const result = await call('POST', `rooms/${host.code}/host`,
    { body: { token: host.hostToken, action: 'build' } });
  assert.equal(result.status, 400);
  assert.match(result.json.error, /more thing/i);
});

test('questions are built from the notes and credited to their authors', async () => {
  const { call, host } = await startedRoom({ questionCount: 6 });
  const built = await call('POST', `rooms/${host.code}/host`,
    { body: { token: host.hostToken, action: 'build' } });
  assert.equal(built.status, 200);
  assert.equal(built.json.writtenBy, 'notes');
  assert.ok(built.json.count >= 3);

  const room = await call('GET', `rooms/${host.code}/state`,
    { query: { playerId: host.playerId, token: host.token } });
  assert.equal(room.json.phase, 'ready');
  assert.equal(room.json.questionsReady, built.json.count);
  assert.match(room.json.notice, /ANTHROPIC_API_KEY/);
});

test('a full game: answer, score, reveal, advance, finish', async () => {
  const { store, call, host, guests } = await startedRoom({ questionCount: 3 });
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'build' } });
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'start' } });

  const total = (await stateFor(call, host, host)).json.question.total;
  for (let round = 0; round < total; round++) {
    const view = (await stateFor(call, host, host)).json;
    assert.equal(view.phase, 'question');
    const room = await store.loadRoom(host.code);
    const question = room.questions[room.currentIndex];

    // Everyone who is allowed to answer does; the right answer goes to whoever
    // did not write the note behind it.
    for (const who of [host, guests.sam, guests.priya]) {
      if (question.contributorIds.includes(who.playerId)) continue;
      const correct = who.playerId === guests.priya.playerId
        ? question.answerIndex
        : (question.answerIndex + 1) % 4;
      const result = await call('POST', `rooms/${host.code}/answer`, {
        body: { playerId: who.playerId, token: who.token, questionId: question.id, choice: correct }
      });
      assert.equal(result.status, 200, JSON.stringify(result.json));
    }

    // Everyone eligible has answered, so the round closes on its own.
    const revealed = (await stateFor(call, host, host)).json;
    assert.equal(revealed.phase, 'reveal');
    assert.equal(revealed.question.answerIndex, question.answerIndex);

    if (round < total - 1) {
      await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'next' } });
    } else {
      await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'next' } });
    }
  }

  const finished = (await stateFor(call, host, host)).json;
  assert.equal(finished.phase, 'finished');
  const priya = finished.players.find((player) => player.id === guests.priya.playerId);
  assert.equal(priya.rank, 1, 'the player who answered correctly should win');
  assert.ok(priya.score > 0);
});

test('benching never leaves a question nobody can answer', async () => {
  const { store, call, host } = await startedRoom({ questionCount: 8 });
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'build' } });
  const room = await store.loadRoom(host.code);
  const players = await store.loadPlayers(host.code);
  for (const question of room.questions) {
    const eligible = players.length - question.contributorIds.length;
    assert.ok(eligible >= 2, `"${question.prompt}" left only ${eligible} players able to answer`);
  }
});

test('a player who wrote the note is told to sit that question out', async () => {
  const { store, call, host, guests } = await startedRoom({ questionCount: 6 });
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'build' } });
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'start' } });

  const room = await store.loadRoom(host.code);
  const question = room.questions[room.currentIndex];
  const authorId = question.contributorIds[0];
  assert.ok(authorId, 'a note question should have an author');

  const author = [host, guests.sam, guests.priya].find((who) => who.playerId === authorId);
  const view = await stateFor(call, host, author);
  assert.equal(view.json.question.youSitOut, true);

  const attempt = await call('POST', `rooms/${host.code}/answer`, {
    body: { playerId: author.playerId, token: author.token, questionId: question.id, choice: 0 }
  });
  assert.equal(attempt.status, 409);
  assert.equal(attempt.json.reason, 'your-question');
});

test('a question closes itself once its time is up', async () => {
  const { store, call, host } = await startedRoom({ questionCount: 3 });
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'build' } });
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'start' } });

  const room = await store.loadRoom(host.code);
  room.questionStartedAt = Date.now() - room.settings.questionSeconds * 1000 - 5000;
  await store.saveRoom(room);

  const view = (await stateFor(call, host, host)).json;
  assert.equal(view.phase, 'reveal', 'an expired question reveals on the next poll');
});

test('the reveal moves on by itself after its own timer', async () => {
  const { store, call, host } = await startedRoom({ questionCount: 3 });
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'build' } });
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'start' } });
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'reveal' } });

  const room = await store.loadRoom(host.code);
  room.revealStartedAt = Date.now() - room.settings.revealSeconds * 1000 - 1000;
  await store.saveRoom(room);

  const view = (await stateFor(call, host, host)).json;
  assert.equal(view.phase, 'question');
  assert.equal(view.question.index, 1);
});

test('a round is only ever scored once, however many devices are polling', async () => {
  const { store, call, host, guests } = await startedRoom({ questionCount: 3 });
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'build' } });
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'start' } });

  const room = await store.loadRoom(host.code);
  const question = room.questions[room.currentIndex];
  const answerer = [host, guests.sam, guests.priya]
    .find((who) => !question.contributorIds.includes(who.playerId));
  await call('POST', `rooms/${host.code}/answer`, {
    body: {
      playerId: answerer.playerId, token: answerer.token,
      questionId: question.id, choice: question.answerIndex
    }
  });

  room.questionStartedAt = Date.now() - room.settings.questionSeconds * 1000 - 5000;
  await store.saveRoom(room);

  // Three devices poll at the same moment. Exactly one of them may award points.
  await Promise.all([host, guests.sam, guests.priya].map((who) => stateFor(call, host, who)));
  const settled = await Promise.all(
    [host, guests.sam, guests.priya].map((who) => stateFor(call, host, who)));

  const scores = settled.map((view) => view.json.players.find((p) => p.id === answerer.playerId).score);
  assert.ok(settled.every((view) => view.json.phase === 'reveal'), 'every device lands on the reveal');
  assert.ok(scores.every((score) => score === scores[0]), `scores diverged: ${scores}`);
  assert.ok(scores[0] > 0 && scores[0] <= 1000,
    `one round must award at most one round of points, got ${scores[0]}`);
});

test('play again clears the scores and keeps the questions', async () => {
  const { call, host } = await startedRoom({ questionCount: 3 });
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'build' } });
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'start' } });
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'again' } });

  const view = (await stateFor(call, host, host)).json;
  assert.equal(view.phase, 'ready');
  assert.ok(view.questionsReady >= 3);
  assert.ok(view.players.every((player) => player.score === 0));
});

test('collecting more notes reopens the lobby', async () => {
  const { call, host } = await startedRoom({ questionCount: 3 });
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'build' } });
  await call('POST', `rooms/${host.code}/host`, { body: { token: host.hostToken, action: 'reopen' } });
  const view = (await stateFor(call, host, host)).json;
  assert.equal(view.phase, 'lobby');
  assert.equal(view.questionsReady, 0);
  assert.equal(view.topicCount, 9, 'the notes are still there');
});

test('health names each deployment problem once', async () => {
  const { call } = harness();

  const bare = (await call('GET', 'health')).json;
  assert.equal(bare.ready, false);
  assert.match(bare.issues.storage, /same room/);
  assert.match(bare.issues.claude, /offline set/);

  // The single-process dev server keeps rooms in memory on purpose.
  const local = await handleApi({
    method: 'GET',
    segments: ['health'],
    query: {},
    body: {},
    store: createMemoryStore(),
    env: { GOH_SINGLE_PROCESS: '1', ANTHROPIC_API_KEY: 'k' }
  });
  assert.equal(local.json.issues.storage, null, 'memory is fine when one process serves everything');
  assert.equal(local.json.ready, true);

  const configured = await handleApi({
    method: 'GET',
    segments: ['health'],
    query: {},
    body: {},
    store: createMemoryStore(),
    env: { KV_REST_API_URL: 'https://db.upstash.io', KV_REST_API_TOKEN: 't', ANTHROPIC_API_KEY: 'k' }
  });
  assert.equal(configured.json.issues.storage, null);
  assert.equal(configured.json.issues.claude, null);
  assert.equal(configured.json.ready, true);
});

test('health explains the TCP-instead-of-REST mistake', async () => {
  const result = await handleApi({
    method: 'GET',
    segments: ['health'],
    query: {},
    body: {},
    store: createMemoryStore(),
    env: { REDIS_URL: 'redis://default:pw@db.upstash.io:6379', ANTHROPIC_API_KEY: 'k' }
  });
  assert.match(result.json.issues.storage, /KV_REST_API_URL/);
});

test('ping answers through the router as well as the standalone function', async () => {
  const { call } = harness();
  const result = await call('GET', 'ping');
  assert.equal(result.status, 200);
  assert.equal(result.json.pong, true);
  assert.equal(result.json.served, 'router');
  for (const value of Object.values(result.json.sees)) assert.equal(typeof value, 'boolean');
  assert.ok(!JSON.stringify(result.json).includes('sk-ant'), 'never echo a key');
});

test('a deep health check exercises the store and reports success', async () => {
  const { call } = harness();
  const result = await call('GET', 'health', { query: { deep: '1' } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json.probe, { ok: true, wrote: true, readBack: true, locks: true });
});

test('a deep health check reports a store that refuses to answer', async () => {
  const broken = {
    kind: 'redis',
    async saveRoom() { throw new Error('Storage request failed (401). Check your Redis credentials.'); },
    async loadRoom() { return null; },
    async loadPlayers() { return []; },
    async loadTopics() { return []; },
    async loadAnswers() { return {}; },
    async deleteRoom() {},
    async tryLock() { return true; }
  };
  const result = await handleApi({
    method: 'GET',
    segments: ['health'],
    query: { deep: '1' },
    body: {},
    store: broken,
    env: { KV_REST_API_URL: 'https://db.upstash.io', KV_REST_API_TOKEN: 'wrong', ANTHROPIC_API_KEY: 'k' }
  });
  assert.equal(result.json.probe.ok, false);
  assert.match(result.json.probe.error, /401/);
  assert.equal(result.json.ready, false, 'a store that cannot be written to is not ready');
  assert.match(result.json.issues.storage, /not answering/);
});

test('a deep check notices a store that writes but cannot read back', async () => {
  const amnesiac = {
    kind: 'redis',
    async saveRoom() {},
    async loadRoom() { return null; },
    async loadPlayers() { return []; },
    async loadTopics() { return []; },
    async loadAnswers() { return {}; },
    async deleteRoom() {},
    async tryLock() { return true; }
  };
  const result = await handleApi({
    method: 'GET', segments: ['health'], query: { deep: '1' }, body: {}, store: amnesiac,
    env: { KV_REST_API_URL: 'https://db.upstash.io', KV_REST_API_TOKEN: 't' }
  });
  assert.equal(result.json.probe.ok, false);
  assert.match(result.json.probe.error, /read back nothing/);
});

test('the shallow health check does not touch the store', async () => {
  let touched = false;
  const watcher = {
    kind: 'redis',
    async saveRoom() { touched = true; },
    async loadRoom() { touched = true; return null; },
    async loadPlayers() { return []; },
    async loadTopics() { return []; },
    async loadAnswers() { return {}; },
    async deleteRoom() { touched = true; },
    async tryLock() { touched = true; return true; }
  };
  await handleApi({
    method: 'GET', segments: ['health'], query: {}, body: {}, store: watcher,
    env: { KV_REST_API_URL: 'https://db.upstash.io', KV_REST_API_TOKEN: 't' }
  });
  assert.equal(touched, false, 'the plain health check must stay cheap');
});
