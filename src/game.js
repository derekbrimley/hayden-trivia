/**
 * Game rules and state.
 *
 * Everything here is plain JSON — no Maps, no class instances — because a room
 * lives in Redis between requests, not in a long-running process. A serverless
 * function loads a room, applies one change, and writes it back.
 *
 * The state is split into four pieces that are stored separately so that
 * concurrent writers never clobber each other:
 *
 *   room     the host writes it (phase, questions, the clock)
 *   players  each player writes only their own record
 *   topics   each player appends only their own topics
 *   answers  each player writes only their own answer to the current question
 */

import { randomUUID } from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const AVATARS = ['🦊', '🐙', '🐢', '🦩', '🐸', '🦄', '🐼', '🦁', '🐝', '🦖', '🐬', '🦉',
  '🐧', '🦔', '🐨', '🦥', '🦡', '🐳', '🦚', '🐿️', '🦦', '🐶', '🐱', '🦈', '🦕', '🐷'];

export const PHASES = ['lobby', 'building', 'ready', 'question', 'reveal', 'finished'];

export const DEFAULT_SETTINGS = {
  topicsPerPlayer: 3,
  questionCount: 12,
  questionSeconds: 25,
  revealSeconds: 12,
  minTopics: 6,
  basePoints: 600,
  speedPoints: 400,
  streakPoints: 50,
  maxStreakBonus: 200,
  // Answers arriving fractionally after the deadline still count; phones are slow.
  graceMs: 1500
};

export const MAX_PLAYERS = 40;
export const MAX_TOPIC_LENGTH = 80;

export function makeRoomCode(random = Math.random) {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return code;
}

export function createRoom({ code, guestName, settings = {} }) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  return {
    code,
    hostToken: randomUUID(),
    hostPlayerId: null,
    guestName: String(guestName ?? '').trim().slice(0, 40) || 'our guest of honor',
    settings: merged,
    phase: 'lobby',
    questions: [],
    currentIndex: -1,
    questionStartedAt: null,
    revealStartedAt: null,
    buildingStartedAt: null,
    writtenBy: null,
    notice: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 0
  };
}

export function touch(room) {
  room.updatedAt = Date.now();
  room.version += 1;
  return room;
}

/* -------------------------------------------------------------------- players */

