/** Shared helpers for the host screen and the player screens. */

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
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {})
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.error ?? `Request failed (${response.status})`);
  }
  return payload;
}

export function showError(node, message) {
  if (!node) return;
  node.textContent = message;
  node.className = 'notice error';
  node.hidden = false;
}

export function showOk(node, message) {
  if (!node) return;
  node.textContent = message;
  node.className = 'notice ok';
  node.hidden = false;
}

export function clearNotice(node) {
  if (node) node.hidden = true;
}

/**
 * Subscribe to a room's event stream.
 *
 * EventSource reconnects on its own, so this mostly exists to keep a clock
 * offset (server time vs. this device's clock) and to show a banner while the
 * connection is down — phones drop the stream every time they sleep.
 */
export function connect(streamUrl, { onState, onClosed } = {}) {
  const source = new EventSource(streamUrl);
  const state = { offsetMs: 0 };
  let banner = null;

  const setBanner = (text) => {
    if (!text) {
      banner?.remove();
      banner = null;
      return;
    }
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'connection';
      document.body.append(banner);
    }
    banner.textContent = text;
  };

  source.addEventListener('open', () => setBanner(null));

  source.addEventListener('state', (event) => {
    const data = JSON.parse(event.data);
    if (typeof data.serverTime === 'number') state.offsetMs = data.serverTime - Date.now();
    setBanner(null);
    onState?.(data);
  });

  source.addEventListener('closed', (event) => {
    const data = JSON.parse(event.data);
    source.close();
    setBanner(null);
    onClosed?.(data);
  });

  source.addEventListener('error', () => {
    if (source.readyState === EventSource.CLOSED) setBanner('Disconnected. Refresh to rejoin.');
    else setBanner('Reconnecting…');
  });

  state.now = () => Date.now() + state.offsetMs;
  state.close = () => source.close();
  return state;
}

/** Drive a countdown bar from the server's `timing` block. */
export function startCountdown({ fillNode, labelNode, timing, now }) {
  let frame = null;
  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = null;
  };
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

export function renderLeaderboard(node, players, { meId = null, revealPoints = null } = {}) {
  if (!node) return;
  if (!players?.length) {
    node.innerHTML = '<p class="muted">Nobody has joined yet.</p>';
    return;
  }
  node.innerHTML = players.map((player) => {
    const gained = revealPoints?.get?.(player.id);
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
