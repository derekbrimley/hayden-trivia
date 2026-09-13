# Guest of Honor Trivia

A party game about the person everyone came to celebrate.

Everyone opens the same link and writes down a few things they know about the guest of
honor. Claude turns the pile of notes into trivia — not "which of these is their hobby",
but the questions that make the room shout *that is so them*. Then you all play on your
phones and find out who actually knows them best.

Works in a living room or across three time zones. Nobody installs anything.

```
   everyone joins            everyone writes notes            Claude writes questions
   ┌──────────┐              ┌──────────────────┐             ┌────────────────────────┐
   │  ABCD    │      →       │ always cold      │      →      │ It's 78 degrees out.   │
   │  join    │              │ hates olives     │             │ Hayden walks in. What  │
   └──────────┘              │ names her plants │             │ are they wearing?      │
                             └──────────────────┘             └────────────────────────┘
```

## Deploy it

The game needs somewhere to keep a room between requests, because serverless functions
forget everything the moment they return. That's one Redis store and one API key.

1. **Push this repo to GitHub** and import it at [vercel.com/new](https://vercel.com/new).
   There's no build step and no framework to pick.
2. **Add a Redis store.** In your Vercel project: Storage → Create → Upstash Redis. Vercel
   sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you. (Any Upstash database works —
   set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` instead.)
3. **Add your Anthropic API key** as the `ANTHROPIC_API_KEY` environment variable, from
   [console.anthropic.com](https://console.anthropic.com/settings/keys).
4. Redeploy, open the URL, and send it to everyone.

| Environment variable | Needed? | What happens without it |
|---|---|---|
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Yes, in production | Rooms live in one function's memory and players see each other vanish |
| `ANTHROPIC_API_KEY` | Strongly recommended | Falls back to plainer questions built from the notes |
| `ANTHROPIC_MODEL` | No | Defaults to `claude-opus-5` |
| `ANTHROPIC_EFFORT` | No | Defaults to `high`; drop to `medium` if writing ever times out |

Writing the questions is the one slow request — `vercel.json` gives it 60 seconds, which
is the Hobby plan's maximum.

## Or run it at home

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... node server.js
```

Rooms are kept in memory, so no Redis is needed. The terminal prints an address like
`http://192.168.1.42:3000` for everyone else on the wifi.

To see what the questions look like before you gather anyone:

```bash
npm run preview                 # writes a sample set
npm run preview -- --show-prompt   # prints the brief Claude is given
npm run preview -- --guest Alex --note "always cold" --note "hates olives"
```

## How a game goes

1. **Someone starts a room** with the guest of honor's name and gets a four-letter code.
2. **Everyone joins** with the code or the invite link, on their own phone.
3. **Everyone writes notes** — three things each by default. Nobody sees anyone else's.
4. **The host presses "Write the questions"** and waits a few seconds.
5. **You play.** A question at a time, everyone answering on their own screen, with a
   leaderboard after each one.

The guest of honor can play too. They will lose, which is the fun of it.

### Writing notes that make good questions

The note is the raw material, so specific beats broad every time.

| Weak note | Better note |
|---|---|
| `likes coffee` | `orders the same drink and still reads the menu` |
| `funny` | `does an impression of her own dad, unprompted` |
| `from Idaho` | `will bring up Idaho within ten minutes of meeting you` |
| `likes to read` | `reads three books at once and finishes none` |

The app's placeholders nudge in that direction: *something they always say*, *a story
they retell every time*, *an opinion they will defend forever*.

### Sitting out your own notes

If a question came from something you wrote, your screen says so and you sit that one
out — no points, no penalty, no pretending you didn't know. With fewer than three people
in the room, or when a question drew on almost everyone's notes, benching is skipped so
there's always somebody left to answer.

## How the questions get written

The notes go to Claude with a brief that spends most of its length on one distinction:

> A weak question asks about the note. A strong question asks about the person, and the
> note is how you check the answer.
>
> Note: *"always cold, wears a hoodie indoors"*
> Weak: Which of these is true about Sam?
> Strong: It is 78 degrees. Sam walks into the room. What is Sam wearing?

Eight question shapes rotate through a game — dropping them into a small everyday scene,
the fastest way to tell whose car you're in, what they'd save from a fire, three truths
and a lie, which pair is both true, what their friends call them about, what happens on a
free evening, and which opinion they'd defend loudest.

Writing happens in small parallel batches, each owning a slice of the notes. That keeps
every request short enough for a serverless timeout and spreads the notes across the game
instead of letting one person's dominate. Every question is checked before it reaches the
room: four distinct options, an answer that exists, and no option so much longer than the
others that it gives itself away. Anything that fails is dropped.

If Claude can't be reached mid-party, the game falls back to questions built from the
notes by a local generator that needs no network, and tells you it did.

## Scoring

| | |
|---|---|
| Correct answer | 600 points |
| Speed bonus | up to 400 more, scaled by the time left |
| Streak bonus | +50 per answer in a row, capped at +200 |
| Wrong, missed, or sat out | nothing — though sitting out doesn't break a streak |

## How it's put together

```
public/            the whole app: one page everyone opens
api/[...path].js   Vercel entry point
server.js          the same thing locally, plus static files
src/router.js      every endpoint, shared by both entry points
src/game.js        rules: phases, scoring, who may see what
src/llm.js         the brief, the batching, and the validation
src/questions.js   the offline fallback generator
src/store.js       Redis in production, memory locally
test/              96 tests
```

There are no sockets. Serverless functions don't stay connected, so every device polls
for the room state — faster during a question, slower in the lobby. Phases move on their
own: whoever polls after a deadline nudges the game forward, and a lock makes sure only
one of them does it, because closing a round awards points.

A room is stored as four separate pieces — the room, the players, the notes, the answers
to the current question — each field written by exactly one device. Two people answering
at the same instant cannot overwrite each other.

```bash
npm test
```

The suite covers scoring and streaks, who is allowed to see the answer, the note-author
bench, self-advancing phases, single-scoring under concurrent polling, the question
validator, the Redis wire format (against a stand-in server), and a full three-player
game through the API.

## Privacy

Notes never leave the room: no player's device is ever sent another player's notes, only
the count. They're held in Redis for twelve hours and expire on their own. The guest of
honor's name and the notes are sent to the Claude API when questions are written — that's
the only thing that leaves your deployment, and it doesn't happen at all without an API key.
