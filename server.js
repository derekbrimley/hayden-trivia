#!/usr/bin/env node
/**
 * Local development server.
 *
 * Serves the static app and hands /api/* to the same router the deployed
 * Vercel function uses. With no Redis configured it keeps rooms in memory, so
 * `node server.js` is enough to play on one machine or one wifi network.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { handleApi } from './src/router.js';
import { sharedStore } from './src/store.js';
import { claudeIsConfigured } from './src/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid JSON body.');
  }
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, relative);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) throw new Error('directory');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(target).pipe(res);
  } catch {
    // Unknown paths fall through to the app, the way Vercel's rewrites do.
    try {
      const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(html);
    } catch {
      res.writeHead(404).end('Not found');
    }
  }
}

/**
 * Handle one request: a static file, or the API.
 *
 * This is exported as the module's default because a host that treats this file
 * as an entrypoint wants a plain (req, res) function. Exporting the http.Server
 * instead is rejected by some of them.
 */
export async function requestListener(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const segments = url.pathname.split('/').filter(Boolean);

  if (segments[0] !== 'api') return serveStatic(res, url.pathname);
  segments.shift();

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const result = await handleApi({
      method: req.method,
      segments,
      query: Object.fromEntries(url.searchParams),
      body,
      store: sharedStore(),
      env: process.env
    });
    const payload = JSON.stringify(result.json);
    res.writeHead(result.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store'
    });
    res.end(payload);
  } catch (error) {
    const payload = JSON.stringify({ error: error?.message ?? 'Something went wrong.' });
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }).end(payload);
  }
}

const server = http.createServer(requestListener);

function localAddresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

// Bind a port only when this file is run as a program. When something imports it
// — a test, or a host wrapping the default export — binding would be pointless
// at best and a crash at worst.
const runAsProgram = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (runAsProgram) {
  // Running as a program means one process serves every request, so keeping
  // rooms in memory is correct here and is not worth warning about. A host that
  // imports this file may run many copies, where it very much is.
  process.env.GOH_SINGLE_PROCESS = '1';

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  🎉  Guest of Honor Trivia is running.');
    console.log('');
    console.log(`  Everyone opens:  http://localhost:${PORT}/`);
    for (const address of localAddresses()) {
      console.log(`                   http://${address}:${PORT}/   (same wifi)`);
    }
    console.log('');
    console.log(`  Storage: ${sharedStore().kind}`);
    console.log(`  Questions: ${claudeIsConfigured() ? 'written by Claude' : 'from your notes (no ANTHROPIC_API_KEY set)'}`);
    console.log('');
  });
}

export { server };
export default requestListener;
