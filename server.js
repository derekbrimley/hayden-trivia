#!/usr/bin/env node
/**
 * Hayden Trivia — game server.
 *
 * Deliberately dependency-free: `node server.js` is the whole install story, which
 * matters when you are setting this up on a laptop at a party. Realtime updates use
 * Server-Sent Events (one long-lived GET per screen) and everything the clients send
 * back is an ordinary POST.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  createRoom, buildDeck, rerollQuestion, removeQuestion, updateQuestion, addCustomQuestion,
  moveQuestion, joinRoom, removePlayer, authPlayer, startGame, submitAnswer, revealAnswer,
  nextQuestion, backToLobby, hostView, playerView, everyoneAnswered, makeRoomCode, touch
} from './src/game.js';
import { cleanKeywords } from './src/questions.js';
import { generateWithClaude, claudeIsConfigured } from './src/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

/** Optional: `npm install` adds the `qrcode` package and join screens gain a QR code. */
let qrcode = null;
try {
  ({ default: qrcode } = await import('qrcode'));
} catch {
  qrcode = null;
}

/** code -> room */
const rooms = new Map();
/** Set of { res, role, roomCode, playerId } */
const clients = new Set();

const ROOM_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000;

/* ----------------------------------------------------------------- utilities */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function fail(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readBody(req, limitBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON body.');
  }
}

function localAddresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ realtime */

function viewFor(client, room) {
  return client.role === 'host' ? hostView(room) : playerView(room, client.playerId);
}

function push(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(client);
  }
}

function broadcast(room) {
  for (const client of clients) {
    if (client.roomCode !== room.code) continue;
    push(client, 'state', viewFor(client, room));
  }
}

function broadcastClosed(room, reason) {
  for (const client of clients) {
    if (client.roomCode !== room.code) continue;
    push(client, 'closed', { reason });
    try { client.res.end(); } catch { /* already gone */ }
    clients.delete(client);
  }
}

/* --------------------------------------------------------------------- clock */

// One timer drives every room: expire questions, auto-advance reveals.
const clock = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase === 'question' && room.questionStartedAt) {
      const expired = now >= room.questionStartedAt + room.settings.questionSeconds * 1000;
      if (expired || everyoneAnswered(room)) {
        revealAnswer(room, now);
        broadcast(room);
      }
    } else if (room.phase === 'reveal' && room.revealStartedAt && room.settings.autoAdvance !== false) {
      if (now >= room.revealStartedAt + room.settings.revealSeconds * 1000) {
        nextQuestion(room, now);
        broadcast(room);
      }
    }
  }
}, 250);

// Housekeeping: drop rooms nobody is using so a long-running server stays tidy.
const housekeeping = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_MAX_AGE_MS || now - room.updatedAt > ROOM_IDLE_MS) {
      broadcastClosed(room, 'This room expired.');
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

// Timers should never be the reason the process stays alive (tests close the server).
clock.unref?.();
housekeeping.unref?.();

/* ------------------------------------------------------------------- statics */

async function serveStatic(req, res, urlPath) {
  let relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (relative === 'host' || relative === 'host/') relative = 'host.html';
  const target = path.join(PUBLIC_DIR, relative);
  // Refuse anything that escapes the public directory.
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    return fail(res, 403, 'Forbidden');
  }
  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) return fail(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(target).pipe(res);
  } catch {
    fail(res, 404, 'Not found');
  }
}

/* -------------------------------------------------------------------- routes */

function requireRoom(res, code) {
  const room = rooms.get(String(code ?? '').toUpperCase());
  if (!room) {
    fail(res, 404, 'No room with that code. Double-check the letters with your host.');
    return null;
  }
  return room;
}

function requireHost(res, room, token) {
  if (room.hostToken !== token) {
    fail(res, 403, 'Only the host screen can do that.');
    return false;
  }
  return true;
}

