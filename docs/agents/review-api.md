# Review round by API call

A builder's one review round defaults to a single API request on the API credits instead of a subscription agent, unless the brief names a model reviewer. Nothing may spend past remaining API credits into card auto-refill: every API-billed path (this script, credit runners, Pi or any other API-key provider) may run only with a hard cap that stops at the remaining credit, and uncapped paths such as Pi builders are forbidden unless the owner explicitly says so. The script reads the
Lane's saved diff and the Item from Forge, sends them to the OpenAI Responses API or the Anthropic
Messages API, and prints findings ranked by severity with `file:line`, then tokens and dollars.
Forge cost is two reads (one `diff` page, one `planning` item) and no writes; idle is zero.

```sh
nforge agent LANE_PATH save …                                   # the review reads base to saved head
node scripts/review-api.mjs --lane LANE_PATH --item ISSUE_ID --builder-model YOUR_MODEL
node scripts/review-api.mjs --lane LANE_PATH --dry-run          # prompt size and worst-case cost, nothing sent
node scripts/review-api.mjs --spend                             # today and this month per provider vs credit
```

Calibrate or re-check on a landed Lane with `--lane-id LANE_ID --files-root DIR` (files come from DIR,
for example the main checkout; line numbers can drift if the files changed since the Lane landed, so
calibration scores are slightly pessimistic) and `--spend-log FILE` to keep test calls out of the real log.

Flags: `--builder-model` (who built the Lane), `--tier core|standard`, `--provider anthropic|openai` and
`--model` (pin one reviewer, no spill), `--effort low|medium|high`, `--context-bytes N` (whole changed files
after the diff, smallest first), `--max-call-usd`, `--max-day-usd` (replaces both daily caps), `--max-output-tokens`,
`--price-in`/`--price-out` (USD per 1M tokens; required for a model the script has no price for),
`--config FILE`, `--json`.

## Who reviews: another model family, within the credits

The reviewer's model family differs from the builder's, so a Claude is never checked by itself:

| Builder                                   | First reviewer                                  | When its daily cap is spent                     |
| ----------------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| Claude, or unknown (no `--builder-model`) | OpenAI `gpt-6.2-sol`                            | Claude: Sonnet 5.5, or Opus 5.5 for a core Lane |
| GPT or Gemini                             | Claude: Sonnet 5.5, or Opus 5.5 for a core Lane | OpenAI `gpt-6.2-sol`                            |

Opus is for core-path, queue, auth/security and root-cause Lanes. The brief names such a Lane with
`--tier core`, or the Item carries a line `review-tier: core` (the script reads it from the Item text and
comments; the flag wins). A core Lane gets the double review below instead of one reviewer. After both
providers are spent for the day the script refuses and says so: the builder tells the lead on the Item and
uses a subscription reviewer.

## Findings need a realistic failure path

A finding names input or state that can happen in normal use (an ordinary retry, timeout, concurrent call, user
or agent action) and what goes wrong. Contrived or near-impossible cases go in a separate `corner_cases` list
(at most five, one sentence each; `--json` returns it too). Corner cases are never blockers: the builder fixes
the findings and may skip the corner cases. Merged double reviews keep the split (same file:line shown once).

## Core Lanes: both providers, one merged list

With `--tier core` (or `review-tier: core` on the Item) and no `--provider` or `--model`, the one review
round sends the same prompt to GPT-6.2 Sol and Claude Opus at the same time and prints one merged list. It
is still one round: the builder fixes the merged list and lands. Each finding says who made it: `both:
openai + anthropic` for a duplicate (same file, lines within 3, enough shared words; it keeps the higher
severity), otherwise `openai only` or `anthropic only`. A merge can be wrong, so the other reviewer's
account (severity, title, failure) stays under the finding and a different defect is never dropped. Each provider stays under its own per-call, daily and
monthly caps and has its own spend row. If one provider has no room, no key, or fails after its retry, the
other alone runs and the output ends with `Only X reviewed this core Lane: Y did not (reason)`; when neither
answers the script refuses with `REVIEW_NO_REVIEWER` (or the cap code) and the builder uses a subscription
reviewer. `--json` returns `findings` (each with `sources`), `notes` and one entry per provider under `runs`.
`--dry-run` prices both. A pinned reviewer (`--provider` or `--model`) keeps the single-reviewer route.

