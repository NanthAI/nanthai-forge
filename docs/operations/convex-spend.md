# Local Convex spend meter

`node scripts/convex-spend.mjs` consumes `convex logs --jsonl --success` and
keeps a private append-only UTC-day ledger. It adds **zero Convex function calls,
zero database reads/writes and no hosted worker**. The CLI itself long-polls the
provider log endpoint; it still transfers log bytes and is not an offline reader.
No probe, dashboard scrape, export or deployment is performed.

## Run and report

Use Node 24.22.1+ and the repository's installed dependencies. Keep the configuration,
ledger and launchd output outside the repository. Authenticate the Convex CLI as the
operator first, using its ordinary login. Run from the checkout that selects the
intended development project:

```sh
node scripts/convex-spend.mjs --config /absolute/private/spend.json
node scripts/convex-spend.mjs --state /absolute/private/spend-data --print
```

The private JSON configuration is:

```json
{
  "stateDirectory": "/absolute/private/spend-data",
  "deployments": ["dev", "team-slug:bench-project:dev/operator"],
  "notifier": {
    "command": ["/absolute/private/notify-spend"],
    "topic": "YOUR_PRIVATE_TOPIC",
    "target": "YOUR_PRIVATE_TARGET"
  }
}
```

Choose explicit development deployment names/references for unattended use. The
Convex CLI supports a named deployment, including a deployment in another project,
but each `logs` process covers only that deployment. A bench deployment therefore
needs its own list entry and existing operator access; dev logs do not include bench.
A deployment list starts one stream per entry and sums their costs locally. Avoid
aliases that select the same deployment twice: the CLI supplies no canonical
identity in each log event. No production deployment is needed for this workflow.

Omit `notifier` to print alerts only. Topic and target come only from the private
config; no service, topic, target or credential is built into the script. The hook
receives one JSON object on stdin with `topic`, `target`, stable `key`, UTC `day`,
threshold and observed/projected dollars. Its stdout/stderr are discarded. It runs
without a shell and inherits ordinary OS settings only; credentials, if needed,
come from the hook's own private setup. Exit zero means delivered. Failed hooks
retry on the next local 30-second tick. Deduplicate on `key` in the hook: a crash
after external delivery but before its ledger acknowledgment can repeat delivery.

`--deployment NAME` can be repeated to override the private list. For an existing
stream or replay, use `--stdin --deployment LABEL`; this reads JSONL from stdin and
never starts the Convex CLI. Reuse the same label on replay.

`--print` performs no network request and prints JSON with today, yesterday, the
seven UTC-day trend, raw usage and dollars by cost class, deployment coverage,
missing fields, gaps, and today's top ten functions by dollars. Empty days have
no coverage and unknown completeness; their observed zero is not a zero bill.

## Cost and alert semantics

