# Run evidence

A passing command, the tests that command reports and an agent's own verification
claim are separate facts. Forge records the command outcome against exact source.
Test-file counts, coverage and file timing from the checked code are self-reported
via CI. They are not independent measurements by Forge. CI time is reported by
the runner; the interval between Forge's recorded timestamps is observed by Forge.
Missing test reports mean **not reported**, even when an older runner retained an
empty report summary. They do not mean that zero tests ran.

Saves accept optional `notVerified` and `outside` declarations in the hosted save
request. They are retained on the immutable save and its original terminal receipt,
with the authenticated author and exact source head on the save. The receipt links
to that immutable save through `saveId`. Retrying the original request
returns the same claim. They add no approval or landing block.

- Omit `notVerified` when the agent has not reported its verification limits.
- Send `notVerified: []` when the agent claims it verified everything it changed.
- Send a list of strings to describe the work it did not verify. This is an agent
  claim, separate from recorded check evidence.

`outside` contains `{kind, what, where?}` summaries. Kinds are `deploy`, `migration`
and `external-setting`. Forge records that the agent made the report; it did not
observe or authorise the external action. Summaries redact token-shaped values,
URL details, private paths and private hostnames. Do not send credential values,
private device labels or settings payloads.

The proof read returns the exact save and check source pins. A composed Candidate
can contain more than one Lane: a claim is never silently moved from its save to a
different checked head. If the association cannot be established, the page says so.

The proof page’s full-check action requests a fresh execution of the configured
command on the original Candidate and source pins, even when an older pass is
reusable. It does not land, change policy or substitute current main. If those
check or runner pins are no longer available, the existing structured error is
shown. Retries use one operation identity derived from the original run.

The check screen links to proof for its displayed run. The proof page uses the
existing receipt-based revert operation directly: it creates a new checked landing
that removes the selected change and preserves later work. A lost reply retries
the same operation; no additional review step is introduced.

Landing requests accept the same optional declarations. The original landing request can
retain them without forcing a redundant save. The CLI/MCP writer is a separate
rollout after these readers; its capability is `save-declarations`.
The proof page gives that request's declaration precedence, binds it to the
accepted source, and links follow-up Items to the immutable landing identity.
Older requests continue to mean “not reported”. Outside summaries are sanitized
before replay identity and persistence on both paths.

Compact successful landing receipts use `selfReportedTestFiles` for the number of
test files reported by the checked code via CI. `null` means no file report, not
zero tests executed. Failed/flaky details keep their source label; `--detail`
keeps the complete original record, including zero counts.
