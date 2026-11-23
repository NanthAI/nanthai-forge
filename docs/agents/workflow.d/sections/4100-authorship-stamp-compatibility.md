### Authorship stamp compatibility

The existing `agentClient` (`harness:model`, or a bare harness) and `agentRun`
fields are the only stored home for app, declared model and run. Lane and save
readers accept those same carriers. An optional `authorship` adds source-builder
kind (`agent` or `person`) and a missing-model `declaration` (`unknown` or
`not-declared`). Only a receipt stamp also carries its non-empty builder `actor`,
which can differ from the approving `actor`. Lanes and saves use their existing
actor field. Person stamps have no agent declaration, client or run.

Readers take an existing declared `agentClient` model before any missing-model
marker; legacy receipts with a model never become “not declared”. Explicit
`unknown` differs from an absent legacy declaration. Each save is immutable:
changing a Lane declaration does not relabel earlier source. All stamp values
use the existing model-ID character rule, without trimming or normalization.
Attribution is excluded from start, save and landing retry identity; a resumed
operation retains the original source request and its first declaration.

The writer negotiates `source-authorship-v1`, deployed after compatible readers.
On the first CLI or MCP agent `start`, `model` or `FORGE_AGENT_MODEL` names the exact
model ID, or `unknown`. Without either, the client's own model (`ANTHROPIC_MODEL` or
`GEMINI_MODEL`, when it is a valid stamp) is used, else `unknown` with a one-time tip;
`start` never refuses for a missing model. A person
outside an agent session is never asked for a model. Without the feature, clients
keep the previous wire format; older clients that send no stamp stay readable as
“not declared”.

For detected agent apps, Forge retains the declaration in its own local session
record on a best-effort basis. Later `start`, `save` and `land` calls inherit it. An optional `model`
or a changed `FORGE_AGENT_MODEL` declares a model switch for later work. A failed
local write does not prevent the current command from sending its declaration.
Without a detected app, an explicit model applies only to that command and is
never retained for later shell commands. The app label comes from the existing
best-effort harness detection, and can be absent. Each canonical save records its
own stamp, so a later save never relabels earlier source. The server records the
builder account from the original submission. Browser landings declare person
authorship. For older receipts, the readers use the recorded submitter's kind
and any app or model already recorded. The proof view shows a save's model
separately from the landing's model. The proof view and `landings` name the
agent builder and the approving person on a supervised landing.

No server model guessing or other app's session-file reads are used. Stamps never
grant access. The labels reuse existing calls and records: no added DB reads,
tables, timers or idle I/O; source bytes stay in R2. Blame and log will join a
bounded slim receipt summary with current access and public-handle mapping,
rather than hydrate whole receipts.
