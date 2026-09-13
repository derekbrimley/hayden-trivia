/**
 * Game state.
 *
 * Pure-ish room logic: no timers, no sockets, no HTTP. The server owns the clock
 * and the transport and calls into here; keeping it separate makes the rules
 * (scoring, phases, who may see the answer) straightforward to test.
 */

import { randomUUID } from 'node:crypto';
import { generateDeck, generateQuestion } from './questions.js';

/** No I/O/0/1 — room codes get read aloud across a noisy room. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const AVATARS = ['🦊', '🐙', '🐢', '🦩', '🐸', '🦄', '🐼', '🦁', '🐝', '🦖', '🐬', '🦉',
  '🐧', '🦔', '🐨', '🦥', '🦡', '🐳', '🦚', '🐿️', '🦦', '🐶', '🐱', '🦈'];

export const DEFAULT_SETTINGS = {
  questionSeconds: 25,
  revealSeconds: 10,
  questionCount: 12,
  basePoints: 600,
  speedPoints: 400,
  streakPoints: 50,
  maxStreakBonus: 200
};

export function makeRoomCode(existing = new Set()) {
  for (let attempt = 0; attempt < 500; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!existing.has(code)) return code;
  }
  throw new Error('Could not allocate a room code.');
}

export function createRoom({ guestName, keywords, settings = {}, code, seed = Date.now() }) {
  const name = String(guestName ?? '').trim() || 'our guest of honor';
  const room = {
    code: code ?? makeRoomCode(),
    hostToken: randomUUID(),
    guestName: name,
    keywords: [...(keywords ?? [])],
    settings: { ...DEFAULT_SETTINGS, ...settings },
    seed,
    questions: [],
    phase: 'setup',
    currentIndex: -1,
    questionStartedAt: null,
    revealStartedAt: null,
    players: new Map(),
    answers: new Map(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 0
  };
  return room;
}

export function touch(room) {
  room.updatedAt = Date.now();
  room.version += 1;
  return room;
}

/** Build (or rebuild) the deck from the room's keywords. */
export function buildDeck(room, { count, seed } = {}) {
  const deck = generateDeck({
    guestName: room.guestName,
    keywords: room.keywords,
    count: count ?? room.settings.questionCount,
    seed: seed ?? room.seed
  });
  room.seed = deck.seed;
  room.keywords = deck.keywords;
  room.questions = deck.questions;
  room.phase = 'setup';
  touch(room);
  return room.questions;
}

/** Replace one question with a fresh draw on the same keyword list. */
export function rerollQuestion(room, questionId, seed = Date.now()) {
  const index = room.questions.findIndex((q) => q.id === questionId);
  if (index === -1) return null;
  const existing = room.questions[index];
  const replacement = generateQuestion({
    guestName: room.guestName,
    keywords: room.keywords,
    seed,
    kind: existing.kind,
    id: existing.id
  });
  room.questions[index] = { ...replacement, index };
  touch(room);
  return room.questions[index];
}

export function removeQuestion(room, questionId) {
  const before = room.questions.length;
  room.questions = room.questions
    .filter((q) => q.id !== questionId)
    .map((q, index) => ({ ...q, index }));
  if (room.questions.length !== before) touch(room);
  return room.questions;
}

/** Host edits: prompt text, option text, which option is correct. */
export function updateQuestion(room, questionId, patch = {}) {
  const index = room.questions.findIndex((q) => q.id === questionId);
  if (index === -1) return null;
  const question = { ...room.questions[index] };
  if (typeof patch.prompt === 'string' && patch.prompt.trim()) {
    question.prompt = patch.prompt.trim().slice(0, 200);
  }
  if (Array.isArray(patch.options)) {
    const options = patch.options
      .map((option) => String(option ?? '').trim().slice(0, 120))
      .filter(Boolean);
    if (options.length >= 2) question.options = options;
  }
  if (Number.isInteger(patch.answerIndex)) {
    question.answerIndex = Math.max(0, Math.min(question.options.length - 1, patch.answerIndex));
  }
  if (typeof patch.explanation === 'string') {
    question.explanation = patch.explanation.trim().slice(0, 240);
  }
  question.source = patch.source ?? 'host';
  room.questions[index] = question;
  touch(room);
  return question;
}

export function addCustomQuestion(room, { prompt, options, answerIndex, explanation }) {
  const cleanOptions = (options ?? [])
    .map((option) => String(option ?? '').trim().slice(0, 120))
    .filter(Boolean);
  if (!String(prompt ?? '').trim() || cleanOptions.length < 2) {
    throw new Error('A question needs a prompt and at least two options.');
  }
  const question = {
    id: `qc_${randomUUID().slice(0, 8)}`,
    kind: 'custom',
    source: 'host',
    star: null,
    prompt: String(prompt).trim().slice(0, 200),
    options: cleanOptions,
    answerIndex: Math.max(0, Math.min(cleanOptions.length - 1, Number(answerIndex) || 0)),
    explanation: String(explanation ?? '').trim().slice(0, 240),
    index: room.questions.length
  };
  room.questions.push(question);
  touch(room);
  return question;
}

