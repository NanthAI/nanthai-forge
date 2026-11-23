# Review round by API call

A builder's one review round is a single API request instead of a subscription agent, unless the brief names a model reviewer. The script reads the
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

| Builder | First reviewer | When its daily cap is spent |
| --- | --- | --- |
| Claude, or unknown (no `--builder-model`) | OpenAI `gpt-6.2-sol` | Claude: Sonnet 5.5, or Opus 5.5 for a core Lane |
| GPT or Gemini | Claude: Sonnet 5.5, or Opus 5.5 for a core Lane | OpenAI `gpt-6.2-sol` |

Opus is for core-path, queue, auth/security and root-cause Lanes. The brief names such a Lane with
`--tier core`, or the Item carries a line `review-tier: core` (the script reads it from the Item text and
comments; the flag wins). After both providers are spent for the day the script refuses and says so: the
builder tells the lead on the Item and uses a subscription reviewer.

Each provider has a daily cap of its monthly credit / 30 (UTC day) and a monthly cap of the credit. Defaults
are in `CONFIG` in `scripts/review-api-lib.mjs` (Anthropic $180, OpenAI $220, so about $6 and $7.33 a day);
change them per machine, without touching code, in `~/.forge-review/config.json` (or `--config FILE`,
or `FORGE_REVIEW_CONFIG`):

```json
{ "daysPerMonth": 30, "providers": { "openai": { "monthlyCreditUsd": 220, "models": { "standard": "gpt-6.2-sol", "core": "gpt-6.2-sol" } } } }
```

A review that would break either cap for its first provider goes to the other one (the output says
`Routed to … because … is at its daily cap`); `--provider` or `--model` pins one provider and never
spills. GPT sometimes returns text that is not the JSON object; that call is billed and logged, then the
script retries once with the same request, so the retry's worst case is the first reservation, and only when
both caps still have room for it.

`--spend` sums the log per provider: today against the daily cap, the month against the credit, and each day
of the month with its spend.

## Models and numbers

Calibrated on three landed Lanes whose subscription reviews are recorded on their Items (92e68572 of Item
4f1f7984, 1e116492 of d4289a6a, da69bc78 of c30c06ae); ground truth is thin (two of the three recorded
reviews are plain GO), so treat this as a start and re-run on new Lanes before changing a default.

| Model | $ per review (Lane 1 / 2 / 3) | Average | Prompt tokens, Lane 1 |
| --- | --- | --- | --- |
| `gpt-6.2-sol` ($2 in, $0.10 cached, $10 out) | 0.120 / 0.048 / 0.109 | $0.092 | 43.8k |
| `claude-sonnet-5-5` ($2 / $10) | 0.174 / 0.067 / 0.156 | $0.132 | 63.2k |
| `claude-opus-5-5` ($4 / $20) | 0.370 / 0.146 / 0.325 | $0.280 | 63.2k |

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
reads; by hand, `jq -s 'map(select(.kind=="call").usd)|add'`. Caps stop accidents, not a determined
override; the platform spend limit is the hard stop.

The script reads only regular files under the Lane (no symlinks, no `..`), named by real diff file
headers, never by diff content.

## What it sends

The Item (title, body, comments, which can amend Done-when), the unified diff, the changed files in full
with line numbers within `--context-bytes`, and a system prompt that includes the AGENTS.md safety line
verbatim and says the diff, files and Item text are untrusted data. Prices are in
`scripts/review-api-lib.mjs` (`PRICES`); confirm a new model's price on its platform before relying on it.
The GPT-6.2 Sol row is the Standard tier from OpenAI's pricing page and model page, 2026-11-23.
