/**
 * The whole app.
 *
 * One page that everyone opens. The person who starts the room is the host and
 * gets the extra buttons; otherwise every device runs the same code and shows
 * the same phase of the same game.
 */

import {
  $, api, escapeHtml, showError, clearNotice, startPolling, startCountdown,
  renderLeaderboard, ordinal, storage, GLYPHS
} from './common.js';

const SESSION_KEY = 'goh-trivia-session';

/**
 * Placeholders do real work here: "a hobby" produces a boring note, while
 * "something they always say" produces one worth writing a question about.
 */
const NOTE_HINTS = [
  'something they always say',
  'a story they retell every time',
  'an opinion they will defend forever',
  'what they do with a free Saturday',
  'something they are weirdly good at',
  'a habit everyone notices',
  'what they would never eat',
  'the thing they are always late for',
  'what is always in their bag'
];

const views = {
  landing: $('#view-landing'),
  topics: $('#view-topics'),
  lobby: $('#view-lobby'),
  building: $('#view-building'),
  ready: $('#view-ready'),
  question: $('#view-question'),
  reveal: $('#view-reveal'),
  finished: $('#view-finished')
};

let session = null;       // { code, playerId, token, hostToken }
let poller = null;
let stopCountdown = null;
let state = null;
let renderedKey = null;   // avoids redrawing (and stealing focus) on every poll
let pendingChoice = null;
let submittedTopics = false;
let busy = false;

function show(name) {
  for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
}

function setRoomLabel(code) {
  $('#room-code').textContent = code ?? '';
  $('#room-code-label').hidden = !code;
}

/* -------------------------------------------------------------- starting up */

const params = new URLSearchParams(location.search);
const codeFromUrl = (params.get('code') ?? location.hash.replace('#', '')).toUpperCase().slice(0, 4);
if (codeFromUrl) $('#join-code').value = codeFromUrl;

const saved = storage.get(SESSION_KEY);
if (saved?.code && saved?.playerId && saved?.token) {
  resume(saved);
} else {
  show('landing');
  if (codeFromUrl) $('#join-name').focus();
}

$('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearNotice($('#create-error'));
  const button = $('#create-button');
  button.disabled = true;
  button.textContent = 'Starting…';
  try {
    const result = await api('/api/rooms', {
      guestName: $('#guest-name').value.trim(),
      name: $('#host-name').value.trim(),
      settings: {
        topicsPerPlayer: Number($('#set-topics').value),
        questionCount: Number($('#set-count').value),
        questionSeconds: Number($('#set-seconds').value)
      }
    });
    resume({
      code: result.code, playerId: result.playerId, token: result.token, hostToken: result.hostToken
    });
  } catch (error) {
    showError($('#create-error'), error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Start a room';
  }
});

$('#join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearNotice($('#join-error'));
  const button = $('#join-button');
  const code = $('#join-code').value.trim().toUpperCase();
  button.disabled = true;
  button.textContent = 'Joining…';
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(code)}/join`, {
      name: $('#join-name').value.trim()
    });
    resume({ code, playerId: result.playerId, token: result.token });
  } catch (error) {
    showError($('#join-error'), error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Join';
  }
});

function resume(next) {
  session = next;
  storage.set(SESSION_KEY, session);
  setRoomLabel(session.code);
  poller?.stop();
  renderedKey = null;

  poller = startPolling({
    url: () => `/api/rooms/${encodeURIComponent(session.code)}/state`
      + `?playerId=${encodeURIComponent(session.playerId)}&token=${encodeURIComponent(session.token)}`,
    intervalFor: () => {
      if (!state) return 1200;
      if (state.phase === 'question' || state.phase === 'reveal') return 1000;
      if (state.phase === 'building') return 1500;
      return 2500;
    },
    onState: render,
    onError: (error) => {
      // A room that no longer exists (server restart, expiry) sends us home.
      if (/lost track|No room/i.test(error.message)) leaveRoom(error.message);
    }
  });
}

function leaveRoom(message) {
  poller?.stop();
  storage.clear(SESSION_KEY);
  session = null;
  state = null;
  setRoomLabel(null);
  show('landing');
  if (message) showError($('#join-error'), message);
}

/* ------------------------------------------------------------------ actions */

async function host(action, extra = {}) {
  if (!session?.hostToken || busy) return null;
  busy = true;
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(session.code)}/host`,
      { token: session.hostToken, action, ...extra });
    poller?.refreshNow();
    return result;
  } catch (error) {
    showError($('#lobby-error'), error.message);
    return null;
  } finally {
    busy = false;
  }
}

$('#build-button').addEventListener('click', async () => {
  const button = $('#build-button');
  button.disabled = true;
  button.textContent = 'Writing…';
  await host('build');
  button.disabled = false;
  button.textContent = 'Write the questions';
});

$('#start-button').addEventListener('click', () => host('start'));
$('#reopen-button').addEventListener('click', () => host('reopen'));
$('#skip-button').addEventListener('click', () => host('reveal'));
$('#next-button').addEventListener('click', () => host('next'));
$('#again-button').addEventListener('click', () => host('again'));
$('#fresh-button').addEventListener('click', () => host('reopen'));