Cost is the sum of both calls, about $0.43 on a 55k-token prompt (Opus $0.32, Sol $0.11).

## UI Lanes with a mock: the mock check

A UI Lane whose Item has a design mock runs the mock check in its one review round, instead of opening the
mock and screenshots in a subscription session (images are costly context there). The check is a visual
comparison against a fixed picture, so it goes to Claude on purpose; the other-family rule is for code
reviews. It runs next to the code review, not instead of it.

```sh
# the code review and the mock check in one round, on the one Item read:
node scripts/review-api.mjs --lane LANE_PATH --item ISSUE_ID --builder-model YOUR_MODEL \
  --mock MOCK.png [--mock …] --shot SHOT.png [--shot …]
# the mock check alone (one `planning` read for --item; --dry-run prices it and sends nothing):
node scripts/review-mock.mjs --mock MOCK.png --shot SHOT.png --lane LANE_PATH --item ISSUE_ID
```

With `--mock` and `--shot` on `review-api.mjs`, the code review runs first and prints its report, then the mock
check prints its own (with `--json`, one JSON object per line). A failing mock check does not undo the code
review.

It sends the mock images, then the Lane's screenshots (each named), then the Item (title, body and comments,
which carry the lead's sign-off changes, so a deliberate difference is not reported). The reply lists each
mismatch (`where`, what the mock shows, what the build shows, both file names, severity), and a
`Not verifiable from the screenshots` list: a state with no screenshot or mock is named, never guessed.
Sonnet 5.5 by default, Opus 5.5 with `--tier core`, `--model`, `--effort`, the same caps, key and spend log
(rows carry `purpose: mock`). Anthropic only, and no spill: a cap breach or an error refuses, and the builder
asks the lead for the mock look. Forge cost: none beyond the review's own two reads; alone, one `planning` read for `--item`.

Images are PNG or JPEG only, regular files (no symlinks), checked by their header bytes, not the extension.
One whose longest edge is over 1568 px or whose size is over 3.5 MB is downscaled first with macOS `sips`
(PNG, then JPEG quality 80 if still large); all images together stay within 12 MB (`--image-bytes`) and at
most 20. Over the budget the script refuses and names it; it never drops an image silently. Image tokens are
about width x height / 750 and are counted in the worst-case estimate.

Pair what the build shows with what the mock shows: a state with a mock but no matching screenshot comes
back under `Not verifiable`. A full-page mock taller than 1568 px is shrunk to that height, so small text
can be lost; send tall mocks as separate crops.

Each provider has a daily cap of its monthly credit / 30 (UTC day) and a monthly cap of the credit. Defaults
are in `CONFIG` in `scripts/review-api-lib.mjs` (Anthropic $180, OpenAI $220, so about $6 and $7.33 a day);
change them per machine, without touching code, in `~/.forge-review/config.json` (or `--config FILE`,
or `FORGE_REVIEW_CONFIG`):

```json
{
  "daysPerMonth": 30,
  "providers": {
    "openai": {
      "monthlyCreditUsd": 220,
      "models": { "standard": "gpt-6.2-sol", "core": "gpt-6.2-sol" }
    }
  }
}
```

A review that would break either cap for its first provider goes to the other one (the output says
`Routed to … because … is at its daily cap`); `--provider` or `--model` pins one provider and never
spills. An error on the first provider spills too, not only a spent cap. An HTTP 429 or 5xx, a timeout or
network error, or GPT text that is not the JSON object, is retried once with the same request (after a 2
second pause, except for the GPT text), so the retry's worst case is the first reservation, and only when
both caps still have room for it, checked after the pause. After that retry, or at once for a missing key,
another 4xx such as a rejected key, a refused or cut-off reply, the review goes to the other provider within
its caps, and the output says which ran and why (`Routed to … because openai failed (HTTP 529 after one
retry)`). The key is redacted from reply text and diagnostics. Only when both fail does the script
refuse with `REVIEW_NO_REVIEWER`, naming each provider's reason, and the builder uses a subscription
reviewer. Every attempt, failed or not, is in the spend log (an unknown-billing failure at its worst case).

