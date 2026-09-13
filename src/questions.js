/**
 * Question generation.
 *
 * The host gives us a guest of honor and twelve keywords. Everything the game
 * asks is derived from those keywords: a keyword is always the truth, and the
 * decoy banks supply believable lies to hide it among.
 *
 * Every question is reproducible from its seed, so a host can reroll a single
 * question without disturbing the rest of the deck.
 */

import { makeRng, hashSeed } from './rng.js';
import { CATEGORIES, categorize, decoysFor, isNegativeKeyword, normalize, phrasesOverlap } from './decoys.js';

export const QUESTION_KINDS = ['spot-the-real', 'odd-one-out', 'category', 'pair-up'];

const PROMPTS = {
  'spot-the-real': [
    'Only one of these is actually a {guest} thing. Which one?',
    'Three of these we made up. Which one is really {guest}?',
    'Which of these would {guest} claim in a heartbeat?',
    'Pick the one that genuinely belongs to {guest}.',
    'One of these is true about {guest}. Place your bets.',
    'Which of these is real, actual, verified {guest}?'
  ],
  'odd-one-out': [
    'Three of these are real {guest} facts. Which one did we invent?',
    'Spot the impostor: which one is NOT {guest}?',
    'One of these is a lie about {guest}. Which one?',
    '{guest}, {guest}, {guest}, and... not {guest}. Which is the fake?',
    'Three truths and a lie. Which is the lie?'
  ],
  'pair-up': [
    'Which pair is BOTH true about {guest}?',
    'Two truths, side by side. Which pair is all real?',
    'Only one of these pairs is fully {guest}. Which?'
  ]
};

const CATEGORY_PROMPTS = [
  "Which of these is {guest}'s {noun}?",
  "Everyone who knows {guest} knows their {noun}. What is it?",
  "Fill in the blank: {guest}'s {noun} is ___"
];

const EXPLANATIONS = {
  'spot-the-real': '“{answer}” is 100% {guest}. The rest were invented.',
  'odd-one-out': '“{answer}” is the fake — the other three are real {guest}.',
  'category': '“{answer}” — pure {guest}.',
  'pair-up': '“{a}” and “{b}” are both real {guest} facts.'
};

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match));
}

