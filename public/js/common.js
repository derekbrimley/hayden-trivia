/** Shared helpers. */

export const GLYPHS = ['▲', '◆', '●', '■'];

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

export async function api(path, body, method = 'POST') {
  const response = await fetch(path, {
    method,
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {})
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) throw new Error(payload?.error ?? `Request failed (${response.status})`);
  return payload;
}

export function showError(node, message) {
  if (!node) return;
  node.textContent = message;
  node.className = 'notice error';
  node.hidden = false;
}

export function clearNotice(node) {
  if (node) node.hidden = true;
}

/**
 * Poll the room for state.
 *
 * There is no socket: on a serverless host nothing stays connected between
 * requests, so every device asks for the current state on a timer. The interval
 * tightens during a question and relaxes in the lobby.
 */
export function startPolling({ url, onState, onError, intervalFor }) {
  let timer = null;
  let stopped = false;
  let failures = 0;
  const clock = { offsetMs: 0, now: () => Date.now() + clock.offsetMs };

  async function tick() {
    if (stopped) return;
    try {
      const state = await api(url(), null, 'GET');
      failures = 0;
      if (typeof state.serverTime === 'number') clock.offsetMs = state.serverTime - Date.now();
      setBanner(null);
      onState(state);
    } catch (error) {
      failures += 1;
      if (failures >= 3) {
        setBanner('Reconnecting…');
        onError?.(error);
      }
    }
    if (!stopped) timer = setTimeout(tick, intervalFor());
  }

  let banner = null;
  function setBanner(text) {
    if (!text) { banner?.remove(); banner = null; return; }
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'connection';
      document.body.append(banner);
    }
    banner.textContent = text;
  }

  tick();
  return {
    clock,
    refreshNow: () => { clearTimeout(timer); tick(); },
    stop: () => { stopped = true; clearTimeout(timer); setBanner(null); }
  };
}

/** Drive a countdown bar from the server's `timing` block. */
export function startCountdown({ fillNode, labelNode, timing, now }) {
  let frame = null;
  const stop = () => { if (frame) cancelAnimationFrame(frame); frame = null; };
  if (!timing?.endsAt || !timing?.totalMs) {
    if (fillNode) fillNode.style.transform = 'scaleX(1)';
    if (labelNode) labelNode.textContent = '';
    return stop;
  }
  const tick = () => {
    const remaining = Math.max(0, timing.endsAt - now());
    if (fillNode) fillNode.style.transform = `scaleX(${remaining / timing.totalMs})`;
    if (labelNode) labelNode.textContent = `${Math.ceil(remaining / 1000)}s`;
    if (remaining > 0) frame = requestAnimationFrame(tick);
  };
  tick();
  return stop;
}

export function renderLeaderboard(node, players, { meId = null, points = null } = {}) {
  if (!node) return;
  if (!players?.length) {
    node.innerHTML = '<p class="muted">Nobody here yet.</p>';
    return;
  }
  node.innerHTML = players.map((player) => {
    const gained = points?.[player.id];
    const delta = gained ? `<span class="delta">+${gained}</span>` : '';
    const score = Number.isFinite(player.score) ? `${player.score.toLocaleString()}${delta}` : '';
    return `
      <div class="board-row ${player.rank === 1 ? 'top' : ''} ${player.id === meId ? 'me' : ''}">
        <div class="rank">${player.rank}</div>
        <div class="who"><span class="avatar">${escapeHtml(player.avatar)}</span>
          <span class="name">${escapeHtml(player.name)}</span></div>
        <div class="score">${score}</div>
      </div>`;
  }).join('');
}

export function ordinal(n) {
  if (!n) return '—';
  const suffixes = ['th', 'st', 'nd', 'rd'];
  return `${n}${suffixes[(n % 100 - 20) % 10] ?? suffixes[n % 100] ?? suffixes[0]}`;
}

export const storage = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  },
  clear(key) {
    try { localStorage.removeItem(key); } catch { /* private mode */ }
  }
};