async function handleCreateRoom(req, res) {
  const body = await readBody(req);
  const keywords = cleanKeywords(body.keywords);
  if (keywords.length < 3) {
    return fail(res, 400, 'Add at least 3 keywords about your guest of honor (12 is the sweet spot).');
  }
  const settings = {};
  for (const key of ['questionSeconds', 'revealSeconds', 'questionCount']) {
    if (Number.isFinite(Number(body.settings?.[key]))) settings[key] = Number(body.settings[key]);
  }
  if (typeof body.settings?.autoAdvance === 'boolean') settings.autoAdvance = body.settings.autoAdvance;
  settings.questionSeconds = Math.min(120, Math.max(5, settings.questionSeconds ?? 25));
  settings.revealSeconds = Math.min(60, Math.max(3, settings.revealSeconds ?? 10));
  settings.questionCount = Math.min(30, Math.max(3, settings.questionCount ?? 12));

  const room = createRoom({
    guestName: body.guestName,
    keywords,
    settings,
    code: makeRoomCode(new Set(rooms.keys()))
  });
  buildDeck(room);
  rooms.set(room.code, room);
  sendJson(res, 201, { code: room.code, hostToken: room.hostToken, state: hostView(room) });
}

async function handleJoin(req, res, room) {
  const body = await readBody(req);
  if (room.phase !== 'setup' && room.phase !== 'finished') {
    // Late arrivals are welcome; they simply start from zero.
  }
  try {
    const player = joinRoom(room, { name: body.name, avatar: body.avatar });
    broadcast(room);
    sendJson(res, 201, {
      playerId: player.id,
      token: player.token,
      name: player.name,
      avatar: player.avatar,
      state: playerView(room, player.id)
    });
  } catch (error) {
    fail(res, 400, error.message);
  }
}

async function handleAnswer(req, res, room) {
  const body = await readBody(req);
  const player = authPlayer(room, body.playerId, body.token);
  if (!player) return fail(res, 403, 'We lost track of you — rejoin with the room code.');
  const result = submitAnswer(room, player.id, { questionId: body.questionId, choice: body.choice });
  if (result.ok) broadcast(room);
  sendJson(res, result.ok ? 200 : 409, result);
}

async function handleHostAction(req, res, room) {
  const body = await readBody(req);
  if (!requireHost(res, room, body.token)) return;
  const { action } = body;

  try {
    switch (action) {
      case 'generate': {
        buildDeck(room, { count: body.count, seed: body.seed ?? Date.now() });
        break;
      }
      case 'generateWithClaude': {
        if (!claudeIsConfigured()) {
          return fail(res, 400, 'Set ANTHROPIC_API_KEY before using Claude-written questions.');
        }
        const questions = await generateWithClaude({
          guestName: room.guestName,
          keywords: room.keywords,
          count: body.count ?? room.settings.questionCount
        });
        room.questions = questions.map((q, index) => ({ ...q, index }));
        room.phase = 'setup';
        touch(room);
        break;
      }
      case 'reroll': rerollQuestion(room, body.questionId, Date.now()); break;
      case 'update': updateQuestion(room, body.questionId, body.patch ?? {}); break;
      case 'remove': removeQuestion(room, body.questionId); break;
      case 'move': moveQuestion(room, body.questionId, body.direction); break;
      case 'addCustom': addCustomQuestion(room, body.question ?? {}); break;
      case 'start': startGame(room); break;
      case 'reveal': revealAnswer(room); break;
      case 'next': nextQuestion(room); break;
      case 'lobby': backToLobby(room); break;
      case 'kick': removePlayer(room, body.playerId); break;
      case 'settings': {
        const next = { ...room.settings };
        if (Number.isFinite(Number(body.settings?.questionSeconds))) {
          next.questionSeconds = Math.min(120, Math.max(5, Number(body.settings.questionSeconds)));
        }
        if (Number.isFinite(Number(body.settings?.revealSeconds))) {
          next.revealSeconds = Math.min(60, Math.max(3, Number(body.settings.revealSeconds)));
        }
        if (typeof body.settings?.autoAdvance === 'boolean') next.autoAdvance = body.settings.autoAdvance;
        room.settings = next;
        touch(room);
        break;
      }
      case 'close': {
        broadcastClosed(room, 'The host ended this game.');
        rooms.delete(room.code);
        return sendJson(res, 200, { ok: true, closed: true });
      }
      default:
        return fail(res, 400, `Unknown action: ${action}`);
    }
  } catch (error) {
    return fail(res, 400, error.message);
  }

  broadcast(room);
  sendJson(res, 200, { ok: true, state: hostView(room) });
}

