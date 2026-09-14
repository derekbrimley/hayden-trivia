#!/usr/bin/env node
/**
 * Check a deployment before the party.
 *
 *   npm run doctor                        # checks this machine's environment
 *   npm run doctor -- https://your.app    # checks a deployed app over HTTP
 *
 * Locally it does a real write-and-read against whatever Redis is configured,
 * because "the variable is set" and "the database answers" are different things.
 */

import { createStore, storageDiagnosis, redisConfig } from '../src/store.js';
import { claudeIsConfigured } from '../src/llm.js';

const PASS = '  ✓';
const FAIL = '  ✗';
const WARN = '  !';

const target = process.argv.slice(2).find((arg) => arg.startsWith('http'));
let failures = 0;

function report(ok, message, detail) {
  if (ok === false) failures += 1;
  console.log(`${ok === true ? PASS : ok === false ? FAIL : WARN} ${message}`);
  if (detail) console.log(`      ${detail}`);
}

if (target) {
  console.log(`\nChecking ${target}\n`);
  const base = target.replace(/\/+$/, '');
  let health;
  try {
    const response = await fetch(`${base}/api/health?deep=1`);
    health = await response.json();
  } catch (error) {
    report(false, 'The deployment did not answer.', error.message);
    process.exit(1);
  }
  const issues = health.issues ?? {};
  // A store that is configured but refuses writes is not "connected".
  const storageWorks = health.storage === 'redis' && (!health.probe || health.probe.ok);
  report(
    storageWorks,
    storageWorks ? 'Redis store connected.' : 'The Redis store is not usable.',
    issues.storage
  );
  report(
    health.claude,
    health.claude ? 'ANTHROPIC_API_KEY is set.' : 'No ANTHROPIC_API_KEY.',
    issues.claude
  );
  if (health.probe) {
    report(health.probe.ok, health.probe.ok
      ? 'Wrote to the database and read it back.'
      : 'The database did not accept a write.', health.probe.error);
  }
  if (health.ready) console.log('\nReady for a party.\n');
  else console.log('\nFix the items above, then redeploy — Vercel only picks up new variables on a new deploy.\n');
  process.exit(health.ready ? 0 : 1);
}

console.log('\nChecking this machine\n');

const diagnosis = storageDiagnosis(process.env);
const config = redisConfig(process.env);

if (diagnosis.problem) {
  report(false, 'Redis is configured but not usable.', diagnosis.problem);
} else if (!config) {
  report(null, 'No Redis configured — rooms will be kept in memory.', diagnosis.note);
} else {
  report(true, `Redis credentials found (${new URL(config.url).host}).`);
  // Setting a variable is not the same as the database answering.
  try {
    const store = createStore(process.env);
    const code = `DOCTOR${Date.now().toString(36).slice(-3).toUpperCase()}`;
    const probe = { code, guestName: 'doctor probe', phase: 'lobby', questions: [], version: 1 };
    await store.saveRoom(probe);
    const readBack = await store.loadRoom(code);
    if (readBack?.guestName === 'doctor probe') {
      report(true, 'Wrote a room to Redis and read it back.');
    } else {
      report(false, 'Wrote to Redis but read back nothing. Check the token has write access.');
    }
    const first = await store.tryLock(`doctor:${code}`);
    const second = await store.tryLock(`doctor:${code}`);
    report(first && !second, first && !second
      ? 'Round locking works, so a round can only be scored once.'
      : 'Locking is not behaving: rounds could be scored twice.');
    await store.deleteRoom(code);
  } catch (error) {
    report(false, 'Redis rejected the request.', error.message);
  }
}

report(claudeIsConfigured(), claudeIsConfigured()
  ? `ANTHROPIC_API_KEY is set (model: ${process.env.ANTHROPIC_MODEL ?? 'claude-opus-5'}).`
  : 'No ANTHROPIC_API_KEY — questions fall back to the simpler offline set.');

console.log(failures
  ? `\n${failures} thing${failures === 1 ? '' : 's'} to fix. See README.md → Deploy it.\n`
  : '\nAll good.\n');
process.exit(failures ? 1 : 0);
