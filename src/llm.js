/**
 * Writing the questions.
 *
 * The party writes down things they know about the guest of honor; Claude turns
 * those notes into questions worth reading out loud. The bar is high on purpose:
 * "which of these is Hayden's hobby?" is a fact lookup, not a party game. We want
 * the question that makes the room laugh because it is so obviously them.
 *
 * Generation is split into small parallel batches, each owning a slice of the
 * notes. That keeps every request short enough for a serverless timeout and
 * guarantees the notes get spread across the game instead of clustering.
 */

import { randomUUID } from 'node:crypto';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const EFFORT = process.env.ANTHROPIC_EFFORT || 'high';
const QUESTIONS_PER_BATCH = 4;

export const STYLES = [
  'situation', 'tell', 'superlative', 'two-truths', 'combo', 'reputation', 'prediction', 'hot-take'
];

export function claudeIsConfigured(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

const SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          style: { type: 'string', enum: STYLES },
          prompt: { type: 'string', description: 'The question, read aloud to the room.' },
          options: {
            type: 'array',
            items: { type: 'string' },
            minItems: 4,
            maxItems: 4,
            description: 'Four choices, matched in length and specificity. Under 60 characters each.'
          },
          answerIndex: { type: 'integer', minimum: 0, maximum: 3 },
          explanation: {
            type: 'string',
            description: 'One warm line revealing the answer, read aloud after the vote.'
          },
          usesTopicIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of the notes the correct answer comes from.'
          }
        },
        required: ['style', 'prompt', 'options', 'answerIndex', 'explanation', 'usesTopicIds'],
        additionalProperties: false
      }
    }
  },
  required: ['questions'],
  additionalProperties: false
};

const GUIDE = `You write questions for a party game about one person: the guest of honor.

The other guests have written down things they know about them. Those notes are the
only true facts you have. Your job is to turn them into multiple-choice questions
that are fun to read out loud and that make the room shout "that is SO them".

WHAT A GOOD QUESTION DOES
A weak question asks about the note. A strong question asks about the person, and the
note is how you check the answer.

  Note: "always cold, wears a hoodie indoors"
  Weak:   Which of these is true about Sam?  -> a fact lookup, no fun
  Strong: It is 78 degrees. Sam walks into the room. What is Sam wearing?

  Note: "reads three books at once"
  Weak:   What is Sam's hobby?
  Strong: You borrow Sam's bag for an afternoon. What do you find inside?

Build a small, specific scene and let the answer be the punchline. The player should
have to know what this person is LIKE, not what was written on a card.

RULES
- The correct answer must trace back to a note. Never invent a new true fact.
- Wrong answers must be things a real person plausibly does. Someone who half-knows
  the guest should be genuinely tempted. Never filler, never absurd.
- Match all four options in length, shape and specificity. A longer, funnier, or more
  detailed option gives the answer away.
- Every option under 60 characters. Short enough to read on a phone.
- Never repeat a question shape twice in a row, and never reuse a sentence pattern.
- Warm and teasing, never mean. Nothing about appearance, weight, money, health,
  relationships, politics or anything a note did not raise first.
- Write the way people actually talk. No stiff quiz-show phrasing.

STYLES, spread across the set
- situation:   drop them in an everyday moment and ask what happens
- tell:        "the fastest way to know you are in their car / kitchen / group chat"
- superlative: what they would save, give up, or never do
- two-truths:  three notes true, one invented, spot the fake
- combo:       which pair is both true of them
- reputation:  "their friends agree they are the person you call when..."
- prediction:  a free evening, a long drive, a group trip — what actually happens
- hot-take:    which opinion would they defend loudest`;

function batchPrompt({ guestName, topics, focus, count }) {
  return [
    GUIDE,
    '',
    `THE GUEST OF HONOR: ${guestName}`,
    '',
    'EVERY NOTE THE PARTY WROTE (use these for wrong answers and combos too):',
    ...topics.map((topic) => `- [${topic.id}] ${topic.text}`),
    '',
    'BUILD THIS BATCH AROUND THESE NOTES:',
    ...focus.map((topic) => `- [${topic.id}] ${topic.text}`),
    '',
    `Write exactly ${count} questions. Use a different style for each one.`,
    'For each question, list in usesTopicIds the ids of the notes the correct answer comes from.',
    `Refer to the guest as "${guestName}".`
  ].join('\n');
}

/** Split the notes into as many groups as there are batches, round-robin. */
function partition(topics, groups) {
  const buckets = Array.from({ length: groups }, () => []);
  topics.forEach((topic, index) => buckets[index % groups].push(topic));
  return buckets.filter((bucket) => bucket.length);
}

/** Pull the JSON object out of a reply, tolerating code fences or stray prose. */
export function parseQuestionJson(text) {
  const trimmed = String(text ?? '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
    return JSON.parse(candidate);
  }
}

