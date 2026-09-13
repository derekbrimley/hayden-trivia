import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRoom, makeRoomCode, makePlayer, makeTopics, cleanTopics, canBuild, startGame,
  acceptAnswer, scoreRound, roundPoints, revealRound, advance, resetToReady, resetScores,
  leaderboard, viewFor, sitsOut, currentQuestion, DEFAULT_SETTINGS
} from '../src/game.js';

function question(overrides = {}) {
  return {
    id: 'q1',
    index: 0,
    prompt: 'It is 11pm on a Tuesday. What is Hayden doing?',
    options: ['Asleep since nine', 'Reorganising the garage', 'Halfway up a climbing wall', 'Watching the news'],
    answerIndex: 2,
    explanation: 'Climbing, obviously.',
    topicIds: ['t1'],
    contributorIds: [],
    ...overrides
  };
}

function setup({ players = ['Derek', 'Sam', 'Priya'], questions = [question()], settings = {} } = {}) {
  const room = createRoom({ code: 'ABCD', guestName: 'Hayden', settings });
  room.questions = questions;
  const list = [];
  for (const name of players) list.push(makePlayer(list, { name, isHost: list.length === 0 }));
  room.hostPlayerId = list[0]?.id ?? null;
  return { room, players: list, topics: [], answers: {} };
}

test('room codes read cleanly out loud', () => {
  for (let i = 0; i < 300; i++) assert.match(makeRoomCode(), /^[A-HJ-NP-Z2-9]{4}$/);
});

test('players get distinct names and avatars', () => {
  const list = [];
  for (const name of ['Sam', 'Sam', 'Sam']) list.push(makePlayer(list, { name }));
  assert.deepEqual(list.map((player) => player.name), ['Sam', 'Sam 2', 'Sam 3']);
  assert.equal(new Set(list.map((player) => player.avatar)).size, 3);
});

test('notes are trimmed, capped and de-duplicated', () => {
  assert.deepEqual(cleanTopics(['  climbs  ', 'climbs', '', null, 'CLIMBS', 'bakes']), ['climbs', 'bakes']);
  assert.equal(cleanTopics(['x'.repeat(200)])[0].length, 80);
});

test('notes remember who wrote them', () => {
  const topics = makeTopics('player-1', ['climbs', 'bakes']);
  assert.equal(topics.length, 2);
  assert.ok(topics.every((topic) => topic.playerId === 'player-1'));
  assert.equal(new Set(topics.map((topic) => topic.id)).size, 2);
});

test('a game cannot be built from too few notes', () => {
  const state = setup();
  assert.equal(canBuild({ ...state, topics: [] }).ok, false);
  assert.match(canBuild({ ...state, topics: [] }).reason, /more thing/i);
  const topics = makeTopics('p1', ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(canBuild({ ...state, topics }).ok, true);
});

test('whoever wrote the note sits the question out', () => {
  const state = setup({ questions: [question({ contributorIds: ['author'] })] });
  assert.equal(sitsOut(currentQuestion({ ...state.room, currentIndex: 0 }), 'author'), true);
  assert.equal(sitsOut(currentQuestion({ ...state.room, currentIndex: 0 }), 'someone-else'), false);
});

test('a sitting-out player cannot answer their own question', () => {
  const state = setup();
  state.room.questions = [question({ contributorIds: [state.players[0].id] })];
  startGame(state.room, 1000);
  const result = acceptAnswer({
    room: state.room, player: state.players[0], questionId: 'q1', choice: 2, existingAnswer: null
  }, 1100);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'your-question');
});

test('answers are refused when late, repeated, stale or out of range', () => {
  const state = setup();
  const player = state.players[1];
  const base = { room: state.room, player, questionId: 'q1', existingAnswer: null };

  assert.equal(acceptAnswer({ ...base, choice: 0 }).reason, 'not-accepting');
  startGame(state.room, 1000);
  assert.equal(acceptAnswer({ ...base, questionId: 'nope', choice: 0 }, 1100).reason, 'stale-question');
  assert.equal(acceptAnswer({ ...base, choice: 9 }, 1100).reason, 'bad-choice');
  assert.equal(acceptAnswer({ ...base, choice: 2, existingAnswer: { choice: 1 } }, 1100).reason, 'already-answered');

  const late = 1000 + DEFAULT_SETTINGS.questionSeconds * 1000 + DEFAULT_SETTINGS.graceMs + 1;
  assert.equal(acceptAnswer({ ...base, choice: 2 }, late).reason, 'too-late');
  // Just inside the grace window still counts — phones are slow.
  const justInTime = 1000 + DEFAULT_SETTINGS.questionSeconds * 1000 + 100;
  assert.equal(acceptAnswer({ ...base, choice: 2 }, justInTime).ok, true);
});

test('a correct answer scores more the faster it lands', () => {
  const state = setup();
  startGame(state.room, 0);
  const quick = scoreRound({
    ...state, answers: { [state.players[0].id]: { choice: 2, correct: true, elapsedMs: 500 } }
  })[0].score;
  const slow = scoreRound({
    ...state, answers: { [state.players[0].id]: { choice: 2, correct: true, elapsedMs: 24000 } }
  })[0].score;
  assert.ok(quick > slow, `${quick} should beat ${slow}`);
  assert.ok(slow >= DEFAULT_SETTINGS.basePoints);
});

