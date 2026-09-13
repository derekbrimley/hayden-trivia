import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRoom, buildDeck, joinRoom, startGame, submitAnswer, revealAnswer, nextQuestion,
  backToLobby, leaderboard, playerView, hostView, everyoneAnswered, rerollQuestion,
  updateQuestion, addCustomQuestion, removeQuestion, moveQuestion, makeRoomCode, authPlayer
} from '../src/game.js';

const KEYWORDS = ['rock climbing', 'hates cilantro', 'grew up in Idaho', 'golden retriever',
  'Taylor Swift', 'flannel shirts', 'Dr Pepper', 'The Office', 'juggling', 'camping',
  'awake at 5am', 'board games'];

function newGame({ count = 3, players = ['Derek', 'Sam'] } = {}) {
  const room = createRoom({ guestName: 'Hayden', keywords: KEYWORDS, seed: 42 });
  buildDeck(room, { count });
  const joined = players.map((name) => joinRoom(room, { name }));
  return { room, players: joined };
}

test('room codes are four readable characters and avoid collisions', () => {
  const existing = new Set();
  for (let i = 0; i < 200; i++) {
    const code = makeRoomCode(existing);
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}$/);
    assert.ok(!existing.has(code));
    existing.add(code);
  }
});

test('players get distinct names and avatars', () => {
  const { room } = newGame({ players: ['Sam', 'Sam', 'Sam'] });
  const names = [...room.players.values()].map((player) => player.name);
  assert.deepEqual(names, ['Sam', 'Sam 2', 'Sam 3']);
  const avatars = new Set([...room.players.values()].map((player) => player.avatar));
  assert.equal(avatars.size, 3);
});

test('a game cannot start without questions or without players', () => {
  const empty = createRoom({ guestName: 'Hayden', keywords: KEYWORDS });
  joinRoom(empty, { name: 'Derek' });
  assert.throws(() => startGame(empty), /questions/i);

  const noPlayers = createRoom({ guestName: 'Hayden', keywords: KEYWORDS });
  buildDeck(noPlayers, { count: 3 });
  assert.throws(() => startGame(noPlayers), /joined/i);
});

test('a correct answer scores more the faster it lands', () => {
  const fast = newGame({ players: ['Fast'] });
  startGame(fast.room, 1000);
  submitAnswer(fast.room, fast.players[0].id,
    { questionId: fast.room.questions[0].id, choice: fast.room.questions[0].answerIndex }, 1500);
  revealAnswer(fast.room, 2000);

  const slow = newGame({ players: ['Slow'] });
  startGame(slow.room, 1000);
  submitAnswer(slow.room, slow.players[0].id,
    { questionId: slow.room.questions[0].id, choice: slow.room.questions[0].answerIndex }, 21000);
  revealAnswer(slow.room, 22000);

  const fastScore = leaderboard(fast.room)[0].score;
  const slowScore = leaderboard(slow.room)[0].score;
  assert.ok(fastScore > slowScore, `${fastScore} should beat ${slowScore}`);
  assert.ok(slowScore >= 600, 'a slow correct answer still earns the base points');
});

test('a wrong answer scores nothing and breaks the streak', () => {
  const { room, players } = newGame();
  startGame(room, 0);
  const first = room.questions[0];
  submitAnswer(room, players[0].id, { questionId: first.id, choice: first.answerIndex }, 100);
  submitAnswer(room, players[1].id, { questionId: first.id, choice: (first.answerIndex + 1) % 4 }, 100);
  revealAnswer(room, 200);

  const board = leaderboard(room);
  assert.equal(board[0].name, 'Derek');
  assert.ok(board[0].score > 0);
  assert.equal(board[1].score, 0);
  assert.equal(room.players.get(players[1].id).streak, 0);
});

test('a streak adds a growing bonus', () => {
  const { room, players } = newGame({ count: 3, players: ['Streak'] });
  startGame(room, 0);
  const scores = [];
  for (let i = 0; i < 3; i++) {
    const question = room.questions[i];
    submitAnswer(room, players[0].id, { questionId: question.id, choice: question.answerIndex }, 100);
    revealAnswer(room, 200);
    scores.push(leaderboard(room)[0].score);
    nextQuestion(room, 300);
  }
  const gains = [scores[0], scores[1] - scores[0], scores[2] - scores[1]];
  assert.ok(gains[1] > gains[0], 'the second correct answer should out-earn the first');
  assert.ok(gains[2] > gains[1], 'the third should out-earn the second');
});

test('answers are refused when they are late, duplicated, or out of range', () => {
  const { room, players } = newGame();
  const question = room.questions[0];
  assert.equal(submitAnswer(room, players[0].id, { questionId: question.id, choice: 0 }).reason, 'not-accepting');

  startGame(room, 0);
  assert.equal(submitAnswer(room, players[0].id, { questionId: 'nope', choice: 0 }).reason, 'stale-question');
  assert.equal(submitAnswer(room, players[0].id, { questionId: question.id, choice: 9 }).reason, 'bad-choice');
  assert.equal(submitAnswer(room, players[0].id, { questionId: question.id, choice: 0 }).ok, true);
  assert.equal(submitAnswer(room, players[0].id, { questionId: question.id, choice: 1 }).reason, 'already-answered');
});

