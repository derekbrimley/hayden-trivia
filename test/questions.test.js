import test from 'node:test';
import assert from 'node:assert/strict';

import { generateDeck, generateQuestion, cleanKeywords, questionIsFair, availableKinds } from '../src/questions.js';
import { categorize, decoysFor, isNegativeKeyword, normalize, phrasesOverlap } from '../src/decoys.js';
import { makeRng } from '../src/rng.js';

const KEYWORDS = [
  'rock climbing', 'hates cilantro', 'grew up in Idaho', 'golden retriever named Moose',
  'knows every Taylor Swift lyric', 'wears the same flannel constantly', 'Dr Pepper with breakfast',
  'quotes The Office daily', 'can juggle', 'camping in the rain', 'awake at 5am', 'terrible at board games'
];

test('cleanKeywords trims, de-duplicates and drops blanks', () => {
  const result = cleanKeywords(['  climbing ', 'climbing', '', null, 'Climbing', 'baking']);
  assert.deepEqual(result, ['climbing', 'baking']);
});

test('the same seed always produces the same deck', () => {
  const a = generateDeck({ guestName: 'Hayden', keywords: KEYWORDS, count: 8, seed: 99 });
  const b = generateDeck({ guestName: 'Hayden', keywords: KEYWORDS, count: 8, seed: 99 });
  assert.deepEqual(a.questions, b.questions);
});

test('different seeds produce different decks', () => {
  const a = generateDeck({ guestName: 'Hayden', keywords: KEYWORDS, count: 8, seed: 1 });
  const b = generateDeck({ guestName: 'Hayden', keywords: KEYWORDS, count: 8, seed: 2 });
  assert.notDeepEqual(a.questions, b.questions);
});

test('every generated question is answerable and fair', () => {
  for (let seed = 0; seed < 60; seed++) {
    const { questions } = generateDeck({ guestName: 'Hayden', keywords: KEYWORDS, count: 12, seed });
    assert.equal(questions.length, 12);
    for (const question of questions) {
      assert.ok(question.prompt.length > 0, 'prompt must not be empty');
      assert.equal(question.options.length, 4);
      assert.ok(questionIsFair(question), `unfair question from seed ${seed}: ${JSON.stringify(question)}`);
      assert.ok(question.options[question.answerIndex], 'the answer must be a real option');
      assert.ok(question.explanation.length > 0);
    }
  }
});

test('the guest name reaches the questions', () => {
  const { questions } = generateDeck({ guestName: 'Priya', keywords: KEYWORDS, count: 6, seed: 5 });
  assert.ok(questions.some((question) => question.prompt.includes('Priya')));
});

test('a deck spreads across the keyword list instead of repeating one', () => {
  const { questions } = generateDeck({ guestName: 'Hayden', keywords: KEYWORDS, count: 12, seed: 7 });
  const stars = new Set(questions.map((question) => question.star));
  assert.ok(stars.size >= 10, `expected most keywords to star, got ${stars.size}`);
});

test('"which one is real" questions hide exactly one true keyword', () => {
  const truth = new Set(KEYWORDS.map(normalize));
  for (let seed = 0; seed < 40; seed++) {
    const question = generateQuestion({
      guestName: 'Hayden', keywords: KEYWORDS, seed, kind: 'spot-the-real'
    });
    const real = question.options.filter((option) => truth.has(normalize(option)));
    assert.equal(real.length, 1, `seed ${seed}: ${JSON.stringify(question.options)}`);
    assert.equal(normalize(question.options[question.answerIndex]), normalize(real[0]));
  }
});

test('"spot the lie" questions hide exactly one invented option', () => {
  const truth = new Set(KEYWORDS.map(normalize));
  for (let seed = 0; seed < 40; seed++) {
    const question = generateQuestion({
      guestName: 'Hayden', keywords: KEYWORDS, seed, kind: 'odd-one-out'
    });
    if (question.kind !== 'odd-one-out') continue;
    const fakes = question.options.filter((option) => !truth.has(normalize(option)));
    assert.equal(fakes.length, 1, `seed ${seed}: ${JSON.stringify(question.options)}`);
    assert.equal(normalize(question.options[question.answerIndex]), normalize(fakes[0]));
  }
});