$('#edit-topics').addEventListener('click', () => {
  submittedTopics = false;
  renderedKey = null;
  renderTopicsForm(state, { existing: true });
});

$('#copy-link').addEventListener('click', async () => {
  const link = `${location.origin}/?code=${session.code}`;
  try {
    await navigator.clipboard.writeText(link);
    $('#copy-done').textContent = 'Link copied.';
  } catch {
    $('#copy-done').textContent = link;
  }
  $('#copy-done').hidden = false;
});

$('#topics-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearNotice($('#topics-error'));
  const topics = [...$('#topic-inputs').querySelectorAll('input')]
    .map((input) => input.value.trim())
    .filter(Boolean);
  if (!topics.length) {
    return showError($('#topics-error'), `Add at least one thing about ${state.guestName}.`);
  }
  const button = $('#topics-button');
  button.disabled = true;
  try {
    await api(`/api/rooms/${encodeURIComponent(session.code)}/topics`, {
      playerId: session.playerId, token: session.token, topics
    });
    submittedTopics = true;
    renderedKey = null;
    poller?.refreshNow();
  } catch (error) {
    showError($('#topics-error'), error.message);
  } finally {
    button.disabled = false;
  }
});

async function answer(choice) {
  if (!state?.question || pendingChoice !== null) return;
  pendingChoice = choice;
  paintOptions(state, choice);
  $('#q-status').textContent = 'Locked in.';
  try {
    await api(`/api/rooms/${encodeURIComponent(session.code)}/answer`, {
      playerId: session.playerId, token: session.token,
      questionId: state.question.id, choice
    });
  } catch {
    // The server is the referee; the next poll shows what it decided.
  }
  poller?.refreshNow();
}

/* ------------------------------------------------------------------- render */

function render(next) {
  state = next;
  setRoomLabel(state.code);

  const mine = state.me?.topicCount > 0;
  if ((state.phase === 'lobby' || state.phase === 'ready') && !mine && !submittedTopics) {
    if (renderedKey !== 'topics-form') renderTopicsForm(state);
    return;
  }

  const key = `${state.phase}:${state.question?.id ?? ''}:${state.version}`;
  const phaseChanged = renderedKey?.split(':')[0] !== state.phase;
  if (phaseChanged) {
    stopCountdown?.();
    if (state.phase === 'question') pendingChoice = null;
  }

  switch (state.phase) {
    case 'lobby': renderLobby(state, phaseChanged); break;
    case 'building': renderBuilding(state); break;
    case 'ready': renderReady(state); break;
    case 'question': renderQuestion(state, phaseChanged || key !== renderedKey); break;
    case 'reveal': renderReveal(state); break;
    case 'finished': renderFinished(state); break;
    default: break;
  }
  renderedKey = key;
}

function renderTopicsForm(view, { existing = false } = {}) {
  show('topics');
  renderedKey = 'topics-form';
  const count = view.settings.topicsPerPlayer;
  $('#topics-title').textContent = `Tell us about ${view.guestName}`;
  $('#topics-hint').textContent = existing
    ? 'Rewriting your list replaces what you sent before.'
    : `Write ${count} things you know about ${view.guestName}. The more specific and `
      + 'ridiculous, the better the questions get. Small true details beat big vague ones.';

  const wrap = $('#topic-inputs');
  wrap.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const row = document.createElement('div');
    row.className = 'keyword-row';
    row.innerHTML = `<span class="num">${i + 1}</span>`;
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 80;
    input.placeholder = NOTE_HINTS[i % NOTE_HINTS.length];
    row.append(input);
    wrap.append(row);
  }
  $('#topics-button').textContent = existing ? 'Save my new list' : "That's my list";
}

function renderLobby(view, full) {
  show('lobby');
  $('#lobby-code').textContent = view.code;
  $('#lobby-count').textContent = `${view.players.length} ${view.players.length === 1 ? 'person' : 'people'}`;
  $('#lobby-players').innerHTML = view.players.map((player) => `
    <span class="chip ${player.topicCount ? 'done' : ''}">
      <span class="avatar">${escapeHtml(player.avatar)}</span>${escapeHtml(player.name)}
      ${player.topicCount ? '<span class="tick">✓</span>' : '<span class="muted">writing…</span>'}
    </span>`).join('');

  const waiting = view.players.filter((player) => !player.topicCount).length;
  $('#lobby-progress').textContent = waiting
    ? `${view.topicCount} notes in. Still waiting on ${waiting} ${waiting === 1 ? 'person' : 'people'}.`
    : `${view.topicCount} notes in from everyone.`;

  $('#host-controls').hidden = !view.isHost;
  $('#waiting-for-host').hidden = view.isHost;
  if (view.isHost) {
    const enough = view.topicCount >= 6;
    $('#build-button').disabled = !enough;
    $('#build-hint').textContent = enough
      ? `Writes ${view.settings.questionCount} questions from everyone's notes. Takes a few seconds.`
      : `Need at least 6 notes about ${view.guestName} — ${view.topicCount} so far.`;
  }
  if (full) clearNotice($('#lobby-error'));
}

