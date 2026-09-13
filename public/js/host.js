/** Host screen: build the deck, run the room, drive the big screen. */

import {
  $, api, escapeHtml, showError, showOk, clearNotice, connect, startCountdown,
  renderLeaderboard, storage, GLYPHS
} from './common.js';

const KEYWORD_SLOTS = 12;
const OPTION_COLORS = ['var(--opt-0)', 'var(--opt-1)', 'var(--opt-2)', 'var(--opt-3)'];

const EXAMPLE = {
  name: 'Hayden',
  keywords: ['rock climbing', 'hates cilantro', 'grew up in Idaho', 'golden retriever named Moose',
    'knows every Taylor Swift lyric', 'wears the same flannel constantly', 'Dr Pepper with breakfast',
    'quotes The Office daily', 'can juggle', 'camping in the rain', 'awake at 5am', 'terrible at board games']
};

const views = {
  setup: $('#view-setup'),
  deck: $('#view-deck'),
  question: $('#view-question'),
  reveal: $('#view-reveal'),
  finished: $('#view-finished')
};

let room = null;          // { code, token }
let stream = null;
let stopCountdown = null;
let latest = null;
let editingDeck = false;  // don't redraw the deck under the host's cursor

function show(name) {
  for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
}

/* ------------------------------------------------------------------ setup */

const KEYWORD_HINTS = ['a hobby', 'a food they refuse to eat', 'where they grew up', 'their pet',
  'music they love', 'what they always wear', 'their drink order', 'a show they quote',
  'a hidden talent', 'their happy place', 'a daily habit', 'something they are terrible at'];

const grid = $('#keyword-grid');
function addKeywordRow(value = '') {
  const index = grid.children.length + 1;
  const row = document.createElement('div');
  row.className = 'keyword-row';
  row.innerHTML = `<span class="num">${index}</span>`;
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 60;
  input.placeholder = KEYWORD_HINTS[(index - 1) % KEYWORD_HINTS.length];
  input.value = value;
  input.addEventListener('input', updateKeywordCount);
  row.append(input);
  grid.append(row);
}

function keywordInputs() {
  return [...grid.querySelectorAll('input')];
}

function updateKeywordCount() {
  const filled = keywordInputs().filter((input) => input.value.trim()).length;
  $('#keyword-count').textContent = `${filled} filled`;
}

for (let i = 0; i < KEYWORD_SLOTS; i++) addKeywordRow();
updateKeywordCount();

$('#add-keyword').addEventListener('click', () => { addKeywordRow(); updateKeywordCount(); });

$('#load-example').addEventListener('click', () => {
  $('#guest-name').value = EXAMPLE.name;
  const inputs = keywordInputs();
  EXAMPLE.keywords.forEach((keyword, index) => {
    if (!inputs[index]) addKeywordRow();
  });
  keywordInputs().forEach((input, index) => { input.value = EXAMPLE.keywords[index] ?? ''; });
  updateKeywordCount();
});

$('#setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearNotice($('#setup-error'));
  const keywords = keywordInputs().map((input) => input.value.trim()).filter(Boolean);
  if (keywords.length < 3) {
    return showError($('#setup-error'), 'Give me at least 3 keywords — 12 makes the best game.');
  }
  const button = $('#create-button');
  button.disabled = true;
  button.textContent = 'Building…';
  try {
    const result = await api('/api/rooms', {
      guestName: $('#guest-name').value.trim(),
      keywords,
      settings: {
        questionCount: Number($('#question-count').value),
        questionSeconds: Number($('#question-seconds').value),
        revealSeconds: Number($('#reveal-seconds').value)
      }
    });
    room = { code: result.code, token: result.hostToken };
    storage.set('trivia-host', room);
    openRoom();
  } catch (error) {
    showError($('#setup-error'), error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Build the game';
  }
});

// Reopening the host screen (refresh, second tab) resumes the room it created.
const savedHost = storage.get('trivia-host');
if (savedHost?.code && savedHost?.token) {
  room = savedHost;
  openRoom();
}

function openRoom() {
  $('#room-code').textContent = room.code;
  $('#room-code-label').hidden = false;
  $('#lobby-code').textContent = room.code;

  const joinUrl = `${location.origin}/?code=${room.code}`;
  $('#join-url').textContent = joinUrl.replace(/^https?:\/\//, '');
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    $('#join-url-note').textContent =
      'Phones need your computer\'s network address, not localhost — the server printed it in the terminal.';
    $('#join-url-note').hidden = false;
  }

  const qrBox = $('#qr-box');
  const image = new Image();
  image.alt = 'Scan to join';
  image.addEventListener('load', () => { qrBox.replaceChildren(image); qrBox.hidden = false; });
  image.addEventListener('error', () => { qrBox.hidden = true; });
  image.src = `/api/rooms/${room.code}/qr?url=${encodeURIComponent(joinUrl)}`;

  fetch('/api/health').then((r) => r.json()).then((health) => {
    $('#claude-write').hidden = !health.claude;
  }).catch(() => {});

  stream?.close?.();
  stream = connect(`/api/rooms/${room.code}/stream?role=host&token=${encodeURIComponent(room.token)}`, {
    onState: render,
    onClosed: () => {
      storage.clear('trivia-host');
      location.reload();
    }
  });

  // A stale room (server restarted) never sends state; drop back to setup.
  setTimeout(() => {
    if (!latest) {
      storage.clear('trivia-host');
      room = null;
      show('setup');
    }
  }, 4000);
}

