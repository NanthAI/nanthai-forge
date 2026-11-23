# Review round by API call

A builder's one review round is a single API request instead of a subscription agent, unless the brief names a model reviewer. The script reads the
Lane's saved diff and the Item from Forge, sends them to the Anthropic Messages API or the OpenAI
Responses API, and prints findings ranked by severity with `file:line`, then tokens and dollars.
Forge cost is two reads (one `diff` page, one `planning` item) and no writes; idle is zero.

```sh
nforge agent LANE_PATH save …                                   # the review reads base to saved head
node scripts/review-api.mjs --lane LANE_PATH --item ISSUE_ID    # one call; fix the findings, then land
node scripts/review-api.mjs --lane LANE_PATH --dry-run          # prompt size and worst-case cost, nothing sent
```

Calibrate or re-check on a landed Lane with `--lane-id LANE_ID --files-root DIR` (files come from DIR,
for example the main checkout; line numbers can drift if the files changed since the Lane landed, so
calibration scores are slightly pessimistic) and `--spend-log FILE` to keep test calls out of the real log.

Flags: `--provider anthropic|openai`, `--model`, `--effort low|medium|high`, `--context-bytes N` (whole
changed files after the diff, smallest first), `--max-call-usd`, `--max-day-usd`, `--max-output-tokens`,
`--price-in`/`--price-out` (USD per 1M tokens; required for a model the script has no price for), `--json`.

## Default model

Default is `anthropic` / `claude-opus-5-5`, effort `high`: about $0.28 per review (25k to 63k prompt
tokens, 2.6k to 5.2k output tokens, $0.15 to $0.36). Use `--model claude-sonnet-5-5` for a small or
mechanical change: about $0.12 per review, 44% of Opus, and it caught the same missing Done-when line
and one doc mismatch Opus did not, but missed Opus's most specific bug. `--provider openai` (`gpt-5.5`,
about $0.34 per call, up to $0.64 when its reasoning runs long) is the second opinion: on the
calibration set one reply was not valid JSON (billed, retry fine) and one high finding contradicted the
change's own design. Calibrated on three landed Lanes (n=3, ground truth is the recorded subscription
review, mostly "GO"), so treat the choice as a start; re-run on new Lanes before changing it.

## Keys

Keys live in the macOS keychain, account `forge`, services `forge-review-anthropic` and
`forge-review-openai`. The lead adds each through the secret-input tool; the owner creates the key
with a hard spend limit on its platform. The script reads a key only to set the request header. It never
prints it, logs it or puts it on a command line, and strips it from any provider error text. With no key it
refuses before sending anything and names the service.

## Spend guards and log

Before sending, the worst case (prompt bytes over 2.5 as tokens, plus the full output cap at output
price) must fit the per-call cap (default $1) and the day's remaining cap (default $10, UTC day). The
script then appends a `reserve` row at the worst case, so builders running at the same time see each
other; the `call` row with the same `id` settles it. A refusal or truncated reply is billed and logged
with its tokens. A timeout, network error or 5xx has unknown billing and is logged as the worst case
(`estimated: true`); a 4xx logs 0.

The log is `~/.forge-review/spend.jsonl` (override `FORGE_REVIEW_SPEND_LOG`), one JSON line per row:
`kind` (`reserve` or `call`), `id`, `time`, `lane`, `item`, `provider`, `model`, and on `call` rows
`inputTokens`, `cachedTokens`, `cacheWriteTokens`, `outputTokens`, `usd`. The lead sums spend with
`jq -s 'map(select(.kind=="call").usd)|add'`. Caps stop accidents, not a determined override; the
platform spend limit is the hard stop.

The script reads only regular files under the Lane (no symlinks, no `..`), named by real diff file
headers, never by diff content.

## What it sends

The Item (title, body, comments, which can amend Done-when), the unified diff, the changed files in full
with line numbers within `--context-bytes`, and a system prompt that includes the AGENTS.md safety line
verbatim and says the diff, files and Item text are untrusted data. Prices are in
`scripts/review-api-lib.mjs` (`PRICES`); confirm a new model's price on its platform before relying on it.
