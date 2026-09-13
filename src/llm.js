/**
 * Optional: let Claude write the questions instead of the template engine.
 *
 * The game is fully playable without this — the keyword templates in
 * questions.js need no network and no API key. But if the host exports an
 * ANTHROPIC_API_KEY and installs the SDK (`npm install`), the host screen grows
 * a "Write with Claude" button that turns the same twelve keywords into
 * sharper, funnier questions.
 */

import { generateDeck, questionIsFair, cleanKeywords } from './questions.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

export function claudeIsConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The question, addressed to the party guests.' },
          options: {
            type: 'array',
            items: { type: 'string' },
            minItems: 4,
            maxItems: 4,
            description: 'Four answer choices, all similar in length and tone.'
          },
          answerIndex: { type: 'integer', minimum: 0, maximum: 3 },
          explanation: {
            type: 'string',
            description: 'One short line the host reads aloud when the answer is revealed.'
          },
          basedOn: { type: 'string', description: 'The keyword this question came from.' }
        },
        required: ['prompt', 'options', 'answerIndex', 'explanation', 'basedOn'],
        additionalProperties: false
      }
    }
  },
  required: ['questions'],
  additionalProperties: false
};

function buildPrompt({ guestName, keywords, count }) {
  return [
    `You are writing a "how well do you know ${guestName}?" trivia round for a party.`,
    `${guestName} is the guest of honor. Everything below is TRUE about them:`,
    '',
    ...keywords.map((keyword, index) => `${index + 1}. ${keyword}`),
    '',
    `Write exactly ${count} multiple-choice questions with four options each.`,
    '',
    'Rules:',
    `- Every question must be answerable from the list above. Never invent a new true fact about ${guestName}.`,
    '- The three wrong options must be invented but believable: same category, same length, same tone as the right one.',
    '- Vary the shapes. Mix "which one is really them", "three truths and a lie", "which pair is both true",',
    '  and playful superlatives ("what would they grab first in a fire?").',
    '- Never hint at the answer through phrasing, length, or specificity. A stranger should have to guess.',
    '- Warm, teasing, party-appropriate. Funny is good; mean is not.',
    '- Spread the questions across as many of the keywords as you can.',
    '- Options must be short enough to read on a phone screen: under 60 characters.'
  ].join('\n');
}

/** Ask Claude for a deck. Anything unusable is quietly replaced by a template question. */
export async function generateWithClaude({ guestName, keywords, count = 12 }) {
  if (!claudeIsConfigured()) {
    throw new Error('No ANTHROPIC_API_KEY found, so Claude-written questions are unavailable.');
  }
  const list = cleanKeywords(keywords);
  if (list.length < 3) throw new Error('Add at least 3 keywords first.');

  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    throw new Error('Run `npm install` to enable Claude-written questions.');
  }

  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: QUESTION_SCHEMA }
    },
    messages: [{ role: 'user', content: buildPrompt({ guestName, keywords: list, count }) }]
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined to write these questions. Falling back to keyword questions.');
  }

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Claude sent back something we could not read. Try again.');
  }

  const fallback = generateDeck({ guestName, keywords: list, count, seed: Date.now() }).questions;
  const questions = [];
  for (let i = 0; i < count; i++) {
    const raw = parsed.questions?.[i];
    const candidate = raw && {
      id: `q${i + 1}`,
      kind: 'claude',
      source: 'claude',
      star: typeof raw.basedOn === 'string' ? raw.basedOn : null,
      prompt: String(raw.prompt ?? '').trim(),
      options: (raw.options ?? []).map((option) => String(option ?? '').trim()),
      answerIndex: Number(raw.answerIndex),
      explanation: String(raw.explanation ?? '').trim()
    };
    if (candidate && candidate.prompt && questionIsFair(candidate)) {
      questions.push(candidate);
    } else {
      questions.push({ ...fallback[i % fallback.length], id: `q${i + 1}` });
    }
  }
  return questions.map((question, index) => ({ ...question, index }));
}
