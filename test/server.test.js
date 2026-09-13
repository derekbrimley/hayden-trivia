/**
 * End-to-end: a real HTTP server, a host, two players, and the event streams
 * they each watch. This is the test that would catch a broken wire format.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

process.env.PORT = '0'; // let the OS choose a free port
const { server } = await import('../server.js');
if (!server.listening) await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  // SSE responses are long-lived; drop them so the process can exit.
  server.closeAllConnections?.();
  server.close();
});

async function post(path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {})
  });
  return { status: response.status, body: await response.json() };
}

/** Minimal SSE client: collects parsed `state` events as they arrive. */
function openStream(path) {
  const controller = new AbortController();
  const events = [];
  const waiters = [];

  const ready = fetch(base + path, { signal: controller.signal }).then(async (response) => {
    if (!response.ok) throw new Error(`stream failed: ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split;
          while ((split = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const name = chunk.match(/^event: (.+)$/m)?.[1];
            const data = chunk.match(/^data: (.+)$/m)?.[1];
            if (name && data) {
              const event = { name, data: JSON.parse(data) };
              events.push(event);
              waiters.splice(0).forEach((resolve) => resolve(event));
            }
          }
        }
      } catch { /* aborted */ }
    })();
    return response;
  });

  return {
    ready,
    events,
    latest: () => events.at(-1)?.data ?? null,
    /** Wait for the next state matching a predicate (or return one already seen). */
    async until(predicate, timeoutMs = 4000) {
      const seen = events.find((event) => event.name === 'state' && predicate(event.data));
      if (seen) return seen.data;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('timed out waiting for a matching state');
        const next = await Promise.race([
          new Promise((resolve) => waiters.push(resolve)),
          new Promise((resolve) => setTimeout(() => resolve(null), remaining))
        ]);
        if (next?.name === 'state' && predicate(next.data)) return next.data;
      }
    },
    close: () => controller.abort()
  };
}

const KEYWORDS = ['rock climbing', 'hates cilantro', 'grew up in Idaho', 'golden retriever',
  'Taylor Swift', 'flannel shirts', 'Dr Pepper', 'The Office', 'juggling', 'camping',
  'awake at 5am', 'board games'];

test('health check reports the server is up', async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('the player page and its assets are served', async () => {
  for (const [path, needle] of [['/', 'Join the game'], ['/host', 'Who are we celebrating?'], ['/css/style.css', '--brand']]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, `${path} should be served`);
    assert.ok((await response.text()).includes(needle), `${path} looked wrong`);
  }
});

test('paths cannot escape the public directory', async () => {
  const response = await fetch(`${base}/../server.js`, { redirect: 'manual' });
  assert.ok(response.status === 403 || response.status === 404, `got ${response.status}`);
});

test('a room needs at least three keywords', async () => {
  const { status, body } = await post('/api/rooms', { guestName: 'Hayden', keywords: ['one'] });
  assert.equal(status, 400);
  assert.match(body.error, /at least 3 keywords/i);
});

test('joining a room that does not exist fails kindly', async () => {
  const { status, body } = await post('/api/rooms/ZZZZ/join', { name: 'Nobody' });
  assert.equal(status, 404);
  assert.match(body.error, /code/i);
});

test('a full game runs from setup to the final leaderboard', async () => {
  const created = await post('/api/rooms', {
    guestName: 'Hayden',
    keywords: KEYWORDS,
    settings: { questionCount: 3, questionSeconds: 30, revealSeconds: 60 }
  });
  assert.equal(created.status, 201);
  const { code, hostToken } = created.body;

  const host = openStream(`/api/rooms/${code}/stream?role=host&token=${hostToken}`);
  await host.ready;

  const derek = (await post(`/api/rooms/${code}/join`, { name: 'Derek' })).body;
  const sam = (await post(`/api/rooms/${code}/join`, { name: 'Sam' })).body;
  assert.ok(derek.playerId && derek.token);

  const derekStream = openStream(
    `/api/rooms/${code}/stream?role=player&playerId=${derek.playerId}&token=${derek.token}`);
  const samStream = openStream(
    `/api/rooms/${code}/stream?role=player&playerId=${sam.playerId}&token=${sam.token}`);
  await Promise.all([derekStream.ready, samStream.ready]);

  await host.until((state) => state.playerCount === 2);

  // Wrong host token cannot drive the game.
  const forged = await post(`/api/rooms/${code}/host`, { token: 'nope', action: 'start' });
  assert.equal(forged.status, 403);

  await post(`/api/rooms/${code}/host`, { token: hostToken, action: 'start' });
  const asked = await host.until((state) => state.phase === 'question');
  const question = asked.question;

  const playerSees = await derekStream.until((state) => state.phase === 'question');
  assert.equal(playerSees.question.answerIndex, undefined, 'players must not receive the answer');

  await post(`/api/rooms/${code}/answer`, {
    playerId: derek.playerId, token: derek.token, questionId: question.id, choice: question.answerIndex
  });
  await post(`/api/rooms/${code}/answer`, {
    playerId: sam.playerId, token: sam.token, questionId: question.id, choice: (question.answerIndex + 1) % 4
  });

  // Everyone answered, so the server reveals without waiting out the clock.
  const revealed = await host.until((state) => state.phase === 'reveal');
  assert.equal(revealed.leaderboard[0].name, 'Derek');
  assert.ok(revealed.leaderboard[0].score > 0);
  assert.equal(revealed.leaderboard[1].score, 0);

  const derekReveal = await derekStream.until((state) => state.phase === 'reveal');
  assert.equal(derekReveal.myAnswer.correct, true);
  assert.equal(derekReveal.question.answerIndex, question.answerIndex);

  // An answer sent after the reveal is refused.
  const late = await post(`/api/rooms/${code}/answer`, {
    playerId: sam.playerId, token: sam.token, questionId: question.id, choice: 0
  });
  assert.equal(late.status, 409);

  for (let i = 0; i < 3; i++) {
    await post(`/api/rooms/${code}/host`, { token: hostToken, action: 'next' });
    const state = await host.until((s) => s.phase === 'question' || s.phase === 'finished');
    if (state.phase === 'finished') break;
    await post(`/api/rooms/${code}/host`, { token: hostToken, action: 'reveal' });
    await host.until((s) => s.phase === 'reveal');
  }

  const finished = await host.until((state) => state.phase === 'finished');
  assert.equal(finished.leaderboard.length, 2);
  assert.equal(finished.leaderboard[0].rank, 1);

  const playerFinish = await samStream.until((state) => state.phase === 'finished');
  assert.ok(typeof playerFinish.leaderboard[0].score === 'number');

  host.close();
  derekStream.close();
  samStream.close();
});

test('the host can reshuffle and edit the deck over HTTP', async () => {
  const created = await post('/api/rooms', {
    guestName: 'Hayden', keywords: KEYWORDS, settings: { questionCount: 4 }
  });
  const { code, hostToken } = created.body;
  const before = created.body.state.questions.map((question) => question.prompt);

  const reshuffled = await post(`/api/rooms/${code}/host`, { token: hostToken, action: 'generate', seed: 777 });
  assert.notDeepEqual(reshuffled.body.state.questions.map((question) => question.prompt), before);

  const target = reshuffled.body.state.questions[0];
  const edited = await post(`/api/rooms/${code}/host`, {
    token: hostToken,
    action: 'update',
    questionId: target.id,
    patch: { prompt: 'Which one is really Hayden?', answerIndex: 3 }
  });
  assert.equal(edited.body.state.questions[0].prompt, 'Which one is really Hayden?');
  assert.equal(edited.body.state.questions[0].answerIndex, 3);

  const removed = await post(`/api/rooms/${code}/host`, {
    token: hostToken, action: 'remove', questionId: target.id
  });
  assert.equal(removed.body.state.questions.length, 3);
});
