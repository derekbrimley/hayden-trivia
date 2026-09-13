#!/usr/bin/env node
/**
 * Try the question writer from the command line, without gathering a party.
 *
 *   node scripts/preview.js --guest Hayden --note "always cold" --note "hates olives"
 *   node scripts/preview.js --show-prompt        # print the brief, call nothing
 *
 * With ANTHROPIC_API_KEY set it writes real questions. Without one it shows the
 * offline questions the app falls back to, so you can see both.
 */

import { writeQuestions, claudeIsConfigured } from '../src/llm.js';
import { fallbackQuestions } from '../src/questions.js';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const notesFromArgs = args.reduce((out, value, index) => {
  if (value === '--note' && args[index + 1]) out.push(args[index + 1]);
  return out;
}, []);

const SAMPLE = [
  'always cold, wears a hoodie indoors in July',
  'reads three books at once and finishes none',
  'refuses to eat anything with olives in it',
  'quotes the same film every single day',
  'names every houseplant in the apartment',
  'keeps every receipt since 2014',
  'cannot parallel park to save their life',
  'makes a spreadsheet for every holiday',
  'awake before sunrise, always'
];

const guestName = flag('guest', 'Hayden');
const texts = notesFromArgs.length ? notesFromArgs : SAMPLE;
const topics = texts.map((text, index) => ({ id: `t${index + 1}`, text, playerId: `p${index % 3}` }));
const count = Number(flag('count', 6));

function print(questions, label) {
  console.log(`\n${label}\n${'─'.repeat(label.length)}\n`);
  questions.forEach((question, index) => {
    console.log(`${index + 1}. [${question.style}] ${question.prompt}`);
    question.options.forEach((option, optionIndex) => {
      console.log(`     ${optionIndex === question.answerIndex ? '✓' : ' '} ${option}`);
    });
    if (question.explanation) console.log(`     → ${question.explanation}`);
    console.log('');
  });
}

if (args.includes('--show-prompt')) {
  // Reach the brief without calling anything: a client that captures and stops.
  const capture = {
    beta: { messages: { create: async (params) => {
      console.log(params.messages[0].content);
      console.log(`\n--- model: ${params.model}, effort: ${params.output_config?.effort} ---`);
      throw Object.assign(new Error('preview only'), { status: 999 });
    } } },
    messages: { create: async () => { throw new Error('preview only'); } }
  };
  await writeQuestions({ guestName, topics, count, client: capture }).catch(() => {});
  process.exit(0);
}

if (claudeIsConfigured()) {
  console.log(`Writing ${count} questions about ${guestName}…`);
  const started = Date.now();
  try {
    const result = await writeQuestions({ guestName, topics, count });
    print(result.questions, `Written by Claude in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    if (result.batchesFailed) console.log(`(${result.batchesFailed} batch(es) failed)`);
  } catch (error) {
    console.error(`\nClaude could not write these: ${error.message}\n`);
    print(fallbackQuestions({ guestName, topics, count }), 'What the party would have played instead');
  }
} else {
  console.log('No ANTHROPIC_API_KEY set, so this is the offline fallback.');
  console.log('Set a key to see the questions your party will actually get.');
  print(fallbackQuestions({ guestName, topics, count }), 'Offline questions, built from the notes');
}
