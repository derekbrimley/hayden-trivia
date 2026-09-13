/**
 * The Claude question writer, exercised against a stub client — these tests
 * never touch the network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { writeQuestions, validateQuestion, STYLES } from '../src/llm.js';

const TOPICS = [
  { id: 't1', text: 'always cold, hoodie indoors', playerId: 'p1' },
  { id: 't2', text: 'reads three books at once', playerId: 'p1' },
  { id: 't3', text: 'refuses to eat olives', playerId: 'p2' },
  { id: 't4', text: 'names every houseplant', playerId: 'p2' },
  { id: 't5', text: 'keeps every receipt since 2014', playerId: 'p3' },
  { id: 't6', text: 'up before sunrise, always', playerId: 'p3' }
];

function goodQuestion(n = 1) {
  return {
    style: 'situation',
    prompt: `It is 78 degrees out. Hayden walks in. What are they wearing? (${n})`,
    options: ['A hoodie, zipped up', 'A summer dress', 'A tank top', 'Shorts and sandals'],
    answerIndex: 0,
    explanation: 'Always cold, always a hoodie.',
    usesTopicIds: ['t1']
  };
}

/** A stand-in for the Anthropic client: records calls, returns canned JSON. */
function stubClient(responder) {
  const calls = [];
  const reply = (prompt) => {
    const payload = responder(prompt, calls.length - 1); // calls already includes this one
    if (payload instanceof Error) throw payload;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(payload) }] };
  };
  return {
    calls,
    beta: {
      messages: {
        create: async (params) => {
          calls.push({ params, beta: true });
          return reply(params.messages[0].content);
        }
      }
    },
    messages: {
      create: async (params) => {
        calls.push({ params, beta: false });
        return reply(params.messages[0].content);
      }
    }
  };
}

test('a well-formed question survives validation', () => {
  const result = validateQuestion(goodQuestion(), new Set(['t1']));
  assert.ok(result);
  assert.equal(result.answerIndex, 0);
  assert.deepEqual(result.topicIds, ['t1']);
  assert.equal(result.source, 'claude');
});

test('validation rejects questions the room could not play', () => {
  const ids = new Set(['t1']);
  assert.equal(validateQuestion({ ...goodQuestion(), options: ['a', 'b', 'c'] }, ids), null, 'needs four options');
  assert.equal(validateQuestion({ ...goodQuestion(), options: ['a', 'a', 'b', 'c'] }, ids), null, 'no duplicates');
  assert.equal(validateQuestion({ ...goodQuestion(), answerIndex: 7 }, ids), null, 'answer must exist');
  assert.equal(validateQuestion({ ...goodQuestion(), prompt: '   ' }, ids), null, 'needs a prompt');
  assert.equal(validateQuestion(null, ids), null);
});

test('validation rejects an option long enough to give itself away', () => {
  const giveaway = {
    ...goodQuestion(),
    options: [
      'A hoodie, zipped up, because they are always freezing no matter the weather',
      'Shorts', 'A tee', 'Sandals'
    ]
  };
  assert.equal(validateQuestion(giveaway, new Set(['t1'])), null);
});

test('validation drops topic ids the room does not have', () => {
  const result = validateQuestion({ ...goodQuestion(), usesTopicIds: ['t1', 'made-up'] }, new Set(['t1']));
  assert.deepEqual(result.topicIds, ['t1']);
});

test('questions are written in parallel batches, each owning some notes', async () => {
  const client = stubClient(() => ({ questions: [goodQuestion(Math.random())] }));
  const result = await writeQuestions({ guestName: 'Hayden', topics: TOPICS, count: 8, client });

  assert.equal(client.calls.length, 2, '8 questions at 4 per batch is two calls');
  assert.ok(result.questions.length > 0);
  assert.equal(result.batchesFailed, 0);

  // Every note is handed to some batch, and each batch is told about all of them.
  const focusBlocks = client.calls.map((call) => call.params.messages[0].content.split('BUILD THIS BATCH AROUND')[1]);
  for (const topic of TOPICS) {
    assert.ok(focusBlocks.some((block) => block.includes(topic.id)), `${topic.id} was never focused on`);
    assert.ok(client.calls.every((call) => call.params.messages[0].content.includes(topic.text)));
  }
});