function uniqueName(players, wanted) {
  const base = String(wanted ?? '').trim().replace(/\s+/g, ' ').slice(0, 18) || 'Player';
  const taken = new Set(players.map((player) => player.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
  }
  return `${base} ${Date.now() % 1000}`;
}

export function makePlayer(players, { name, isHost = false }) {
  const used = new Set(players.map((player) => player.avatar));
  const free = AVATARS.filter((emoji) => !used.has(emoji));
  return {
    id: randomUUID(),
    token: randomUUID(),
    name: uniqueName(players, name),
    avatar: free.length ? free[Math.floor(Math.random() * free.length)] : '🎈',
    isHost,
    score: 0,
    streak: 0,
    correctCount: 0,
    topicCount: 0,
    joinedAt: Date.now(),
    lastSeen: Date.now()
  };
}

export function cleanTopics(texts) {
  const out = [];
  const seen = new Set();
  for (const raw of texts ?? []) {
    const text = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_TOPIC_LENGTH);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

export function makeTopics(playerId, texts) {
  return cleanTopics(texts).map((text) => ({ id: `t_${randomUUID().slice(0, 8)}`, text, playerId }));
}

/* ---------------------------------------------------------------------- rules */

export function canBuild({ room, players, topics }) {
  if (room.phase !== 'lobby' && room.phase !== 'ready') {
    return { ok: false, reason: 'The game has already started.' };
  }
  if (topics.length < room.settings.minTopics) {
    const needed = room.settings.minTopics - topics.length;
    return { ok: false, reason: `Need ${needed} more thing${needed === 1 ? '' : 's'} about ${room.guestName} first.` };
  }
  if (players.length < 1) return { ok: false, reason: 'Nobody has joined yet.' };
  return { ok: true };
}

export function currentQuestion(room) {
  if (room.currentIndex < 0) return null;
  return room.questions[room.currentIndex] ?? null;
}

/**
 * A player who submitted the fact behind a question already knows the answer,
 * so they sit that one out instead of collecting free points.
 */
export function sitsOut(question, playerId) {
  return Boolean(question?.contributorIds?.includes(playerId));
}

export function questionDeadline(room) {
  if (room.phase !== 'question' || !room.questionStartedAt) return null;
  return room.questionStartedAt + room.settings.questionSeconds * 1000;
}

export function startGame(room, now = Date.now()) {
  if (!room.questions.length) throw new Error('There are no questions yet.');
  room.phase = 'question';
  room.currentIndex = 0;
  room.questionStartedAt = now;
  room.revealStartedAt = null;
  room.notice = null;
  touch(room);
  return room;
}

export function acceptAnswer({ room, player, questionId, choice, existingAnswer }, now = Date.now()) {
  if (room.phase !== 'question') return { ok: false, reason: 'not-accepting' };
  const question = currentQuestion(room);
  if (!question || question.id !== questionId) return { ok: false, reason: 'stale-question' };
  if (sitsOut(question, player.id)) return { ok: false, reason: 'your-question' };
  if (existingAnswer) return { ok: false, reason: 'already-answered' };

  const index = Number(choice);
  if (!Number.isInteger(index) || index < 0 || index >= question.options.length) {
    return { ok: false, reason: 'bad-choice' };
  }
  const deadline = questionDeadline(room);
  if (deadline && now > deadline + room.settings.graceMs) return { ok: false, reason: 'too-late' };

  return {
    ok: true,
    answer: {
      choice: index,
      elapsedMs: Math.max(0, now - (room.questionStartedAt ?? now)),
      correct: index === question.answerIndex
    }
  };
}

/**
 * Score the current question. Returns the players with updated scores; the
 * caller persists them. Called once, by the host, when the round closes.
 */
export function scoreRound({ room, players, answers }) {
  const question = currentQuestion(room);
  if (!question) return players;
  const { basePoints, speedPoints, questionSeconds, streakPoints, maxStreakBonus } = room.settings;
  const limitMs = questionSeconds * 1000;

  return players.map((player) => {
    // Sitting out is not a wrong answer: it neither scores nor breaks a streak.
    if (sitsOut(question, player.id)) return { ...player };
    const answer = answers[player.id];
    if (!answer?.correct) return { ...player, streak: 0 };
    const remaining = Math.max(0, limitMs - answer.elapsedMs) / limitMs;
    const streakBonus = Math.min(player.streak * streakPoints, maxStreakBonus);
    const points = Math.round(basePoints + speedPoints * remaining) + streakBonus;
    return {
      ...player,
      score: player.score + points,
      streak: player.streak + 1,
      correctCount: player.correctCount + 1
    };
  });
}

/** Points each player earned on the current question (for the reveal screen). */
export function roundPoints({ room, players, answers }) {
  const scored = scoreRound({ room, players, answers });
  const before = new Map(players.map((player) => [player.id, player.score]));
  return new Map(scored.map((player) => [player.id, player.score - (before.get(player.id) ?? 0)]));
}

export function revealRound(room, now = Date.now()) {
  room.phase = 'reveal';
  room.revealStartedAt = now;
  touch(room);
  return room;
}

export function advance(room, now = Date.now()) {
  if (room.currentIndex + 1 >= room.questions.length) {
    room.phase = 'finished';
    room.questionStartedAt = null;
    room.revealStartedAt = null;
  } else {
    room.currentIndex += 1;
    room.phase = 'question';
    room.questionStartedAt = now;
    room.revealStartedAt = null;
  }
  touch(room);
  return room;
}

export function resetToReady(room) {
  room.phase = room.questions.length ? 'ready' : 'lobby';
  room.currentIndex = -1;
  room.questionStartedAt = null;
  room.revealStartedAt = null;
  touch(room);
  return room;
}

export function resetScores(players) {
  return players.map((player) => ({ ...player, score: 0, streak: 0, correctCount: 0 }));
}

export function leaderboard(players) {
  return players
    .map((player) => ({
      id: player.id, name: player.name, avatar: player.avatar, isHost: player.isHost,
      score: player.score, streak: player.streak, correctCount: player.correctCount
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((player, index) => ({ ...player, rank: index + 1 }));
}

/* ---------------------------------------------------------------------- views */

function timing(room) {
  const { questionSeconds, revealSeconds } = room.settings;
  if (room.phase === 'question' && room.questionStartedAt) {
    return { endsAt: room.questionStartedAt + questionSeconds * 1000, totalMs: questionSeconds * 1000 };
  }
  if (room.phase === 'reveal' && room.revealStartedAt) {
    return { endsAt: room.revealStartedAt + revealSeconds * 1000, totalMs: revealSeconds * 1000 };
  }
  return { endsAt: null, totalMs: null };
}

/**
 * What one device is allowed to see. The correct answer is withheld until the
 * reveal, and topics are never echoed back to anyone — they are the game.
 */
export function viewFor({ room, players, topics, answers }, playerId) {
  const revealed = room.phase === 'reveal' || room.phase === 'finished';
  const me = players.find((player) => player.id === playerId) ?? null;
  const question = currentQuestion(room);
  const myAnswer = answers?.[playerId] ?? null;
  const board = leaderboard(players);

  const questionView = question && {
    id: question.id,
    index: room.currentIndex,
    total: room.questions.length,
    prompt: question.prompt,
    options: question.options,
    style: question.style ?? null,
    ...(revealed ? { answerIndex: question.answerIndex, explanation: question.explanation } : {}),
    ...(revealed && question.contributorIds?.length
      ? { contributors: question.contributorIds.map((id) => players.find((p) => p.id === id)?.name).filter(Boolean) }
      : {}),
    youSitOut: sitsOut(question, playerId)
  };

  const answeredCount = Object.keys(answers ?? {}).length;
  const eligibleCount = question
    ? players.filter((player) => !sitsOut(question, player.id)).length
    : players.length;

  return {
    version: room.version,
    code: room.code,
    guestName: room.guestName,
    phase: room.phase,
    notice: room.notice,
    settings: {
      topicsPerPlayer: room.settings.topicsPerPlayer,
      questionSeconds: room.settings.questionSeconds,
      questionCount: room.settings.questionCount
    },
    questionsReady: room.questions.length,
    writtenBy: room.writtenBy,
    topicCount: topics.length,
    isHost: Boolean(me?.isHost),
    me: me && {
      id: me.id, name: me.name, avatar: me.avatar, score: me.score,
      streak: me.streak, topicCount: me.topicCount,
      rank: board.find((player) => player.id === me.id)?.rank ?? null
    },
    players: board.map((player) => ({
      ...player,
      score: revealed || room.phase === 'lobby' || room.phase === 'ready' || room.phase === 'building'
        ? player.score
        : undefined,
      topicCount: players.find((p) => p.id === player.id)?.topicCount ?? 0
    })),
    question: questionView,
    myAnswer: myAnswer && {
      choice: myAnswer.choice,
      correct: revealed ? myAnswer.correct : null
    },
    answeredCount,
    eligibleCount,
    timing: timing(room),
    serverTime: Date.now()
  };
}