test('pair questions have exactly one fully true pair', () => {
  const truth = new Set(KEYWORDS.map(normalize));
  for (let seed = 0; seed < 40; seed++) {
    const question = generateQuestion({ guestName: 'Hayden', keywords: KEYWORDS, seed, kind: 'pair-up' });
    if (question.kind !== 'pair-up') continue;
    const bothTrue = question.options.filter((option) =>
      option.split(' + ').every((half) => truth.has(normalize(half))));
    assert.equal(bothTrue.length, 1, `seed ${seed}: ${JSON.stringify(question.options)}`);
    assert.equal(question.options[question.answerIndex], bothTrue[0]);
  }
});

test('a short keyword list still produces a playable deck', () => {
  const { questions } = generateDeck({ guestName: 'Sam', keywords: ['bagels', 'ska music', 'Vermont'], count: 5, seed: 3 });
  assert.equal(questions.length, 5);
  for (const question of questions) assert.ok(questionIsFair(question));
});

test('fewer than three keywords is refused', () => {
  assert.throws(() => generateDeck({ guestName: 'Sam', keywords: ['bagels'], count: 5 }), /at least 3 keywords/i);
});

test('kinds needing several keywords are withheld from short lists', () => {
  assert.deepEqual(availableKinds(3), ['spot-the-real', 'category']);
  assert.ok(availableKinds(12).includes('pair-up'));
});

test('decoys avoid the real keywords and their vocabulary', () => {
  const rng = makeRng(11);
  const decoys = decoysFor('wears the same flannel constantly', { rng, exclude: KEYWORDS, count: 3 });
  assert.equal(decoys.length, 3);
  for (const decoy of decoys) {
    assert.ok(!decoy.toLowerCase().includes('flannel'), `decoy leaked the keyword: ${decoy}`);
    for (const keyword of KEYWORDS) assert.ok(!phrasesOverlap(decoy, keyword), `decoy overlaps "${keyword}": ${decoy}`);
  }
});

test('keywords are sorted into sensible decoy categories', () => {
  assert.equal(categorize('hates cilantro'), 'food');
  assert.equal(categorize('rock climbing'), 'activity');
  assert.equal(categorize('golden retriever named Moose'), 'animal');
  assert.equal(categorize('grew up in Idaho'), 'travel');
  assert.equal(categorize('Dr Pepper with breakfast'), 'drink');
});

test('questionIsFair rejects duplicates and out-of-range answers', () => {
  assert.equal(questionIsFair({ kind: 'custom', options: ['a', 'a', 'b', 'c'], answerIndex: 0 }), false);
  assert.equal(questionIsFair({ kind: 'custom', options: ['a', 'b'], answerIndex: 5 }), false);
  assert.equal(questionIsFair({ kind: 'custom', options: ['a', 'b'], answerIndex: 1 }), true);
});

test('things the guest dislikes are never framed as a favourite', () => {
  const negatives = ['hates cilantro', 'terrible at board games', "can't whistle", 'allergic to cats'];
  for (let seed = 0; seed < 40; seed++) {
    for (const star of negatives) {
      const question = generateQuestion({
        guestName: 'Hayden', keywords: KEYWORDS.concat(negatives), seed, kind: 'category', star
      });
      assert.notEqual(question.kind, 'category',
        `"${star}" should not headline a preference question: ${question.prompt}`);
    }
  }
});

test('a whole deck never asks for a favourite that the guest dislikes', () => {
  const negativeSet = new Set(['hates cilantro', 'terrible at board games'].map(normalize));
  for (let seed = 0; seed < 30; seed++) {
    const { questions } = generateDeck({ guestName: 'Hayden', keywords: KEYWORDS, count: 12, seed });
    for (const question of questions) {
      if (question.kind === 'category') {
        assert.ok(!negativeSet.has(normalize(question.star)),
          `seed ${seed} asked "${question.prompt}" about "${question.star}"`);
      }
    }
  }
});
