/**
 * The API.
 *
 * A single pure-ish function so the same code serves both `node server.js`
 * locally and a Vercel function in production. It takes a described request and
 * returns a described response; the two entry points only deal with transport.
 */

import {
  createRoom, makeRoomCode, makePlayer, makeTopics, cleanTopics, canBuild, currentQuestion,
  startGame, acceptAnswer, scoreRound, revealRound, advance, resetToReady, resetScores,
  viewFor, touch, sitsOut, questionDeadline, MAX_PLAYERS, DEFAULT_SETTINGS
} from './game.js';
import { fallbackQuestions } from './questions.js';
import { writeQuestions, claudeIsConfigured } from './llm.js';
import { storageDiagnosis } from './store.js';

const json = (status, body) => ({ status, json: body });
const fail = (status, error) => ({ status, json: { error } });

/** Load the four pieces of a room in one go. */
async function loadState(store, code, { withAnswers = true } = {}) {
  const room = await store.loadRoom(code);
  if (!room) return null;
  const [players, allTopics] = await Promise.all([store.loadPlayers(code), store.loadTopics(code)]);
  // Replaced notes are tombstoned rather than deleted; they never come back out.
  const topics = allTopics.filter((topic) => !topic.retired);
  const question = currentQuestion(room);
  const answers = withAnswers && question ? await store.loadAnswers(code, question.id) : {};
  return { room, players, topics, answers };
}

function authPlayer(state, playerId, token) {
  const player = state.players.find((candidate) => candidate.id === playerId);
  return player && player.token === token ? player : null;
}

/**
 * Move the game along when a deadline has passed.
 *
 * Nothing runs between requests on a serverless host, so whoever polls next
 * nudges the clock forward. A lock makes sure exactly one of them does the work,
 * which matters because closing a round awards points.
 */
async function maybeAdvance(store, state, now = Date.now()) {
  const { room } = state;

  if (room.phase === 'question') {
    const question = currentQuestion(room);
    const deadline = questionDeadline(room);
    const eligible = state.players.filter((player) => !sitsOut(question, player.id));
    // Nobody left to answer (everyone wrote a note behind it) closes it at once.
    const everyoneAnswered = eligible.every((player) => state.answers[player.id]);
    if (!question || (!everyoneAnswered && (!deadline || now <= deadline))) return state;

    // Another device got there first: re-read rather than show a stale question.
    if (!(await store.tryLock(`close:${room.code}:${question.id}`))) {
      return (await loadState(store, room.code)) ?? state;
    }
    const scored = scoreRound({ room, players: state.players, answers: state.answers });
    await store.savePlayers(room.code, scored);
    revealRound(room, now);
    await store.saveRoom(room);
    return { ...state, room, players: scored };
  }

  if (room.phase === 'reveal' && room.revealStartedAt) {
    if (now < room.revealStartedAt + room.settings.revealSeconds * 1000) return state;
    if (!(await store.tryLock(`advance:${room.code}:${room.currentIndex}`))) {
      return (await loadState(store, room.code)) ?? state;
    }
    advance(room, now);
    await store.saveRoom(room);
    const question = currentQuestion(room);
    const answers = question ? await store.loadAnswers(room.code, question.id) : {};
    return { ...state, room, answers };
  }

  return state;
}

/* -------------------------------------------------------------------- handlers */

async function createRoomHandler({ body, store }) {
  const name = String(body.name ?? '').trim();
  if (!name) return fail(400, 'Tell us your name first.');

  const settings = {};
  for (const key of ['questionCount', 'questionSeconds', 'revealSeconds', 'topicsPerPlayer']) {
    const value = Number(body.settings?.[key]);
    if (Number.isFinite(value)) settings[key] = value;
  }
  settings.questionCount = Math.min(30, Math.max(3, settings.questionCount ?? DEFAULT_SETTINGS.questionCount));
  settings.questionSeconds = Math.min(120, Math.max(5, settings.questionSeconds ?? DEFAULT_SETTINGS.questionSeconds));
  settings.revealSeconds = Math.min(60, Math.max(4, settings.revealSeconds ?? DEFAULT_SETTINGS.revealSeconds));
  settings.topicsPerPlayer = Math.min(8, Math.max(1, settings.topicsPerPlayer ?? DEFAULT_SETTINGS.topicsPerPlayer));

  // Four letters, but try again in the unlikely event the code is taken.
  let code = null;
  for (let attempt = 0; attempt < 8 && !code; attempt++) {
    const candidate = makeRoomCode();
    if (!(await store.loadRoom(candidate))) code = candidate;
  }
  if (!code) return fail(503, 'Could not start a new room. Try again.');

  const room = createRoom({ code, guestName: body.guestName, settings });
  const host = makePlayer([], { name, isHost: true });
  room.hostPlayerId = host.id;
  await store.saveRoom(room);
  await store.savePlayer(code, host);

  return json(201, {
    code,
    hostToken: room.hostToken,
    playerId: host.id,
    token: host.token,
    state: viewFor({ room, players: [host], topics: [], answers: {} }, host.id)
  });
}