The operating-budget rates are $2 per million calls, $0.20 per decimal GB of
database I/O, $0.12 per decimal GB of network egress, $0.30 per GB-hour of action
compute, and $0.11 per 1,000 decimal query-GB of search. These are the selected
budget model, before allowances and invoice adjustments, rather than a live price
lookup. [Convex pricing](https://www.convex.dev/pricing) and
[search costs](https://docs.convex.dev/search/text-search#costs) describe provider
pricing; search query bytes have a separate rate from database bytes.

Each Completion counts a call, including cached query responses, failures and
separate OCC attempts. I/O uses `databaseIoReadBytes + databaseIoWriteBytes`;
search uses `textIndexQueryBytes + textIndexWriteQueryBytes`; egress uses
`networkEgressBytes`. Compute reuses the benchmark's provider adapter: action
memory MB divided by 1024, multiplied by execution seconds divided by 3600.
Queries/mutations have zero action compute. Missing/invalid usage yields a null
cost class and total, with a separately labelled known-dollar subtotal.

Every 30 seconds the local process checks whether today's projected known cost
exceeds **$1.50/day**, or one function's observed known cost exceeds **$0.50 today**.
Projection divides each deployment's observed known cost by its locally watched
seconds today and scales to 24 hours, then sums deployments. A partial initial
sample can be noisy. Gaps are not filled or treated as free time. Each alert key is
acknowledged once per UTC day after printing/successful delivery. No action is
blocked, paused or disabled; thresholds only notify.

## Coverage and restart

The ledger stores only function identifiers, hashed execution identities, numeric
usage, coverage and alert/gap records. It never stores console lines, arguments,
results or error text. Each append is flushed; replayed execution identities are
ignored, including after a restart. Every local tick also atomically replaces a
derived `YYYY-MM-DD.summary.json` with per-function/per-class totals and dollars;
these summaries can always be rebuilt from the append-only `.jsonl` journals.
Retry count and deployment label distinguish
real OCC attempts and separate streams. One writer holds a local SQLite transaction lock (Node built-in; no added dependency);
another process can read reports. The OS releases the lock on process exit/crash;
SQLite holds no usage data, and the day journals remain the source of truth.

Coverage is **always partial**: the CLI has no exposed resumable cursor or proof
that it delivered every completion. Starts, stops, provider warnings, malformed
records and torn ledger records are marked as gaps. Local coverage heartbeats
write every 30 seconds, including when no function runs; they make no server call.
The first stream fetch selects the live head (`--history 0`); earlier/restart time
is unknown, and there is no historical backfill. A crash may lose the final
heartbeat interval. Silent provider drops cannot be counted or ruled out. No
traffic is not itself evidence of a gap. Torn bytes are preserved, and resumed
records start on a new line.

Storage, backup/export traffic absent from function logs, other unlisted projects,
R2 charges, allowances and invoice adjustments remain outside this model. Compare
against the same deployment/window in Usage, and reconcile separately with the
team invoice; do not treat this estimate as a complete team bill.

At roughly 200,000 completions/day (the current all-in order of magnitude), the
local ledger and replay work are O(completions), not O(landings or search results).
The writer retains current/replayed day identities and records; startup/reporting
reads day files sequentially, and reports aggregate by function. Disk and memory
grow with captured traffic; no automatic retention/deletion policy is installed.
A synthetic 200,000-completion/100-function model run took 1.97 seconds to normalize
and 0.26 seconds to aggregate, with 93 MB heap growth and 307 MB peak RSS; its
normalized records imply about 54 MB/day on disk for that fixture. This excludes
the identity Set, journal replay/flushes, and the separate Convex CLI processes; it
is not a measured live-machine ceiling or billed saving. Growth remains linear.
The seven-day report processes one day at a time. Keep the machine's configured
disk reserve and monitor the local ledger separately. At higher volume, measure
local memory, startup and reporting time before choosing a different ledger.

## macOS user background job

The lead installs this; the script does not install or enable anything. Substitute
absolute paths and a unique label in a user LaunchAgent plist such as
`~/Library/LaunchAgents/dev.forge.convex-spend.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.forge.convex-spend</string>
  <key>ProgramArguments</key><array>
    <string>/absolute/path/to/node</string>
    <string>/absolute/checkout/scripts/convex-spend.mjs</string>
    <string>--config</string><string>/absolute/private/spend.json</string>
  </array>
  <key>WorkingDirectory</key><string>/absolute/checkout</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/absolute/node/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>/absolute/private/spend.stdout.log</string>
  <key>StandardErrorPath</key><string>/absolute/private/spend.stderr.log</string>
</dict></plist>
```

After preparing the private config/directory and verifying a foreground stream:

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.forge.convex-spend.plist"
```

To stop/undo the background job, preserving all ledger/configuration files:

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.forge.convex-spend.plist"
```

Review the private logs and `--print` output after installation. Restart warnings
and gaps are evidence to inspect, never a reason to silently replace a deployment.