/* ----------------------------------------------------------- host actions */

async function act(action, payload = {}, { notice = null } = {}) {
  try {
    const result = await api(`/api/rooms/${room.code}/host`, { token: room.token, action, ...payload });
    if (notice) showOk($('#deck-notice'), notice);
    return result;
  } catch (error) {
    showError($('#deck-notice'), error.message);
    return null;
  }
}

$('#regenerate').addEventListener('click', async () => {
  editingDeck = false;
  await act('generate', { seed: Date.now() }, { notice: 'Fresh questions, same keywords.' });
});

$('#claude-write').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '✨ Writing…';
  editingDeck = false;
  await act('generateWithClaude', {}, { notice: 'Claude wrote this set — give it a read before you start.' });
  button.disabled = false;
  button.textContent = '✨ Write with Claude';
});

$('#add-question').addEventListener('click', async () => {
  editingDeck = false;
  await act('addCustom', {
    question: {
      prompt: 'Your question here',
      options: ['Option one', 'Option two', 'Option three', 'Option four'],
      answerIndex: 0,
      explanation: ''
    }
  }, { notice: 'Added a blank question at the end — fill it in.' });
});

$('#start-button').addEventListener('click', () => act('start'));
$('#skip-button').addEventListener('click', () => act('reveal'));
$('#next-button').addEventListener('click', () => act('next'));
$('#again-button').addEventListener('click', () => act('lobby'));
$('#newdeck-button').addEventListener('click', async () => {
  await act('lobby');
  await act('generate', { seed: Date.now() });
});

/* ----------------------------------------------------------------- render */

function render(state) {
  latest = state;
  stopCountdown?.();

  if (state.phase === 'setup') {
    show('deck');
    renderLobby(state);
    if (!editingDeck) renderDeck(state);
    return;
  }
  if (state.phase === 'question') return renderQuestion(state);
  if (state.phase === 'reveal') return renderReveal(state);
  if (state.phase === 'finished') return renderFinished(state);
}

function renderLobby(state) {
  $('#player-count').textContent = `${state.playerCount} ${state.playerCount === 1 ? 'player' : 'players'}`;
  $('#empty-lobby').hidden = state.playerCount > 0;
  $('#player-chips').innerHTML = state.players.map((player) => `
    <span class="chip ${player.connected ? '' : 'off'}">
      <span class="avatar">${escapeHtml(player.avatar)}</span>${escapeHtml(player.name)}
    </span>`).join('');
  $('#start-button').disabled = state.playerCount === 0 || state.questions.length === 0;
  $('#start-button').textContent = state.playerCount === 0
    ? 'Waiting for players…'
    : `Start the game (${state.questions.length} questions)`;
}

function renderDeck(state) {
  const list = $('#deck-list');
  if (!state.questions.length) {
    list.innerHTML = '<p class="muted">No questions yet.</p>';
    return;
  }
  list.innerHTML = state.questions.map((question, index) => `
    <div class="deck-item" data-id="${question.id}">
      <div class="deck-head">
        <span class="tag">${index + 1} · ${escapeHtml(labelFor(question.kind))}</span>
        <div class="button-row">
          <button class="subtle" data-act="up" title="Move up">↑</button>
          <button class="subtle" data-act="down" title="Move down">↓</button>
          <button class="subtle" data-act="reroll">🎲 Reroll</button>
          <button class="subtle" data-act="remove">Remove</button>
        </div>
      </div>
      <input class="q-prompt" type="text" data-field="prompt" value="${escapeHtml(question.prompt)}" />
      <div class="deck-options" style="margin-top:10px">
        ${question.options.map((option, optionIndex) => `
          <div class="deck-option">
            <input type="radio" name="answer-${question.id}" data-answer="${optionIndex}"
                   ${optionIndex === question.answerIndex ? 'checked' : ''} title="This one is true" />
            <span class="swatch" style="background:${OPTION_COLORS[optionIndex % 4]}"></span>
            <input type="text" data-option="${optionIndex}" value="${escapeHtml(option)}" />
          </div>`).join('')}
      </div>
    </div>`).join('');

  for (const item of list.querySelectorAll('.deck-item')) {
    const id = item.dataset.id;

    item.querySelector('[data-act="reroll"]').addEventListener('click', () => {
      editingDeck = false;
      act('reroll', { questionId: id });
    });
    item.querySelector('[data-act="remove"]').addEventListener('click', () => {
      editingDeck = false;
      act('remove', { questionId: id });
    });
    item.querySelector('[data-act="up"]').addEventListener('click', () => {
      editingDeck = false;
      act('move', { questionId: id, direction: 'up' });
    });
    item.querySelector('[data-act="down"]').addEventListener('click', () => {
      editingDeck = false;
      act('move', { questionId: id, direction: 'down' });
    });

    // Typing pauses redraws so an incoming state push can't yank the field away.
    for (const input of item.querySelectorAll('input[type="text"]')) {
      input.addEventListener('focus', () => { editingDeck = true; });
      input.addEventListener('blur', () => { editingDeck = false; saveQuestion(item, id); });
    }
    for (const radio of item.querySelectorAll('input[type="radio"]')) {
      radio.addEventListener('change', () => saveQuestion(item, id));
    }
  }
}