/** Trim, drop blanks, drop duplicates. The host's list, cleaned up. */
export function cleanKeywords(keywords) {
  const seen = new Set();
  const out = [];
  for (const raw of keywords ?? []) {
    const text = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!text) continue;
    const key = normalize(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/** Which question kinds a keyword list can support. Short lists lose the wider ones. */
export function availableKinds(keywordCount) {
  const kinds = ['spot-the-real', 'category'];
  if (keywordCount >= 4) kinds.push('odd-one-out');
  if (keywordCount >= 4) kinds.push('pair-up');
  return kinds;
}

/** Place the correct answer at a random index among its decoys. */
function assemble(rng, correct, decoys) {
  const options = rng.shuffle([correct, ...decoys]);
  return { options, answerIndex: options.indexOf(correct) };
}

function buildSpotTheReal({ rng, guestName, keywords, star }) {
  const decoys = decoysFor(star, { rng, exclude: keywords, count: 3 });
  const { options, answerIndex } = assemble(rng, star, decoys);
  return {
    kind: 'spot-the-real',
    prompt: fill(rng.pick(PROMPTS['spot-the-real']), { guest: guestName }),
    options,
    answerIndex,
    explanation: fill(EXPLANATIONS['spot-the-real'], { answer: star, guest: guestName })
  };
}

function buildCategory({ rng, guestName, keywords, star }) {
  // "Which is their comfort food?" cannot be answered with "hates cilantro".
  if (isNegativeKeyword(star)) return buildSpotTheReal({ rng, guestName, keywords, star });
  const category = CATEGORIES[categorize(star)];
  const decoys = decoysFor(star, { rng, exclude: keywords, count: 3 });
  const { options, answerIndex } = assemble(rng, star, decoys);
  return {
    kind: 'category',
    prompt: fill(rng.pick(CATEGORY_PROMPTS), { guest: guestName, noun: category.noun }),
    options,
    answerIndex,
    explanation: fill(EXPLANATIONS.category, { answer: star, guest: guestName })
  };
}

function buildOddOneOut({ rng, guestName, keywords, star }) {
  // Three real keywords (the star plus two companions) hiding one invented fact.
  const companions = rng
    .shuffle(keywords.filter((k) => normalize(k) !== normalize(star)))
    .slice(0, 2);
  const truths = [star, ...companions];
  const [fake] = decoysFor(star, { rng, exclude: keywords, count: 3 });
  if (!fake) return buildSpotTheReal({ rng, guestName, keywords, star });
  const { options, answerIndex } = assemble(rng, fake, truths);
  return {
    kind: 'odd-one-out',
    prompt: fill(rng.pick(PROMPTS['odd-one-out']), { guest: guestName }),
    options,
    answerIndex,
    explanation: fill(EXPLANATIONS['odd-one-out'], { answer: fake, guest: guestName })
  };
}

function buildPairUp({ rng, guestName, keywords, star }) {
  const others = rng.shuffle(keywords.filter((k) => normalize(k) !== normalize(star)));
  const partner = others[0];
  if (!partner) return buildSpotTheReal({ rng, guestName, keywords, star });

  const fakes = decoysFor(star, { rng, exclude: keywords, count: 5 });
  if (fakes.length < 4) return buildOddOneOut({ rng, guestName, keywords, star });

  const join = (a, b) => `${a} + ${b}`;
  const correct = join(star, partner);
  // Each wrong pair carries at most one truth, so exactly one pair is fully real.
  const wrong = [
    join(others[1] ?? star, fakes[0]),
    join(fakes[1], others[2] ?? partner),
    join(fakes[2], fakes[3])
  ];
  const { options, answerIndex } = assemble(rng, correct, wrong);
  return {
    kind: 'pair-up',
    prompt: fill(rng.pick(PROMPTS['pair-up']), { guest: guestName }),
    options,
    answerIndex,
    explanation: fill(EXPLANATIONS['pair-up'], { a: star, b: partner, guest: guestName })
  };
}

const BUILDERS = {
  'spot-the-real': buildSpotTheReal,
  'category': buildCategory,
  'odd-one-out': buildOddOneOut,
  'pair-up': buildPairUp
};

/**
 * Reject a question whose options give the answer away — for example a decoy
 * that shares vocabulary with the real keyword it is meant to hide.
 */
export function questionIsFair(question) {
  if (!question || !Array.isArray(question.options)) return false;
  if (question.options.length < 2) return false;
  if (!Number.isInteger(question.answerIndex)) return false;
  if (question.answerIndex < 0 || question.answerIndex >= question.options.length) return false;
  const seen = new Set();
  for (const option of question.options) {
    const key = normalize(option);
    if (!key || seen.has(key)) return false;
    seen.add(key);
  }
  if (question.kind === 'spot-the-real' || question.kind === 'category') {
    const answer = question.options[question.answerIndex];
    for (let i = 0; i < question.options.length; i++) {
      if (i !== question.answerIndex && phrasesOverlap(answer, question.options[i])) return false;
    }
  }
  return true;
}

/**
 * Build one question. `star` is the keyword the question is built around;
 * omit it and one is chosen from the list.
 */
export function generateQuestion({ guestName, keywords, seed = 1, kind, star, id }) {
  const list = cleanKeywords(keywords);
  if (list.length === 0) throw new Error('At least one keyword is required.');
  const rng = makeRng(seed);
  const kinds = availableKinds(list.length);
  const chosenKind = kinds.includes(kind) ? kind : rng.pick(kinds);
  const chosenStar = list.some((k) => normalize(k) === normalize(star)) ? star : rng.pick(list);

  let question = BUILDERS[chosenKind]({ rng, guestName, keywords: list, star: chosenStar });
  if (!questionIsFair(question)) {
    // Fall back to the simplest shape rather than shipping a broken question.
    question = buildSpotTheReal({ rng, guestName, keywords: list, star: chosenStar });
  }
  return {
    id: id ?? `q_${hashSeed(`${seed}:${chosenStar}`).toString(36)}`,
    source: 'keywords',
    star: chosenStar,
    seed,
    ...question
  };
}

/**
 * Build a full deck. Keywords are rotated so that every one of them stars in at
 * least one question before any keyword repeats, and question kinds alternate so
 * the deck never feels like the same question four times.
 */
export function generateDeck({ guestName = 'our guest of honor', keywords, count = 10, seed = Date.now(), kinds: only } = {}) {
  const list = cleanKeywords(keywords);
  if (list.length < 3) {
    throw new Error('Give me at least 3 keywords — 12 makes the best game.');
  }
  const rng = makeRng(seed);
  const available = availableKinds(list.length);
  const kinds = only?.length ? available.filter((kind) => only.includes(kind)) : available;
  if (!kinds.length) throw new Error('No usable question kinds for this list.');

  // Rotation: shuffle the keywords, walk the list, reshuffle when it runs out.
  let rotation = rng.shuffle(list);
  let rotationIndex = 0;
  const nextStar = () => {
    if (rotationIndex >= rotation.length) {
      rotation = rng.shuffle(list);
      rotationIndex = 0;
    }
    return rotation[rotationIndex++];
  };

  const questions = [];
  const usedPrompts = new Set();
  for (let i = 0; i < count; i++) {
    const kind = kinds[i % kinds.length];
    const star = nextStar();
    let question = null;
    // A few attempts so a repeated prompt or an unfair draw can be re-rolled.
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = generateQuestion({
        guestName,
        keywords: list,
        seed: hashSeed(`${seed}:${i}:${attempt}`),
        kind,
        star,
        id: `q${i + 1}`
      });
      const promptKey = `${candidate.kind}:${candidate.prompt}`;
      if (!usedPrompts.has(promptKey) || attempt === 5) {
        usedPrompts.add(promptKey);
        question = candidate;
        break;
      }
    }
    questions.push({ ...question, index: i });
  }

  return { seed, guestName, keywords: list, questions };
}

/**
 * The offline fallback.
 *
 * When there is no API key, or Claude cannot be reached mid-party, the party
 * still gets a game. These questions are simpler than the written ones — they
 * ask which fact is real rather than what the guest would do — but they are
 * built from the same notes and are playable in the same round.
 */
export function fallbackQuestions({ guestName, topics, count = 12, seed = Date.now() }) {
  const byText = new Map();
  for (const topic of topics ?? []) {
    const key = normalize(topic.text);
    if (key && !byText.has(key)) byText.set(key, topic);
  }
  const texts = [...byText.values()].map((topic) => topic.text);
  // Notes are written as sentences now, not tidy keywords. "Which is their
  // comfort food?" only reads well next to a noun, and pairing two sentences
  // makes an option too long for a phone, so long notes use the plainer shapes.
  const averageLength = texts.reduce((total, text) => total + text.length, 0) / (texts.length || 1);
  const kinds = averageLength > 24
    ? ['spot-the-real', 'odd-one-out']
    : ['spot-the-real', 'odd-one-out', 'category', 'pair-up'];

  const deck = generateDeck({ guestName, keywords: texts, count, seed, kinds });

  return deck.questions.map((question) => {
    // Tie each question back to the notes it used, so their authors sit it out.
    const used = question.options
      .map((option) => byText.get(normalize(option)))
      .filter(Boolean)
      .map((topic) => topic.id);
    const star = byText.get(normalize(question.star ?? ''));
    return {
      id: question.id,
      source: 'notes',
      style: question.kind,
      prompt: question.prompt,
      options: question.options,
      answerIndex: question.answerIndex,
      explanation: question.explanation,
      topicIds: [...new Set(star ? [star.id, ...used] : used)]
    };
  });
}