async function joinHandler({ state, body, store }) {
  const { room } = state;
  if (state.players.length >= MAX_PLAYERS) return fail(400, 'This room is full.');
  const name = String(body.name ?? '').trim();
  if (!name) return fail(400, 'Tell us your name first.');

  const player = makePlayer(state.players, { name });
  await store.savePlayer(room.code, player);
  const players = [...state.players, player];

  return json(201, {
    playerId: player.id,
    token: player.token,
    name: player.name,
    avatar: player.avatar,
    state: viewFor({ ...state, players }, player.id)
  });
}

async function topicsHandler({ state, body, store }) {
  const { room } = state;
  const player = authPlayer(state, body.playerId, body.token);
  if (!player) return fail(403, 'We lost track of you — rejoin with the room code.');
  if (room.phase !== 'lobby' && room.phase !== 'ready') {
    return fail(409, 'The questions are already written.');
  }

  const wanted = cleanTopics(body.topics);
  if (!wanted.length) return fail(400, `Add at least one thing about ${room.guestName}.`);

  // A player replaces their own notes rather than piling more on.
  const previous = state.topics.filter((topic) => topic.playerId === player.id);
  const fresh = makeTopics(player.id, wanted.slice(0, room.settings.topicsPerPlayer + 2));
  await store.addTopics(room.code, fresh);
  if (previous.length) {
    await store.addTopics(room.code, previous.map((topic) => ({ ...topic, retired: true })));
  }

  const updated = { ...player, topicCount: fresh.length, lastSeen: Date.now() };
  await store.savePlayer(room.code, updated);

  const topics = [...state.topics.filter((topic) => topic.playerId !== player.id), ...fresh];
  const players = state.players.map((candidate) => (candidate.id === player.id ? updated : candidate));
  return json(200, { ok: true, state: viewFor({ ...state, players, topics }, player.id) });
}

async function answerHandler({ state, body, store }) {
  const { room } = state;
  const player = authPlayer(state, body.playerId, body.token);
  if (!player) return fail(403, 'We lost track of you — rejoin with the room code.');

  const result = acceptAnswer({
    room,
    player,
    questionId: body.questionId,
    choice: body.choice,
    existingAnswer: state.answers[player.id]
  });
  if (!result.ok) return json(409, result);

  await store.saveAnswer(room.code, body.questionId, player.id, result.answer);
  const answers = { ...state.answers, [player.id]: result.answer };
  const next = await maybeAdvance(store, { ...state, answers });
  return json(200, { ok: true, state: viewFor(next, player.id) });
}

/** Write the questions. Slow — this is the one request that calls the model. */
async function buildHandler({ state, body, store, env }) {
  const { room } = state;
  const check = canBuild(state);
  if (!check.ok) return fail(400, check.reason);

  const count = room.settings.questionCount;
  const live = state.topics;

  room.phase = 'building';
  room.buildingStartedAt = Date.now();
  room.notice = null;
  touch(room);
  await store.saveRoom(room);

  let questions = [];
  let writtenBy = 'notes';
  let notice = null;

  if (claudeIsConfigured(env) && body.useClaude !== false) {
    try {
      const result = await writeQuestions({ guestName: room.guestName, topics: live, count });
      questions = result.questions;
      writtenBy = 'claude';
      if (result.batchesFailed) notice = 'A couple of questions did not come back, so this round is shorter.';
    } catch (error) {
      notice = `Could not reach Claude (${error.message}) — played from your notes instead.`;
    }
  } else if (!claudeIsConfigured(env)) {
    notice = 'No ANTHROPIC_API_KEY on this deployment, so these are simpler note questions.';
  }

  if (questions.length < 3) {
    questions = fallbackQuestions({ guestName: room.guestName, topics: live, count });
    writtenBy = 'notes';
  }

  // Whoever wrote a note behind a question sits that one out — but a question
  // nobody is left to answer is not a question, so benching stops before the
  // room runs out of players.
  const topicOwner = new Map(live.map((topic) => [topic.id, topic.playerId]));
  const roomSize = state.players.length;
  room.questions = questions.map((question, index) => {
    const authors = [...new Set((question.topicIds ?? []).map((id) => topicOwner.get(id)).filter(Boolean))];
    const playable = roomSize >= 3 && roomSize - authors.length >= 2;
    return { ...question, index, contributorIds: playable ? authors : [] };
  });
  room.phase = 'ready';
  room.writtenBy = writtenBy;
  room.notice = notice;
  touch(room);
  await store.saveRoom(room);

  return json(200, { ok: true, writtenBy, count: room.questions.length, notice });
}