export function moveQuestion(room, questionId, direction) {
  const from = room.questions.findIndex((q) => q.id === questionId);
  if (from === -1) return room.questions;
  const to = from + (direction === 'up' ? -1 : 1);
  if (to < 0 || to >= room.questions.length) return room.questions;
  const list = room.questions.slice();
  [list[from], list[to]] = [list[to], list[from]];
  room.questions = list.map((q, index) => ({ ...q, index }));
  touch(room);
  return room.questions;
}

/* ------------------------------------------------------------------ players */

function uniqueName(room, wanted) {
  const base = String(wanted ?? '').trim().replace(/\s+/g, ' ').slice(0, 18) || 'Player';
  const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now() % 1000}`;
}

export function joinRoom(room, { name, avatar }) {
  if (room.players.size >= 40) throw new Error('This room is full.');
  const used = new Set([...room.players.values()].map((p) => p.avatar));
  const free = AVATARS.filter((emoji) => !used.has(emoji));
  const player = {
    id: randomUUID(),
    token: randomUUID(),
    name: uniqueName(room, name),
    avatar: AVATARS.includes(avatar) && !used.has(avatar)
      ? avatar
      : (free[Math.floor(Math.random() * free.length)] ?? '🎈'),
    score: 0,
    streak: 0,
    correctCount: 0,
    joinedAt: Date.now(),
    lastSeen: Date.now(),
    connected: true
  };
  room.players.set(player.id, player);
  touch(room);
  return player;
}

export function removePlayer(room, playerId) {
  if (room.players.delete(playerId)) touch(room);
}

export function authPlayer(room, playerId, token) {
  const player = room.players.get(playerId);
  if (!player || player.token !== token) return null;
  player.lastSeen = Date.now();
  return player;
}

/* -------------------------------------------------------------------- rules */

export function currentQuestion(room) {
  if (room.currentIndex < 0) return null;
  return room.questions[room.currentIndex] ?? null;
}

function answersFor(room, questionId) {
  if (!room.answers.has(questionId)) room.answers.set(questionId, new Map());
  return room.answers.get(questionId);
}

export function startGame(room, now = Date.now()) {
  if (room.questions.length === 0) throw new Error('Generate some questions first.');
  if (room.players.size === 0) throw new Error('Nobody has joined yet.');
  for (const player of room.players.values()) {
    player.score = 0;
    player.streak = 0;
    player.correctCount = 0;
  }
  room.answers = new Map();
  room.currentIndex = 0;
  room.phase = 'question';
  room.questionStartedAt = now;
  room.revealStartedAt = null;
  touch(room);
  return room;
}

export function submitAnswer(room, playerId, { questionId, choice }, now = Date.now()) {
  if (room.phase !== 'question') return { ok: false, reason: 'not-accepting' };
  const question = currentQuestion(room);
  if (!question || question.id !== questionId) return { ok: false, reason: 'stale-question' };
  const player = room.players.get(playerId);
  if (!player) return { ok: false, reason: 'unknown-player' };

  const index = Number(choice);
  if (!Number.isInteger(index) || index < 0 || index >= question.options.length) {
    return { ok: false, reason: 'bad-choice' };
  }
  const answers = answersFor(room, question.id);
  if (answers.has(playerId)) return { ok: false, reason: 'already-answered' };

  const elapsedMs = Math.max(0, now - (room.questionStartedAt ?? now));
  answers.set(playerId, { choice: index, elapsedMs, correct: index === question.answerIndex, points: 0 });
  touch(room);
  return { ok: true, elapsedMs, everyoneAnswered: answers.size >= room.players.size };
}

/** Award points for the current question and move to the reveal phase. */
export function revealAnswer(room, now = Date.now()) {
  const question = currentQuestion(room);
  if (!question) return null;
  if (room.phase === 'reveal') return question;

  const { basePoints, speedPoints, questionSeconds, streakPoints, maxStreakBonus } = room.settings;
  const limitMs = questionSeconds * 1000;
  const answers = answersFor(room, question.id);

  // Slowest-first, so a tie on correctness still ranks by speed in the round recap.
  for (const player of room.players.values()) {
    const answer = answers.get(player.id);
    if (answer?.correct) {
      const remaining = Math.max(0, limitMs - answer.elapsedMs) / limitMs;
      const streakBonus = Math.min(player.streak * streakPoints, maxStreakBonus);
      answer.points = Math.round(basePoints + speedPoints * remaining) + streakBonus;
      player.score += answer.points;
      player.streak += 1;
      player.correctCount += 1;
    } else {
      player.streak = 0;
      if (answer) answer.points = 0;
    }
  }

  room.phase = 'reveal';
  room.revealStartedAt = now;
  touch(room);
  return question;
}

export function nextQuestion(room, now = Date.now()) {
  if (room.currentIndex + 1 >= room.questions.length) {
    room.phase = 'finished';
    room.questionStartedAt = null;
    room.revealStartedAt = null;
    touch(room);
    return room;
  }
  room.currentIndex += 1;
  room.phase = 'question';
  room.questionStartedAt = now;
  room.revealStartedAt = null;
  touch(room);
  return room;
}

export function backToLobby(room) {
  room.phase = 'setup';
  room.currentIndex = -1;
  room.questionStartedAt = null;
  room.revealStartedAt = null;
  room.answers = new Map();
  for (const player of room.players.values()) {
    player.score = 0;
    player.streak = 0;
    player.correctCount = 0;
  }
  touch(room);
  return room;
}

export function leaderboard(room) {
  return [...room.players.values()]
    .map((p) => ({
      id: p.id, name: p.name, avatar: p.avatar, score: p.score,
      streak: p.streak, correctCount: p.correctCount, connected: p.connected
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((p, index) => ({ ...p, rank: index + 1 }));
}

/** Per-question recap shown at reveal: who got it, how fast, what it earned. */
export function roundResults(room) {
  const question = currentQuestion(room);
  if (!question) return [];
  const answers = answersFor(room, question.id);
  return [...room.players.values()]
    .map((player) => {
      const answer = answers.get(player.id);
      return {
        id: player.id,
        name: player.name,
        avatar: player.avatar,
        choice: answer ? answer.choice : null,
        correct: Boolean(answer?.correct),
        points: answer?.points ?? 0,
        elapsedMs: answer?.elapsedMs ?? null
      };
    })
    .sort((a, b) => b.points - a.points || (a.elapsedMs ?? Infinity) - (b.elapsedMs ?? Infinity));
}

export function answeredCount(room) {
  const question = currentQuestion(room);
  if (!question) return 0;
  return answersFor(room, question.id).size;
}

export function everyoneAnswered(room) {
  return room.players.size > 0 && answeredCount(room) >= room.players.size;
}

/* --------------------------------------------------------------------- views */

function questionView(room, { includeAnswer }) {
  const question = currentQuestion(room);
  if (!question) return null;
  const view = {
    id: question.id,
    index: question.index,
    kind: question.kind,
    prompt: question.prompt,
    options: question.options,
    total: room.questions.length
  };
  if (includeAnswer) {
    view.answerIndex = question.answerIndex;
    view.explanation = question.explanation;
  }
  return view;
}

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

/** What a player's phone is allowed to know right now. */
export function playerView(room, playerId) {
  const revealed = room.phase === 'reveal' || room.phase === 'finished';
  const question = questionView(room, { includeAnswer: revealed });
  const player = room.players.get(playerId) ?? null;
  const answers = question ? answersFor(room, question.id) : null;
  const myAnswer = answers?.get(playerId) ?? null;

  return {
    role: 'player',
    version: room.version,
    code: room.code,
    guestName: room.guestName,
    phase: room.phase,
    question,
    timing: timing(room),
    answeredCount: answeredCount(room),
    playerCount: room.players.size,
    me: player && {
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      score: player.score,
      streak: player.streak,
      rank: leaderboard(room).find((p) => p.id === player.id)?.rank ?? null
    },
    myAnswer: myAnswer && { choice: myAnswer.choice, correct: revealed ? myAnswer.correct : null, points: revealed ? myAnswer.points : null },
    leaderboard: revealed || room.phase === 'setup' ? leaderboard(room) : leaderboard(room).map(({ id, name, avatar, rank }) => ({ id, name, avatar, rank })),
    serverTime: Date.now()
  };
}

/** What the host's big screen sees: everything. */
export function hostView(room) {
  return {
    role: 'host',
    version: room.version,
    code: room.code,
    guestName: room.guestName,
    keywords: room.keywords,
    settings: room.settings,
    phase: room.phase,
    questions: room.questions,
    currentIndex: room.currentIndex,
    question: questionView(room, { includeAnswer: true }),
    timing: timing(room),
    answeredCount: answeredCount(room),
    playerCount: room.players.size,
    players: leaderboard(room),
    leaderboard: leaderboard(room),
    roundResults: room.phase === 'reveal' ? roundResults(room) : [],
    serverTime: Date.now()
  };
}