function handleStream(req, res, room, params) {
  const role = params.get('role') === 'host' ? 'host' : 'player';
  if (role === 'host' && params.get('token') !== room.hostToken) {
    return fail(res, 403, 'Bad host token.');
  }
  let playerId = null;
  if (role === 'player') {
    const player = authPlayer(room, params.get('playerId'), params.get('token'));
    if (!player) return fail(res, 403, 'Rejoin the room to reconnect.');
    player.connected = true;
    playerId = player.id;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');

  const client = { res, role, roomCode: room.code, playerId };
  clients.add(client);
  push(client, 'state', viewFor(client, room));
  if (role === 'player') broadcast(room);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* closed below */ }
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
    if (playerId && room.players.has(playerId)) {
      room.players.get(playerId).connected = false;
      touch(room);
      broadcast(room);
    }
  });
}

async function handleQr(req, res, room, params) {
  const target = params.get('url');
  if (!qrcode || !target) return fail(res, 404, 'QR codes are unavailable (run `npm install`).');
  try {
    const svg = await qrcode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    res.end(svg);
  } catch {
    fail(res, 500, 'Could not render a QR code.');
  }
}

/* --------------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const segments = url.pathname.split('/').filter(Boolean);

  try {
    if (segments[0] !== 'api') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    }

    // /api/health
    if (segments[1] === 'health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        rooms: rooms.size,
        qr: Boolean(qrcode),
        claude: claudeIsConfigured()
      });
    }

    // /api/rooms
    if (segments[1] === 'rooms' && segments.length === 2 && req.method === 'POST') {
      return await handleCreateRoom(req, res);
    }

    if (segments[1] === 'rooms' && segments.length >= 3) {
      const room = requireRoom(res, segments[2]);
      if (!room) return;
      const action = segments[3];

      if (!action && req.method === 'GET') {
        return sendJson(res, 200, {
          code: room.code, guestName: room.guestName, phase: room.phase, playerCount: room.players.size
        });
      }
      if (action === 'join' && req.method === 'POST') return await handleJoin(req, res, room);
      if (action === 'answer' && req.method === 'POST') return await handleAnswer(req, res, room);
      if (action === 'host' && req.method === 'POST') return await handleHostAction(req, res, room);
      if (action === 'stream' && req.method === 'GET') return handleStream(req, res, room, url.searchParams);
      if (action === 'qr' && req.method === 'GET') return await handleQr(req, res, room, url.searchParams);
      return fail(res, 404, 'Not found');
    }

    fail(res, 404, 'Not found');
  } catch (error) {
    fail(res, 400, error.message ?? 'Something went wrong.');
  }
});

server.listen(PORT, HOST, () => {
  const addresses = localAddresses();
  console.log('');
  console.log('  🎉  Trivia server is up.');
  console.log('');
  console.log(`  Host screen:     http://localhost:${PORT}/host`);
  console.log(`  Players join at: http://localhost:${PORT}/`);
  for (const address of addresses) {
    console.log(`                   http://${address}:${PORT}/   (same wifi)`);
  }
  console.log('');
  if (!qrcode) console.log('  Tip: run `npm install` to show a scannable QR code on the host screen.');
  if (claudeIsConfigured()) console.log('  Claude-written questions: enabled (ANTHROPIC_API_KEY found).');
  console.log('');
});

export { server, rooms };