function textOf(response) {
  return (response.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * Ask the model once.
 *
 * Three attempts, each dropping a newer API feature, so that a deployment on an
 * older API still gets its questions:
 *   1. the beta endpoint with a server-side fallback, so a refusal is re-run
 *      on another model instead of leaving the party with nothing
 *   2. the plain endpoint, still with a schema
 *   3. no schema at all, asking for JSON in the prompt
 * Only a 400 — the API telling us it does not know a parameter — steps down.
 */
async function ask(client, prompt) {
  const base = { model: MODEL, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] };
  const structured = { ...base, output_config: { effort: EFFORT, format: { type: 'json_schema', schema: SCHEMA } } };

  const attempts = [
    () => client.beta.messages.create({
      ...structured,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default'
    }),
    () => client.messages.create(structured),
    () => client.messages.create({
      ...base,
      messages: [{
        role: 'user',
        content: `${prompt}\n\nReply with JSON only, shaped as `
          + '{"questions":[{"style","prompt","options":[4 strings],"answerIndex","explanation","usesTopicIds":[]}]}'
      }]
    })
  ];

  let lastError = null;
  for (const attempt of attempts) {
    let response;
    try {
      response = await attempt();
    } catch (error) {
      // Anything other than "the API does not understand this request" is real.
      if (error?.status !== 400) throw error;
      lastError = error;
      continue;
    }
    if (response.stop_reason === 'refusal') {
      throw new Error('Claude declined to write questions from these notes.');
    }
    return parseQuestionJson(textOf(response));
  }
  throw lastError ?? new Error('Claude could not be reached.');
}

/** Reject anything unplayable before it reaches the room. */
export function validateQuestion(question, topicIds) {
  if (!question || typeof question.prompt !== 'string' || !question.prompt.trim()) return null;
  const options = (question.options ?? []).map((option) => String(option ?? '').trim());
  if (options.length !== 4 || options.some((option) => !option)) return null;

  const seen = new Set();
  for (const option of options) {
    const key = option.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) return null;
    seen.add(key);
  }
  const answerIndex = Number(question.answerIndex);
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) return null;

  // An option far longer than the others is a giveaway, not a question.
  const lengths = options.map((option) => option.length);
  if (Math.max(...lengths) > 90) return null;
  if (Math.max(...lengths) > 2.5 * Math.min(...lengths) && Math.max(...lengths) > 40) return null;

  const uses = (question.usesTopicIds ?? []).filter((id) => topicIds.has(id));
  return {
    id: `q_${randomUUID().slice(0, 8)}`,
    source: 'claude',
    style: STYLES.includes(question.style) ? question.style : 'situation',
    prompt: question.prompt.trim().slice(0, 240),
    options,
    answerIndex,
    explanation: String(question.explanation ?? '').trim().slice(0, 240),
    topicIds: uses
  };
}

/** Two questions that open the same way feel like one question asked twice. */
function tooSimilar(a, b) {
  const head = (text) => text.toLowerCase().replace(/[^a-z0-9 ]+/g, '').split(' ').slice(0, 5).join(' ');
  return head(a.prompt) === head(b.prompt);
}

/**
 * Write a set of questions from the party's notes.
 * Returns `{ questions, batchesFailed }` — a partial set still makes a game.
 */
export async function writeQuestions({ guestName, topics, count = 12, client }) {
  if (!topics?.length) throw new Error('No notes to work from yet.');
  const anthropic = client ?? (await createClient());

  const batches = Math.max(1, Math.ceil(count / QUESTIONS_PER_BATCH));
  const groups = partition(topics, batches);
  const perBatch = Math.ceil(count / groups.length);
  const topicIds = new Set(topics.map((topic) => topic.id));

  const results = await Promise.allSettled(groups.map((focus) =>
    ask(anthropic, batchPrompt({ guestName, topics, focus, count: perBatch }))));

  const questions = [];
  let batchesFailed = 0;
  const failures = [];
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      batchesFailed += 1;
      failures.push(result.reason?.message ?? 'unknown error');
      continue;
    }
    for (const raw of result.value.questions ?? []) {
      const question = validateQuestion(raw, topicIds);
      if (question && !questions.some((existing) => tooSimilar(existing, question))) {
        questions.push(question);
      }
    }
  }

  if (!questions.length) {
    throw new Error(failures[0] ?? 'Claude did not return any usable questions.');
  }
  return { questions: interleave(questions).slice(0, count), batchesFailed };
}

/** Batches come back grouped by style; shuffle them apart so the game varies. */
function interleave(questions) {
  const byStyle = new Map();
  for (const question of questions) {
    if (!byStyle.has(question.style)) byStyle.set(question.style, []);
    byStyle.get(question.style).push(question);
  }
  const out = [];
  while (out.length < questions.length) {
    for (const bucket of byStyle.values()) {
      const next = bucket.shift();
      if (next) out.push(next);
    }
  }
  return out;
}

async function createClient() {
  if (!claudeIsConfigured()) {
    throw new Error('ANTHROPIC_API_KEY is not set on this deployment.');
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic();
}