function saveQuestion(item, id) {
  const prompt = item.querySelector('[data-field="prompt"]').value;
  const options = [...item.querySelectorAll('[data-option]')].map((input) => input.value);
  const checked = item.querySelector('input[type="radio"]:checked');
  act('update', {
    questionId: id,
    patch: { prompt, options, answerIndex: checked ? Number(checked.dataset.answer) : 0 }
  });
}

function labelFor(kind) {
  return {
    'spot-the-real': 'which one is real',
    'odd-one-out': 'spot the lie',
    'category': 'signature',
    'pair-up': 'pairs',
    'custom': 'yours',
    'claude': 'written by Claude'
  }[kind] ?? kind;
}

function optionMarkup(question, { revealed = false } = {}) {
  return question.options.map((option, index) => `
    <div class="option ${revealed && index !== question.answerIndex ? 'dimmed' : ''}
                ${revealed && index === question.answerIndex ? 'correct' : ''}" data-index="${index}">
      <span class="glyph">${GLYPHS[index % GLYPHS.length]}</span>
      <span>${escapeHtml(option)}</span>
    </div>`).join('');
}

function renderQuestion(state) {
  show('question');
  const question = state.question;
  $('#q-counter').textContent = `Question ${question.index + 1} of ${question.total}`;
  $('#q-answered').textContent = `${state.answeredCount} of ${state.playerCount} answered`;
  $('#q-prompt').textContent = question.prompt;
  $('#q-options').innerHTML = optionMarkup(question);
  stopCountdown = startCountdown({
    fillNode: $('#q-fill'), labelNode: $('#q-timer'), timing: state.timing, now: stream.now
  });
}

function renderReveal(state) {
  show('reveal');
  const question = state.question;
  $('#r-counter').textContent = `Question ${question.index + 1} of ${question.total}`;
  $('#r-prompt').textContent = question.prompt;
  $('#r-options').innerHTML = optionMarkup(question, { revealed: true });

  const gotIt = state.roundResults.filter((result) => result.correct);
  const fastest = gotIt[0];
  $('#r-explanation').innerHTML = [
    escapeHtml(question.explanation ?? ''),
    gotIt.length
      ? `<br /><b>${gotIt.length} of ${state.playerCount}</b> got it`
        + (fastest ? ` — fastest was ${escapeHtml(fastest.avatar)} ${escapeHtml(fastest.name)}` : '')
      : '<br />Nobody got that one.'
  ].join(' ');

  const points = new Map(state.roundResults.map((result) => [result.id, result.points]));
  renderLeaderboard($('#r-board'), state.leaderboard, { revealPoints: points });

  $('#next-button').textContent = question.index + 1 >= question.total ? 'See the winner' : 'Next question';
  stopCountdown = startCountdown({
    fillNode: null, labelNode: $('#r-timer'), timing: state.timing, now: stream.now
  });
}

function renderFinished(state) {
  show('finished');
  const [first, second, third] = state.leaderboard;
  $('#winner-line').innerHTML = first
    ? `🏆 ${escapeHtml(first.avatar)} ${escapeHtml(first.name)} knows ${escapeHtml(state.guestName)} best!`
    : 'Game over';

  const pillar = (player, className) => player ? `
    <div class="pillar ${className}">
      <div class="avatar">${escapeHtml(player.avatar)}</div>
      <div class="name">${escapeHtml(player.name)}</div>
      <div class="score">${player.score.toLocaleString()}</div>
    </div>` : '';

  $('#podium').innerHTML = pillar(second, 'second') + pillar(first, 'first') + pillar(third, 'third');
  renderLeaderboard($('#final-board'), state.leaderboard);
}