`--spend` sums the log per provider: today against the daily cap, the month against the credit, and each day
of the month with its spend.

## Models and numbers

Calibrated on three landed Lanes whose subscription reviews are recorded on their Items (92e68572 of Item
4f1f7984, 1e116492 of d4289a6a, da69bc78 of c30c06ae); ground truth is thin (two of the three recorded
reviews are plain GO), so treat this as a start and re-run on new Lanes before changing a default.

| Model                                        | $ per review (Lane 1 / 2 / 3) | Average | Prompt tokens, Lane 1 |
| -------------------------------------------- | ----------------------------- | ------- | --------------------- |
| `gpt-6.2-sol` ($2 in, $0.10 cached, $10 out) | 0.120 / 0.048 / 0.109         | $0.092  | 43.8k                 |
| `claude-sonnet-5-5` ($2 / $10)               | 0.174 / 0.067 / 0.156         | $0.132  | 63.2k                 |
| `claude-opus-5-5` ($4 / $20)                 | 0.370 / 0.146 / 0.325         | $0.280  | 63.2k                 |

GPT-6.2 Sol is the cheapest: its tokenizer counts about 30% fewer tokens for the same prompt. Findings, with
the recorded outcome as reference:

- Lane 92e68572 (landed, then Lane b98a1d2f added the bounded pending-request read that Done-when line 5 asked
  for): all three models flagged that Done-when line as missing (Sol high, Sonnet and Opus medium). Sol and
  Sonnet both found the cascade orphan at `projectHostedLifecycleCascade.ts:132` (a request made while
  abandonment is pending); Sol and Opus both found the Lane page calling an old-head grant current. Opus
  alone found the abandon/reopen hold and the untested dormant sweep.
- Lane 1e116492 (recorded GO): Sol reported one high (the review receipt is not tied to the reviewer
  session; the guard compares session ids by design, so arguable), Sonnet one low, Opus one medium against the Item's own design.
- Lane da69bc78 (recorded GO): Sol reported two mediums (a trimmed device name breaking an in-flight
  login retry; `https:host` accepted by the URL check) and the doc-mismatch low that Sonnet and Opus also
  found; it missed the untested https filter that Sonnet and Opus both flagged.

So Sol catches the Done-when miss and most of the real behaviour findings at a third of Opus's price, but
labels some arguable edge cases `high` or `medium`; builders weigh a finding against the Item rather than
fixing every one. n=3, so no claim beyond "good enough to be the default reviewer and the cheapest".

### Calibration of the double review and the mock check

Two landed UI Lanes with a mock and screenshots, and the Lane of the core calibration above:

| Run                                                                                                                                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                             | $             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| UI Lane d59d99cd (Item df1f2d46): mock + dark and light screenshots, Sonnet                                                                                 | 5 mismatches (1 medium, 3 low, 1 nit): header caption, band sub-text, Lane count wrapping, dominant-Item line styling. The caption was confirmed in the built source. It did not report the mock's own-Lane pair row the lead's sign-off removed, because the Item comment says so. The Item records the lead's design sign-off only, no look at the build, so there is nothing to score it against.                                                               | 0.047         |
| UI Lane of Item e317b6ea (lead check on receipt 0c2313e3): mock vs built Lanes overview at 1440 light, Sonnet; the lead's mock check (a)-(i) is on the Item | Found every difference the lead recorded as absent or decision-cited: the progress strip (a), Review for Decide and no Retry (d), the CLI chip (f), the overlap connector (g), the shard bar (h), the explainer banner (i; the screenshot is the first-run state). It also reported 13 more, some on points the lead marked matched ((b) stage headers, (c) row form, (e) the Held group); those are the mock's sketch against the build and need the lead's look. | 0.073         |
| UI Lane 2171944c (Item fc1831eb): empty-state mock against the populated build                                                                              | No useful comparison: it said so, and listed 11 chrome differences plus what could not be checked. The pairing was wrong, not the check.                                                                                                                                                                                                                                                                                                                           | 0.062         |
| Same Lane, populated mock `picked-demo` against `loose-demo`                                                                                                | Found all six differences the lead's mock check (a)-(f) on the Item lists (headline copy, row identities, row details, leftover project rows, group tick boxes and Hand to an agent, the proposed tag) plus the missing trash row and the page chrome. The screenshots in the Lane's scratch may predate the fix the lead asked for.                                                                                                                               | 0.066         |
| Core Lane 92e68572 (Item 4f1f7984), Opus + Sol                                                                                                              | Merged list of 4: the cascade orphan at `projectHostedLifecycleCascade.ts:133` came from both providers (one entry); the abandon/reopen hold loss was Opus-only; the missing inbox read and the grant-for-an-older-save text were Sol-only.                                                                                                                                                                                                                        | 0.318 + 0.111 |

