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

**1. Import the repo.** Push it to GitHub and open [vercel.com/new](https://vercel.com/new).
There's no build step and no framework to pick — accept the defaults and deploy.

**2. Add the Redis store.** In your new project: **Storage** → **Create Database** →
**Upstash** → **Redis**. Pick the free plan and a region near wherever the party is.
When it asks which project to connect it to, pick this one and tick **all three**
environments (Production, Preview, Development). Vercel writes the credentials into your
environment variables for you.

> **The one thing that catches people out.** Upstash gives you two different ways in: a
> connection string that starts with `redis://`, and a pair of REST credentials. This app
> uses the REST pair, because that is what works from a serverless function. If your
> project ends up with only `REDIS_URL`, open the database in the Upstash console, copy
> **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN** from the REST section, and
> add them to Vercel by hand. `/api/health` tells you if you got this wrong.

**3. Add your Anthropic API key.** **Settings** → **Environment Variables** → add
`ANTHROPIC_API_KEY`, from [console.anthropic.com](https://console.anthropic.com/settings/keys).

**4. Redeploy.** Vercel only picks up new environment variables on a new deployment:
**Deployments** → the top one → **⋯** → **Redeploy**.

**5. Check it.** Visit `https://your-app.vercel.app/api/health`, or run:

```bash
npm run doctor -- https://your-app.vercel.app
```

It tells you whether the store and the key are both live, and what to fix if not.

| Environment variable | Needed? | What happens without it |
|---|---|---|
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Yes, in production | Rooms live in one function's memory and players see each other vanish |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Alternative to the above | Either naming works |
| `ANTHROPIC_API_KEY` | Strongly recommended | Falls back to plainer questions built from the notes |
| `ANTHROPIC_MODEL` | No | Defaults to `claude-opus-5` |
| `ANTHROPIC_EFFORT` | No | Defaults to `high`; drop to `medium` if writing ever times out |

Writing the questions is the one slow request — `vercel.json` gives it 60 seconds, which
is the Hobby plan's maximum.

### If the deployment crashes

**`500: INTERNAL_SERVER_ERROR` / `FUNCTION_INVOCATION_FAILED`.** Check the framework
preset first: **Settings** → **General** → **Framework Preset** must be **Other**. Vercel
sometimes auto-detects this repo as the *Node.js* preset, because `package.json` has a
`main` and a `start` script, and then tries to run `server.js` as the whole app instead of
serving `public/` as static files with `api/` as functions. `vercel.json` pins
`"framework": null` to prevent it; if the dashboard still shows something else, change it
there and redeploy.

**Guests get a login screen.** Vercel Authentication protects every `*.vercel.app` URL
by default on some accounts, so the owner can open the app and nobody else can. Turn it
off at **Settings** → **Deployment Protection** → **Vercel Authentication**. The game
still needs a room code to join, so the link alone gives nothing away.

**Buttons that do nothing.** The page now says why. A banner across the top names the
problem — the API not answering, or no database connected — and if the app script itself
fails to load, a guard that runs without it puts that on the page too. A dead button with
no message should no longer be possible.

Then narrow it down with two URLs:

| URL | What it means |
|---|---|
| `/api/ping` fails too | The project's build or runtime settings are wrong — start with the framework preset above. `ping` imports nothing, so it cannot fail on this app's own code. |
| `/api/ping` works, `/api/health` does not | The fault is in the app. `/api/health` now answers with the error message and a short stack instead of a blank crash page. |

`/api/ping` also reports which environment variables the function can see — as true/false,
never their values — which is the quickest way to spot a variable that was added but never
picked up, because Vercel only applies new variables on a new deployment.

## Or run it at home

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... node server.js
```

Rooms are kept in memory, so no Redis is needed. The terminal prints an address like
`http://192.168.1.42:3000` for everyone else on the wifi.

`npm run doctor` checks this machine the same way, including a real write and read
against whatever Redis you have configured.

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
test/              102 tests
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
