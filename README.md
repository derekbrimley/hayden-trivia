# Guest of Honor Trivia

A multiplayer party game about the person everyone came to celebrate.

You give it twelve keywords about the guest of honor. It turns them into a round of
multiple-choice trivia, puts the questions on the big screen, and everyone else plays
along on their phones. Fastest correct answer wins the round; the leaderboard decides
who actually knows the guest best.

Built for birthdays, retirements, going-away parties, showers, and any other excuse to
embarrass someone affectionately.

```
┌──────────────────────────────┐        ┌──────────┐ ┌──────────┐ ┌──────────┐
│  Which of these is really    │        │  ▲   ◆   │ │  ▲   ◆   │ │  ▲   ◆   │
│  a Hayden thing?             │   ⟵    │          │ │          │ │          │
│  ▲ pottery  ◆ postcards      │        │  ●   ■   │ │  ●   ■   │ │  ●   ■   │
│  ● rock climbing  ■ homebrew │        └──────────┘ └──────────┘ └──────────┘
└──────────────────────────────┘           phones answering in the room
      laptop on the TV
```

## Run it

No install step, no build step, no accounts, no internet:

```bash
node server.js
```

Then:

1. Open the **host screen** at `http://localhost:3000/host` on the laptop you've plugged
   into the TV.
2. Type the guest's name and twelve keywords, and press **Build the game**.
3. Everyone else opens the address the server printed (something like
   `http://192.168.1.42:3000`) and enters the four-letter room code.
4. Press **Start the game**.

Everyone needs to be on the same wifi. The terminal prints the exact address to read out.

Optional extras, both of which the game runs happily without:

```bash
npm install          # adds a scannable QR code to the join screen
export ANTHROPIC_API_KEY=sk-ant-...   # adds a "Write with Claude" button
```

## Picking the twelve keywords

Anything true about the guest works. The mix matters more than the wording — a spread
across categories gives the generator more to play with:

| Good keyword | Why it works |
|---|---|
| `rock climbing` | A hobby, so the fake options can be other hobbies |
| `hates cilantro` | Dislikes are great; the game knows not to call it a favourite |
| `grew up in Idaho` | Places make believable decoys |
| `golden retriever named Moose` | Specific and personal |
| `quotes The Office daily` | Everyone in the room will nod |
| `terrible at board games` | Affectionate weaknesses land well |

Short phrases beat sentences. Twelve is the sweet spot; three is the minimum.

## How questions get made

The generator treats your keywords as the only truth about the guest, then hides them
among invented options drawn from a decoy bank of 160 believable alternatives across twelve categories.
Each keyword is sorted into a category — food, hobby, place, pet, music, quirk and so on —
so the wrong answers look like the right one instead of like a non sequitur.

Four shapes, rotated so a round never feels repetitive:

- **Which one is real** — one true keyword hiding among three invented ones.
- **Spot the lie** — three true keywords and one invention.
- **Signature** — "which of these is their go-to comfort food?", using the keyword's category.
- **Pairs** — four pairs of facts, exactly one of which is true all the way through.

Every keyword stars in at least one question before any of them repeats. Decks are
reproducible: the same seed always produces the same deck, and **Reshuffle all** just
draws a new one.

The generator is a best guess, so the host screen lets you fix it before anyone plays:
edit any prompt or option, move the green dot to the true answer, reroll a single
question, reorder them, delete the duds, or write your own from scratch. Questions you
write yourself sit alongside generated ones.

With an `ANTHROPIC_API_KEY` set, **Write with Claude** swaps the template engine for
Claude Opus 5, which writes sharper and funnier questions from the same twelve keywords.
Anything it returns that isn't answerable falls back to a generated question, and you
still get to edit everything before you start.

## Scoring

| | |
|---|---|
| Correct answer | 600 points |
| Speed bonus | up to 400 more, scaled by how much time was left |
| Streak bonus | +50 per answer in a row, capped at +200 |
| Wrong or missed | nothing, and the streak resets |

Fast and right beats slow and right; the streak bonus keeps a runaway leader catchable.

## Host controls

Once a game is running the host screen owns the pace: **Reveal now** cuts a question
short, **Next question** moves on, and the round reveals itself automatically when
everyone has answered or the clock runs out. After the last question you get a podium,
plus **Play again with the same deck** and **Fresh questions**.

Players who arrive late can still join — they just start from zero. Locking a phone or
refreshing the page rejoins the same player.

## Settings

| Setting | Default | Where |
|---|---|---|
| Questions per game | 12 | Host setup screen |
| Seconds per question | 25 | Host setup screen |
| Seconds on the answer | 10 | Host setup screen |
| Port | 3000 | `PORT=8080 node server.js` |
| Claude model | `claude-opus-5` | `ANTHROPIC_MODEL` |

## How it's put together

```
server.js          HTTP + Server-Sent Events; one room per four-letter code
src/questions.js   keywords → questions (the part that makes the game work)
src/decoys.js      category detection and the believable-lie bank
src/game.js        rooms, players, phases, scoring — no I/O, easy to test
src/llm.js         optional Claude-written questions
src/rng.js         seeded randomness, so decks are reproducible
public/            host screen, player screen, one stylesheet
test/              40 tests: generator fairness, game rules, full HTTP playthrough
```

Realtime updates are Server-Sent Events rather than websockets, which keeps the whole
server inside Node's standard library. The server is the referee: it owns the clock,
decides what counts as correct, and never sends a player the answer before the reveal —
there is a test for exactly that.

```bash
npm test
```

## Privacy

Nothing is written to disk and nothing leaves the machine. Rooms live in memory and
disappear when the server stops, or a few hours after the last activity. The one
exception is **Write with Claude**, which sends the guest's name and your twelve
keywords to the Claude API; skip that button and the game never touches the network.