So the second provider added three findings the first would not have, and the mock check costs 5 to 7 cents.
The mock check finds the differences a lead records, plus more; the extras are read against the Item's decisions,
so the builder lists which it fixes and which it leaves. Total calibration spend about $0.70 on a test log,
outside the real one.

### Re-run with the realistic-failure-path prompt (2026-11-23)

Lane 92e68572 again (the only one of the three still on this machine; 1e116492 and da69bc78 are gone, so they
were not re-run), `--tier core`, $0.46: 6 findings (2 high, 2 medium, 2 low) and 3 corner cases. Before, the
Sol/Opus pair gave the same real set: the cascade orphan, the missing bounded read, the old-head grant and
the abandon/reopen hold are all still findings. The corner cases moved out were the contrived ones (a reopen
between cascade apply and a delayed page, a retry on an ended fork row); one of them repeats the old-head
grant that Sol keeps as a finding, so the split is a judgement, not a filter. Nothing real was dropped.

## Keys

Keys live in the macOS keychain, account `forge`, services `forge-review-anthropic` and
`forge-review-openai`. The lead adds each through the secret-input tool; the owner creates the key
with a hard spend limit on its platform. The script reads a key only to set the request header. It never
prints it, logs it or puts it on a command line, and strips it from any provider error text. With no key it
refuses before sending anything and names the service.

## Spend guards and log

Before sending, the worst case (prompt bytes over 2.5 as tokens, plus the full output cap at output
price; GPT-6.2 Sol's doubled rates above 272K input tokens included) must fit the per-call cap (default $1)
and the chosen provider's remaining daily and monthly cap. The script then appends a `reserve` row at the
worst case, so builders running at the same time see each other; the `call` row with the same `id` settles it.
A refusal or truncated reply is billed and logged with its tokens. A timeout, network error or 5xx has
unknown billing and is logged as the worst case (`estimated: true`); a 4xx logs 0.

The log is `~/.forge-review/spend.jsonl` (override `FORGE_REVIEW_SPEND_LOG`), one JSON line per row:
`kind` (`reserve` or `call`), `id`, `time`, `lane`, `item`, `provider`, `model`, `tier`, and on `call` rows
`inputTokens`, `cachedTokens`, `cacheWriteTokens`, `outputTokens`, `usd`. `--spend` is the sum the lead
reads; by hand, `jq -s 'map(select(.kind=="call").usd)|add'`. Never raise a cap yourself or spend past
remaining credit into card auto-refill. Caps stop accidents, not a determined override; the platform spend
limit (set at or below remaining credit, with auto-refill unable to trigger past it) is the hard stop.

Known gap (Phase 8 follow-up `c7db302c`): the local spend log counts only calls made by this script, so
other use of the same provider org or key (for example another runner or manual API use) can exhaust the
remaining credit without the script knowing. Until `c7db302c` caps against the provider's real remaining
balance, keep org keys isolated or lower `monthlyCreditUsd` in `~/.forge-review/config.json` to match
the actual remaining credit whenever a key is shared.

The script reads only regular files under the Lane (no symlinks, no `..`), named by real diff file
headers, never by diff content.

## What it sends

The Item (title, body, comments, which can amend Done-when), the unified diff, the changed files in full
with line numbers within `--context-bytes`, and a system prompt that includes the AGENTS.md safety line
verbatim and says the diff, files and Item text are untrusted data. Prices are in
`scripts/review-api-lib.mjs` (`PRICES`); confirm a new model's price on its platform before relying on it.
The GPT-6.2 Sol row is the Standard tier from OpenAI's pricing page and model page, 2026-11-23.