test('a wrong answer scores nothing and resets the streak', () => {
  const state = setup();
  state.players[1].streak = 3;
  startGame(state.room, 0);
  const scored = scoreRound({
    ...state, answers: { [state.players[1].id]: { choice: 0, correct: false, elapsedMs: 900 } }
  });
  const player = scored.find((candidate) => candidate.id === state.players[1].id);
  assert.equal(player.score, 0);
  assert.equal(player.streak, 0);
});

test('a streak pays more each round, up to a cap', () => {
  const state = setup();
  startGame(state.room, 0);
  const gains = [];
  let players = state.players;
  for (let i = 0; i < 6; i++) {
    const answers = { [players[0].id]: { choice: 2, correct: true, elapsedMs: 0 } };
    const before = players[0].score;
    players = scoreRound({ ...state, players, answers });
    gains.push(players[0].score - before);
  }
  assert.ok(gains[1] > gains[0]);
  assert.ok(gains[2] > gains[1]);
  assert.equal(gains.at(-1) - gains[0], DEFAULT_SETTINGS.maxStreakBonus, 'the bonus stops growing');
});

test('sitting out neither scores nor breaks a streak', () => {
  const state = setup({ questions: [question({ contributorIds: ['author'] })] });
  state.players[0] = { ...state.players[0], id: 'author', streak: 2, score: 900 };
  startGame(state.room, 0);
  const scored = scoreRound({ ...state, answers: {} });
  const author = scored.find((player) => player.id === 'author');
  assert.equal(author.score, 900);
  assert.equal(author.streak, 2);
});

test('roundPoints reports what each player just earned', () => {
  const state = setup();
  startGame(state.room, 0);
  const answers = {
    [state.players[0].id]: { choice: 2, correct: true, elapsedMs: 0 },
    [state.players[1].id]: { choice: 0, correct: false, elapsedMs: 0 }
  };
  const points = roundPoints({ ...state, answers });
  assert.ok(points.get(state.players[0].id) > 0);
  assert.equal(points.get(state.players[1].id), 0);
});

test('the game ends after the last question', () => {
  const state = setup({ questions: [question(), question({ id: 'q2', index: 1 })] });
  startGame(state.room, 0);
  revealRound(state.room, 10);
  advance(state.room, 20);
  assert.equal(state.room.phase, 'question');
  assert.equal(state.room.currentIndex, 1);
  revealRound(state.room, 30);
  advance(state.room, 40);
  assert.equal(state.room.phase, 'finished');
});

test('playing again keeps the deck and clears the scores', () => {
  const state = setup();
  startGame(state.room, 0);
  const players = resetScores(scoreRound({
    ...state, answers: { [state.players[0].id]: { choice: 2, correct: true, elapsedMs: 0 } }
  }));
  resetToReady(state.room);
  assert.equal(state.room.phase, 'ready');
  assert.equal(state.room.currentIndex, -1);
  assert.ok(players.every((player) => player.score === 0 && player.streak === 0));
});

test('a player view hides the answer until the reveal', () => {
  const state = setup();
  startGame(state.room, 0);
  const during = viewFor(state, state.players[1].id);
  assert.equal(during.question.answerIndex, undefined);
  assert.equal(during.question.explanation, undefined);
  assert.equal(during.players[0].score, undefined, 'live scores stay hidden mid-question');

  revealRound(state.room, 100);
  const after = viewFor(state, state.players[1].id);
  assert.equal(after.question.answerIndex, 2);
  assert.equal(typeof after.players[0].score, 'number');
});

test('no view ever contains the raw notes', () => {
  const state = setup();
  state.topics = makeTopics(state.players[0].id, ['secretly loves karaoke']);
  const serialized = JSON.stringify(viewFor(state, state.players[1].id));
  assert.ok(!serialized.includes('karaoke'), 'notes must never be sent to other players');
  assert.equal(JSON.parse(serialized).topicCount, 1, 'but the count is fine to show');
});

test('the reveal credits whoever wrote the note', () => {
  const state = setup();
  state.room.questions = [question({ contributorIds: [state.players[0].id] })];
  startGame(state.room, 0);
  revealRound(state.room, 10);
  const view = viewFor(state, state.players[1].id);
  assert.deepEqual(view.question.contributors, [state.players[0].name]);
  assert.equal(viewFor(state, state.players[0].id).question.youSitOut, true);
});

test('the leaderboard ranks by score then name', () => {
  const players = [
    { id: 'a', name: 'Zoe', avatar: '🦊', score: 10, streak: 0, correctCount: 1 },
    { id: 'b', name: 'Amy', avatar: '🐙', score: 10, streak: 0, correctCount: 1 },
    { id: 'c', name: 'Max', avatar: '🐢', score: 99, streak: 1, correctCount: 2 }
  ];
  assert.deepEqual(leaderboard(players).map((player) => player.name), ['Max', 'Amy', 'Zoe']);
  assert.deepEqual(leaderboard(players).map((player) => player.rank), [1, 2, 3]);
});
