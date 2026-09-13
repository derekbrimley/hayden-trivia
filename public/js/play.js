/** Player screen: join a room, answer on your phone, watch your score. */

import {
  $, api, escapeHtml, showError, clearNotice, connect, startCountdown,
  renderLeaderboard, storage, GLYPHS
} from './common.js';

const views = {
  join: $('#view-join'),
  lobby: $('#view-lobby'),
  question: $('#view-question'),
  reveal: $('#view-reveal'),
  finished: $('#view-finished')
};

let session = null;      // { code, playerId, token }
let stream = null;
let stopCountdown = null;
let answeredQuestionId = null;
let pendingChoice = null;

function show(name) {
  for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
}

function setRoomLabel(code) {
  $('#room-code').textContent = code ?? '';
  $('#room-code-label').hidden = !code;
}

/* ------------------------------------------------------------------- join */

const params = new URLSearchParams(location.search);
const prefillCode = (params.get('code') ?? location.hash.replace('#', '')).toUpperCase().slice(0, 4);
if (prefillCode) $('#join-code').value = prefillCode;

const saved = storage.get('trivia-session');
if (saved?.code && saved?.playerId && saved?.token) {
  // Reconnect after a refresh or a phone screen lock.
  startSession(saved, { silent: true });
}

$('#join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearNotice($('#join-error'));
  const button = $('#join-button');
  const code = $('#join-code').value.trim().toUpperCase();
  const name = $('#join-name').value.trim();
  if (!code || !name) return;

  button.disabled = true;
  button.textContent = 'Joining…';
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(code)}/join`, { name });
    startSession({ code, playerId: result.playerId, token: result.token });
  } catch (error) {
    showError($('#join-error'), error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Let me in';
  }
});

function startSession(next, { silent = false } = {}) {
  session = next;
  storage.set('trivia-session', session);
  setRoomLabel(session.code);
  const url = `/api/rooms/${encodeURIComponent(session.code)}/stream`
    + `?role=player&playerId=${encodeURIComponent(session.playerId)}&token=${encodeURIComponent(session.token)}`;
  stream?.close?.();
  stream = connect(url, {
    onState: render,
    onClosed: (data) => {
      storage.clear('trivia-session');
      session = null;
      show('join');
      showError($('#join-error'), data.reason ?? 'The game ended.');
    }
  });
  // A stale saved session (server restarted, room expired) fails the stream;
  // fall back to the join form rather than leaving the player staring at a spinner.
  if (silent) {
    setTimeout(() => {
      if (views.join.hidden === false) storage.clear('trivia-session');
    }, 4000);
  }
}

/* ----------------------------------------------------------------- render */

function render(state) {
  setRoomLabel(state.code);
  stopCountdown?.();

  if (state.me) {
    $('#me-avatar').textContent = state.me.avatar;
    $('#me-name').textContent = state.me.name;
  }

  if (state.phase === 'setup') {
    show('lobby');
    $('#lobby-status').textContent = 'Waiting for the host to start…';
    $('#lobby-guest').textContent = `Tonight's guest of honor: ${state.guestName}`;
    renderLeaderboard($('#lobby-board'), state.leaderboard, { meId: state.me?.id });
    return;
  }

  if (state.phase === 'question') return renderQuestion(state);
  if (state.phase === 'reveal') return renderReveal(state);
  if (state.phase === 'finished') return renderFinished(state);
}

function renderQuestion(state) {
  const question = state.question;
  if (!question) return;
  show('question');

  if (answeredQuestionId !== question.id) pendingChoice = null;

  $('#q-counter').textContent = `Question ${question.index + 1} of ${question.total}`;
  $('#q-prompt').textContent = question.prompt;

  const myChoice = state.myAnswer ? state.myAnswer.choice : pendingChoice;
  const locked = myChoice !== null && myChoice !== undefined;

  $('#q-options').innerHTML = question.options.map((option, index) => `
    <button class="option tappable ${locked && index !== myChoice ? 'dimmed' : ''} ${index === myChoice ? 'chosen' : ''}"
            data-index="${index}" ${locked ? 'disabled' : ''}>
      <span class="glyph">${GLYPHS[index % GLYPHS.length]}</span>
      <span>${escapeHtml(option)}</span>
    </button>`).join('');

  for (const button of $('#q-options').querySelectorAll('button')) {
    button.addEventListener('click', () => answer(state, Number(button.dataset.index)));
  }

  $('#q-status').textContent = locked
    ? 'Locked in. Eyes on the big screen.'
    : 'Tap your answer — faster answers score more.';

  stopCountdown = startCountdown({
    fillNode: $('#q-fill'),
    labelNode: $('#q-timer'),
    timing: state.timing,
    now: stream.now
  });
}

async function answer(state, choice) {
  if (!session || !state.question) return;
  pendingChoice = choice;
  answeredQuestionId = state.question.id;
  // Optimistic: lock the buttons immediately so a double tap can't register twice.
  renderQuestion({ ...state, myAnswer: { choice } });
  try {
    await api(`/api/rooms/${encodeURIComponent(session.code)}/answer`, {
      playerId: session.playerId,
      token: session.token,
      questionId: state.question.id,
      choice
    });
  } catch {
    // The server is the referee: if it rejected the answer the next state push
    // will simply show the question as unanswered again.
  }
}

function renderReveal(state) {
  show('reveal');
  const question = state.question;
  const mine = state.myAnswer;
  const correctText = question?.options?.[question.answerIndex] ?? '';

  if (!mine) {
    $('#reveal-emoji').textContent = '😴';
    $('#reveal-headline').textContent = 'No answer that time';
  } else if (mine.correct) {
    $('#reveal-emoji').textContent = '🎉';
    $('#reveal-headline').textContent = `Correct! +${mine.points}`;
  } else {
    $('#reveal-emoji').textContent = '💀';
    $('#reveal-headline').textContent = 'Not this time';
  }

  $('#reveal-detail').innerHTML = `The answer was <b>${escapeHtml(correctText)}</b>.`
    + (state.me ? `<br />You're in ${ordinal(state.me.rank)} with ${state.me.score.toLocaleString()} points.` : '');

  renderLeaderboard($('#reveal-board'), state.leaderboard, { meId: state.me?.id });
}

function renderFinished(state) {
  show('finished');
  const me = state.leaderboard?.find((player) => player.id === state.me?.id);
  $('#final-headline').textContent = me?.rank === 1 ? '🏆 You won!' : "That's a wrap!";
  $('#final-detail').textContent = me
    ? `${ordinal(me.rank)} place · ${me.score.toLocaleString()} points`
    : '';
  renderLeaderboard($('#final-board'), state.leaderboard, { meId: state.me?.id });
}

function ordinal(n) {
  if (!n) return '—';
  const suffix = ['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] ?? ['th', 'st', 'nd', 'rd'][n % 100] ?? 'th';
  return `${n}${suffix}`;
}