test('one failed batch still yields a game', async () => {
  const client = stubClient((prompt, index) => (
    index === 0 ? new Error('overloaded') : { questions: [goodQuestion(index)] }
  ));
  const result = await writeQuestions({ guestName: 'Hayden', topics: TOPICS, count: 8, client });
  assert.equal(result.batchesFailed, 1);
  assert.ok(result.questions.length > 0);
});

test('every batch failing is an error the host can act on', async () => {
  const client = stubClient(() => new Error('rate limited'));
  await assert.rejects(
    () => writeQuestions({ guestName: 'Hayden', topics: TOPICS, count: 4, client }),
    /rate limited/
  );
});

test('a refusal is reported rather than returned as a question', async () => {
  const client = {
    beta: {
      messages: {
        create: async () => ({ stop_reason: 'refusal', stop_details: { category: 'other' }, content: [] })
      }
    },
    messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) }
  };
  await assert.rejects(
    () => writeQuestions({ guestName: 'Hayden', topics: TOPICS, count: 4, client }),
    /declined/i
  );
});

test('an API that rejects the fallback beta is retried without it', async () => {
  const calls = [];
  const client = {
    beta: {
      messages: {
        create: async (params) => {
          calls.push('beta');
          const error = new Error('unknown beta');
          error.status = 400;
          throw error;
        }
      }
    },
    messages: {
      create: async (params) => {
        calls.push('plain');
        assert.equal(params.fallbacks, undefined, 'the retry must not carry beta-only fields');
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ questions: [goodQuestion()] }) }] };
      }
    }
  };
  const result = await writeQuestions({ guestName: 'Hayden', topics: TOPICS, count: 4, client });
  assert.deepEqual(calls, ['beta', 'plain']);
  assert.equal(result.questions.length, 1);
});

test('near-identical questions are not asked twice', async () => {
  const client = stubClient(() => ({ questions: [goodQuestion(1), goodQuestion(1)] }));
  const result = await writeQuestions({ guestName: 'Hayden', topics: TOPICS, count: 4, client });
  assert.equal(result.questions.length, 1);
});

test('the brief tells the model what a good question looks like', async () => {
  const client = stubClient(() => ({ questions: [goodQuestion()] }));
  await writeQuestions({ guestName: 'Hayden', topics: TOPICS, count: 4, client });
  const prompt = client.calls[0].params.messages[0].content;

  assert.match(prompt, /asks about the person/i, 'the core instruction is present');
  assert.match(prompt, /Hayden/, 'the guest is named');
  assert.match(prompt, /never mean/i, 'the tone guardrail is present');
  for (const style of STYLES) assert.ok(prompt.includes(style), `style ${style} is offered`);
  assert.equal(client.calls[0].params.model, 'claude-opus-5');
  assert.equal(client.calls[0].params.output_config.format.type, 'json_schema');
});

test('a reply wrapped in a code fence is still read', async () => {
  const { parseQuestionJson } = await import('../src/llm.js');
  const payload = { questions: [goodQuestion()] };
  assert.deepEqual(parseQuestionJson(JSON.stringify(payload)), payload);
  assert.deepEqual(parseQuestionJson('```json\n' + JSON.stringify(payload) + '\n```'), payload);
  assert.deepEqual(parseQuestionJson('Here you go:\n' + JSON.stringify(payload)), payload);
});

test('an API that knows neither the beta nor structured output still works', async () => {
  const seen = [];
  const badRequest = () => Object.assign(new Error('unknown parameter'), { status: 400 });
  const client = {
    beta: { messages: { create: async () => { seen.push('beta'); throw badRequest(); } } },
    messages: {
      create: async (params) => {
        if (params.output_config) { seen.push('schema'); throw badRequest(); }
        seen.push('plain');
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '```json\n' + JSON.stringify({ questions: [goodQuestion()] }) + '\n```' }]
        };
      }
    }
  };
  const result = await writeQuestions({ guestName: 'Hayden', topics: TOPICS, count: 4, client });
  assert.deepEqual(seen, ['beta', 'schema', 'plain']);
  assert.equal(result.questions.length, 1);
});

test('a real failure is not mistaken for an old API', async () => {
  const client = {
    beta: { messages: { create: async () => { throw Object.assign(new Error('overloaded'), { status: 529 }); } } },
    messages: { create: async () => { throw new Error('should not be reached'); } }
  };
  await assert.rejects(() => writeQuestions({ guestName: 'Hayden', topics: TOPICS, count: 4, client }), /overloaded/);
});