test('revealing twice does not double-score', () => {
  const { room, players } = newGame();
  startGame(room, 0);
  const question = room.questions[0];
  submitAnswer(room, players[0].id, { questionId: question.id, choice: question.answerIndex }, 100);
  revealAnswer(room, 200);
  const once = leaderboard(room)[0].score;
  revealAnswer(room, 300);
  assert.equal(leaderboard(room)[0].score, once);
});

test('the game ends after the last question', () => {
  const { room, players } = newGame({ count: 2 });
  startGame(room, 0);
  for (let i = 0; i < 2; i++) {
    revealAnswer(room, 100);
    nextQuestion(room, 200);
  }
  assert.equal(room.phase, 'finished');
  assert.ok(players.length > 0);
});

test('everyoneAnswered notices when the room is done', () => {
  const { room, players } = newGame();
  startGame(room, 0);
  const question = room.questions[0];
  submitAnswer(room, players[0].id, { questionId: question.id, choice: 0 }, 10);
  assert.equal(everyoneAnswered(room), false);
  submitAnswer(room, players[1].id, { questionId: question.id, choice: 1 }, 20);
  assert.equal(everyoneAnswered(room), true);
});

test("a player's view never leaks the answer before the reveal", () => {
  const { room, players } = newGame();
  startGame(room, 0);
  const view = playerView(room, players[0].id);
  assert.equal(view.question.answerIndex, undefined);
  assert.equal(view.question.explanation, undefined);
  assert.equal(view.leaderboard[0].score, undefined, 'mid-question scores stay hidden');

  revealAnswer(room, 100);
  const revealed = playerView(room, players[0].id);
  assert.equal(revealed.question.answerIndex, room.questions[0].answerIndex);
  assert.ok(typeof revealed.leaderboard[0].score === 'number');
});

test('the host view keeps the answers', () => {
  const { room } = newGame();
  startGame(room, 0);
  const view = hostView(room);
  assert.equal(view.question.answerIndex, room.questions[0].answerIndex);
  assert.equal(view.questions.length, 3);
});

test('playing again resets scores but keeps the deck and the players', () => {
  const { room, players } = newGame();
  startGame(room, 0);
  const question = room.questions[0];
  submitAnswer(room, players[0].id, { questionId: question.id, choice: question.answerIndex }, 100);
  revealAnswer(room, 200);
  assert.ok(leaderboard(room)[0].score > 0);

  backToLobby(room);
  assert.equal(room.phase, 'setup');
  assert.equal(room.questions.length, 3);
  assert.equal(room.players.size, 2);
  assert.equal(leaderboard(room)[0].score, 0);
});

test('the host can reroll, edit, add, move and remove questions', () => {
  const { room } = newGame({ count: 3 });
  const original = { ...room.questions[0] };
  const rerolled = rerollQuestion(room, original.id, 12345);
  assert.equal(rerolled.id, original.id);
  assert.notDeepEqual(rerolled.options, original.options);

  updateQuestion(room, original.id, { prompt: 'Custom prompt?', options: ['a', 'b', 'c'], answerIndex: 2 });
  assert.equal(room.questions[0].prompt, 'Custom prompt?');
  assert.equal(room.questions[0].answerIndex, 2);

  // An answer index past the end of the option list is clamped, never left dangling.
  updateQuestion(room, original.id, { answerIndex: 99 });
  assert.equal(room.questions[0].answerIndex, 2);

  const custom = addCustomQuestion(room, { prompt: 'Mine?', options: ['x', 'y'], answerIndex: 1 });
  assert.equal(room.questions.at(-1).id, custom.id);

  moveQuestion(room, custom.id, 'up');
  assert.equal(room.questions[2].id, custom.id);
  assert.deepEqual(room.questions.map((question) => question.index), [0, 1, 2, 3]);

  removeQuestion(room, custom.id);
  assert.equal(room.questions.length, 3);
  assert.deepEqual(room.questions.map((question) => question.index), [0, 1, 2]);
});

test('a custom question needs a prompt and at least two options', () => {
  const { room } = newGame();
  assert.throws(() => addCustomQuestion(room, { prompt: '', options: ['a', 'b'] }), /prompt/i);
  assert.throws(() => addCustomQuestion(room, { prompt: 'Hi?', options: ['only one'] }), /options/i);
});

test('a player token is required to act as that player', () => {
  const { room, players } = newGame();
  assert.ok(authPlayer(room, players[0].id, players[0].token));
  assert.equal(authPlayer(room, players[0].id, 'wrong-token'), null);
  assert.equal(authPlayer(room, 'nobody', players[0].token), null);
});
