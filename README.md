# context-policy

Per-model context compaction for the [pi coding agent](https://pi.dev).

pi has two settings that decide when your session gets summarised and how much of it survives. They
are global: one pair of numbers for every model you use.

That works fine if you always run the same model. The moment you switch between a small context and
a large one, the same number is far too early for one and far too late for the other — and too late
means the model runs out of room in the middle of an answer, and pi has to throw the turn away and
start over.

This extension computes both from whatever model is loaded.

## What goes wrong without it

The defaults are `reserveTokens: 16384` — compact once the context comes within 16k of full — and
`keepRecentTokens: 20000` — keep the last 20k of conversation, summarise everything older.

**The trigger drifts with the window.** Reserving 16k out of 256k is nothing, so compaction waits
until 94% — plenty late. Reserving 16k out of 32k is half the model, so compaction fires at 50%. At
16k it is the entire window: the session is over the threshold before you have typed anything.

**The tail can be larger than the window.** Keeping "the last 20k" of a 16k model leaves nothing to
summarise. pi goes looking for a cut point, finds the whole conversation is smaller than the tail it
is supposed to keep, and quietly does nothing — while the threshold keeps firing every single turn.

**The reserve can be smaller than the answer.** A model allowed 32k of output, sitting behind a 16k
reserve, can run past the end of the window before the threshold is ever reached. pi catches it,
drops the turn, compacts and replays. Nothing breaks, but you paid for a generation you will never
see.

And one that has nothing to do with the numbers: **pi only looks between prompts.** The check happens
after the whole tool loop has finished, so a single "go fix the failing tests" that fans out into
forty tool calls is never checked while it runs. You find out where the limit was when the reply
stops mid-sentence.

## What it does instead

From the loaded model's context window `W` and its output limit `M`:

| Number | Worked out as | What it is for |
|---|---|---|
| `reserve` | `min(max(M × 1.1, 4096), max(W × 0.30, 2048))` | room held back for the reply |
| `threshold` | `W − reserve` | compact here |
| `keep` | `clamp(threshold × 0.35, 2000, 48000)` | conversation kept word for word |
| `summary cap` | `clamp(reserve × 0.5, 1024, min(M, 8192))` | output limit for the summary itself |

Hold back enough room for the longest answer the model is allowed to give, but never more than 30% of
the window, down to a floor of 2048. Compact when the rest fills up. Keep about a third of the usable
window as real conversation, so there is always roughly two thirds of the way to go before the next
compaction. A model that declares no output limit is treated as if it had 4096.

| Window | Max output | Compacts at | Keeps |
|---|---|---|---|
| 8192 | 2048 | 5735 (70%) | 2007 |
| 16384 | 4096 | 11878 (72%) | 4157 |
| 32768 | 8192 | 23757 (73%) | 8314 |
| 65536 | 8192 | 56525 (86%) | 19783 |
| 65536 | 16384 | 47514 (73%) | 16629 |
| 131072 | 16384 | 113050 (86%) | 39567 |
| 131072 | 32768 | 95027 (72%) | 33259 |
| 262144 | 32768 | 226099 (86%) | 48000 (capped) |

Two models with the same window can land in different places, and that is the point: the one allowed
to write twice as much needs twice the room to write it in. The last row hits the 48k ceiling on
`keep` — past roughly 140k of window the kept tail stops growing.

The `maxTokens` in your model config is a real input here, not decoration. It is what pi sends as
`max_tokens`, so it is exactly what the reserve has to cover. If anything removes that limit from the
request, generation is bounded only by the window and this calculation rests on nothing.

## Install

Needs pi 0.80.4 or newer, for the `agent_settled` event, which fires when a run finishes. Developed
against 0.84.2. Nothing enforces this: pi ignores a handler for an event it doesn't know, so on an
older build the extension simply loses the end-of-run trigger and keeps the mid-run one.

As a package:

```bash
pi install git:github.com/somewhat-useful/context-policy
```

Or just put the folder where pi looks. There is no build step; pi runs the TypeScript as it is:

```bash
git clone https://github.com/somewhat-useful/context-policy ~/.pi/agent/extensions/context-policy
```

## The two settings you still have to change

An extension cannot switch pi's own compaction off, only postpone it, so pi's numbers have to sit
behind the policy's. Behind is decided by whichever of your models produces the smallest numbers —
usually the one with the smallest output limit, not the smallest window, because the reserve is
driven by `maxTokens` until the window gets small enough for the 30% cap to bite.

So run `/context-policy` under each model you use and note the lowest reserve and the lowest keep you
see. Then:

- **`reserveTokens` below that lowest reserve.** A smaller reserve means a later threshold, which is
  what you want here: pi waits, the extension goes first. Get it wrong and pi tries to compact ahead
  of the policy on every turn while the extension cancels it, which shows up as a repeating
  "Auto-compaction cancelled" line.
- **`keepRecentTokens` at or below the lowest keep.** This is the number pi uses to decide whether
  there is anything worth compacting at all. Too large, and it answers "nothing to do" before the
  extension is ever asked where to cut.

```json
"compaction": {
  "enabled": true,
  "reserveTokens": 8192,
  "keepRecentTokens": 4000
}
```

Those two values suit a fleet whose weakest row is a 32k window with an 8k output limit: reserve 9011
and keep 8314, both cleared. Swap in a model with a 4k output limit and the ceiling drops to reserve
4506 and keep 4157, so `4096` and `4000` would be the numbers instead. The window alone will not tell
you — read the numbers off the command.

Do not race to the bottom, though. These are also what pi uses on its own: when summarising fails and
it falls back to its own compaction, and on any machine where the extension isn't loaded. A reserve
of 512 satisfies the rule and leaves you with no fallback worth having.

Leave `enabled` alone. Turning it off also turns off pi's recovery from a context overflow, which is
the safety net under everything here.

## Check that it took

```
/context-policy
```

```
Example Model (local/example-model)
window 65,536, max output 8,192
compact at 56,525 (86%), reserve 9,011
keep 19,783 recent, summary cap 4,505
now 38,410 (59%)
pi settings: reserve 8,192, keep 4,000
```

Any line starting with `!` is a problem with your pi compaction settings, and says what to change.
The same check runs once when a session starts.

## How it works

| Hook | What happens |
|---|---|
| `turn_end` | The mid-run guard. This fires after every model reply and its tool results — the only place inside a running task where the context can be measured at all. Past the threshold it compacts and puts the task back on its feet. A reply with no tool calls means the run is ending anyway, so it is left alone. |
| `agent_settled` | The ordinary case: compacts at the threshold once the run has finished. |
| `session_before_compact` | Cancels pi's own threshold-triggered compaction while the context is still below the policy threshold; `/compact` and overflow recovery always go through. Otherwise it takes over — picks the cut point from `keep`, summarises everything older using the current model, and hands back the summary along with a running list of files read and changed. |
| `session_start` | Warns once, at startup, if either of the two settings above is in the way. |

The summary is a checkpoint with a fixed shape: goal, constraints, what's done, what's in progress,
what's blocked, decisions and why, next steps. On a session that has been compacted before, the
previous summary goes in with it and comes back updated, so you end up with one continuous record
rather than a summary of a summary of a summary. `/compact <instructions>` still works — whatever you
type is appended to the summarising prompt.

If any of it fails, the extension steps aside and pi's own compaction runs.

## Tuning

The policy is the constants at the top of `index.ts`. These are the ones worth touching:

- `OUTPUT_HEADROOM` — the reserve is the model's output limit times this…
- `MIN_RESERVE_TOKENS` — …but never below this, which is what really decides the reserve for any
  model whose output limit is under about 3.7k.
- `MAX_RESERVE_SHARE_OF_WINDOW` — and never more of the window than this.
- `KEEP_SHARE_OF_THRESHOLD` — the kept tail, as a share of the threshold.
- `MAX_KEEP_TOKENS` — a ceiling on that tail, for very large windows.
- `MIN_KEEP_TOKENS` — doubles as the on/off switch: a window that cannot clear this once the reserve
  is taken out gets no policy at all.

The reserve is `min(max(M × OUTPUT_HEADROOM, MIN_RESERVE_TOKENS), …)`, so work out which of those two
is binding for your model before turning anything. Replies still getting cut off, or pi reporting
context overflow? Raise `OUTPUT_HEADROOM` — or `MIN_RESERVE_TOKENS`, if that is the one holding.
Summaries losing detail you needed? Raise `KEEP_SHARE_OF_THRESHOLD`, and the bill arrives as more
frequent compaction, because a bigger tail leaves less room before the next one.

`/reload` picks up edits without restarting. This assumes you cloned the repo; if you installed it as
a package, your copy lives in pi's package store and `pi update` will overwrite anything you change
there, so clone it instead.

## What it can't do

**Picking up after a mid-run compaction isn't seamless.** There is no `agent.continue()` in the
extension API, so `ctx.compact()` stops the run and the work is restarted with
`pi.sendMessage({ display: false }, { triggerTurn: true })` — the same door a typed prompt comes
through, hidden from the transcript, arriving at the model as a normal user message. Tool calls caught
by the stop come back as "Operation aborted", so nothing is malformed, but the model may well run the
last one again. Cancelling the compaction with Escape is understood as cancelling the task: the run
is left stopped, and nothing is reported.

**When compaction cannot help, the extension stands down.** If a compaction finishes still above the
threshold — on a small window with a large system prompt, summary plus kept tail can exceed it the
moment it lands — or if summarising fails outright, it says so once and stops trying rather than
spending a summarization on every turn. The task is restarted anyway, pi carries on with its own
settings, and as soon as the context is seen back under the threshold the policy takes over again by
itself.

**Under `-p` and `--mode json` it works, but silently.** Everything fires as usual, including the
mid-run guard injecting its continuation into what you expected to be a single-shot run. There is no
UI in those modes, so nothing is ever reported — failures just fall back to pi.

**The cut point and the trigger use different rulers.** Where to cut is decided from a `chars / 4`
estimate of the messages, while the decision to compact uses real token counts from the provider. On
a small window with a big system prompt the estimate can stay under `keep`, and then the extension
declines and lets pi handle it.

**Summaries are written by the model you are talking to.** Every compaction bills a full summarization
request to it, and there is no way to route that to something cheaper or faster.

**File tracking only sees pi's own `read`, `write` and `edit`.** If a custom tool touches files, those
files won't show up in the summary.

**Falling back to pi loses the file lists.** pi ignores the accumulated read/modified lists of a
compaction that came from an extension, so whenever the extension steps aside — a dropped or
truncated summarization, an empty summary — that history restarts from empty.

**A model with no declared context window turns the whole thing off.** No policy can be computed,
every hook quietly does nothing, and pi's global numbers apply. `/context-policy` says so when asked.

**Very small windows are refused outright.** If the window cannot hold back a reply and still leave a
2000-token tail, there is no policy to apply and the extension goes inert. That is also why the table
starts at 8192.

## Depends on

Things this extension knows about pi that are not part of a stable contract, and the first places to
look when a pi upgrade changes its behaviour:

- The ordering between `ctx.compact()`'s internal abort and the delivery of `agent_settled`. The
  in-flight flag exists because a compaction started from `turn_end` is still parked when
  `agent_settled` arrives.
- `findCutPoint` is exported but appears in no example; its index range is documented only in the
  type declarations.
- The tool names `read`, `write`, `edit` and their `path` argument, mirroring pi's own extractor. A
  renamed tool degrades file tracking to empty lists, quietly.
- The `<read-files>` / `<modified-files>` markup, reproduced here because pi's own formatter is not
  exported. If pi changes it, summaries from the extension and from pi's fallback drift apart.