function renderBuilding(view) {
  show('building');
  $('#building-title').textContent = `Writing questions about ${view.guestName}…`;
  $('#building-line').textContent =
    `Turning ${view.topicCount} notes into ${view.settings.questionCount} questions. This takes a few seconds.`;
}

function renderReady(view) {
  show('ready');
  $('#ready-title').textContent = `${view.questionsReady} questions ready`;
  $('#ready-note').textContent = view.notice
    ?? (view.writtenBy === 'claude'
      ? `Written from everything the room knows about ${view.guestName}.`
      : `Built from the room's notes about ${view.guestName}.`);
  $('#ready-host').hidden = !view.isHost;
  $('#ready-wait').hidden = view.isHost;
  renderLeaderboard($('#ready-board'), view.players, { meId: view.me?.id });
}

function paintOptions(view, choice) {
  const question = view.question;
  const locked = choice !== null && choice !== undefined;
  $('#q-options').innerHTML = question.options.map((option, index) => `
    <button class="option ${question.youSitOut ? '' : 'tappable'}
                 ${locked && index !== choice ? 'dimmed' : ''}
                 ${index === choice ? 'chosen' : ''}"
            data-index="${index}" ${locked || question.youSitOut ? 'disabled' : ''}>
      <span class="glyph">${GLYPHS[index % GLYPHS.length]}</span>
      <span>${escapeHtml(option)}</span>
    </button>`).join('');
  if (!locked && !question.youSitOut) {
    for (const button of $('#q-options').querySelectorAll('button')) {
      button.addEventListener('click', () => answer(Number(button.dataset.index)));
    }
  }
}

function renderQuestion(view, redraw) {
  show('question');
  const question = view.question;
  if (!question) return;

  $('#q-counter').textContent = `Question ${question.index + 1} of ${question.total}`;
  $('#q-answered').textContent = `${view.answeredCount} of ${view.eligibleCount} in`;

  const myChoice = view.myAnswer ? view.myAnswer.choice : pendingChoice;
  if (redraw) {
    $('#q-prompt').textContent = question.prompt;
    paintOptions(view, myChoice);
  }

  $('#q-status').textContent = question.youSitOut
    ? '🤫 This one came from your notes — sit tight.'
    : (myChoice !== null && myChoice !== undefined
      ? 'Locked in.'
      : 'Tap your answer. Faster answers score more.');

  $('#skip-button').hidden = !view.isHost;
  stopCountdown?.();
  stopCountdown = startCountdown({
    fillNode: $('#q-fill'), labelNode: $('#q-timer'), timing: view.timing, now: poller.clock.now
  });
}

function renderReveal(view) {
  show('reveal');
  const question = view.question;
  const mine = view.myAnswer;
  const correct = question?.options?.[question.answerIndex] ?? '';

  if (question?.youSitOut) {
    $('#reveal-emoji').textContent = '🤫';
    $('#reveal-headline').textContent = 'That one was yours';
  } else if (!mine) {
    $('#reveal-emoji').textContent = '😴';
    $('#reveal-headline').textContent = 'No answer that time';
  } else if (mine.correct) {
    $('#reveal-emoji').textContent = '🎉';
    $('#reveal-headline').textContent = 'Correct!';
  } else {
    $('#reveal-emoji').textContent = '💀';
    $('#reveal-headline').textContent = 'Not this time';
  }

  $('#reveal-answer').innerHTML = `The answer was <b>${escapeHtml(correct)}</b>.`;
  const credit = question?.contributors?.length
    ? ` ${question.contributors.map(escapeHtml).join(' and ')} wrote that one down.`
    : '';
  $('#reveal-because').innerHTML = escapeHtml(question?.explanation ?? '') + credit;

  renderLeaderboard($('#reveal-board'), view.players, { meId: view.me?.id });
  $('#next-button').hidden = !view.isHost;
  $('#next-button').textContent =
    question && question.index + 1 >= question.total ? 'See the winner' : 'Next question';
}

function renderFinished(view) {
  show('finished');
  const [first, second, third] = view.players;
  $('#winner-line').innerHTML = first
    ? `🏆 ${escapeHtml(first.avatar)} ${escapeHtml(first.name)} knows ${escapeHtml(view.guestName)} best`
    : 'Game over';

  const pillar = (player, className) => player ? `
    <div class="pillar ${className}">
      <div class="avatar">${escapeHtml(player.avatar)}</div>
      <div class="name">${escapeHtml(player.name)}</div>
      <div class="score">${player.score.toLocaleString()}</div>
    </div>` : '';
  $('#podium').innerHTML = pillar(second, 'second') + pillar(first, 'first') + pillar(third, 'third');

  const me = view.players.find((player) => player.id === view.me?.id);
  $('#final-detail').textContent = me ? `You finished ${ordinal(me.rank)}.` : '';
  renderLeaderboard($('#final-board'), view.players, { meId: view.me?.id });
  $('#again-button').hidden = !view.isHost;
  $('#fresh-button').hidden = !view.isHost;
}