async function hostHandler({ state, body, store, env }) {
  const { room } = state;
  if (body.token !== room.hostToken) return fail(403, 'Only the person who started the room can do that.');

  switch (body.action) {
    case 'build':
      return buildHandler({ state, body, store, env });

    case 'start': {
      if (!room.questions.length) return fail(400, 'Write the questions first.');
      await store.savePlayers(room.code, resetScores(state.players));
      startGame(room);
      await store.saveRoom(room);
      return json(200, { ok: true });
    }

    case 'reveal': {
      if (room.phase !== 'question') return fail(409, 'Nothing to reveal.');
      const question = currentQuestion(room);
      if (await store.tryLock(`close:${room.code}:${question.id}`)) {
        await store.savePlayers(room.code, scoreRound(state));
        revealRound(room);
        await store.saveRoom(room);
      }
      return json(200, { ok: true });
    }

    case 'next': {
      if (room.phase !== 'reveal') return fail(409, 'Wait for the answer first.');
      if (await store.tryLock(`advance:${room.code}:${room.currentIndex}`)) {
        advance(room);
        await store.saveRoom(room);
      }
      return json(200, { ok: true });
    }

    case 'again': {
      await store.savePlayers(room.code, resetScores(state.players));
      resetToReady(room);
      room.notice = null;
      await store.saveRoom(room);
      return json(200, { ok: true });
    }

    case 'reopen': {
      // Back to collecting notes, keeping everyone in the room.
      room.phase = 'lobby';
      room.questions = [];
      room.currentIndex = -1;
      room.notice = null;
      touch(room);
      await store.saveRoom(room);
      return json(200, { ok: true });
    }

    case 'close': {
      await store.deleteRoom(room.code);
      return json(200, { ok: true, closed: true });
    }

    default:
      return fail(400, `Unknown action: ${body.action}`);
  }
}

/* ---------------------------------------------------------------------- router */

export async function handleApi({ method, segments, query, body = {}, store, env = process.env }) {
  // segments: everything after /api
  const [head, code, action] = segments;

  if (head === 'health' && method === 'GET') {
    const storage = storageDiagnosis(env);
    const hasClaude = claudeIsConfigured(env);
    return json(200, {
      ok: true,
      ready: storage.kind === 'redis' && hasClaude,
      storage: store.kind,
      claude: hasClaude,
      // One message per thing that needs fixing, so a checker can show each once.
      issues: {
        storage: storage.problem
          ?? (storage.kind === 'memory'
            ? 'Players on different devices will not see the same room.'
            : null),
        claude: hasClaude
          ? null
          : 'Questions fall back to the simpler offline set.'
      }
    });
  }

  if (head === 'rooms' && !code && method === 'POST') {
    return createRoomHandler({ body, store });
  }

  if (head !== 'rooms' || !code) return fail(404, 'Not found');

  const roomCode = String(code).toUpperCase();
  const state = await loadState(store, roomCode);
  if (!state) return fail(404, 'No room with that code. Check the letters with whoever started it.');

  if (!action && method === 'GET') {
    return json(200, {
      code: state.room.code,
      guestName: state.room.guestName,
      phase: state.room.phase,
      playerCount: state.players.length
    });
  }

  if (action === 'state' && method === 'GET') {
    const player = authPlayer(state, query.playerId, query.token);
    if (!player) return fail(403, 'We lost track of you — rejoin with the room code.');
    const next = await maybeAdvance(store, state);
    return json(200, viewFor(next, player.id));
  }

  if (action === 'join' && method === 'POST') return joinHandler({ state, body, store });
  if (action === 'topics' && method === 'POST') return topicsHandler({ state, body, store });
  if (action === 'answer' && method === 'POST') return answerHandler({ state, body, store });
  if (action === 'host' && method === 'POST') return hostHandler({ state, body, store, env });

  return fail(404, 'Not found');
}
