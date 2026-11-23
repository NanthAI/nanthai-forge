# Review round by API call

A builder's review round can be a single API request instead of a subscription agent. It is opt-in until calibration on landed Lanes picks a default provider and model; a brief may ask for it. The script reads the
Lane's saved diff and the Item from Forge, sends them to the Anthropic Messages API or the OpenAI
Responses API, and prints findings ranked by severity with `file:line`, then tokens and dollars.
Forge cost is two reads (one `diff` page, one `planning` item) and no writes; idle is zero.

```sh
nforge agent LANE_PATH save …                                   # the review reads base to saved head
node scripts/review-api.mjs --lane LANE_PATH --item ISSUE_ID    # one call; fix the findings, then land
node scripts/review-api.mjs --lane LANE_PATH --dry-run          # prompt size and worst-case cost, nothing sent
```

Flags: `--provider anthropic|openai`, `--model`, `--effort low|medium|high`, `--context-bytes N` (whole
changed files after the diff, smallest first), `--max-call-usd`, `--max-day-usd`, `--max-output-tokens`,
`--price-in`/`--price-out` (USD per 1M tokens; required for a model the script has no price for), `--json`.

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
